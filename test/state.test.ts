/**
 * The state machine decides when video plays, freezes, and resumes. Every bug
 * users actually reported lived here, so each test below is a regression that
 * shipped once: the thinking phase playing nothing, a permission pause that
 * flashed and resumed, a `p` that the next tool call undid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine, type ExitInfo } from '../src/daemon/state.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Short debounces keep the suite fast; the ratios match production. */
function harness() {
  const calls: string[] = [];
  const sm = new StateMachine(
    {
      enter: () => calls.push('enter'),
      resume: () => calls.push('resume'),
      pause: (i: ExitInfo) => calls.push('pause:' + i.reason),
      stop: (i: ExitInfo) => calls.push('stop:' + i.reason),
    },
    25, // cold
    10, // resume
    60, // prompt
  );
  // mirrors the daemon's gate: work signals are swallowed while `p` is held
  let manualPause = false;
  return {
    calls,
    sm,
    hook(event: string, ctx: Record<string, unknown> = {}) {
      if (event === 'prompt') manualPause = false;
      if (event === 'work-start' && manualPause) return;
      sm.onEvent(event, ctx);
    },
    pressP() {
      if (sm.state !== 'idle') {
        manualPause = true;
        sm.onEvent('snap-back', { reason: 'manual' });
      }
    },
    pressR() {
      manualPause = false;
      if (sm.state === 'paused') sm.resumeNow();
    },
    held: () => manualPause,
  };
}

test('a submitted prompt starts playback — thinking time is rot time', async () => {
  const h = harness();
  h.hook('prompt', { sessionId: 's' });
  await wait(90);
  assert.equal(h.sm.state, 'playing');
  assert.deepEqual(h.calls, ['enter']);
});

test('a tool call during playback does not re-trigger', async () => {
  const h = harness();
  h.hook('prompt', { sessionId: 's' });
  await wait(90);
  h.hook('work-start', { sessionId: 's' });
  await wait(60);
  assert.deepEqual(h.calls, ['enter']);
});

test('a permission arriving inside the debounce cancels the play — no flash', async () => {
  const h = harness();
  h.hook('work-start', { sessionId: 's' }); // PreToolUse, cold
  h.sm.onEvent('snap-back', { sessionId: 's', reason: 'permission' });
  await wait(80);
  assert.deepEqual(h.calls, [], 'nothing should have rendered');
  assert.equal(h.sm.state, 'idle');
});

test('an async straggler cannot flash-resume a permission pause', async () => {
  const h = harness();
  h.hook('prompt', { sessionId: 's' });
  await wait(90);
  h.sm.onEvent('snap-back', { sessionId: 's', reason: 'permission' });
  await wait(120);
  // a work-start spawned before the pause, delivered after it
  h.hook('work-start', { sessionId: 's' });
  await wait(60);
  assert.deepEqual(h.calls, ['enter', 'pause:permission']);
});

test('a real approval still resumes once the guard window passes', async () => {
  const h = harness();
  h.hook('prompt', { sessionId: 's' });
  await wait(90);
  h.sm.onEvent('snap-back', { sessionId: 's', reason: 'permission' });
  await wait(800);
  h.hook('work-start', { sessionId: 's' });
  await wait(40);
  assert.deepEqual(h.calls, ['enter', 'pause:permission', 'resume']);
});

test('resumeNow steps over the straggler guard (auto-resume timer, r key)', async () => {
  const h = harness();
  h.hook('prompt', { sessionId: 's' });
  await wait(90);
  h.sm.onEvent('snap-back', { sessionId: 's', reason: 'permission' });
  h.sm.resumeNow(); // immediately, well inside the guard
  await wait(40);
  assert.deepEqual(h.calls, ['enter', 'pause:permission', 'resume']);
});

test('p pauses like a permission, and claude working cannot undo it', async () => {
  const h = harness();
  h.hook('prompt', { sessionId: 's' });
  await wait(90);
  h.pressP();
  assert.deepEqual(h.calls, ['enter', 'pause:manual']);
  h.hook('work-start', { sessionId: 's' });
  await wait(60);
  h.hook('work-start', { sessionId: 's' });
  await wait(60);
  assert.deepEqual(h.calls, ['enter', 'pause:manual'], 'the hold must survive tool calls');
  h.pressR();
  await wait(40);
  assert.deepEqual(h.calls, ['enter', 'pause:manual', 'resume']);
});

test('the next prompt releases a held p — same contract as q', async () => {
  const h = harness();
  h.hook('prompt', { sessionId: 's' });
  await wait(90);
  h.pressP();
  h.hook('prompt', { sessionId: 's' });
  await wait(90);
  assert.equal(h.held(), false);
  assert.deepEqual(h.calls, ['enter', 'pause:manual', 'resume']);
});

test('p while idle is a no-op', () => {
  const h = harness();
  h.pressP();
  assert.deepEqual(h.calls, []);
  assert.equal(h.held(), false);
});

test('done gets a longer suppression window than a permission', async () => {
  const h = harness();
  h.hook('prompt', { sessionId: 's' });
  await wait(90);
  h.sm.onEvent('snap-back', { sessionId: 's', reason: 'done' });
  await wait(800); // past the 700ms permission guard, inside done's 1500ms
  h.hook('work-start', { sessionId: 's' });
  await wait(40);
  assert.deepEqual(h.calls, ['enter', 'pause:done']);
});

test('a prompt clears the post-done suppression', async () => {
  const h = harness();
  h.hook('prompt', { sessionId: 'a' });
  await wait(90);
  h.sm.onEvent('snap-back', { sessionId: 'a', reason: 'done' });
  h.sm.onEvent('snap-back', { sessionId: 'a', reason: 'session-end' });
  h.hook('prompt', { sessionId: 'b' });
  await wait(90);
  assert.deepEqual(h.calls, ['enter', 'pause:done', 'stop:session-end', 'enter']);
});

test('one cycle, one session: another session cannot steer it', async () => {
  const h = harness();
  h.hook('prompt', { sessionId: 'A' });
  await wait(90);
  h.sm.onEvent('snap-back', { sessionId: 'B', reason: 'done' });
  await wait(20);
  assert.deepEqual(h.calls, ['enter']);
  assert.equal(h.sm.owner, 'A');
});

test('a rot window is counted exactly once', async () => {
  const windows: number[] = [];
  const sm = new StateMachine(
    {
      enter: () => {},
      resume: () => {},
      pause: (i: ExitInfo) => windows.push(i.rotSeconds),
      stop: (i: ExitInfo) => windows.push(i.rotSeconds),
    },
    25,
    10,
    60,
  );
  sm.onEvent('prompt', { sessionId: 's' });
  await wait(90);
  sm.onEvent('snap-back', { sessionId: 's', reason: 'permission' });
  sm.onEvent('snap-back', { sessionId: 's', reason: 'permission' }); // joke refresh
  assert.equal(windows.length, 2);
  assert.equal(windows[1], 0, 'the repeat snap-back must not re-count the window');
});
