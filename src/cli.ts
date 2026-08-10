/**
 * rotpilot CLI. The `hook` / `_daemon` / `_tv` paths bypass commander so the
 * hook client stays as fast as possible.
 */
export {};
import type { CardSection } from './ui.js'; // type-only: erased at runtime, keeps the fast path lean

/**
 * Module-level data MUST be declared above the dispatch below.
 *
 * `await mainCli()` is top-level await: it suspends the rest of this module
 * body until it resolves. Anything declared after it is therefore still
 * unassigned while a command runs — and because the bundler emits these as
 * `var`, they read as `undefined` instead of throwing. That made it a timing
 * bug rather than a crash: a slow async command (`init`) yields long enough
 * for the module body to resume and assign them, so it looked fine, while a
 * synchronous one (`window panel`) completed first and silently rendered
 * nothing. Keep declarations here and it cannot happen.
 */

/** The kitty setup as a command you can paste, not two lines to go and find a
 * file for. `grep -q` guards it, so pasting twice cannot duplicate the keys,
 * and `>>` creates the file if kitty has never written one. */
const KITTY_SETUP_CMD =
  "grep -q '^listen_on' ~/.config/kitty/kitty.conf 2>/dev/null || " +
  "printf 'allow_remote_control socket-only\\nlisten_on unix:/tmp/kitty\\n' >> ~/.config/kitty/kitty.conf";

/** name → what you're signing up for. Shown by `init`, in feed order of harm. */
const FEED_BLURBS: Array<[string, string]> = [
  ['localLoop', 'the default — one local video on loop, no network'],
  ['shorts', 'youtube shorts'],
  ['instagram', 'reels — opt-in, at your own risk'],
];

const fast = process.argv[2];

if (fast === 'hook') {
  const { runHook } = await import('./hooks/map.js');
  await runHook(process.argv[3] ?? '');
} else if (fast === '_daemon') {
  const { runDaemon } = await import('./daemon/daemon.js');
  await runDaemon();
} else if (fast === '_tv') {
  const { runTv } = await import('./render/tv.js');
  const fpsFlag = process.argv.find((a) => a.startsWith('--fps='));
  await runTv(process.argv.includes('--test'), fpsFlag ? Number(fpsFlag.split('=')[1]) : undefined);
} else {
  await mainCli();
}

