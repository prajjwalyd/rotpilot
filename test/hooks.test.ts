/**
 * Hook installation writes into the user's Claude Code settings, so the
 * guarantees here are safety properties, not niceties: it must be idempotent,
 * it must fully remove itself, and it must never touch the global settings file.
 *
 * Every test uses a throwaway project dir. Nothing here reads or writes
 * ~/.claude — `uninstallGlobalHooks` is deliberately not exercised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHooks, uninstallHooks, hooksInstalled } from '../src/hooks/install.js';

function project(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rp-hooks-'));
}
const settings = (dir: string) => path.join(dir, '.claude', 'settings.local.json');
const read = (dir: string) => JSON.parse(fs.readFileSync(settings(dir), 'utf8'));

interface Entry {
  matcher?: string;
  hooks: Array<{ command: string; async?: boolean; timeout?: number }>;
}
function wiring(dir: string): Array<{ event: string; arg: string; sync: boolean; matcher?: string }> {
  const hooks = read(dir).hooks as Record<string, Entry[]>;
  return Object.entries(hooks).flatMap(([event, entries]) =>
    entries.flatMap((e) =>
      e.hooks.map((h) => ({
        event,
        arg: /hook (\S+)$/.exec(h.command)?.[1] ?? '?',
        sync: !h.async,
        matcher: e.matcher,
      })),
    ),
  );
}

test('installs and reports installed', () => {
  const dir = project();
  installHooks(dir);
  assert.ok(fs.existsSync(settings(dir)));
  assert.equal(hooksInstalled(dir), true);
});

test('PermissionRequest is SYNC — it must beat the dialog to the screen', () => {
  const dir = project();
  installHooks(dir);
  const pr = wiring(dir).find((w) => w.event === 'PermissionRequest');
  assert.ok(pr, 'PermissionRequest must be wired');
  assert.equal(pr.arg, 'attention');
  assert.equal(pr.sync, true, 'async would let the dialog paint before the feed freezes');
});

test('work signals are async so they never block claude', () => {
  const dir = project();
  installHooks(dir);
  const w = wiring(dir);
  for (const event of ['PreToolUse', 'PostToolUse', 'MessageDisplay', 'UserPromptSubmit']) {
    assert.equal(w.find((x) => x.event === event)?.sync, false, `${event} should be async`);
  }
});

test('pause and lifecycle signals stay sync so they survive `claude -p` exiting', () => {
  const dir = project();
  installHooks(dir);
  const w = wiring(dir);
  for (const event of ['Stop', 'StopFailure', 'SessionEnd', 'Notification']) {
    assert.equal(w.find((x) => x.event === event)?.sync, true, `${event} must not be droppable`);
  }
});

test('no "*" matcher — it is not a valid regex', () => {
  const dir = project();
  installHooks(dir);
  // documented syntax: a matcher with special chars compiles as an unanchored
  // regex, and new RegExp('*') throws "Nothing to repeat". Omit for match-all.
  for (const w of wiring(dir)) assert.notEqual(w.matcher, '*');
  const raw = fs.readFileSync(settings(dir), 'utf8');
  assert.ok(!raw.includes('"matcher": "*"'));
});

test('an API error ends the rot too (StopFailure), and denials resume', () => {
  const dir = project();
  installHooks(dir);
  const w = wiring(dir);
  assert.equal(w.find((x) => x.event === 'StopFailure')?.arg, 'done');
  assert.equal(w.find((x) => x.event === 'PermissionDenied')?.arg, 'work-start');
});

test('Notification covers permission, idle and MCP elicitation', () => {
  const dir = project();
  installHooks(dir);
  const m = wiring(dir).find((x) => x.event === 'Notification')?.matcher ?? '';
  for (const kind of ['permission_prompt', 'idle_prompt', 'elicitation_dialog']) {
    assert.ok(m.includes(kind), `${kind} missing from ${m}`);
  }
});

test('commands use absolute node + absolute cli — hooks run without a PATH', () => {
  const dir = project();
  installHooks(dir);
  for (const { command } of Object.values(read(dir).hooks as Record<string, Entry[]>).flat().flatMap((e) => e.hooks)) {
    assert.match(command, /^"\/.*" "\/.*" hook \S+$/, command);
  }
});

test('re-installing does not duplicate (init is documented as idempotent)', () => {
  const dir = project();
  installHooks(dir);
  const first = wiring(dir).length;
  installHooks(dir);
  installHooks(dir);
  assert.equal(wiring(dir).length, first);
});

test('uninstall removes the file it created', () => {
  const dir = project();
  installHooks(dir);
  uninstallHooks(dir);
  assert.equal(fs.existsSync(settings(dir)), false);
  assert.equal(hooksInstalled(dir), false);
});

test("uninstall preserves the user's own settings and hooks", () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    settings(dir),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    }),
  );
  installHooks(dir);
  uninstallHooks(dir);
  const after = read(dir);
  assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] }, 'unrelated settings must survive');
  assert.equal(after.hooks.PreToolUse.length, 1);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'echo mine', "the user's own hook must survive");
});
