/** Terminal size queries + kitty binary discovery + focus control. */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { log } from '../log.js';

export interface TermSize {
  cols: number;
  rows: number;
  pxw: number;
  pxh: number;
}

const KITTY_APP = '/Applications/kitty.app/Contents/MacOS';

export function findKitty(): { kitty: string; kitten: string } | null {
  const candidates = [KITTY_APP, `${process.env.HOME}/Applications/kitty.app/Contents/MacOS`];
  for (const dir of candidates) {
    if (fs.existsSync(`${dir}/kitty`)) return { kitty: `${dir}/kitty`, kitten: `${dir}/kitten` };
  }
  // PATH fallback
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && fs.existsSync(`${dir}/kitty`)) {
      const kitten = fs.existsSync(`${dir}/kitten`) ? `${dir}/kitten` : `${dir}/kitty`;
      return { kitty: `${dir}/kitty`, kitten };
    }
  }
  return null;
}

/**
 * Query the terminal's text-area pixel size via CSI 14 t. Must be called from a
 * process that owns the tty (the _tv client). Falls back to cell-size guess.
 */
export function queryTermSize(): Promise<TermSize> {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const fallback: TermSize = { cols, rows, pxw: cols * 9, pxh: rows * 18 };
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(fallback);

  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = '';
    const done = (size: TermSize) => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      resolve(size);
    };
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      const m = buf.match(/\x1b\[4;(\d+);(\d+)t/);
      if (m) done({ cols, rows, pxh: parseInt(m[1], 10), pxw: parseInt(m[2], 10) });
    };
    const timer = setTimeout(() => done(fallback), 500);
    stdin.on('data', onData);
    process.stdout.write('\x1b[14t');
  });
}

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: stdout?.toString() ?? '',
        err: err ? (stderr?.toString().trim() || err.message) : '',
      });
    });
  });
}

/** Focus a window in a kitty instance via its remote-control socket. */
export async function focusKittyWindow(kitten: string, listenOn: string, match: string): Promise<boolean> {
  const r = await run(kitten, ['@', '--to', listenOn, 'focus-window', '--match', match]);
  return r.ok;
}

/** Layout of the currently active tab (where claude is running). */
async function activeTabLayout(kitten: string, listenOn: string): Promise<string | null> {
  const r = await run(kitten, ['@', '--to', listenOn, 'ls']);
  if (!r.ok) return null;
  try {
    const oss = JSON.parse(r.out) as Array<{ is_focused: boolean; tabs: Array<{ is_active: boolean; layout: string }> }>;
    const os = oss.find((o) => o.is_focused) ?? oss[0];
    const tab = os?.tabs.find((t) => t.is_active) ?? os?.tabs[0];
    return tab?.layout ?? null;
  } catch {
    return null;
  }
}

export interface Panel {
  windowId: string;
  /** layout to restore when the panel closes (null = tab was already `splits`) */
  prevLayout: string | null;
}

/**
 * Open the TV as a right-side panel inside the user's own kitty window (so
 * claude stays visible). A true vertical split needs the `splits` layout, so
 * we switch the tab to it (remembering the old layout to restore on close);
 * as a last resort, launch without a location. Returns null on failure.
 */
export async function launchKittyPanel(
  kitten: string,
  listenOn: string,
  cmd: string[],
  biasPct: number,
): Promise<Panel | null> {
  const layout = await activeTabLayout(kitten, listenOn);
  let prevLayout: string | null = null;
  if (layout && layout !== 'splits') {
    const sw = await run(kitten, ['@', '--to', listenOn, 'goto-layout', 'splits']);
    if (sw.ok) prevLayout = layout;
  }
  const base = ['@', '--to', listenOn, 'launch', '--type=window', '--keep-focus', '--title=rotpilot-tv'];
  let r = await run(kitten, [...base, '--location=vsplit', `--bias=${biasPct}`, ...cmd]);
  if (!r.ok) r = await run(kitten, [...base, ...cmd]);
  const id = r.out.trim();
  if (r.ok && /^\d+$/.test(id)) return { windowId: id, prevLayout };
  if (prevLayout) await run(kitten, ['@', '--to', listenOn, 'goto-layout', prevLayout]);
  return null;
}

