/**
 * One Chrome session: launch on demand, navigate feeds, start/stop the PNG
 * screencast, pause/resume <video>, and human-paced read-only scrolling.
 */
import CDP from 'chrome-remote-interface';
import { launchChrome, killStaleChrome, type ChromeProc } from './launch.js';
import { getFeed, type Feed } from '../feeds/index.js';
import { loadConfig } from '../config.js';
import { log } from '../log.js';

// The clip the user is actually watching = the <video> with the largest area
// inside the viewport. Feeds keep preloaded neighbor clips as extra (sometimes
// playing) video elements, so "first video" or "first playing video" is wrong.
const CURRENT_VIDEO_JS = `(() => {
  let best = null, bestA = 0;
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    const a = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) *
              Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    if (a > bestA) { bestA = a; best = v; }
  }
  return best;
})()`;

/**
 * The scroll-snap container a clip lives in: walk UP from the video until an
 * ancestor can actually scroll. Generic, so it works on any snap feed without
 * site-specific container selectors.
 *
 * Folded into FEED_PROBE_JS so the advance code resolves the container from the
 * SAME video watchOne is timing. They used to disagree — the watcher timed the
 * clip in view while the advance scrolled whatever container the first
 * `offsetWidth > 0` video happened to sit in.
 */
const SNAP_CONTAINER_FN_JS = `((v) => {
  let el = v ? v.parentElement : null;
  while (el && el.scrollHeight - el.clientHeight < 100) el = el.parentElement;
  return el;
})`;

/**
 * Page-side probe shared by the advance logic: which clip is showing, and when
 * the feed has stopped moving.
 *
 * `sig()` deliberately uses the SNAPPED INDEX (offset / viewport height), not the
 * raw scrollTop — a smooth scroll that gets pulled back to the same clip by
 * scroll-snap still moves scrollTop through dozens of intermediate values, so a
 * raw-offset comparison reports success for an advance that went nowhere.
 *
 * `quiet()` waits for the offset to hold still across consecutive samples. Every
 * check brackets itself with it, so momentum from the previous attempt can't be
 * misread as this one landing.
 */
export const FEED_PROBE_JS = `{
  container: ${SNAP_CONTAINER_FN_JS},
  cur() { return ${CURRENT_VIDEO_JS}; },
  src(v) { return (v && (v.currentSrc || v.src)) || ''; },
  top() { const c = this.container(this.cur()); return Math.round(c ? c.scrollTop : scrollY); },
  sig() {
    const c = this.container(this.cur());
    const h = (c ? c.clientHeight : innerHeight) || 1;
    return this.src(this.cur()) + '|' + Math.round(this.top() / h);
  },
  async quiet(ticks) {
    let last = NaN, stable = 0;
    for (let i = 0; i < ticks; i++) {
      await new Promise((r) => setTimeout(r, 80));
      const t = this.top();
      if (t === last) { if (++stable >= 2) return; } else { stable = 0; last = t; }
    }
  },
}`;

/**
 * Page-side watcher: resolves once the clip on screen has had its one
 * play-through. 'ended' for clips that finish, 'looped' for shorts/reels (which
 * loop rather than ever firing `ended`), 'changed' if the feed moved on without
 * us, 'timeout' as the structural clamp — a stalled video fires neither `ended`
 * nor a wrap, so without the clamp this would hang forever.
 */
function watchOneExpr(maxMs: number): string {
  return `(() => new Promise((res) => {
    const src = (v) => (v && (v.currentSrc || v.src)) || '';
    const first = ${CURRENT_VIDEO_JS};
    if (!first) return setTimeout(() => res('no-video'), 3000);
    const src0 = src(first);
    let last = first.currentTime;
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (Date.now() - t0 > ${Math.round(maxMs)}) { clearInterval(iv); return res('timeout'); }
      // Re-resolve every tick instead of holding the element we started with.
      // Feeds that swap the <video> node per clip (rather than reusing one
      // player) would otherwise leave us timing an element that has scrolled
      // away and will never end or wrap — a clip stuck for the whole max bound.
      const v = ${CURRENT_VIDEO_JS};
      if (!v) return; // transient, mid-swap
      if (src(v) !== src0) { clearInterval(iv); return res('changed'); }
      if (v.ended) { clearInterval(iv); return res('ended'); }
      const ct = v.currentTime;
      if (ct + 0.75 < last) { clearInterval(iv); return res('looped'); }
      last = Math.max(last, ct);
    }, 250);
  }))()`;
}