async function mainCli(): Promise<void> {
  const { Command } = await import('commander');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const { request, fireAndForget } = await import('./daemon/ipc.js');
  const { loadConfig, saveConfig, PID_PATH, SOCKET_PATH, CONFIG_PATH } = await import('./config.js');
  const ui = await import('./ui.js'); // shared CLI styling (see src/ui.ts)

  /**
   * The one renderer for every synthesized report. The model's output is parsed
   * into {headline, items} by `parseSynth` before it gets here, so this does no
   * guessing — previously this function carried regexes for heading case, bold
   * markers and three bullet glyphs, and each command applied them slightly
   * differently.
   */
  const renderSynth = (s: import('./memory/summarize.js').Synth): string[] => {
    const out: string[] = [];
    if (s.headline) out.push(ui.wrapText(s.headline, '  ', 68));
    if (s.headline && s.items.length) out.push('');
    // continuations hang under the text, not the glyph, so a wrapped item reads
    // as one thing
    for (const it of s.items) out.push(`  ${ui.dim('·')} ${ui.wrapText(it, '    ', 66).trimStart()}`);
    return out;
  };

  /** `--raw`: dump the exact prompt sent to Haiku — plain and copy-pasteable. */
  const printRaw = async (prompt: string, kind: string, n: number): Promise<void> => {
    const { MODEL, summarizerAvailable } = await import('./memory/summarize.js');
    console.log('');
    console.log(
      ui.dim(
        `── raw · ${kind} · model ${MODEL} · ${n} unit${n === 1 ? '' : 's'} · summarizer ${summarizerAvailable() ? 'available' : 'unavailable'} ──`,
      ),
    );
    console.log('');
    console.log(prompt);
    console.log('');
  };

  const cliPath = path.resolve(process.argv[1]);

  async function daemonAlive(): Promise<boolean> {
    return (await request({ t: 'status' }, 700)) !== null;
  }

  async function startDaemon(): Promise<boolean> {
    if (await daemonAlive()) return true;
    const child = spawn(process.execPath, [cliPath, '_daemon'], { detached: true, stdio: 'ignore' });
    child.unref();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await daemonAlive()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  async function stopDaemon(): Promise<void> {
    await request({ t: 'shutdown' }, 2000);
    // fallback: kill by pid file
    try {
      const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8'), 10);
      if (pid > 0) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
    } catch {}
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {}
    try {
      fs.unlinkSync(PID_PATH);
    } catch {}
    // Sweep daemons the pid file never knew about. A pre-0.2.0 race let a second
    // daemon clobber the pid file and orphan the first, which then survived every
    // `stop` — still holding a Chrome and fighting the live daemon for the
    // profile. The race is fixed, but installs that already have orphans need
    // this to ever get clean again.
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve) => {
      execFile('pgrep', ['-f', 'cli.js _daemon'], (_e: unknown, out: string) => {
        for (const line of (out ?? '').split('\n')) {
          const pid = Number(line.trim());
          if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        }
        resolve();
      });
    });
    // belt and braces: no orphaned chrome (it would swallow future launches as tabs)
    const { killStaleChrome } = await import('./chrome/launch.js');
    await killStaleChrome();
  }

  let version = '0.0.0';
  try {
    // resolve the npm bin symlink, then dist/cli.js → ../package.json
    // (single source of truth for the version)
    const real = fs.realpathSync(cliPath);
    version = JSON.parse(fs.readFileSync(path.resolve(path.dirname(real), '../package.json'), 'utf8')).version;
  } catch {}

  const program = new Command();
  program
    .name('rotpilot')
    .description('claude code feeds you brainrot while it works — and yanks it away the second it needs you')
    .version(version);

  program
    .command('init')
    .description('install rotpilot into claude code (hooks + checks)')
    // no --uninstall flag: it did exactly what `rotpilot off` does, one more
    // way to spell the same thing
    .action(async () => {
      const { installHooks, uninstallGlobalHooks } = await import('./hooks/install.js');
      const { findKitty } = await import('./render/terminal.js');
      const { findChrome } = await import('./chrome/launch.js');
      ui.masthead('claude feeds you brainrot while it works — and yanks it away when it needs you');
      console.log('');
      // one-time: scrub any legacy global hooks from older versions
      if (uninstallGlobalHooks()) console.log(ui.ok('removed a legacy global install from ~/.claude/settings.json'));
      const kitty = findKitty();
      const { findGhostty } = await import('./render/terminal.js');
      const ghostty = findGhostty();
      if (kitty) console.log(ui.ok(`kitty found (${kitty.kitty})`));
      if (ghostty) console.log(ui.ok('ghostty found (panel via AppleScript, Ghostty ≥1.3)'));
      if (!kitty && !ghostty)
        console.log(ui.no('no supported terminal — install kitty (sw.kovidgoyal.net/kitty) or Ghostty ≥1.3 (ghostty.org)'));
      const chrome = findChrome();
      console.log(chrome ? ui.ok('google chrome found') : ui.no('google chrome not found — install it; rotpilot uses it as the video engine'));
      const cfg = loadConfig();
      if (!cfg.engram.userId) cfg.engram.userId = `rotpilot-${(await import('node:crypto')).randomUUID()}`;
      saveConfig(cfg);
      console.log(ui.ok(`config written to ${CONFIG_PATH} (feed: ${cfg.feed})`));
      // The loop video is NOT fetched here. init should not silently pull 20MB
      // off youtube on your behalf — it is a third-party download, it can take a
      // while, and it can fail in ways that have nothing to do with rotpilot.
      // localLoop works without it (built-in animation), so this is an offer.
      if (cfg.feed === 'localLoop') {
        const { loopReady } = await import('./feeds/download.js');
        if (loopReady()) console.log(ui.ok('brainrot loop ready'));
        else console.log(ui.note('localLoop plays a built-in animation · `rotpilot loop` fetches the real subway-surfers clip (~20MB)'));
      }
      installHooks(process.cwd());
      console.log(ui.ok(`rotpilot ON for ${process.cwd()}`));
      console.log(ui.note('hooks in ./.claude/settings.local.json — this project only, never global'));
      const inTerm = process.env.KITTY_LISTEN_ON || process.env.TERM_PROGRAM === 'ghostty';
      if (!inTerm) {
        console.log('');
        console.log(ui.warn('not a supported terminal — nothing will play here.'));
        console.log(ui.bullet('rotpilot is terminal-only (for now)'));
        console.log(ui.bullet('ghostty ≥1.3 — works out of the box'));
        console.log(ui.bullet('kitty — needs remote control on, then a restart:'));
        console.log(ui.tip('paste this —', KITTY_SETUP_CMD));
      }
      console.log('');
      console.log(ui.heading('next steps'));
      console.log('');
      console.log(ui.step(1, 'RESTART any running claude sessions (hooks load at session start)'));
      console.log(ui.step(2, 'run claude in kitty or ghostty, in this project, on something chunky'));
      console.log(ui.step(3, 'rot — it yanks the feed away when claude needs you'));
      console.log(ui.step(4, `${ui.bold('rotpilot stats')} — see the damage`));
      console.log('');
      console.log(ui.tip('in the tv —', '↑↓ scroll · p pause · r resume · q quit'));
      console.log(ui.tip('enable in other projects —', 'rotpilot on'));
      console.log(ui.tip('escape hatches —', 'rotpilot off · rotpilot stop'));
      console.log('');
      console.log(ui.heading('feeds'));
      console.log('');
      for (const [name, what] of FEED_BLURBS) {
        // pad BEFORE coloring so the escapes never skew the column
        console.log(ui.bullet(`${ui.bold(name.padEnd(11))}${ui.dim(what)}`));
      }
      console.log('');
      console.log(ui.tip('switch anytime —', 'rotpilot feed <name>'));
    });

  program
    .command('start')
    .description('start the rotpilot daemon')
    .action(async () => {
      console.log((await startDaemon()) ? ui.ok('rotpilot daemon running') : ui.no('daemon failed to start (see ~/.config/rotpilot/daemon.log)'));
    });

  program
    .command('stop')
    .description('stop the daemon, chrome, and the tv window')
    .action(async () => {
      await stopDaemon();
      console.log(ui.ok('rotpilot stopped'));
    });

  program
    .command('status')
    .description('show daemon status')
    .action(async () => {
      const s = await request({ t: 'status' }, 700);
      const { hooksInstalled } = await import('./hooks/install.js');
      const dir = process.cwd();
      const on = hooksInstalled(dir);
      const lines: string[] = [];
      const row = (k: string, v: string) => lines.push(`  ${ui.dim(k.padEnd(9))} ${v}`);
      row('rotpilot', on ? ui.green('ON for this project') : ui.dim('off here (`rotpilot on` to enable)'));
      const termName = process.env.KITTY_LISTEN_ON
        ? ui.green('kitty (remote control ✓)')
        : process.env.TERM_PROGRAM === 'ghostty'
          ? ui.green('ghostty ✓')
          : ui.yellow('unsupported — needs kitty or ghostty');
      row('terminal', termName);
      if (!s) {
        row('daemon', ui.dim('not running'));
      } else {
        row('daemon', `running ${ui.dim(`(pid ${s.pid})`)}`);
        row('state', String(s.state));
        row('feed', String(s.feed));
        row('tv', s.tv ? `connected ${ui.dim(`(${s.tvMode})`)}` : ui.dim('not open'));
        if (s.state === 'playing') {
          row('frames', `${s.framesSent} sent ${ui.dim(`(${s.captureFps} fps)`)}`);
          if (s.frameW) row('video', `${s.frameW}x${s.frameH} ${ui.dim(`(${((s.frameW as number) / (s.frameH as number)).toFixed(3)} aspect)`)}`);
        }
      }
      console.log('');
      console.log(ui.card(`status · ${path.basename(dir)}`, [{ body: lines }]));
      console.log('');
    });

  program
    .command('stats')
    .description('your rot report (screenshot it, you coward)')
    .action(async () => {
      const { printStats } = await import('./memory/stats.js');
      await printStats();
    });

  program
    .command('engram [action] [value]')
    .description('optional Engram memory: setup guide · `key` = save API key · `id` = show/restore your memory scope · `transcripts on|off` = opt in · `check` = live test')
    .action(async (action?: string, value?: string) => {
      const {
        TOPIC_DESIGN,
        engramEnabled,
        sendCheckConversation,
        runStatus,
        listMemories,
        searchMemories,
        saveApiKey,
        clearApiKey,
        lastEngramError,
      } = await import('./memory/engram.js');

      if (action === 'key') {
        if (value === 'clear') {
          console.log(clearApiKey() ? ui.ok('stored key removed') : ui.note('no stored key to remove'));
          return;
        }
        let key = value;
        if (!key) {
          // hidden prompt: the key never lands in shell history or on screen
          key = await new Promise<string>((resolve) => {
            // hidden prompt on a TTY (per-keystroke, nothing echoed); piped
            // stdin (`pbpaste | rotpilot engram key`) arrives as lines + EOF
            process.stdout.write('paste your Engram API key (input hidden): ');
            const stdin = process.stdin;
            let buf = '';
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              stdin.setRawMode?.(false);
              stdin.pause();
              process.stdout.write('\n');
              resolve(buf.trim());
            };
            stdin.setRawMode?.(true);
            stdin.resume();
            stdin.setEncoding('utf8');
            stdin.on('data', (ch: string) => {
              if (ch === '\u0003' || ch === '\u0004') {
                process.stdout.write('\n');
                process.exit(1);
              } else if (ch === '\u007f') {
                buf = buf.slice(0, -1);
              } else if (/[\r\n]/.test(ch)) {
                buf += ch.split(/[\r\n]/)[0];
                finish();
              } else {
                buf += ch;
              }
            });
            stdin.on('end', finish);
          });
        }
        if (!key) {
          console.log(ui.no('no key given'));
          process.exitCode = 1;
          return;
        }
        saveApiKey(key);
        console.log(ui.ok('key saved to ~/.config/rotpilot/engram.key (mode 600, survives any shell)'));
        console.log(ui.tip('verify the pipe —', 'rotpilot engram check'));
        return;
      }

      // Your memories are scoped to this id. It is generated locally on first
      // run and lives only in config.json — so a reinstall (or a new machine)
      // mints a fresh one and every existing memory becomes unreachable. The
      // API key you can re-copy from the console; this you cannot. Hence a way
      // to read it BEFORE you need it, and to set it back after.
      if (action === 'id') {
        const cfg = loadConfig();
        if (!value) {
          console.log('');
          console.log(ui.card('engram · your memory id', [
            {
              body: [
                `  ${ui.bold(cfg.engram.userId)}`,
                '',
                ui.dim('  every memory you have is filed under this. it exists only in'),
                ui.dim('  ~/.config/rotpilot/config.json — save it somewhere you keep things.'),
              ],
            },
          ]));
          console.log('');
          console.log(ui.tip('on a new machine, or after a reinstall —', 'rotpilot engram id <that-value>'));
          console.log('');
          return;
        }
        const prev = cfg.engram.userId;
        cfg.engram.userId = value.trim();
        saveConfig(cfg);
        console.log(ui.ok(`memory id set to ${cfg.engram.userId}`));
        console.log(ui.note(`was ${prev} — anything filed under that is now out of scope`));
        console.log(ui.tip('confirm your history is back —', 'rotpilot recap --plain'));
        return;
      }

      if (action === 'transcripts') {
        if (value !== 'on' && value !== 'off') {
          console.log(ui.no('usage: rotpilot engram transcripts on|off'));
          process.exitCode = 1;
          return;
        }
        const cfg = loadConfig();
        cfg.engram.shareTranscripts = value === 'on';
        saveConfig(cfg);
        if (value === 'on') {
          console.log(ui.ok('transcript sharing ON — the "what you missed" memory is live.'));
          console.log('');
          console.log(ui.heading('what this means, plainly'));
          console.log('');
          console.log(ui.bullet('when a rot window ends, the segment of the CLAUDE SESSION TRANSCRIPT that'));
          console.log('    streamed by while you watched (your prompts, claude\'s messages and tool');
          console.log('    calls — which can include code) is sent to YOUR Engram project');
          console.log(ui.bullet('engram splits it into what claude DID and what still NEEDS YOU'));
          console.log(ui.bullet('nothing is shared with rotpilot or anyone else — your project, your key'));
          console.log('');
          console.log(ui.tip('read it back —', 'rotpilot recap'));
          console.log(ui.tip('turn it off any time —', 'rotpilot engram transcripts off'));
        } else {
          console.log(ui.ok('transcript sharing OFF — no session content leaves this machine.'));
          console.log(ui.note('local recap, stats & budget still work; `recap --all` will go stale'));
        }
        return;
      }

      if (action !== 'check') {
        console.log('');
        console.log(ui.heading('engram — optional memory for cross-session recap'));
        console.log('');
        console.log(
          ui.wrapText(
"`rotpilot recap` already works locally for the current session, no setup. Engram is optional: connect it and each rot window's transcript slice is stored — split into what claude DID and what still NEEDS YOU — so recap can reach back across past sessions and other projects with `--all` or a question. Off unless you set it up here.",
          ),
        );
        console.log('');
        console.log(ui.step(1, 'create an Engram project at https://console.weaviate.cloud'));
        console.log(ui.dim('       the topic SET is fixed at creation — define exactly TWO in the'));
        console.log(ui.dim('       default group, both "User + property scoped" (property: project),'));
        console.log(ui.dim('       both UNBOUNDED:'));
        console.log('');
        for (const t of TOPIC_DESIGN) {
          console.log(`       ${ui.brand(t.name)}  ${ui.dim(`— powers ${t.powers}`)}`);
          console.log(ui.wrapText(t.description, '         ', 64));
        }
        console.log('');
        // BOTH is not a style preference. The topic set cannot be changed after
        // the project is created, so someone who defines one is stuck without
        // the other for good — and each one is a different half of recap.
        console.log(ui.dim('       BOTH are required, and you cannot add the second later.'));
        console.log(ui.dim('       (the descriptions are the extraction prompts — editable later)'));
        console.log('');
        console.log(ui.step(2, 'save an API key (created in the console, shown once):'));
        console.log(`       ${ui.bold('rotpilot engram key')}   ${ui.dim('# hidden prompt, 0600 · or ENGRAM_API_KEY env var')}`);
        console.log('');
        console.log(ui.step(3, 'opt in to the transcript memory (session content leaves the machine):'));
        console.log(`       ${ui.bold('rotpilot engram transcripts on')}`);
        console.log('');
        console.log(ui.step(4, 'verify the pipe end-to-end:'));
        console.log(`       ${ui.bold('rotpilot engram check')}`);
        console.log('');
        const cfgNow = loadConfig();
        console.log(
          `  ${ui.dim('status:')}  key ${engramEnabled() ? ui.ok('saved') : ui.no('missing')}   transcripts ${cfgNow.engram.shareTranscripts ? ui.ok('on') : ui.no('off')}`,
        );
        return;
      }

      // ── live end-to-end check ──
      // the test conversation is scoped to the fake project "rotpilot-check",
      // so whatever extraction makes of it never appears in a real recap
      if (!engramEnabled()) {
        console.log(ui.no('no API key. run `rotpilot engram` for setup.'));
        process.exitCode = 1;
        return;
      }
      console.log(ui.step(1, 'auth + read — listing memories…'));
      const list = await listMemories({ limit: 5 });
      if (!list) {
        console.log(ui.no('list failed — bad key or unreachable project.'));
        if (lastEngramError()) console.log(`  engram said: ${lastEngramError()}`);
        process.exitCode = 1;
        return;
      }
      const topics = [...new Set(list.memories.map((m) => m.topic).filter(Boolean))];
      console.log('    ' + ui.ok(`authenticated${topics.length ? ` — topics seen: ${topics.join(', ')}` : ' (no memories under this id yet)'}`));
      // A valid key with zero memories is ambiguous: genuinely new, or the right
      // key against the wrong scope after a reinstall. Say which id we looked
      // under, so "engram is broken" and "wrong id" stop looking identical.
      if (!topics.length)
        console.log(
          '    ' + ui.note(`looked under ${loadConfig().engram.userId} — if you had memories before, restore it: rotpilot engram id <old-id>`),
        );

      console.log(ui.step(2, 'write — a synthetic marked conversation (scope: rotpilot-check)…'));
      const conv = await sendCheckConversation();
      if (!conv) {
        console.log(ui.no('conversation input rejected.'));
        if (lastEngramError()) console.log(`  engram said: ${lastEngramError()}`);
        console.log('  fix: the topics/scopes must match `rotpilot engram` exactly — both topics need');
        console.log('  the "User + property scoped" setting with the property literally named "project".');
        console.log('  topics are fixed at creation, so a mismatch means recreating the project.');
        process.exitCode = 1;
        return;
      }
      console.log('    ' + ui.ok(`accepted (run ${conv.run_id})`));
      let status = conv.status;
      for (let i = 0; i < 5 && !['completed', 'failed'].includes(status); i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const run = await runStatus(conv.run_id);
        if (!run) break;
        status = run.status;
        if (run.error) console.log(`    pipeline error: ${run.error}`);
      }
      console.log(
        status === 'completed'
          ? '    ' + ui.ok('extraction run completed')
          : status === 'failed'
            ? '    ' + ui.no('run FAILED — check the topics/scopes against `rotpilot engram`')
            : '    ' + ui.note(`run status: ${status} — queued; extraction lands when the pipeline catches up (minutes is normal)`),
      );

      console.log(ui.step(3, 'search…'));
      const search = await searchMemories('what did claude do recently?', { limit: 3 });
      if (search?.memories?.length) {
        console.log('    ' + ui.ok(`search works — ${search.memories.length} hit(s). first: "${search.memories[0].content.slice(0, 70)}…"`));
      } else {
        console.log('    ' + ui.note('search returned nothing yet (fresh project). rot a little, then: rotpilot recap'));
      }
      console.log('');
      const on = loadConfig().engram.shareTranscripts;
      console.log(`engram is wired. transcripts are ${on ? 'ON — rot windows feed it' : 'OFF — nothing ships until `rotpilot engram transcripts on`'};`);
      console.log('`rotpilot recap` reads it back.');
    });

  program
    .command('budget [amount]')
    .description('set a rot ration stats holds you to — `budget 10m` (daily) · `budget 1h --weekly` · `budget off`')
    .option('--daily', 'a daily budget (default)')
    .option('--weekly', 'a weekly budget instead of daily')
    .action(async (amount: string | undefined, opts: { daily?: boolean; weekly?: boolean }) => {
      const { parseDuration, humanDuration } = await import('./memory/budget.js');
      const cfg = loadConfig();
      // no amount → show the current ration
      if (!amount) {
        if (cfg.budget) {
          console.log(ui.ok(`rot budget: ${ui.bold(`${humanDuration(cfg.budget.limitSec)} per ${cfg.budget.period}`)}`));
          console.log(ui.tip('watch it burn —', 'rotpilot stats'));
        } else {
          console.log(ui.no('no rot budget set.'));
          console.log(ui.tip('set one —', 'rotpilot budget 10m'));
        }
        return;
      }
      if (['off', 'none', 'clear'].includes(amount.toLowerCase())) {
        if (!cfg.budget) {
          console.log(ui.note('no budget was set.'));
          return;
        }
        delete cfg.budget;
        saveConfig(cfg);
        console.log(ui.ok('rot budget cleared. rot freely, you animal.'));
        return;
      }
      if (opts.daily && opts.weekly) {
        console.log(ui.no('pick one: --daily or --weekly, not both.'));
        process.exitCode = 1;
        return;
      }
      const sec = parseDuration(amount);
      if (sec == null) {
        console.log(ui.no('bad amount. try `rotpilot budget 10m` or `rotpilot budget 1h --weekly`.'));
        process.exitCode = 1;
        return;
      }
      const period: 'day' | 'week' = opts.weekly ? 'week' : 'day';
      cfg.budget = { limitSec: sec, period, since: new Date().toISOString() };
      saveConfig(cfg);
      console.log(ui.ok(`rot budget: ${ui.bold(`${humanDuration(sec)} per ${period}`)}`));
      console.log(ui.note('rotpilot rations you and rats you out in stats the moment you blow it'));
      console.log(ui.tip('watch it burn —', 'rotpilot stats'));
    });

  program
    .command('recap [question...]')
    .description('what you missed while you rotted — this session, plus everything still waiting on you ("question": ask across every repo)')
    .option('--all', 'widen the first half to this repo across every past session, not just this one (engram)')
    .option('--days <n>', 'how far back "still on you" reaches', '14')
    .option('--plain', 'skip the write-ups and just list what happened (instant)')
    .option('--raw', 'print the exact prompts sent to haiku (no synthesis) — for debugging')
    .action(async (words: string[], opts: { raw?: boolean; all?: boolean; days?: string; plain?: boolean }) => {
      const { engramEnabled, getRecap, searchRecap, looseEnds } = await import('./memory/engram.js');
      const {
        summarizerAvailable,
        funRecap,
        funAnswer,
        funLocalRecap,
        funLoose,
        recapPrompt,
        answerPrompt,
        localRecapPrompt,
        loosePrompt,
        ageLabel,
        noSynth,
      } = await import('./memory/summarize.js');
      const { rotContext } = await import('./memory/store.js');
      const cfg = loadConfig();
      const ctx = rotContext();
      const project = path.basename(process.cwd());
      const days = Math.max(1, parseInt(opts.days ?? '14', 10) || 14);
      const synthOn = !opts.plain && !opts.raw && summarizerAvailable();
      // fallback (no claude / offline): strip the repeated "On <date>, Claude "
      // lead-in so the raw list at least reads cleanly
      const clean = (s: string) =>
        s.replace(/^On\s+\w+\s+\d{1,2}\s+\w+\s+\d{4},?\s*/i, '').replace(/^Claude\s+/, '');
      // the two cross-session modes (--all, "question") need the optional Engram
      // memory; say so plainly instead of erroring, so local recap still stands
      // on its own and Engram reads as optional, not a paywall
      const needsEngram = (what: string) => {
        console.log('');
        console.log(
          ui.card('recap · needs engram', [
            {
              body: [
                ui.dim(`  ${what}`),
                ui.dim('  reads across sessions, which uses engram — an optional memory you connect yourself.'),
                ui.dim('  this session already works locally: just run `rotpilot recap`.'),
              ],
            },
          ]),
        );
        console.log('');
        console.log(ui.tip('optional, if you want it —', 'rotpilot engram'));
        console.log('');
      };

      // ── question mode: semantic Q&A across ALL projects (engram only) ──
      if (words.length) {
        const q = words.join(' ');
        if (!engramEnabled()) return needsEngram(`asking "${q}" across every repo you've rotted through`);
        const stop = ui.spinner(`catching you up on "${q}"…`);
        const r = await searchRecap(q);
        const { synth } = synthOn && r?.memories?.length ? await funAnswer(q, r.memories, ctx) : noSynth;
        stop();
        if (!r?.memories?.length) {
          console.log('');
          console.log(
            ui.card(`recap · "${q}"`, [{ body: [ui.dim('  engram has nothing on that (yet). rot more, ask again.')] }]),
          );
          console.log('');
          return;
        }
        if (opts.raw) return printRaw(answerPrompt(q, r.memories, ctx), 'answer', r.memories.length);
        const bodyLines = synth
          ? renderSynth(synth)
          : r.memories.map((m) => ui.wrapText('• ' + clean(m.content), '  ', 68));
        console.log('');
        console.log(ui.card(`while you were rotting · "${q}"`, [{ body: bodyLines }]));
        console.log('');
        return;
      }

      /**
       * One half of the card. `notes` print under it, dim — scope lines and the
       * reason a write-up is missing.
       */
      interface Half {
        heading: string;
        body: string[];
        notes: string[];
        /** `--raw`: the exact prompt, its kind, and how many units went in */
        raw?: [string, string, number];
      }
      const asList = (mems: Array<{ content: string }>): string[] =>
        mems.map((m) => ui.wrapText('• ' + clean(m.content), '  ', 68));
      const dimLines = (s: string): string[] => s.split('\n').map((l) => ui.dim('  ' + l));

      /**
       * §1 — what Claude actually did. This session by default (local, no key,
       * no network); with `--all`, this repo across every session Engram
       * remembers. DONE work only — what's still owed is §2, and having both
       * halves report it printed the same item twice.
       */
      const buildHappened = async (): Promise<Half> => {
        // `--all` without Engram falls back to the local session rather than
        // printing a second "connect engram" pitch under §2's — one upsell per
        // screen, and the fallback is more useful than an apology.
        if (opts.all && engramEnabled()) {
          const heading = 'all sessions';
          const got = await getRecap(project);
          if (!got) return { heading, body: dimLines('engram unreachable — try `rotpilot engram check`.'), notes: [] };
          const { work } = got;
          // Engram truncates oldest-first with no way to page past it, so a full
          // page means the RECENT work is what's missing — the opposite of what
          // this half is for. Say so rather than present stale work as current.
          const capNote = got.capped
            ? ['engram returned a full page for this repo — it has no pagination, so the most recent work may be missing']
            : [];
          if (!work.length)
            return {
              heading,
              body: dimLines(
                cfg.engram.shareTranscripts
                  ? `nothing on record for ${project} yet.\nrot a little; extraction runs async (queue can lag a few minutes).`
                  : `nothing on record for ${project} yet.\nthe transcript memory is OFF — turn it on with:\nrotpilot engram transcripts on`,
              ),
              notes: [],
            };
          const { synth, note } = synthOn ? await funRecap(project, work, ctx) : noSynth;
          return {
            heading,
            body: synth ? renderSynth(synth) : asList(work),
            notes: [...capNote, ...(note ? [note] : [])],
            raw: [recapPrompt(project, work, ctx), 'recap', work.length],
          };
        }
        const heading = 'this session';
        const skipped = opts.all ? ['--all needs engram — showing this session instead'] : [];
        const { localWindow } = await import('./memory/local.js');
        const messages = localWindow(process.cwd(), 0);
        const claudeDid = messages.filter((m) => m.role === 'assistant' && (m.content || m.tool_calls?.length));
        if (!claudeDid.length)
          return {
            heading,
            body: dimLines(
              messages.length
                ? 'quiet session — claude did nothing worth catching up on.'
                : "couldn't find this session's transcript. run recap from the repo you're rotting in.",
            ),
            notes: skipped,
          };
        const { synth, note } = synthOn ? await funLocalRecap(project, messages, ctx) : noSynth;
        const body: string[] = [];
        if (synth) body.push(...renderSynth(synth));
        else {
          // Exactly what the synthesizer was handed, so a failure shows you the
          // real input instead of a different, thinner skim.
          const { missedLine, digestLines } = await import('./memory/transcript.js');
          const line = missedLine(messages);
          if (line) body.push(ui.wrapText(line, '  ', 68));
          for (const l of digestLines(messages)) body.push(`  ${ui.dim('·')} ${ui.wrapText(l, '    ', 66).trimStart()}`);
        }
        return {
          heading,
          body,
          notes: [...skipped, ...(note ? [note] : [])],
          raw: [localRecapPrompt(project, messages, ctx), 'local', messages.length],
        };
      };

      /**
       * §2 — what's still owed, across every repo and every session.
       *
       * The one thing a local transcript physically cannot do: Claude Code's
       * per-session JSONL rotates, so a question Claude asked while you rotted
       * dies with the session that asked it. That is why this half — and only
       * this half — needs Engram, and why the upsell lives here rather than
       * gating a whole command.
       */
      const buildOwed = async (): Promise<Half> => {
        const heading = 'still on you';
        if (!engramEnabled())
          return {
            heading,
            body: [
              ui.dim("  every question claude asks while you rot dies with that session — claude code's"),
              ui.dim('  transcripts are per-session and rotate. engram keeps them, across every repo.'),
              '',
              ui.tip('optional, if you want it —', 'rotpilot engram'),
            ],
            notes: [],
          };
        const found = await looseEnds({ days });
        const mems = found?.items ?? [];
        if (!found || !mems.length)
          return {
            heading,
            body: [
              ui.dim(
                found && found.total > 0
                  ? `  nothing in the last ${days} days. ${found.total}${found.capped ? '+' : ''} older ones are still on the books — rotpilot recap --days 60`
                  : '  nothing hanging. either you answered everything or you never rotted. sure.',
              ),
            ],
            notes: [],
          };
        const { synth, note } = synthOn ? await funLoose(mems, ctx) : noSynth;
        // Every fallback line gets an age. Without it the list showed a date only
        // when Engram happened to bake one into its prose — so some items read as
        // dated and others as timeless, which is worse than none at all.
        const body = synth
          ? renderSynth(synth)
          : mems.flatMap((m) => [
              ui.wrapText('• ' + m.content.replace(/^On [^,]+, /, ''), '  ', 68),
              ui.dim(`    ${ageLabel(m)}${m.properties?.project ? ` · ${m.properties.project}` : ''}`),
            ]);
        const hidden = found.inWindow - mems.length;
        const older = found.total - found.inWindow;
        const scope = [
          `last ${days} days`,
          hidden > 0 ? `${hidden} more in range` : null,
          // `capped`: engram's page is full, so "older" is a floor — say 5+, not 5
          older > 0 ? `${older}${found.capped ? '+' : ''} older` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return { heading, body, notes: [scope, ...(note ? [note] : [])], raw: [loosePrompt(mems, ctx), 'loose', mems.length] };
      };

      // Concurrently: the two halves hit different sources and each may spawn
      // its own Haiku, and ~8s twice in a row is a wait nobody should pay for
      // two independent questions.
      const stop = ui.spinner(opts.plain ? 'counting what you missed…' : 'catching you up…');
      const halves = await Promise.all([buildHappened(), buildOwed()]);
      stop();

      if (opts.raw) {
        const prompts = halves.map((h) => h.raw).filter(Boolean) as Array<[string, string, number]>;
        if (!prompts.length) {
          console.log(ui.no('nothing to summarize — no session transcript and nothing hanging.'));
          process.exitCode = 1;
          return;
        }
        for (const [prompt, kind, n] of prompts) await printRaw(prompt, kind, n);
        return;
      }

      console.log('');
      console.log(ui.card(`recap · ${project}`, halves.map((h) => ({ heading: h.heading, body: h.body }) as CardSection)));
      console.log('');
      // Said once, not per half: without this the plain lists read as rotpilot
      // being broken rather than as a missing prerequisite.
      const notes = halves.flatMap((h) => h.notes);
      if (!opts.plain && !summarizerAvailable())
        notes.push('no `claude` cli on PATH — showing the plain lists (the write-ups use your own claude)');
      for (const n of notes) console.log(ui.note(n));
      if (engramEnabled()) console.log(ui.tip('ask across every repo —', 'rotpilot recap "what changed in auth?"'));
      console.log('');
    });

  // Opt-in on purpose: this pulls ~20MB from youtube via yt-dlp. `init` used to
  // do it silently, which is a surprising thing for a setup command to do with
  // someone's network and disk — and when youtube's bot check refuses, it fails
  // in a way that looks like rotpilot is broken. Now you ask for it.
  program
    .command('loop')
    .description('download the subway-surfers clip localLoop plays (~20MB, via yt-dlp — optional)')
    .action(async () => {
      const { ensureLoopVideo, haveYtdlp, MANUAL_LOOP_CMD, LOOP_TARGET } = await import('./feeds/download.js');
      if (!haveYtdlp()) {
        console.log(ui.warn('yt-dlp not found — it is what fetches the clip'));
        console.log(ui.tip('install it —', 'brew install yt-dlp'));
        console.log(ui.note('localLoop plays a built-in animation until then — nothing is broken'));
        return;
      }
      const stop = ui.spinner('fetching the loop from youtube (~20MB, one-time)…');
      const status = ensureLoopVideo();
      stop();
      if (status === 'present') console.log(ui.ok(`already there — ${LOOP_TARGET}`));
      else if (status === 'downloaded') console.log(ui.ok(`loop ready — ${LOOP_TARGET}`));
      else if (status === 'blocked') {
        // The common failure, and it is not a network problem. Cookies are the
        // fix, and reading someone's browser cookies is their call, not ours.
        console.log(ui.warn('youtube asked rotpilot to prove it is not a bot'));
        console.log(ui.dim('   it does this for repeat or datacentre traffic. the fix is cookies from a'));
        console.log(ui.dim('   logged-in browser, which rotpilot will not read on its own — so, yours:'));
        console.log(ui.tip('paste this —', MANUAL_LOOP_CMD));
        console.log(ui.note('or skip it entirely: localLoop plays a built-in animation'));
      } else {
        console.log(ui.warn('download failed — see ~/.config/rotpilot/daemon.log for what yt-dlp said'));
        console.log(ui.note('localLoop plays a built-in animation meanwhile — nothing is broken'));
      }
    });

  program
    .command('feed <name>')
    .description('switch feed: localLoop | shorts | instagram')
    .option('--accept-risk', 'instagram only: accept the ToS/ban risk (records the consent, so this is asked once)')
    .action(async (name: string, opts: { acceptRisk?: boolean }) => {
      const cfg = loadConfig();
      if (!['localLoop', 'shorts', 'instagram'].includes(name)) {
        console.log(ui.no('unknown feed. options: localLoop | shorts | instagram'));
        process.exitCode = 1;
        return;
      }
      if (name === 'instagram' && !cfg.allowInstagram && !opts.acceptRisk) {
        console.log(ui.warn('instagram mode is OPT-IN and at your own risk.'));
        console.log(ui.dim('   automating instagram violates meta\'s terms of service; accounts can get'));
        console.log(ui.dim('   flagged or banned. rotpilot only scrolls (never likes/follows/comments)'));
        console.log(ui.dim('   and uses a real headful chrome, but the risk is yours. use a burner.'));
        console.log('');
        // A flag, not "go hand-edit this JSON". The consent still has to be
        // typed deliberately — it just does not cost you a detour through an
        // editor to say yes.
        console.log(ui.tip('to accept —', 'rotpilot feed instagram --accept-risk'));
        process.exitCode = 1;
        return;
      }
      if (name === 'instagram' && opts.acceptRisk && !cfg.allowInstagram) {
        cfg.allowInstagram = true;
        console.log(ui.ok('instagram risk accepted — recorded, so you will not be asked again'));
      }
      cfg.feed = name as typeof cfg.feed;
      saveConfig(cfg);
      console.log(ui.ok(`feed set to ${name}${name === 'instagram' ? ' — log into instagram in the chrome window on first play' : ''}`));
    });

  program
    .command('uninstall')
    .description('full cleanup: daemon, chrome, hooks, and all local data')
    .option('--keep-data', 'keep config + rot history (still wipes the chrome profile)')
    .action(async (opts: { keepData?: boolean }) => {
      const os = await import('node:os');
      const { uninstallHooks, uninstallGlobalHooks } = await import('./hooks/install.js');
      const { CONFIG_DIR, CHROME_PROFILE_DIR } = await import('./config.js');
      const { engramEnabled } = await import('./memory/engram.js');
      const { killOrphanTvWindows } = await import('./render/terminal.js');
      // Read the memory id BEFORE anything is deleted. It is generated locally
      // and stored nowhere else, so wiping the config orphans every Engram
      // memory permanently — silently, unless we say so here.
      const memoryId = engramEnabled() ? loadConfig().engram.userId : null;
      await stopDaemon();
      // stopDaemon closes the TV the LIVE daemon owns; this gets the ones left
      // behind by daemons that died without cleaning up, which nothing else can.
      const orphans = await killOrphanTvWindows();
      if (orphans) console.log(ui.ok(`closed ${orphans} orphaned tv window${orphans === 1 ? '' : 's'}`));
      console.log(ui.ok('daemon, chrome, and tv stopped'));
      uninstallHooks(process.cwd());
      const scrubbed = uninstallGlobalHooks();
      console.log(ui.ok(`hooks removed from ${process.cwd()}/.claude/settings.local.json`));
      if (scrubbed) console.log(ui.ok('scrubbed a legacy global install from ~/.claude/settings.json'));
      console.log('  (rotpilot is per-project — run `rotpilot off` in any OTHER enabled project to clear it too)');
      if (opts.keepData) {
        // the chrome profile can hold real logins (instagram) — never keep it
        fs.rmSync(CHROME_PROFILE_DIR, { recursive: true, force: true });
        // credentials never survive an uninstall, even --keep-data
        for (const f of ['daemon.log', 'tv-test.json', 'engram.key']) fs.rmSync(path.join(CONFIG_DIR, f), { force: true });
        console.log(ui.ok(`chrome profile + logs + stored keys wiped (kept config + rot history in ${CONFIG_DIR})`));
      } else {
        fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
        console.log(ui.ok(`removed ${CONFIG_DIR} (config, rot history, chrome profile)`));
      }
      // Loud, and last, so it is the thing still on screen afterwards. Your
      // Engram memories survive this uninstall — but only reachable with the id.
      if (memoryId && !opts.keepData) {
        console.log('');
        console.log(
          ui.card('keep this — your engram memories outlive this uninstall', [
            {
              body: [
                `  ${ui.bold(memoryId)}`,
                '',
                ui.dim('  your memories are still in engram, filed under that id. it was generated'),
                ui.dim('  on this machine and stored only in the config just deleted — without it'),
                ui.dim('  a reinstall starts empty and there is no way to get them back.'),
                '',
                ui.dim('  after reinstalling:  rotpilot engram id ' + memoryId),
              ],
            },
          ]),
        );
      }
      console.log('');
      console.log(ui.tip('last step, removes this command itself —', 'npm uninstall -g rotpilot'));
      console.log(ui.note(`the two kitty.conf lines are yours to keep or remove: ${os.homedir()}/.config/kitty/kitty.conf`));
    });

  program
    .command('off')
    .description('turn rotpilot OFF for the current project (removes its hooks; other projects unaffected)')
    .action(async () => {
      const { uninstallHooks } = await import('./hooks/install.js');
      const dir = process.cwd();
      uninstallHooks(dir);
      await fireAndForget({ t: 'user-stop' }); // stop anything currently playing
      console.log(ui.ok(`rotpilot OFF for ${dir}`));
      console.log(ui.note('removed hooks from ./.claude/settings.local.json — other projects keep theirs'));
      console.log(ui.note('restart claude here for it to take effect'));
    });

  program
    .command('on')
    .description('turn rotpilot ON for the current project (installs hooks here only)')
    .action(async () => {
      const { installHooks } = await import('./hooks/install.js');
      const cfg = loadConfig();
      if (!cfg.engram.userId) cfg.engram.userId = `rotpilot-${(await import('node:crypto')).randomUUID()}`;
      saveConfig(cfg); // also (re)creates the config file — its existence gates the hook client
      const dir = process.cwd();
      installHooks(dir);
      console.log(ui.ok(`rotpilot ON for ${dir}`));
      console.log(ui.note('hooks in ./.claude/settings.local.json — this project only, not committed'));
      console.log(ui.note('restart claude in this project (in kitty or ghostty) to pick it up'));
      if (!process.env.KITTY_LISTEN_ON && process.env.TERM_PROGRAM !== 'ghostty') {
        console.log('');
        console.log(ui.warn('you are not in a supported terminal, so nothing will play here.'));
        // continuations sit under the ⚠ glyph's text column (3), dim like other
        // secondary prose
        console.log(ui.dim('   rotpilot is terminal-only: run claude in ghostty (≥1.3, works out of the'));
        console.log(ui.dim('   box) or kitty, which needs remote control on and a restart:'));
        console.log(ui.tip('paste this —', KITTY_SETUP_CMD));
      }
    });

  program
    .command('window <mode>')
    .description('where the tv opens: panel (split beside claude, default) | window (separate)')
    .action(async (mode: string) => {
      if (mode !== 'panel' && mode !== 'window') {
        console.log(ui.no('unknown mode. options: panel | window'));
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig();
      cfg.window = mode;
      saveConfig(cfg);
      console.log(ui.ok(`tv opens as ${mode === 'panel' ? 'a side panel beside claude' : 'a separate window'}`));
      if (mode === 'panel' && !process.env.KITTY_LISTEN_ON && process.env.TERM_PROGRAM !== 'ghostty') {
        console.log(ui.warn('kitty remote control not detected — panel mode needs it on, then a restart'));
        console.log(ui.tip('paste this —', KITTY_SETUP_CMD));
        console.log(ui.dim('   until then rotpilot falls back to a separate window.'));
      }
    });

  program
    .command('demo')
    .description('30s demo with the safe feed: start playing, then snap back')
    .option('--seconds <n>', 'how long to rot', '30')
    .action(async (opts: { seconds: string }) => {
      const term = process.env.KITTY_LISTEN_ON ? 'kitty' : process.env.TERM_PROGRAM === 'ghostty' ? 'ghostty' : undefined;
      if (!term) {
        console.log(ui.no('not inside kitty or ghostty — the demo needs a supported terminal to dock the tv.'));
        process.exitCode = 1;
        return;
      }
      if (!(await startDaemon())) {
        console.log(ui.no('daemon failed to start (see ~/.config/rotpilot/daemon.log)'));
        process.exitCode = 1;
        return;
      }
      const secs = Math.max(5, parseInt(opts.seconds, 10) || 30);
      const ctx = {
        kittyWindowId: process.env.KITTY_WINDOW_ID,
        kittyListenOn: process.env.KITTY_LISTEN_ON,
        term,
        cwd: process.cwd(),
        sessionId: 'demo',
      };
      // replay a real session, in order. session-start matters: it opens the
      // greeting panel AND clears the snooze latch a previous q / demo /
      // `rotpilot off` left behind — without it the daemon silently drops the
      // work-start and the demo looks dead.
      await fireAndForget({ t: 'hook', event: 'session-start', ctx });
      await new Promise((r) => setTimeout(r, 800));
      console.log(`▶ demo: rotting for ${secs}s, then snapping back…`);
      await fireAndForget({ t: 'hook', event: 'work-start', ctx });
      // self-check a few seconds in: are frames actually reaching the tv?
      await new Promise((r) => setTimeout(r, Math.min(5000, secs * 1000)));
      const st = await request({ t: 'status' }, 700);
      if (st?.state === 'playing' && st.owner && st.owner !== 'demo') {
        console.log('  ' + ui.no(`another claude session (${String(st.owner).slice(0, 8)}…) is using the tv right now — demo skipped.`));
        console.log('    let it finish (or press q in its panel) and rerun the demo.');
        process.exitCode = 1;
        return;
      }
      if (st?.state === 'playing' && (st.framesSent as number) > 0) {
        console.log('  ' + ui.ok(`playing — ${st.tvMode}, ${st.framesSent} frames so far`));
      } else if (st?.state === 'playing') {
        console.log('  ' + ui.warn('playing but no frames yet (chrome still warming?) — if the panel stays blank, check ~/.config/rotpilot/daemon.log'));
      } else {
        console.log('  ' + ui.no(`not playing (state: ${st ? st.state : 'daemon unreachable'}) — check ~/.config/rotpilot/daemon.log`));
      }
      await new Promise((r) => setTimeout(r, Math.max(0, secs * 1000 - 5000)));
      await fireAndForget({ t: 'hook', event: 'snap-back', reason: 'done', ctx });
      console.log('⏸ snapped back — read the panel. closing in 6s…');
      await new Promise((r) => setTimeout(r, 6000));
      // end like a real session (session-end closes the panel whether we played
      // or only greeted) — NOT user-stop, which would snooze the daemon and
      // silently kill the next demo/session's playback until its next prompt
      await fireAndForget({ t: 'hook', event: 'snap-back', reason: 'session-end', ctx });
      console.log(ui.ok("demo done. that yank you felt? that's the product."));
    });

  program
    .command('hook <event>')
    .description('(internal, called by Claude Code hooks) forward a hook event to the daemon');

  /**
   * Bare `rotpilot`, before setup, is the real onboarding moment.
   *
   * `npm i -g` prints nothing — npm ≥7 hides lifecycle script output unless the
   * user passes --foreground-scripts, so a postinstall banner is invisible to
   * almost everyone (measured on npm 11.13). What a new user does next is type
   * the command they just installed, and a 17-line command dump does not tell
   * them that rotpilot does nothing at all until `init` wires up the hooks.
   *
   * Only when unconfigured: once set up, `rotpilot` is the normal help again.
   */
  if (process.argv.length <= 2 && !fs.existsSync(CONFIG_PATH)) {
    ui.masthead('claude code feeds you brainrot while it works — and yanks it away when it needs you');
    console.log('');
    console.log(ui.heading('not set up yet — two steps'));
    console.log('');
    console.log(ui.step(1, `cd to a project you want it in, then run ${ui.bold('rotpilot init')}`));
    console.log(ui.step(2, `restart claude there, ${ui.bold('in kitty or ghostty ≥1.3')} — hooks load at session start`));
    console.log('');
    console.log(ui.note('terminal-only for now, and it needs google chrome.'));
    console.log('');
    console.log(ui.tip('see it work first, no claude needed —', 'rotpilot demo'));
    console.log(ui.tip('every command —', 'rotpilot --help'));
    console.log('');
    return;
  }

  program.parse();
}
