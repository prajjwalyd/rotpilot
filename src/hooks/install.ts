/**
 * Write rotpilot into Claude Code's hooks — PROJECT-SCOPED.
 *
 * Hooks go into <projectDir>/.claude/settings.local.json (the per-project,
 * git-ignored settings file), NOT the global ~/.claude/settings.json. This means:
 *   - rotpilot is ON only in projects where you ran `rotpilot on`
 *   - returning to such a project keeps it on (the hooks live in the repo dir)
 *   - other projects, and your global config, stay untouched
 * The hook client additionally requires a supported terminal (kitty or Ghostty),
 * so the desktop app and the VS Code extension never trigger anything even
 * inside an enabled project.
 *
 * Schema verified against code.claude.com/docs/en/hooks (2026-07). Idempotent:
 * strips any prior rotpilot entries before adding.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const GLOBAL_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

function projectSettingsPath(projectDir: string): string {
  return path.join(projectDir, '.claude', 'settings.local.json');
}

// event → cli hook arg.
//
// ASYNC vs SYNC: high-frequency "claude is working" signals are ASYNC (docs:
// async only skips the wait, it does not delay when the hook fires) so the
// ~80ms node startup never blocks Claude's loop on every tool call/message.
// Pause and lifecycle signals stay SYNC — async hooks can be killed when
// `claude -p` exits, which would leave the feed playing forever — and
// PermissionRequest MUST be sync to beat the dialog to the screen.
//
// A matcher is omitted where we want every occurrence: per the documented
// syntax any matcher containing special characters is compiled as an unanchored
// regex, and `*` is not a valid one ("Nothing to repeat"). Omitting is the
// documented match-all.
const WIRING: Array<{ event: string; arg: string; matcher?: string; async?: boolean }> = [
  // warm the daemon + chrome before the first tool, killing cold-start lag
  { event: 'SessionStart', arg: 'session-start', async: true },
  // A submitted prompt is the START of the rot window, not just a prewarm cue:
  // it fires before the model sees the prompt, so the thinking phase — which
  // used to play nothing until the first tool call — is covered.
  { event: 'UserPromptSubmit', arg: 'prompt', async: true },
  // "Claude is working" signals → play. MessageDisplay fires while Claude is
  // streaming output, so it resumes the instant Claude responds (e.g. after you
  // answer a question) — the official replacement for tailing the transcript.
  { event: 'PreToolUse', arg: 'work-start', async: true },
  { event: 'PostToolUse', arg: 'work-start', async: true },
  { event: 'MessageDisplay', arg: 'work-start', async: true },
  // No hook fires when a permission is APPROVED, but one fires when it is
  // auto-denied — and a denial means claude carries on, so it's a resume.
  { event: 'PermissionDenied', arg: 'work-start', async: true },
  // Subagents: their tool calls fire NO hooks in the parent session (docs), so
  // SubagentStart is the only "working" signal during an agent run — and the
  // daemon counts them so a Stop while a background agent still runs is not
  // treated as "claude finished".
  { event: 'SubagentStart', arg: 'subagent-start', async: true },
  { event: 'SubagentStop', arg: 'subagent-stop' },
  // "Claude needs you" signals → pause + alert.
  //
  // PermissionRequest fires when Claude Code is ABOUT TO SHOW the dialog and is
  // consulted synchronously (it can answer the prompt on your behalf), so it
  // completes before the dialog paints — the earliest possible pause. We return
  // nothing, which is "no objection": the dialog shows exactly as it would have.
  // Notification stays as the backup for any mode where it doesn't fire.
  { event: 'PermissionRequest', arg: 'attention' },
  { event: 'Notification', arg: 'attention', matcher: 'permission_prompt|idle_prompt|elicitation_dialog' },
  { event: 'Stop', arg: 'done' },
  // a turn killed by an API error (rate limit, server error) ends without a
  // Stop; without this the feed runs on until the 10-minute watchdog
  { event: 'StopFailure', arg: 'done' },
  { event: 'SessionEnd', arg: 'session-end' },
];

function commandPrefix(): string {
  // always absolute node + absolute cli: hooks fired from sessions launched
  // outside a login shell (desktop app, IDE) have no nvm/npm PATH
  let cli = path.resolve(process.argv[1]);
  try {
    cli = fs.realpathSync(cli); // resolve the npm bin symlink to the real dist/cli.js
  } catch {}
  return `"${process.execPath}" "${cli}"`;
}

function isOurs(h: unknown): boolean {
  const cmd = (h as { command?: string })?.command ?? '';
  return / hook (session-start|prompt|work-start|subagent-start|subagent-stop|attention|done|session-end)$/.test(cmd) && /rotpilot|cli\.js/.test(cmd);
}

function readSettings(file: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function stripOurs(settings: Record<string, any>): void {
  const hooks = settings.hooks;
  if (!hooks) return;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event]
      .map((entry: any) => ({
        ...entry,
        hooks: Array.isArray(entry.hooks) ? entry.hooks.filter((h: unknown) => !isOurs(h)) : entry.hooks,
      }))
      .filter((entry: any) => !Array.isArray(entry.hooks) || entry.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
}

/** Turn rotpilot ON for one project by writing hooks into its settings.local.json. */
export function installHooks(projectDir: string): void {
  const file = projectSettingsPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = readSettings(file);
  stripOurs(settings);
  settings.hooks ??= {};
  const prefix = commandPrefix();
  for (const { event, arg, matcher, async } of WIRING) {
    const hook: Record<string, unknown> = { type: 'command', command: `${prefix} hook ${arg}`, timeout: 10 };
    if (async) hook.async = true;
    const entry: Record<string, unknown> = { hooks: [hook] };
    if (matcher) entry.matcher = matcher;
    settings.hooks[event] ??= [];
    settings.hooks[event].push(entry);
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

/** Turn rotpilot OFF for one project. Deletes the file if nothing else is in it. */
export function uninstallHooks(projectDir: string): void {
  const file = projectSettingsPath(projectDir);
  if (!fs.existsSync(file)) return;
  const settings = readSettings(file);
  stripOurs(settings);
  if (Object.keys(settings).length === 0) {
    fs.rmSync(file, { force: true });
  } else {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  }
}

export function hooksInstalled(projectDir: string): boolean {
  const settings = readSettings(projectSettingsPath(projectDir));
  return JSON.stringify(settings.hooks ?? {}).includes('hook work-start');
}

/**
 * Scrub any rotpilot hooks from the GLOBAL ~/.claude/settings.json — older
 * versions installed there. Returns true if it changed anything. Never removes
 * the user's own (non-rotpilot) settings.
 */
export function uninstallGlobalHooks(): boolean {
  if (!fs.existsSync(GLOBAL_SETTINGS)) return false;
  const settings = readSettings(GLOBAL_SETTINGS);
  const before = JSON.stringify(settings.hooks ?? {});
  stripOurs(settings);
  if (JSON.stringify(settings.hooks ?? {}) === before) return false;
  fs.writeFileSync(GLOBAL_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return true;
}
