/**
 * rotpilot CLI. The `hook` / `_daemon` / `_tv` paths bypass commander so the
 * hook client stays as fast as possible.
 */
export {};
import type { CardSection } from './ui.js'; // type-only: erased at runtime, keeps the fast path lean

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
    .option('--uninstall', 'remove rotpilot hooks from claude code')
    .action(async (opts: { uninstall?: boolean }) => {
      const { installHooks, uninstallHooks, uninstallGlobalHooks } = await import('./hooks/install.js');
      const { findKitty } = await import('./render/terminal.js');
      const { findChrome } = await import('./chrome/launch.js');
      if (opts.uninstall) {
        uninstallHooks(process.cwd());
        const scrubbed = uninstallGlobalHooks();
        console.log(ui.ok(`rotpilot hooks removed from ${process.cwd()}/.claude/settings.local.json`));
        if (scrubbed) console.log(ui.ok('also scrubbed a legacy global install from ~/.claude/settings.json'));
        return;
      }
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
      // fetch the default brainrot loop into the user's own config dir (never
      // bundled/redistributed). Only needed for the localLoop feed.
      if (cfg.feed === 'localLoop') {
        const { ensureLoopVideo } = await import('./feeds/download.js');
        const status = ensureLoopVideo(undefined, (s) => console.log(`  ${s}`));
        if (status === 'present') console.log(ui.ok('brainrot loop ready'));
        else if (status === 'downloaded') console.log(ui.ok('brainrot loop downloaded'));
        else if (status === 'no-ytdlp')
          console.log(ui.warn('yt-dlp not found — `brew install yt-dlp`, then rerun init for the subway-surfers loop; until then localLoop plays the built-in animation'));
        else console.log(ui.warn('loop download failed (network?) — localLoop plays the built-in animation for now'));
      }
      installHooks(process.cwd());
      console.log(ui.ok(`rotpilot ON for ${process.cwd()}`));
      console.log(ui.note('hooks in ./.claude/settings.local.json — this project only, never global'));
      const inTerm = process.env.KITTY_LISTEN_ON || process.env.TERM_PROGRAM === 'ghostty';
      if (!inTerm) {
        console.log('');
        console.log(ui.warn('not a supported terminal — nothing will play here.'));
        console.log(ui.bullet('rotpilot is terminal-only (never the desktop app or VS Code)'));
        console.log(ui.bullet('ghostty ≥1.3 — works out of the box'));
        console.log(ui.bullet('kitty — add two lines to ~/.config/kitty/kitty.conf, then restart:'));
        console.log(`      ${ui.dim('allow_remote_control socket-only')}`);
        console.log(`      ${ui.dim('listen_on unix:/tmp/kitty')}`);
      }
      console.log('');
      console.log(ui.heading('next steps'));
      console.log('');
      console.log(ui.step(1, 'RESTART any running claude sessions (hooks load at session start)'));
      console.log(ui.step(2, 'run claude in kitty or ghostty, in this project, on something chunky'));
      console.log(ui.step(3, 'rot — it yanks the feed away when claude needs you'));
      console.log(ui.step(4, `${ui.bold('rotpilot stats')} — see the damage`));
      console.log('');
      console.log(ui.tip('enable in other projects —', 'rotpilot on'));
      console.log(ui.tip('switch feeds —', 'rotpilot feed <name>'));
      console.log(ui.tip('escape hatches —', 'q in the tv · rotpilot off · rotpilot stop'));
      console.log('');
      console.log(ui.note('feeds: localLoop (default, safe) · shorts · instagram (opt-in, at your own risk)'));
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
    .description('optional Engram memory: setup guide · `key` = save API key · `transcripts on|off` = opt in · `check` = live test')
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
          console.log(clearApiKey() ? ui.ok('stored key removed') : 'no stored key to remove');
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
          console.log('  what this means, plainly:');
          console.log('  · when a rot window ends, the segment of the CLAUDE SESSION TRANSCRIPT that');
          console.log('    streamed by while you watched (your prompts, claude\'s messages and tool');
          console.log('    calls — which can include code) is sent to YOUR Engram project');
          console.log('  · engram splits it into what claude DID and what still NEEDS YOU —');
          console.log('    `rotpilot recap` gets it back');
          console.log('  · nothing is shared with rotpilot or anyone else; it goes to your project,');
          console.log('    under your key. turn it off any time: rotpilot engram transcripts off');
        } else {
          console.log(ui.ok('transcript sharing OFF — no session content leaves this machine.'));
          console.log('  (vows + stats receipts still work; `rotpilot recap` will go stale.)');
        }
        return;
      }

      if (action !== 'check') {
        console.log('');
        console.log(ui.heading('rotpilot × engram — the "what you missed" memory'));
        console.log('');
        console.log(
          ui.wrapText(
            "rotpilot exists to make you NOT watch while claude works. engram remembers what you missed: each rot window's slice of the session transcript, split into what claude DID and what still NEEDS YOU. `rotpilot recap` gets it back — even weeks later, even across projects.",
          ),
        );
        console.log('');
        console.log(ui.step(1, 'create an Engram project at https://console.weaviate.cloud'));
        console.log(ui.dim('       the topic SET is fixed at creation — define exactly TWO in the'));
        console.log(ui.dim('       default group, both "User + property scoped" (property: project),'));
        console.log(ui.dim('       both UNBOUNDED:'));
        console.log('');
        for (const t of TOPIC_DESIGN) {
          console.log(`       ${ui.brand(t.name)}`);
          console.log(ui.wrapText(t.description, '         ', 64));
        }
        console.log('');
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
      console.log('1/3 auth + read — listing memories…');
      const list = await listMemories({ limit: 5 });
      if (!list) {
        console.log(ui.no('list failed — bad key or unreachable project.'));
        if (lastEngramError()) console.log(`  engram said: ${lastEngramError()}`);
        process.exitCode = 1;
        return;
      }
      const topics = [...new Set(list.memories.map((m) => m.topic).filter(Boolean))];
      console.log('    ' + ui.ok(`authenticated${topics.length ? ` — topics seen: ${topics.join(', ')}` : ' (no memories yet)'}`));

      console.log('2/3 write — a synthetic marked conversation (scope: rotpilot-check)…');
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

      console.log('3/3 search…');
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
    .command('vow <promise...>')
    .description('put a promise about your rot habit on the record — stats will hold you to it')
    .action(async (words: string[]) => {
      const { addVow } = await import('./memory/store.js');
      const text = words.join(' ');
      addVow(text);
      console.log(ui.ok(`on the record: "${text}"`));
      console.log(ui.tip('rotpilot never forgets — receipts in', 'rotpilot stats'));
    });

  program
    .command('recap [question...]')
    .description('what you missed: everything claude did while you rotted (needs engram + transcripts on)')
    .option('--raw', 'print the exact prompt + fragments sent to haiku (no synthesis) — for debugging')
    .action(async (words: string[], opts: { raw?: boolean }) => {
      const { engramEnabled, getRecap, searchRecap } = await import('./memory/engram.js');
      const { summarizerAvailable, funRecap, funAnswer, recapPrompt, answerPrompt, MODEL } =
        await import('./memory/summarize.js');
      const { rotContext } = await import('./memory/store.js');
      if (!engramEnabled()) {
        console.log(ui.no('recap needs a memory. run `rotpilot engram` to set one up.'));
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig();
      const ctx = rotContext();
      // fallback (no claude / offline): strip the repeated "On <date>, Claude "
      // lead-in so the raw list at least reads cleanly
      const clean = (s: string) =>
        s.replace(/^On\s+\w+\s+\d{1,2}\s+\w+\s+\d{4},?\s*/i, '').replace(/^Claude\s+/, '');
      // tolerant header match: Haiku drifts ("claude handled:", "**your move**",
      // "Claude Handled") — normalise them all to one styled label so the
      // structure renders consistently instead of sometimes-plain.
      const LABEL = /^[#*\s]*(claude handled|your move|needs you|done)\b[\s:*]*$/i;
      const fmtSynth = (text: string): string =>
        text
          .split('\n')
          .map((line) => {
            const t = line.trim();
            if (!t) return '';
            const m = t.match(LABEL);
            if (m) return ui.heading(m[1].toLowerCase());
            return ui.wrapText(line, '  ', 68);
          })
          .join('\n');
      // `--raw`: dump the exact prompt (voice + rot stats + fragments) sent to
      // Haiku — plain and copy-pasteable, no box, no synthesis.
      const printRaw = (prompt: string, kind: string, n: number) => {
        console.log('');
        console.log(
          ui.dim(
            `── raw · ${kind} · model ${MODEL} · ${n} fragment${n === 1 ? '' : 's'} · summarizer ${summarizerAvailable() ? 'available' : 'unavailable'} ──`,
          ),
        );
        console.log('');
        console.log(prompt);
        console.log('');
      };

      if (words.length) {
        // question mode: semantic search across ALL projects' missed work
        const q = words.join(' ');
        const stop = ui.spinner(`catching you up on "${q}"…`);
        const r = await searchRecap(q);
        const synth =
          !opts.raw && r?.memories?.length && summarizerAvailable() ? await funAnswer(q, r.memories, ctx) : null;
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
          ? fmtSynth(synth).split('\n')
          : r.memories.map((m) => ui.wrapText('• ' + clean(m.content), '  ', 68));
        console.log('');
        console.log(ui.card(`while you were rotting · "${q}"`, [{ body: bodyLines }]));
        console.log('');
        return;
      }

      const project = path.basename(process.cwd());
      const stop = ui.spinner('catching you up…');
      const recap = await getRecap(project);
      const synth =
        !opts.raw && recap && (recap.looseEnds.length || recap.work.length) && summarizerAvailable()
          ? await funRecap(project, recap.looseEnds, recap.work, ctx)
          : null;
      stop();
      if (!recap) {
        console.log(ui.no('engram unreachable — try again, or `rotpilot engram check`.'));
        process.exitCode = 1;
        return;
      }
      if (opts.raw && recap && (recap.looseEnds.length || recap.work.length))
        return printRaw(
          recapPrompt(project, recap.looseEnds, recap.work, ctx),
          'recap',
          recap.looseEnds.length + recap.work.length,
        );
      if (!recap.looseEnds.length && !recap.work.length) {
        const msg = cfg.engram.shareTranscripts
          ? `nothing on record for ${project} yet.\nrot a little; extraction runs async (queue can lag a few minutes).`
          : `nothing on record for ${project} yet.\nthe transcript memory is OFF — turn it on with:\nrotpilot engram transcripts on`;
        console.log('');
        console.log(ui.card(`recap · ${project}`, [{ body: msg.split('\n').map((l) => ui.dim('  ' + l)) }]));
        console.log('');
        return;
      }
      let sections: CardSection[];
      if (synth) {
        // synth is one blob; its embedded "claude handled"/"your move" headers
        // are already turned into ▎ headings by fmtSynth
        sections = [{ body: fmtSynth(synth).split('\n') }];
      } else {
        // fallback: de-noised raw list as proper ▎ sections, same order as the
        // synth shape (what got done, then what's left) so both modes read alike
        sections = [];
        if (recap.work.length)
          sections.push({ heading: 'claude handled', body: recap.work.map((m) => ui.wrapText('• ' + clean(m.content), '  ', 68)) });
        if (recap.looseEnds.length)
          sections.push({ heading: 'your move', body: recap.looseEnds.map((m) => ui.wrapText('• ' + clean(m.content), '  ', 68)) });
      }
      console.log('');
      console.log(ui.card(`recap · ${project}`, sections));
      console.log('');
      console.log(ui.tip('ask anything —', 'rotpilot recap "what was the image bug?"'));
      console.log('');
    });

  program
    .command('feed <name>')
    .description('switch feed: localLoop | shorts | instagram')
    .action(async (name: string) => {
      const cfg = loadConfig();
      if (!['localLoop', 'shorts', 'instagram'].includes(name)) {
        console.log(ui.no('unknown feed. options: localLoop | shorts | instagram'));
        process.exitCode = 1;
        return;
      }
      if (name === 'instagram' && !cfg.allowInstagram) {
        console.log(ui.warn('instagram mode is OPT-IN and at your own risk.'));
        console.log('   automating instagram violates meta\'s terms of service; accounts can get');
        console.log('   flagged or banned. rotpilot only scrolls (never likes/follows/comments)');
        console.log('   and uses a real headful chrome, but the risk is yours. use a burner.');
        console.log('');
        console.log('   to accept: set "allowInstagram": true in ~/.config/rotpilot/config.json,');
        console.log('   then run `rotpilot feed instagram` again.');
        process.exitCode = 1;
        return;
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
      await stopDaemon();
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
      console.log('');
      console.log('last step (removes this command itself):');
      console.log('  npm uninstall -g rotpilot');
      console.log('');
      console.log(`the two kitty.conf lines (allow_remote_control / listen_on) are yours to keep or remove: ${os.homedir()}/.config/kitty/kitty.conf`);
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
      console.log('  removed hooks from ./.claude/settings.local.json — other projects keep theirs.');
      console.log('  restart claude here for it to take effect.');
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
      console.log('  hooks written to ./.claude/settings.local.json (this project only, not committed).');
      if (!process.env.KITTY_LISTEN_ON && process.env.TERM_PROGRAM !== 'ghostty') {
        console.log('');
        console.log(ui.warn('you are not in a supported terminal, so nothing will play here.'));
        console.log('   rotpilot is terminal-only: run claude in ghostty (≥1.3, works out of the');
        console.log('   box) or kitty (needs two lines in ~/.config/kitty/kitty.conf + restart):');
        console.log('     allow_remote_control socket-only');
        console.log('     listen_on unix:/tmp/kitty');
      }
      console.log('  restart claude in this project (in kitty or ghostty) to pick it up.');
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
        console.log(ui.warn('kitty remote control not detected — panel mode needs these two lines'));
        console.log('   in ~/.config/kitty/kitty.conf (then restart kitty):');
        console.log('     allow_remote_control socket-only');
        console.log('     listen_on unix:/tmp/kitty');
        console.log('   until then rotpilot falls back to a separate window.');
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

  program.parse();
}
