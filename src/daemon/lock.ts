/**
 * The daemon singleton lock.
 *
 * Its own module so it can be tested without booting a daemon — which launches
 * Chrome and can re-spawn itself on a macOS automation denial, making any
 * process-counting test of the lock meaningless.
 */
import fs from 'node:fs';

/**
 * Take the lock atomically. Returns false when a LIVE owner already holds it.
 *
 * The original guard read the pid, checked it was alive, then wrote — three
 * steps, no atomicity. Hooks arrive in bursts at session start and each can
 * spawn a daemon, so two routinely got past the read before either wrote: the
 * second clobbered the file and the first ran on untracked, holding a Chrome
 * that `rotpilot stop` could never reach, fighting the live daemon over the
 * shared profile. Observed live: two daemons 27 minutes apart, one pid file.
 *
 * `wx` is create-or-fail in a single syscall, so exactly one racer can win.
 * A file left by a daemon that died hard is detected (pid no longer alive),
 * removed, and retried once.
 */
export function claimPidLock(pidPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(pidPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      if (ownerIsAlive(pidPath)) return false;
      try {
        fs.unlinkSync(pidPath); // stale — clear it and try once more
      } catch {}
    }
  }
  return false;
}

/** Is the pid in the file a process that still exists (and isn't us)? */
function ownerIsAlive(pidPath: string): boolean {
  let owner = 0;
  try {
    owner = parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
  } catch {
    return false; // unreadable/empty → treat as stale
  }
  if (!Number.isInteger(owner) || owner <= 0 || owner === process.pid) return false;
  try {
    process.kill(owner, 0); // signal 0 tests existence without touching it
    return true;
  } catch {
    return false;
  }
}

/** Drop the lock, but only if we still own it — never delete a successor's. */
export function releasePidLock(pidPath: string): void {
  try {
    if (parseInt(fs.readFileSync(pidPath, 'utf8'), 10) === process.pid) fs.unlinkSync(pidPath);
  } catch {}
}
