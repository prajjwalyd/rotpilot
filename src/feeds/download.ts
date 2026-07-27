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

export type LoopStatus = 'present' | 'downloaded' | 'no-ytdlp' | 'failed';

/** Ensure loop.mp4 exists. Non-fatal: returns a status the caller reports. */
export function ensureLoopVideo(url = DEFAULT_LOOP_URL, log: (s: string) => void = () => {}): LoopStatus {
  if (loopExists()) return 'present';
  if (!have('yt-dlp')) return 'no-ytdlp';

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = path.join(CONFIG_DIR, 'loop.download.mp4');
  try {
    fs.rmSync(tmp, { force: true });
  } catch {}

  log('downloading the default brainrot loop (one-time)…');
  // video-only, ≤1080 tall, mp4 — no audio needed, and avoids a mux/merge step
  const dl = spawnSync(
    'yt-dlp',
    ['-f', 'bv[height<=1080][ext=mp4]/bv[height<=1080]/b[height<=1080]', '-o', tmp, url],
    { stdio: 'inherit' },
  );
  if (dl.status !== 0 || !fs.existsSync(tmp)) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return 'failed';
  }

  if (have('ffmpeg')) {
    // shrink to the panel's native 480×854 and drop audio → a lean loop
    log('optimizing…');
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