export async function closeKittyPanel(kitten: string, listenOn: string, panel: Panel): Promise<void> {
  if (panel.prevLayout) {
    // restore the layout of the tab holding the panel (window match → its tab)
    const r = await run(kitten, [
      '@', '--to', listenOn, 'goto-layout', '--match', `window_id:${panel.windowId}`, panel.prevLayout,
    ]);
    if (!r.ok) await run(kitten, ['@', '--to', listenOn, 'goto-layout', panel.prevLayout]);
  }
  await run(kitten, ['@', '--to', listenOn, 'close-window', '--match', `id:${panel.windowId}`]);
}

// ───────────────────────── Ghostty (AppleScript) ─────────────────────────
// Ghostty ≥1.3 exposes an AppleScript dictionary (verified against the bundled
// Ghostty.sdef): `split <terminal> direction right with configuration
// {command:…}` opens a pane running our command, terminals carry stable UUID
// `id`s, and `focus (terminal id X)` / `close (terminal id X)` work as direct
// app-level specifiers. Frame streaming over the kitty graphics protocol was
// verified inside Ghostty: 480/480 frames accepted at 24fps.

export function findGhostty(): boolean {
  return fs.existsSync('/Applications/Ghostty.app') || fs.existsSync(`${process.env.HOME}/Applications/Ghostty.app`);
}

// osascript is spawned per call; at session-start the machine is busy (chrome
// cold-launch + node spawns), so even a fast script can be slow to *start*.
// Launch ops pass a generous timeout; quick ops (focus/close) use the default.
function osa(script: string, timeoutMs?: number): Promise<{ ok: boolean; out: string; err: string }> {
  return run('osascript', ['-e', script], timeoutMs);
}

function asStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface GhosttyPanel {
  /** the TV pane */
  tvId: string;
  /** the pane claude was focused in when the panel opened (snap-back target) */
  claudeId: string | null;
}

/**
 * Split the user's focused Ghostty pane and run `cmd` in the new pane.
 * Captures the previously-focused pane id first — that's claude's pane, the
 * snap-back target. Returns null on failure (no window, automation denied, …).
 */
export async function ghosttyLaunchPanel(cmd: string[]): Promise<GhosttyPanel | null> {
  const command = cmd.map((c) => `"${c}"`).join(' ');
  const r = await osa(
    `tell application "Ghostty"
      set t1 to focused terminal of selected tab of front window
      set cfg to (new surface configuration from {command:${asStr(command)}, wait after command:false})
      set t2 to split t1 direction right with configuration cfg
      return (id of t1) & "|" & (id of t2)
    end tell`,
    12000,
  );
  if (!r.ok) {
    log('ghostty split failed:', r.err.slice(0, 200), ghosttyPermHint(r.err));
    return null;
  }
  const [claudeId, tvId] = r.out.trim().split('|');
  if (!tvId) return null;
  return { tvId, claudeId: claudeId || null };
}

/** A macOS automation-permission denial (error -1743) is sticky for a process's
 * whole life, so a daemon denied once keeps failing until restarted. Point at
 * the fix rather than just logging a raw code. */
function ghosttyPermHint(err: string): string {
  if (!isAutomationDenial(err)) return '';
  automationDenied = true;
  return '· automation denied for THIS process (cached for its lifetime) — respawning a clean daemon';
}

function isAutomationDenial(err: string): boolean {
  return /-1743|not authori[sz]|Apple event/i.test(err);
}

/**
 * macOS caches an AppleEvents denial against the *requesting process* for its
 * entire life. The daemon is a long-lived singleton, so one denial early on
 * leaves it unable to script Ghostty in every future session — while a freshly
 * spawned process is granted normally. Verified: a poisoned daemon failed every
 * attempt across sessions; a fresh one opened the pane immediately.
 *
 * The daemon reads this to decide it should exit and let the next hook boot a
 * clean replacement, rather than staying silently broken forever.
 */
