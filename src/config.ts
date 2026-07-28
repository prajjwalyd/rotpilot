import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// NOTE: on/off is NOT a config flag — rotpilot is on wherever its hooks live in
// the project's .claude/settings.local.json (see hooks/install.ts), and the
// hook client checks that file directly.

/** A self-imposed rot ration: at most `limitSec` per day/week. `since` anchors
 * the "days under budget" streak. rotpilot doles it out and taunts you at the
 * line — it's the warden's version of a limit, not an earnest promise. */
export interface Budget {
  limitSec: number;
  period: 'day' | 'week';
  since: string; // ISO — when the budget was set
}

export interface RotpilotConfig {
  feed: 'localLoop' | 'shorts' | 'instagram';
  fps: number;
  /** [min, max] ms per clip — safety clamps around the video-driven advance
   * (which fires when a clip has played through once). min paces ultra-short
   * loops; max is the watchdog for stalled/endless clips. */
  watchBoundsMs: [number, number];
  /** panel: split inside your kitty window (claude stays visible). window: separate OS window. */
  window: 'panel' | 'window';
  /** panel width as % of the terminal when in panel mode */
  panelBias: number;
  /** permission pauses auto-resume after this many seconds (0 = never; a real
   * work signal still resumes sooner). Claude fires no hook at approval, so
   * this is the predictable backstop. */
  autoResumeSec: number;
  /** the snap-back ding */
  sound: boolean;
  /** kill the feed's audio entirely (launches the engine Chrome with
   * --mute-audio). Default false: the feed HAS sound while it's actively
   * showing in the terminal; a silence guard in the driver mutes it whenever
   * it's prewarmed/paused/hidden, so audio never leaks from the background. */
  muteFeed: boolean;
  /** Engram (docs.weaviate.io/engram) memory — active only with an API key.
   * userId scopes this machine's memories. shareTranscripts is the EXPLICIT
   * opt-in for the "what you missed" memory: rot-window segments of the Claude
   * session transcript (your prompts + Claude's work, which can include code)
   * are sent to your Engram project for extraction. Off by default; enable
   * with `rotpilot engram transcripts on`. */
  engram: { userId: string; shareTranscripts: boolean };
  allowInstagram: boolean;
  /** optional self-imposed rot ration; unset = no budget (`rotpilot budget`) */
  budget?: Budget;
}

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'rotpilot');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const SOCKET_PATH = path.join(CONFIG_DIR, 'rotpilot.sock');
export const PID_PATH = path.join(CONFIG_DIR, 'daemon.pid');
export const LOG_PATH = path.join(CONFIG_DIR, 'daemon.log');
export const STORE_PATH = path.join(CONFIG_DIR, 'rot.json');
export const CHROME_PROFILE_DIR = path.join(CONFIG_DIR, 'chrome-profile');
export const ENGRAM_KEY_PATH = path.join(CONFIG_DIR, 'engram.key');
export const KITTY_SOCK = path.join(CONFIG_DIR, 'kitty-tv.sock');

const DEFAULT_CONFIG: RotpilotConfig = {
  feed: 'localLoop',
  fps: 20,
  watchBoundsMs: [5000, 60000],
  window: 'panel',
  panelBias: 33,
  autoResumeSec: 6,
  sound: true,
  muteFeed: false,
  engram: { userId: '', shareTranscripts: false },
  allowInstagram: false,
};

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig(): RotpilotConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw, engram: { ...DEFAULT_CONFIG.engram, ...raw.engram } };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: RotpilotConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}
