/**
 * The daemon singleton lock. Tested here rather than by counting daemons,
 * because booting a daemon launches Chrome and can re-spawn itself on a macOS
 * automation denial — so process counts prove nothing about the lock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { claimPidLock, releasePidLock } from '../src/daemon/lock.js';

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-lock-')), 'daemon.pid');

test('an uncontended lock is taken, and records the owner', () => {
  const p = tmp();
  assert.equal(claimPidLock(p), true);
  assert.equal(fs.readFileSync(p, 'utf8'), String(process.pid));
});

test('a LIVE owner keeps the lock — the second daemon must stand down', () => {
  const p = tmp();
  // a real process we did not start ourselves, so the liveness check is honest
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(p, String(child.pid));
    assert.equal(claimPidLock(p), false, 'must not steal a live daemon’s lock');
    assert.equal(fs.readFileSync(p, 'utf8'), String(child.pid), 'owner must be untouched');
  } finally {
    child.kill('SIGKILL');
  }
});

test('a lock left by a daemon that died hard is reclaimed', () => {
  const p = tmp();
  // A pid that definitely does not exist. Deliberately NOT "spawn then kill":
  // an unreaped child stays a zombie, and kill -0 SUCCEEDS on a zombie, so
  // waiting for it to look dead hangs forever (it did).
  let dead = 999_999;
  for (;;) {
    try {
      process.kill(dead, 0);
      dead -= 1; // taken — try a lower one
    } catch {
      break; // nobody home
    }
  }
  fs.writeFileSync(p, String(dead));
  assert.equal(claimPidLock(p), true, 'a stale lock must not wedge the daemon out forever');
  assert.equal(fs.readFileSync(p, 'utf8'), String(process.pid));
});

test('an empty or corrupt lock file is treated as stale, not as an owner', () => {
  for (const junk of ['', '   ', 'not-a-pid', '0', '-1']) {
    const p = tmp();
    fs.writeFileSync(p, junk);
    assert.equal(claimPidLock(p), true, `should reclaim on ${JSON.stringify(junk)}`);
  }
});

test('releasing only removes YOUR lock, never a successor’s', () => {
  const p = tmp();
  claimPidLock(p);
  fs.writeFileSync(p, '999999'); // pretend a successor took over
  releasePidLock(p);
  assert.ok(fs.existsSync(p), 'a straggler must not free the live daemon’s lock');
});