let automationDenied = false;

export function automationWasDenied(): boolean {
  return automationDenied;
}

/** Open the TV as a separate Ghostty window (fallback when there's no front window). */
export async function ghosttyLaunchWindow(cmd: string[]): Promise<GhosttyPanel | null> {
  const command = cmd.map((c) => `"${c}"`).join(' ');
  const r = await osa(
    `tell application "Ghostty"
      set claudeId to ""
      try
        set claudeId to id of (focused terminal of selected tab of front window)
      end try
      set cfg to (new surface configuration from {command:${asStr(command)}, wait after command:false})
      set w to new window with configuration cfg
      delay 0.3
      return claudeId & "|" & (id of (focused terminal of selected tab of w))
    end tell`,
    12000,
  );
  if (!r.ok) {
    log('ghostty window failed:', r.err.slice(0, 200), ghosttyPermHint(r.err));
    return null;
  }
  const [claudeId, tvId] = r.out.trim().split('|');
  if (!tvId) return null;
  return { tvId, claudeId: claudeId || null };
}

export async function ghosttyFocusTerminal(id: string): Promise<boolean> {
  const r = await osa(`tell application "Ghostty" to focus (terminal id ${asStr(id)})`);
  return r.ok;
}

export async function ghosttyCloseTerminal(id: string): Promise<void> {
  await osa(`tell application "Ghostty" to close (terminal id ${asStr(id)})`);
}

/** Get the frontmost macOS application name (to restore focus on snap-back fallback). */
export async function frontmostApp(): Promise<string | null> {
  const r = await run('osascript', [
    '-e',
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ]);
  return r.ok ? r.out.trim() : null;
}

export async function activateApp(name: string): Promise<void> {
  // asStr, not a bare interpolation: escapes backslashes as well as quotes, so a
  // pathological app name can't terminate the AppleScript string literal
  const app = asStr(name);
  const r = await run('osascript', ['-e', `tell application ${app} to activate`]);
  if (r.ok) return;
  // frontmostApp reports PROCESS names, which aren't always the AppleScript
  // application name (VS Code's process is "Code"). System Events keys off the
  // process name, so it can still land what `tell application` just missed.
  await run('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose name is ${app} to true`,
  ]);
}

/** Is `name` (from frontmostApp) one of the terminals rotpilot lives in? Lets the
 * daemon tell "you're sitting in the terminal" from "you're off in another app",
 * which is the difference between a focus grab being helpful and being rude. */
export function isTerminalApp(name: string): boolean {
  return /^(kitty|ghostty)$/i.test(name.trim());
}

/**
 * Close TV windows nothing owns any more.
 *
 * The TV is normally torn down by the daemon that launched it — but a daemon
 * that dies without cleaning up (crash, kill -9, a machine that slept) leaves
 * the window running forever, and `uninstall` could not reap it either, since
 * it asks the daemon to do the closing and there is no daemon left. One was
 * found still alive 13 days after the daemon that spawned it.
 *
 * Matching is on rotpilot's OWN window title, which nothing else sets.
 */
export async function killOrphanTvWindows(): Promise<number> {
  const find = (): Promise<number[]> =>
    new Promise((resolve) => {
      execFile('pgrep', ['-f', 'kitty --title=rotpilot-tv'], (_e, out) => {
        resolve(
          (out ?? '')
            .split('\n')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n > 0),
        );
      });
    });
  const signal = (pids: number[], sig: NodeJS.Signals): void => {
    for (const pid of pids) {
      try {
        process.kill(pid, sig);
      } catch {}
    }
  };
  const before = await find();
  if (!before.length) return 0;
  // kitty does not exit on SIGTERM here, so escalate rather than report a
  // success we never confirmed — the count returned is what actually died.
  signal(before, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  const stubborn = await find();
  if (stubborn.length) {
    signal(stubborn, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
  }
  const after = await find();
  return before.length - after.length;
}