export class ChromeSession {
  private chrome: ChromeProc | null = null;
  private client: CDP.Client | null = null;
  private currentFeed: string | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private playGuardTimer: NodeJS.Timeout | null = null;
  /** bumping this cancels the current watch-advance loop */
  private scrollGen = 0;
  /** the daemon's frame sink; the screencast listener is re-attached to every
   * new CDP client in doEnsure, so this must survive teardown/relaunch cycles */
  private onFrame: ((png: Buffer) => void) | null = null;
  private ensuring: Promise<void> | null = null;
  // liveness is tracked via the CDP connection, NOT the launcher process: we
  // launch Chrome in the background with `open -g`, whose process exits
  // immediately, so its exitCode is useless.
  private chromeAlive = false;

  /** Serialized: the prompt-time prewarm and the play-time ensure must not race. */
  ensure(feedName: string): Promise<void> {
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.doEnsure(feedName).finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  private async doEnsure(feedName: string): Promise<void> {
    if (this.chrome && !this.chromeAlive) {
      // chrome died / was closed by the user (CDP connection dropped)
      this.chrome = null;
      this.client = null;
      this.currentFeed = null;
    }
    if (!this.chrome) {
      this.chrome = await launchChrome();
      await this.attach();
      log('chrome launched on port', this.chrome.port);
    }
    if (this.currentFeed !== feedName) {
      const feed = getFeed(feedName);
      try {
        await this.client!.Page.navigate({ url: feed.url() });
      } catch (e) {
        // the navigation usually went through even when the CDP command errors
        // (startup target swap) — play()'s reattach recovers the session
        log('navigate error (page swap?)', e as Error);
      }
      // no settle sleep: start capturing immediately and let the feed load
      // on-camera — a loading page for a beat beats seconds of frozen wait
      this.currentFeed = feedName;
    }
    try {
      await (this.client as any).send('Page.setWebLifecycleState', { state: 'active' });
    } catch {}
    // prewarm must be SILENT until play() (panel actually showing)
    this.startSilenceGuard();
  }

  /** Connect a CDP client to the running Chrome and do the full page setup. */
  private async attach(): Promise<void> {
    this.client = await CDP({ port: this.chrome!.port });
    this.chromeAlive = true;
    this.client.on('disconnect', () => {
      this.chromeAlive = false;
    });
    await this.client.Page.enable();
    await this.client.Runtime.enable();
    // the frame listener belongs to THIS client — a new client (fresh Chrome or
    // reattach) needs its own, or frames are emitted into the void
    {
      const c = this.client;
      c.Page.on('screencastFrame', async (ev) => {
        try {
          await c.Page.screencastFrameAck({ sessionId: ev.sessionId });
        } catch {}
        this.onFrame?.(Buffer.from(ev.data, 'base64'));
      });
    }
    // clean fingerprint: force navigator.webdriver undefined on every doc
    // (replaces the --disable-blink-features flag that caused the warning bar)
    try {
      await this.client.Page.addScriptToEvaluateOnNewDocument({
        source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});",
      });
    } catch {}
    // exact 9:16 portrait viewport no matter how the OS clamps the window
    await this.client.Emulation.setDeviceMetricsOverride({
      width: 480,
      height: 853,
      deviceScaleFactor: 0,
      mobile: false,
    });
    // Chrome runs HEADFUL (a real, findable window) but sized to the portrait
    // content and meant to sit BEHIND your terminal. setWindowBounds fixes the
    // wide black gutter the profile otherwise remembers. Two calls on purpose:
    // if the profile restored a maximized window, a combined state+bounds call
    // fails silently — restore 'normal' first, then size it.
    // NOTE: never minimize — a minimized window freezes the capture (0 frames);
    // and never move it off-screen — macOS throttles non-visible windows.
    try {
      const { windowId } = await this.client.Browser.getWindowForTarget();
      await this.client.Browser.setWindowBounds({ windowId, bounds: { windowState: 'normal' } });
      await this.client.Browser.setWindowBounds({
        windowId,
        bounds: { left: 80, top: 80, width: 500, height: 950 },
      });
    } catch {}
  }

  /**
   * Re-attach to the running Chrome after the page target swapped out from
   * under the session — a fresh Chrome replaces its startup about:blank tab
   * during the first navigation, killing page-level CDP sessions ("Not
   * attached to an active page").
   */
  private async reattach(): Promise<boolean> {
    try {
      await this.client?.close();
    } catch {}
    this.client = null;
    if (!this.chrome) return false;
    try {
      await this.attach();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Silence guard: audio is audible ONLY while the feed is actively showing in
   * the terminal. A one-shot v.pause() does not stick — YouTube's player
   * auto-resumes right past it — so while prewarmed/paused/hidden we re-mute +
   * re-pause every 400ms. play()/resume stop the guard and unmute.
   */
  private startSilenceGuard(): void {
    this.stopPlayGuard();
    if (this.silenceTimer) return;
    const enforce = () => void this.evalAllVideos('v.muted=true;v.pause()');
    enforce();
    this.silenceTimer = setInterval(enforce, 400);
    this.silenceTimer.unref?.();
  }

  private stopSilenceGuard(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /**
   * Play guard — the silence guard's mirror, active while the feed is showing.
   * Feeds re-assert their own state on every clip change: Instagram starts each
   * NEW reel's <video> muted, so a one-shot unmute at play() goes silent on the
   * next advance. Every second: SOLO the clip actually in view — unmute + play
   * it, mute + pause every other <video>. Feeds preload neighbor clips as extra
   * video elements; unmuting all of them plays two audio tracks at once.
   */
  private startPlayGuard(): void {
    this.stopSilenceGuard();
    if (this.playGuardTimer) return;
    const enforce = () =>
      void this.eval(`(() => {
        const cur = ${CURRENT_VIDEO_JS};
        for (const v of document.querySelectorAll('video')) {
          if (v === cur) { v.muted = false; v.volume = 1; if (v.paused) v.play().catch(() => {}); }
          else { v.muted = true; if (!v.paused) v.pause(); }
        }
      })()`);
    enforce();
    this.playGuardTimer = setInterval(enforce, 1000);
    this.playGuardTimer.unref?.();
  }

  private stopPlayGuard(): void {
    if (this.playGuardTimer) {
      clearInterval(this.playGuardTimer);
      this.playGuardTimer = null;
    }
  }

  private feed(): Feed {
    return getFeed(this.currentFeed ?? 'localLoop');
  }

  async play(maxWidth: number, maxHeight: number, fps: number, onFrame: (png: Buffer) => void): Promise<void> {
    this.startPlayGuard();
    this.onFrame = onFrame;
    const params = {
      format: 'png' as const,
      maxWidth: Math.min(maxWidth || 900, 1280),
      maxHeight: Math.min(maxHeight || 1280, 1280),
      everyNthFrame: fps >= 30 ? 1 : 2, // video pages composite ~30fps; TV throttles the rest
    };
    try {
      await this.client!.Page.startScreencast(params);
    } catch (e) {
      log('startScreencast failed (page swap?), reattaching', e as Error);
      if (!(await this.reattach())) throw e;
      await this.client!.Page.startScreencast(params);
    }
    this.startScrolling();
  }

  /**
   * Soft pause: stop advancing reels and silence the feed (guard, not one-shot —
   * YouTube auto-resumes past a plain pause), but KEEP the screencast pipeline
   * alive so resuming is still a fast unmute+play, no CDP restart. Used for
   * resident (permission/done) pauses.
   */
  softPause(): void {
    this.stopScrolling();
    void this.silence();
  }

  /**
   * Mute + pause every video, resolving once the mute has actually LANDED in the
   * page (the guard's own enforce is fire-and-forget). The snap-back cue is
   * played after this resolves: a reel at full volume masks a short wav, which is
   * why the sound only ever seemed to fire when nothing was playing.
   */
  async silence(): Promise<void> {
    this.stopPlayGuard();
    await this.evalAllVideos('v.muted=true;v.pause()');
    this.startSilenceGuard();
  }

  /** Resume from a soft pause: unmute, replay, start advancing reels again. */
  resumeScroll(): void {
    this.startPlayGuard();
    this.startScrolling();
  }

  /** Full pause: tear the screencast down (used for deep idle / teardown). */
  async pause(): Promise<void> {
    this.stopScrolling();
    this.startSilenceGuard();
    if (this.client) {
      try {
        await this.client.Page.stopScreencast();
      } catch (e) {
        log('pause error', e as Error);
      }
    }
  }

  private async eval(expression: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.Runtime.evaluate({ expression, returnByValue: true });
    } catch {}
  }

  private async evalAllVideos(stmt: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.Runtime.evaluate({
        expression: `document.querySelectorAll('video').forEach(v=>{${stmt}})`,
        returnByValue: true,
      });
    } catch {}
  }

  /**
   * Watch-then-advance loop. The advance is driven by the VIDEO, not a blind
   * timer: watchOne() resolves when the current clip has played through once
   * (loop-wrap or `ended`), and watchBoundsMs clamps it — a clip shorter than
   * min gets held to min, one longer than max gets cut at max. Read-only:
   * advancing scrolls/clicks Next, never likes/follows/comments.
   */
  private startScrolling(): void {
    const gen = ++this.scrollGen;
    const [minMs, maxMs] = loadConfig().watchBoundsMs;
    const alive = () => gen === this.scrollGen && !!this.client && this.chromeAlive;
    const loop = async () => {
      while (alive()) {
        const started = Date.now();
        const why = await this.watchOne(Math.max(2000, maxMs));
        if (!alive()) return;
        // the feed already moved on without us — someone scrolled by hand, or
        // the page auto-advanced. Don't advance again on top of that; just start
        // watching whatever is on screen now, from the top.
        if (why === 'changed') continue;
        const remain = Math.max(1000, minMs) - (Date.now() - started);
        if (remain > 0) await new Promise((r) => setTimeout(r, remain));
        if (!alive()) return;
        try {
          const how = await this.feed().next(this.client!);
          log(`advance (${why}) -> ${how ?? 'ok'}`);
        } catch (e) {
          log('advance error', e as Error);
        }
        await new Promise((r) => setTimeout(r, 600)); // let the new clip start
      }
    };
    void loop();
  }

  private stopScrolling(): void {
    this.scrollGen++; // cancels the loop at its next liveness check
  }

  /**
   * Resolve when the visible video has completed one play-through: 'ended' for
   * non-looping clips, a currentTime wrap for looping ones (shorts/reels loop
   * instead of ending). 'timeout' caps clips longer than maxMs; 'no-video'
   * degrades to the timer behavior.
   */
  private async watchOne(maxMs: number): Promise<string> {
    if (!this.client) return 'no-client';
    try {
      const r = await this.client.Runtime.evaluate({
        expression: watchOneExpr(maxMs),
        awaitPromise: true,
        returnByValue: true,
      });
      return ((r as any)?.result?.value as string) ?? 'eval-failed';
    } catch {
      return 'eval-failed';
    }
  }

  /**
   * Manual scroll, driven by the arrow keys in the TV panel. Restarts the watch
   * loop so the clip you just landed on gets a full play-through before the
   * automatic advance takes over again.
   */
  async step(dir: 'up' | 'down'): Promise<string> {
    if (!this.client) return 'no-client';
    const feed = this.feed();
    let how = 'noop';
    try {
      how = (dir === 'down' ? await feed.next(this.client) : await feed.prev?.(this.client)) ?? 'noop';
    } catch (e) {
      log('manual step error', e as Error);
      how = 'error';
    }
    this.startScrolling(); // bumps the generation: old loop dies, dwell restarts
    log(`manual ${dir} -> ${how}`);
    return how;
  }

  async teardown(): Promise<void> {
    this.stopScrolling();
    this.stopSilenceGuard();
    this.stopPlayGuard();
    this.onFrame = null;
    try {
      await this.client?.close();
    } catch {}
    try {
      this.chrome?.proc.kill();
    } catch {}
    await killStaleChrome(); // belt and braces: nothing may keep holding our profile
    this.client = null;
    this.chrome = null;
    this.currentFeed = null;
  }
}

/** Dispatch a key press (used by feeds to advance to the next short/reel). */
export async function pressKey(client: CDP.Client, key: 'ArrowDown' | 'ArrowUp'): Promise<void> {
  const vk = key === 'ArrowDown' ? 40 : 38;
  const info = { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', ...info });
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 80));
  await client.Input.dispatchKeyEvent({ type: 'keyUp', ...info });
}
