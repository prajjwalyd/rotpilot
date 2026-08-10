/**
 * rotpilotd — owns the Chrome session, the TV window, the state machine, the
 * memory sinks, and the IPC server. Spawned detached by `rotpilot start`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import type net from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve, send, type Msg } from './ipc.js';
import { StateMachine, type HookCtx, type ExitInfo } from './state.js';
import { ChromeSession } from '../chrome/driver.js';
import {
  findKitty,
  focusKittyWindow,
  frontmostApp,
  activateApp,
  isTerminalApp,
  launchKittyPanel,
  closeKittyPanel,
  findGhostty,
  ghosttyLaunchPanel,
  ghosttyLaunchWindow,
  ghosttyFocusTerminal,
  ghosttyCloseTerminal,
  automationWasDenied,
  type Panel,
  type GhosttyPanel,
} from '../render/terminal.js';
import { pngDims } from '../render/kitty.js';
import { loadConfig, PID_PATH, KITTY_SOCK, ensureConfigDir } from '../config.js';
import { appendEvent, patchLastLatency, repoLabel } from '../memory/store.js';
import { sendRotWindow } from '../memory/engram.js';
import { rotWindowMessages, missedLine, countQuestions } from '../memory/transcript.js';
import { log } from '../log.js';

interface TvState {
  sock: net.Socket;
  cols: number;
  rows: number;
  pxw: number;
  pxh: number;
}

// shown in the TV while the video is paused — go finish your work
const JOKES: Record<string, string[]> = {
  permission: [
    'claude needs a permission. your deadline needs a miracle.',
    "go click allow. i'll keep your spot warm.",
    "your AI is blocked and it's your fault. sit with that.",
    'permission required. pretend you read the command first.',
    'the machine awaits your blessing. the reels await your return.',
  ],
  done: [
    'claude finished. one of you had to.',
    "task complete. go review it — future you loves surprises.",
    "it's done. go look busy.",
    'claude shipped. your turn to take the credit.',
    "work's done. the rot will be here when you've earned it.",
  ],
  idle: [
    "claude is waiting on YOU now. the roles reversed and it's embarrassing.",
    'your AI got bored waiting for you. even the machine has standards.',
  ],
  manual: [
    'you paused it yourself. character growth, allegedly.',
    'rot suspended by your own hand. weird flex, but noted.',
    'self-control. disgusting. press r when it passes.',
    'paused on purpose. the feed will wait. it always waits.',
  ],
  default: ['back to work. the rot waits. it always waits.'],
};

function pickJoke(reason: string): string {
  const list = JOKES[reason] ?? JOKES.default;
  return list[Math.floor(Math.random() * list.length)];
}

// shown the moment claude starts, before any work — so the panel is present
// from the start and feels like part of claude, not something that only appears
// mid-task.
const GREETINGS = [
  'rotpilot online. give claude something chunky so we can rot.',
  "i'm here to babysit your attention span. try not to enjoy it.",
  'claude works, you rot. that was always the arrangement.',
  'booted up. the feed is warm. your discipline is not.',
  "standing by. the second claude moves, so do we.",
];
function pickGreeting(): string {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
}

export async function runDaemon(): Promise<void> {
  ensureConfigDir();
  // singleton guard: hooks auto-spawn daemons, so a live one must win
  try {
    const existing = parseInt(fs.readFileSync(PID_PATH, 'utf8'), 10);
    if (existing > 0) {
      process.kill(existing, 0); // throws if dead
      process.exit(0);
    }
  } catch {}
  fs.writeFileSync(PID_PATH, String(process.pid));
  const cfg = loadConfig();
  log('daemon starting, pid', process.pid, 'feed', cfg.feed);

  const chrome = new ChromeSession();
  // prewarm at boot so the very first play is warm, not a 3-4s cold launch
  // (the daemon only ever runs because a live, enabled project asked for it)
  void chrome.ensure(cfg.feed).catch((e) => log('boot prewarm failed', e as Error));
  let tv: TvState | null = null;
  let tvProc: ReturnType<typeof spawn> | null = null;
  let prevFrontApp: string | null = null;
  let lastSnapbackAt = 0;
  let framesSent = 0;
  let playStartedAt = 0;
  let frameW = 0;
  let frameH = 0;
  // when the TV lives as a split inside the user's own kitty window
  let panel: (Panel & { listenOn: string }) | null = null;
  // when the TV lives as a Ghostty split (or window): pane ids for focus/close
  let gPanel: GhosttyPanel | null = null;
  // user pressed q in the TV: stay quiet until they submit the next prompt
  let snoozed = false;
  // user pressed p: a HELD pause. Without this latch claude's next tool call
  // would resume the feed a moment later and the key would do nothing. Released
  // by r, by the next prompt (same contract as q), or by the session ending.
  let manualPause = false;
  // gate frame forwarding so a snap-back freezes the TV instantly, before the
  // (slower) CDP stopScreencast round-trip completes
  let forwarding = false;
  // deep pause: after a resident pause sits idle a while, fully release Chrome
  let deepPaused = false;
  let deepPauseTimer: NodeJS.Timeout | null = null;
  // auto-resume: no hook fires at permission approval, so resume after a timer
  let autoResumeTimer: NodeJS.Timeout | null = null;
  // which snap-back put us in the current pause — resume refocuses differently
  // for a permission (hand focus back) than for anything else (grab the TV)
  let lastPauseReason: string | null = null;
  // the app a permission snap-back interrupted, so we can return you to it
  let returnFocusTo: string | null = null;
  // live subagents (SubagentStart/Stop). A Stop that arrives while a background
  // agent is still running is NOT "claude finished" — claude gets re-invoked
  // when the agent completes. Reset each turn so a missed SubagentStop can't
  // wedge us in "still working" forever.
  let activeSubagents = 0;

  const kitty = findKitty();

  function assetsDir(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');
  }

  /**
   * Exit so the next hook boots a clean daemon.
   *
   * A macOS AppleEvents denial is cached against this process for its whole
   * life, so once denied we can never dock a Ghostty pane again — not in this
   * session, not in any future one. A fresh process gets granted normally, and
   * hooks already auto-spawn the daemon, so quitting IS the repair.
   *
   * Rate-limited through a stamp file: if the grant is genuinely missing, every
   * replacement would be denied too, and an unguarded version would respawn on
   * every tool call.
   */
  function respawnForAutomationDenial(): void {
    const stamp = path.join(path.dirname(PID_PATH), 'tcc-respawn');
    const COOLDOWN_MS = 10 * 60 * 1000;
    try {
      const last = Date.parse(fs.readFileSync(stamp, 'utf8').trim());
      if (Number.isFinite(last) && Date.now() - last < COOLDOWN_MS) {
        log('automation denied, but a respawn was already tried recently — grant it in System Settings › Privacy & Security › Automation');
        return;
      }
    } catch {}
    try {
      fs.writeFileSync(stamp, new Date().toISOString());
    } catch {}
    log('automation denied for this process — exiting so the next hook boots a clean daemon');
    void teardown();
  }

  async function waitForHello(ms = 10000): Promise<TvState | null> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (tv) return tv;
      await new Promise((r) => setTimeout(r, 100));
    }
    log('TV never said hello');
    return null;
  }

  async function ensureTv(ctx: HookCtx): Promise<TvState | null> {
    if (tv && !tv.sock.destroyed) return tv;
    tv = null;
    const cliPath = process.argv[1];
    const cfgNow = loadConfig();
    const tvCmd = [process.execPath, cliPath, '_tv'];

    // ── Ghostty session: split pane via AppleScript (Ghostty ≥1.3) ──
    if (ctx.term === 'ghostty' && findGhostty()) {
      if (cfgNow.window === 'panel') {
        const p = await ghosttyLaunchPanel(tvCmd);
        if (p) {
          gPanel = p;
          const t = await waitForHello();
          if (t) return t;
          await ghosttyCloseTerminal(p.tvId);
          gPanel = null;
        }
        log('ghostty panel launch failed, falling back to separate window');
      }
      const w = await ghosttyLaunchWindow(tvCmd);
      if (w) {
        gPanel = w;
        return waitForHello();
      }
      log('ghostty window launch failed');
      if (automationWasDenied()) respawnForAutomationDenial();
      return null;
    }

    // ── kitty session ──
    if (!kitty) {
      log('kitty not found; cannot open TV');
      return null;
    }

    // default: split panel inside the user's own kitty window, claude stays
    // visible. Needs the user's kitty remote-control socket (from hook env).
    if (cfgNow.window === 'panel' && ctx.kittyListenOn) {
      const p = await launchKittyPanel(
        kitty.kitten,
        ctx.kittyListenOn,
        tvCmd,
        Math.min(80, Math.max(15, cfgNow.panelBias)),
      );
      if (p) {
        panel = { ...p, listenOn: ctx.kittyListenOn };
        const t = await waitForHello();
        if (t) return t;
        await closeKittyPanel(kitty.kitten, ctx.kittyListenOn, p);
        panel = null;
      }
      log('panel launch failed, falling back to separate window');
    }

    // fallback / configured: our own kitty OS window
    try {
      fs.unlinkSync(KITTY_SOCK);
    } catch {}
    tvProc = spawn(
      kitty.kitty,
      [
        '--title=rotpilot-tv',
        '-o', 'allow_remote_control=socket-only',
        '--listen-on', `unix:${KITTY_SOCK}`,
        '-o', 'confirm_os_window_close=0',
        ...tvCmd,
      ],
      { stdio: 'ignore', detached: false },
    );
    tvProc.on('exit', () => {
      tv = null;
      tvProc = null;
    });
    return waitForHello();
  }

  // stable frame handler — set up once, reused across cold starts and
  // deep-pause restarts. Gated by `forwarding`.
  const onFrame = (png: Buffer): void => {
    if (!forwarding) return; // paused/snapped-back: drop frames
    framesSent++;
    if (!frameW) {
      const d = pngDims(png);
      if (d) {
        frameW = d.w;
        frameH = d.h;
      }
    }
    if (tv && !tv.sock.destroyed) send(tv.sock, { t: 'frame', data: png.toString('base64') });
  };

  async function startPlayback(): Promise<void> {
    const cfgNow = loadConfig();
    framesSent = 0;
    playStartedAt = Date.now();
    frameW = 0;
    frameH = 0;
    forwarding = true;
    await chrome.play(tv?.pxw ?? 900, tv?.pxh ?? 1280, cfgNow.fps, onFrame);
  }

  // Give the TV keyboard focus so `q`/Esc reach it — and it grabs your
  // attention. Works for a kitty panel/window or a Ghostty pane.
  async function focusTv(): Promise<void> {
    try {
      if (gPanel) await ghosttyFocusTerminal(gPanel.tvId);
      else if (panel && kitty) await focusKittyWindow(kitty.kitten, panel.listenOn, `id:${panel.windowId}`);
      else if (kitty) await focusKittyWindow(kitty.kitten, `unix:${KITTY_SOCK}`, 'title:^rotpilot-tv');
    } catch {}
  }

  // Where focus belongs once the video is rolling again.
  //
  // A permission snap-back yanks you into the terminal mid-whatever, so resuming
  // hands focus back to the app it interrupted — pressing y/n should return you
  // where you were, not leave you parked in the terminal. Two guards: if you were
  // already in the terminal there's nothing to hand back, and if you've since
  // moved somewhere yourself we leave you there (otherwise the auto-resume timer
  // drags the terminal in front of you a few seconds after you walked away,
  // which is the same rudeness pointing the other way).
  //
  // Every other resume still grabs the TV — that focus steal IS the attention
  // grab, and `q` needs the panel focused to work.
  async function refocusAfterResume(): Promise<void> {
    // consume both up front, so a failure below can't leave them set for the
    // next cycle
    const reason = lastPauseReason;
    const target = returnFocusTo;
    lastPauseReason = null;
    returnFocusTo = null;
    if (reason !== 'permission') {
      await focusTv();
      return;
    }
    if (!target) return; // you were already in the terminal — leave it alone
    const cur = await frontmostApp();
    if (cur && isTerminalApp(cur)) await activateApp(target);
  }

  // COLD start: full setup, then play.
  async function enterPlaying(ctx: HookCtx): Promise<void> {
    log('enter PLAYING', ctx);
    const t0 = Date.now();
    clearDeepPause();
    deepPaused = false;
    try {
      const cfgNow = loadConfig();
      void frontmostApp()
        .then((a) => (prevFrontApp = a))
        .catch(() => {});
      let tvMs = 0;
      let chromeMs = 0;
      const [tvReady] = await Promise.all([
        ensureTv(ctx).then((r) => ((tvMs = Date.now() - t0), r)),
        chrome.ensure(cfgNow.feed).then(() => (chromeMs = Date.now() - t0)),
      ]);
      // No panel means nowhere to draw. Starting the screencast anyway burned
      // CPU encoding PNGs into the void and left Chrome running behind a
      // terminal that shows nothing — which is what the ghostty-denied logs
      // looked like from the outside.
      if (!tvReady) {
        log('no TV surface — skipping playback (chrome stays warm and silent)');
        return;
      }
      await startPlayback();
      // latency breakdown lands in daemon.log so slow plays are diagnosable
      log(`PLAY in ${Date.now() - t0}ms (tv ${tvMs}ms, chrome ${chromeMs}ms)`);
      await focusTv();
    } catch (e) {
      // cold boots can race Chrome's startup-tab swap; one retry rides over it.
      // Without this the state machine sits in `playing` with no screencast —
      // audio without video — until the next pause/resume cycle.
      log('enterPlaying failed, retrying once', e as Error);
      try {
        await new Promise((r) => setTimeout(r, 600));
        await chrome.ensure(loadConfig().feed);
        await startPlayback();
        log(`PLAY (retry) in ${Date.now() - t0}ms`);
        await focusTv();
      } catch (e2) {
        log('enterPlaying retry failed', e2 as Error);
      }
    }
  }

  // RESUME from a resident pause — near-instant. If we only soft-paused, the
  // screencast is still live, so this is just a flag flip + resume scrolling.
  async function resumePlaying(): Promise<void> {
    clearDeepPause();
    clearAutoResume();
    try {
      if (deepPaused) {
        deepPaused = false;
        await startPlayback(); // screencast was torn down; restart it
      } else {
        forwarding = true; // frames already flowing → instant
        chrome.resumeScroll();
        playStartedAt = playStartedAt || Date.now();
      }
      await refocusAfterResume();
      log('RESUME (deep=' + deepPaused + ')');
    } catch (e) {
      log('resume failed', e as Error);
    }
  }

  // RESIDENT snap-back — freeze + roast instantly, keep everything warm.
  function pausePlaying(info: ExitInfo): void {
    log('PAUSE', info.reason);
    lastSnapbackAt = Date.now();
    lastPauseReason = info.reason;
    forwarding = false; // freeze the TV immediately
    // permission pauses get a visible countdown + auto-resume (no approval hook
    // exists); a real work signal still resumes sooner if it arrives.
    const cfgNow = loadConfig();
    const countdownSec = info.reason === 'permission' ? Math.max(0, Math.round(cfgNow.autoResumeSec)) : 0;
    // the instant "while you rotted: 3 edits · 1 question waiting" line —
    // parsed locally from the transcript, shows on the very first snap-back
    // with no Engram anything
    const missed = missedLine(rotWindowMessages(info.ctx.transcriptPath, info.rotSeconds));
    if (missed) log('missed:', missed);
    const manual = info.reason === 'manual';
    if (tv && !tv.sock.destroyed) {
      send(tv.sock, { t: 'paused', msg: pickJoke(info.reason), countdownSec, missed, manual });
    }
    chrome.softPause(); // stop advancing reels, but keep the pipeline warm
    // A pause you asked for gets no ding and no focus grab — there's nothing to
    // alert you to, and yanking focus to claude would take it off the panel,
    // which is the only place `r` can be typed.
    if (!manual) snapBackSideEffects(info);
    recordBreak(info);
    clearAutoResume();
    if (countdownSec > 0) {
      autoResumeTimer = setTimeout(() => {
        log('auto-resume after countdown');
        sm.resumeNow();
      }, countdownSec * 1000);
      autoResumeTimer.unref?.();
    }
    // if the pause drags on, fully release Chrome to save cycles
    clearDeepPause();
    deepPauseTimer = setTimeout(() => {
      log('deep pause (idle) — releasing screencast');
      void chrome.pause();
      deepPaused = true;
    }, 15000);
    deepPauseTimer.unref?.();
  }

  // Open the resident panel at session start (before any work) showing a
  // greeting, so it feels like part of claude from the first moment. Docks
  // beside claude WITHOUT stealing focus (the panel launches --keep-focus, and
  // we deliberately do NOT call focusTv here — that's only for actual playback).
  async function openIdlePanel(ctx: HookCtx): Promise<void> {
    const cfgNow = loadConfig();
    if (snoozed) return;
    // only a docked panel makes sense at idle
    const canPanel = (ctx.kittyListenOn && kitty) || (ctx.term === 'ghostty' && findGhostty());
    if (cfgNow.window !== 'panel' || !canPanel) return;
    if (tv && !tv.sock.destroyed) return; // already open
    try {
      const t = await ensureTv(ctx);
      if (t && !t.sock.destroyed) send(t.sock, { t: 'idle', msg: pickGreeting() });
    } catch (e) {
      log('openIdlePanel failed', e as Error);
    }
  }

  // Close the TV panel/window, keeping Chrome warm. Shared by stop + q-on-idle.
  async function closeTvPanel(): Promise<void> {
    try {
      if (tv && !tv.sock.destroyed) send(tv.sock, { t: 'clear' });
      if (gPanel) {
        await ghosttyCloseTerminal(gPanel.tvId);
        gPanel = null;
      }
      if (panel && kitty) {
        await closeKittyPanel(kitty.kitten, panel.listenOn, panel);
        panel = null;
      }
      tv = null;
      tvProc?.kill();
      tvProc = null;
    } catch (e) {
      log('closeTvPanel failed', e as Error);
    }
  }

  // CLOSE snap-back — tear the TV down.
  async function stopPlaying(info: ExitInfo): Promise<void> {
    log('STOP', info.reason);
    lastSnapbackAt = Date.now();
    lastPauseReason = null;
    returnFocusTo = null;
    forwarding = false;
    clearDeepPause();
    clearAutoResume();
    snapBackSideEffects(info);
    recordBreak(info);
    try {
      // a CLOSE (q / session-end / watchdog) fully tears Chrome down so no
      // window lingers in the background; the next prompt's prewarm relaunches
      // it. Resident done/permission PAUSES keep Chrome warm instead — those go
      // through pausePlaying.
      await chrome.teardown();
      await closeTvPanel();
    } catch (e) {
      log('stopPlaying failed', e as Error);
    }
  }

  // The cue has to land in SILENCE. A reel at full volume masks a short wav, so
  // the snap-back sound only ever seemed to work when nothing was playing — you
  // heard it when the feed was already paused and never while watching. Mute
  // first, then play. Bounded: a wedged Chrome must not swallow the cue.
  async function playSnapbackCue(): Promise<void> {
    await Promise.race([chrome.silence(), new Promise((r) => setTimeout(r, 400))]);
    execFile('afplay', [path.join(assetsDir(), 'sounds', 'snapback.wav')], () => {});
  }

  function snapBackSideEffects(info: ExitInfo): void {
    // deliberately NOT awaited alongside the focus grab below — the focus snap is
    // the part that gets your attention and must not queue behind a CDP call
    if (loadConfig().sound) void playSnapbackCue();
    void (async () => {
      // Read the frontmost app BEFORE we steal focus — this is the only moment
      // it still says where you actually were. Something already in the terminal
      // has nothing to hand back, so it stays null.
      if (info.reason === 'permission') {
        const before = await frontmostApp();
        returnFocusTo = before && !isTerminalApp(before) ? before : null;
      }
      let focused = false;
      if (gPanel?.claudeId) {
        // ghostty: focus the exact pane claude was in when the panel opened
        focused = await ghosttyFocusTerminal(gPanel.claudeId);
      } else if (kitty && info.ctx.kittyListenOn && info.ctx.kittyWindowId) {
        focused = await focusKittyWindow(kitty.kitten, info.ctx.kittyListenOn, `id:${info.ctx.kittyWindowId}`);
      }
      if (!focused && prevFrontApp) await activateApp(prevFrontApp);
    })();
  }

  function recordBreak(info: ExitInfo): void {
    // joke refreshes and never-played snap-backs carry no rot window — not a break
    if (info.rotSeconds <= 0) return;
    const feed = loadConfig().feed;
    // count what claude asked while you were gone; the transcript that holds it
    // rotates with the session, so this tally is the only lasting trace
    const questions = countQuestions(rotWindowMessages(info.ctx.transcriptPath, info.rotSeconds));
    appendEvent({
      ts: new Date().toISOString(),
      sessionId: info.ctx.sessionId,
      repo: repoLabel(info.ctx.cwd),
      feed,
      reason: info.reason,
      workSeconds: info.workSeconds,
      rotSeconds: info.rotSeconds,
      responseLatencyMs: null,
      questions,
    });
    // the opt-in "what you missed" memory: ship the transcript segment that
    // streamed by during this rot window (gated inside on key + consent)
    sendRotWindow({
      transcriptPath: info.ctx.transcriptPath,
      project: repoLabel(info.ctx.cwd),
      feed,
      rotSeconds: info.rotSeconds,
    });
  }

  function clearDeepPause(): void {
    if (deepPauseTimer) {
      clearTimeout(deepPauseTimer);
      deepPauseTimer = null;
    }
  }

  function clearAutoResume(): void {
    if (autoResumeTimer) {
      clearTimeout(autoResumeTimer);
      autoResumeTimer = null;
    }
  }


  const sm = new StateMachine(
    { enter: enterPlaying, resume: resumePlaying, pause: pausePlaying, stop: stopPlaying },
    250, // cold-start debounce — snappy, still filters sub-250ms one-shot calls
    100, // resume debounce — near-instant
    600, // prompt-start debounce — rides over turns answered in a blink
  );

  // watchdog: if claude vanished mid-rot (killed, crashed, -p exited), no hook
  // will ever tell us — don't let the feed run forever
  let lastHookAt = Date.now();
  const WATCHDOG_MS = 10 * 60 * 1000;
  setInterval(() => {
    if (sm.state === 'playing' && Date.now() - lastHookAt > WATCHDOG_MS) {
      log('watchdog: no hook traffic while playing, snapping back');
      sm.onEvent('snap-back', { reason: 'watchdog' });
    }
  }, 60 * 1000).unref?.();

  const server = serve((msg: Msg, sock) => {
    switch (msg.t) {
      case 'hook': {
        const ctx = (msg.ctx ?? {}) as HookCtx;
        const event = String(msg.event ?? '');
        if (msg.reason) ctx.reason = String(msg.reason);
        lastHookAt = Date.now();
        log('hook', event, ctx.reason ?? '', ctx.sessionId ?? '');
        // response-latency: first user-side event after a snap-back
        if (lastSnapbackAt && (event === 'prompt' || event === 'work-start')) {
          patchLastLatency(Date.now() - lastSnapbackAt);
          lastSnapbackAt = 0;
        }
        if (event === 'prompt') {
          snoozed = false; // new prompt re-arms after a user q
          manualPause = false; // …and releases a held p, same contract
          activeSubagents = 0; // fresh turn — clear any leaked agent count
        }
        // prewarm chrome on any pre-work signal so the first play is warm
        if (event === 'prompt' || event === 'session-start') {
          void chrome.ensure(loadConfig().feed).catch((e) => log('prewarm failed', e as Error));
        }
        if (event === 'session-start') {
          snoozed = false; // NEW session = clean slate; a q from a past session must not mute startup
          manualPause = false;
          activeSubagents = 0;
          void openIdlePanel(ctx); // show the greeting panel from the start
          break; // no state change — the state machine only drives playback
        }
        // subagents: count them, and treat a spawn as a work signal (their tool
        // calls fire NO hooks in the parent session, so this is the only one)
        if (event === 'subagent-start') {
          activeSubagents++;
          if (!snoozed) sm.onEvent('work-start', ctx);
          break;
        }
        if (event === 'subagent-stop') {
          activeSubagents = Math.max(0, activeSubagents - 1);
          break; // never a pause: claude continues (or is re-invoked) after this
        }
        // a Stop while background agents run is a lull, not "done" — keep rotting
        if (event === 'snap-back' && ctx.reason === 'done' && activeSubagents > 0) {
          log(`done ignored: ${activeSubagents} subagent(s) still running`);
          break;
        }
        // a session ending while nothing plays: close the greeting panel it
        // opened (the state machine only manages playback, so without this the
        // idle panel would linger after claude exits)
        if (event === 'snap-back' && ctx.reason === 'session-end' && sm.state === 'idle') {
          void closeTvPanel();
          void chrome.teardown();
          break;
        }
        // a held p outranks claude getting back to work — otherwise the very
        // next tool call would undo the pause a beat after you asked for it
        if (event === 'work-start' && (snoozed || manualPause)) break;
        sm.onEvent(event, ctx);
        break;
      }
      case 'tv-hello':
      case 'tv-resize': {
        tv = {
          sock,
          cols: Number(msg.cols) || 80,
          rows: Number(msg.rows) || 24,
          pxw: Number(msg.pxw) || 900,
          pxh: Number(msg.pxh) || 600,
        };
        const cfgNow = loadConfig();
        send(sock, { t: 'tv-config', fps: cfgNow.fps, feed: cfgNow.feed });
        sock.on('close', () => {
          if (tv?.sock === sock) tv = null;
        });
        break;
      }
      case 'scroll': // arrow keys in the TV panel — drive the feed by hand
        // only while the feed is actually showing: arrows on a pause screen or a
        // greeting have nothing to scroll
        if (sm.state === 'playing' && (msg.dir === 'up' || msg.dir === 'down')) {
          void chrome.step(msg.dir as 'up' | 'down');
        }
        break;
      case 'user-pause': // p pressed in the TV — same resident pause as a permission
        if (sm.state === 'idle') break;
        manualPause = true;
        sm.onEvent('snap-back', { reason: 'manual' });
        break;
      case 'user-resume': // r pressed in the TV
        manualPause = false;
        if (sm.state === 'paused') sm.resumeNow();
        break;
      case 'user-stop': // q pressed in the TV, or `rotpilot off`
        snoozed = true;
        manualPause = false;
        if (sm.state === 'idle') {
          // q on the greeting panel (never played): close it AND kill Chrome so
          // nothing lingers in the background
          void closeTvPanel();
          void chrome.teardown();
        } else {
          sm.onEvent('snap-back', { reason: 'user' });
        }
        break;
      case 'status':
        send(sock, {
          t: 'status',
          state: sm.state,
          owner: sm.owner ?? null,
          feed: loadConfig().feed,
          pid: process.pid,
          tv: !!tv,
          tvMode: gPanel ? (gPanel.claudeId ? 'ghostty-panel' : 'ghostty-window') : panel ? 'panel' : 'window',
          frameW,
          frameH,
          framesSent,
          captureFps:
            sm.state === 'playing' && playStartedAt
              ? Math.round((framesSent / Math.max(1, Date.now() - playStartedAt)) * 10000) / 10
              : 0,
        });
        break;
      case 'shutdown':
        send(sock, { t: 'ok' });
        void teardown();
        break;
    }
  });

  async function teardown(): Promise<void> {
    log('daemon teardown');
    try {
      await chrome.teardown();
    } catch {}
    try {
      if (tv && !tv.sock.destroyed) send(tv.sock, { t: 'clear' });
      if (gPanel) await ghosttyCloseTerminal(gPanel.tvId);
      gPanel = null;
      if (panel && kitty) await closeKittyPanel(kitty.kitten, panel.listenOn, panel);
      panel = null;
      tvProc?.kill();
    } catch {}
    try {
      server.close();
    } catch {}
    try {
      fs.unlinkSync(PID_PATH);
    } catch {}
    setTimeout(() => process.exit(0), 300);
  }

  process.on('SIGTERM', () => void teardown());
  process.on('SIGINT', () => void teardown());
  process.on('uncaughtException', (e) => log('uncaught', e));
  process.on('unhandledRejection', (e) => log('unhandled', e as Error));
}
