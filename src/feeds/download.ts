/**
 * Fetch the default brainrot loop into the user's OWN config dir at init time.
 * We never bundle or redistribute the video — each user pulls their own copy
 * from YouTube via yt-dlp. If yt-dlp isn't installed the localLoop feed simply
 * falls back to the built-in canvas animation (see assets/player.html).
 */
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config.js';
import { log } from '../log.js';

// Subway Surfers (2024) gameplay, 9:16, uploaded "No Copyright" by the official
// Subway Surfers account.
const DEFAULT_LOOP_URL = 'https://www.youtube.com/watch?v=QPW3XwBoQlw';
const LOOP_PATH = path.join(CONFIG_DIR, 'loop.mp4');

function have(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function loopExists(): boolean {
  return fs.existsSync(LOOP_PATH);
}

/** Has the user already fetched the loop? Lets `init` offer it instead of
 * silently downloading 20MB from a third party on their behalf. */
export function loopReady(): boolean {
  return loopExists();
}

/** Is yt-dlp installed? `rotpilot loop` needs it and says so up front. */
export function haveYtdlp(): boolean {
  return have('yt-dlp');
}

export type LoopStatus = 'present' | 'downloaded' | 'no-ytdlp' | 'blocked' | 'failed';

/** Where a user can put the file themselves if we can't fetch it. */
export const LOOP_TARGET = LOOP_PATH;

/** The exact command to fetch the loop by hand, cookies included — the remedy
 * for `blocked`. rotpilot will NOT read your browser cookies on its own; that
 * is your call to make, so it hands you the command instead. */
export const MANUAL_LOOP_CMD = `yt-dlp --cookies-from-browser chrome -f 'bv[height<=1080]' -o ${LOOP_PATH} ${DEFAULT_LOOP_URL}`;

/** Ensure loop.mp4 exists. Non-fatal: returns a status the caller reports. */
export function ensureLoopVideo(url = DEFAULT_LOOP_URL, note: (s: string) => void = () => {}): LoopStatus {
  if (loopExists()) return 'present';
  if (!have('yt-dlp')) return 'no-ytdlp';

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = path.join(CONFIG_DIR, 'loop.download.mp4');
  try {
    fs.rmSync(tmp, { force: true });
  } catch {}

  note('downloading the default brainrot loop (one-time)…');
  // video-only, ≤1080 tall, mp4 — no audio needed, and avoids a mux/merge step
  // stderr is CAPTURED, not inherited: yt-dlp's progress bar rewrites its line
  // with \r, which off a TTY renders as one enormous wall of percentages. We
  // still need its text, because the interesting failure is not a network error.
  const dl = spawnSync(
    'yt-dlp',
    ['-f', 'bv[height<=1080][ext=mp4]/bv[height<=1080]/b[height<=1080]', '-o', tmp, url],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
  );
  if (dl.status !== 0 || !fs.existsSync(tmp)) {
    const err = String(dl.stderr ?? '').trim();
    log(`yt-dlp failed: ${err.slice(0, 400)}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    // YouTube throttles datacentre and repeat traffic with a bot check. It is
    // the most likely failure by far, and "network?" sends people debugging
    // their wifi — it needs cookies, and that is a different remedy entirely.
    return /sign in to confirm|not a bot|cookies|403|429/i.test(err) ? 'blocked' : 'failed';
  }

  if (have('ffmpeg')) {
    // shrink to the panel's native 480×854 and drop audio → a lean loop
    note('optimizing…');
    const ff = spawnSync(
      'ffmpeg',
      // prettier-ignore
      ['-y', '-i', tmp, '-vf', 'scale=480:854:flags=lanczos', '-an', '-c:v', 'libx264',
        '-crf', '30', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', LOOP_PATH],
      { stdio: 'ignore' },
    );
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    if (ff.status !== 0 || !fs.existsSync(LOOP_PATH)) return 'failed';
  } else {
    try {
      fs.renameSync(tmp, LOOP_PATH); // no ffmpeg: use the raw download as-is
    } catch {
      return 'failed';
    }
  }
  return 'downloaded';
}
