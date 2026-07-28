/**
 * `rotpilot hook <event>` — invoked by Claude Code hooks (async, but still
 * must be fast and failure-silent: a dead daemon must never break a session).
 * Reads the hook payload from stdin, maps it to a daemon event, fires it over
 * the socket, exits 0 no matter what.
 */
import { fireAndForget } from '../daemon/ipc.js';

interface HookPayload {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
  notification_type?: string;
}

async function readStdin(timeoutMs = 400): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on('data', (d) => (data += d.toString('utf8')));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => resolve(data));
  });
}

export async function runHook(name: string): Promise<void> {
  // terminal-only: rotpilot lives in a terminal side panel, and only kitty
  // (remote-control socket) and Ghostty ≥1.3 (AppleScript) can dock one. No
  // supported terminal in the env means we're in the Claude desktop app, the
  // VS Code extension, or another terminal — do nothing, instantly.
  const inKitty = !!process.env.KITTY_LISTEN_ON;
  const inGhostty = process.env.TERM_PROGRAM === 'ghostty' || !!process.env.GHOSTTY_RESOURCES_DIR;
  if (!inKitty && !inGhostty) {
    process.exit(0);
  }
  try {
    let payload: HookPayload = {};
    try {
      const raw = await readStdin();
      if (raw.trim()) payload = JSON.parse(raw);
    } catch {}

    const ctx = {
      sessionId: payload.session_id,
      cwd: payload.cwd,
      transcriptPath: payload.transcript_path,
      kittyWindowId: process.env.KITTY_WINDOW_ID,
      kittyListenOn: process.env.KITTY_LISTEN_ON,
      term: inKitty ? 'kitty' : 'ghostty',
    };

    let msg: { event: string; reason?: string } | null = null;
    switch (name) {
      case 'session-start':
        msg = { event: 'session-start' };
        break;
      case 'prompt':
        msg = { event: 'prompt' };
        break;
      case 'work-start':
        msg = { event: 'work-start' };
        break;
      case 'subagent-start':
        msg = { event: 'subagent-start' };
        break;
      case 'subagent-stop':
        msg = { event: 'subagent-stop' };
        break;
      case 'attention':
        // Fired by two events. PermissionRequest is the fast path — it runs
        // before the dialog is painted and carries no notification_type, so it
        // falls through to 'permission', which is exactly right. Notification is
        // the backup, and its notification_type separates the idle nag from a
        // permission prompt.
        msg = {
          event: 'snap-back',
          reason: payload.notification_type === 'idle_prompt' ? 'idle' : 'permission',
        };
        break;
      case 'done':
        msg = { event: 'snap-back', reason: 'done' };
        break;
      case 'session-end':
        msg = { event: 'snap-back', reason: 'session-end' };
        break;
      default:
        break;
    }
    if (msg) {
      // events that may need to boot the daemon (warm it before work)
      const SPAWN_EVENTS = new Set(['session-start', 'prompt', 'work-start', 'subagent-start']);
      if (SPAWN_EVENTS.has(msg.event)) {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { CONFIG_PATH } = await import('../config.js');
        // no config file = uninstalled: sessions with stale hot-loaded hooks
        // must not resurrect the daemon
        if (!fs.existsSync(CONFIG_PATH)) process.exit(0);
        // per-project gate: rotpilot is ON only where its hooks file lives.
        // Checked live (walk up from the session cwd) so `rotpilot off` takes
        // effect immediately, even for sessions that hot-loaded the hooks.
        let dir = payload.cwd || process.cwd();
        let on = false;
        for (let i = 0; i < 20 && !on; i++) {
          try {
            on = fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8').includes('hook work-start');
          } catch {}
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        if (!on) process.exit(0);
      }
      const delivered = await fireAndForget({ t: 'hook', ...msg, ctx });
      // hands-off: if the daemon is down, boot it now so it's warm by first tool
      if (!delivered && SPAWN_EVENTS.has(msg.event)) {
        const { spawn } = await import('node:child_process');
        const path = await import('node:path');
        spawn(process.execPath, [path.resolve(process.argv[1]), '_daemon'], {
          detached: true,
          stdio: 'ignore',
        }).unref();
        // re-send so a just-booted daemon gets this event (esp. work-start)
        await new Promise((r) => setTimeout(r, 250));
        await fireAndForget({ t: 'hook', ...msg, ctx });
      }
    }
  } catch {}
  process.exit(0);
}
