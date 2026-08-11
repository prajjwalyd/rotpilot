/** Local memory sink: one JSON file, append events, read for `stats`. */
import fs from 'node:fs';
import path from 'node:path';
import { STORE_PATH, ensureConfigDir, loadConfig } from '../config.js';
import { budgetContextLine } from './budget.js';

export interface BreakEvent {
  ts: string; // ISO timestamp of the snap-back
  sessionId?: string;
  repo?: string; // basename of cwd
  feed: string;
  reason: string; // permission | idle | done | session-end | user | watchdog
  workSeconds: number; // how long Claude worked
  rotSeconds: number; // how long you rotted
  responseLatencyMs?: number | null; // snap-back → your next action in Claude
  /** how many things claude asked you during this window — the debt stats prices */
  questions?: number;
}

interface Store {
  version: 1;
  events: BreakEvent[];
}

function read(): Store {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (Array.isArray(s.events)) return s;
  } catch {}
  return { version: 1, events: [] };
}

function write(s: Store): void {
  ensureConfigDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(s, null, 2) + '\n');
}

export function appendEvent(ev: BreakEvent): void {
  const s = read();
  s.events.push(ev);
  write(s);
}

/** Fill in how fast the user responded to the most recent snap-back. */
export function patchLastLatency(ms: number): void {
  const s = read();
  const last = s.events[s.events.length - 1];
  if (last && last.responseLatencyMs == null) {
    last.responseLatencyMs = ms;
    write(s);
  }
}

export function readEvents(): BreakEvent[] {
  return read().events;
}

/** A factual rot summary for the recap synthesizer to cite: when you last
 * rotted, that break's length, the week's tally, and how you're doing against
 * your rot budget (if set) so Haiku can rub it in. '' if no history. */
export function rotContext(): string {
  const evs = read().events;
  if (!evs.length) return '';
  const dur = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)}h`);
  const last = evs[evs.length - 1];
  const agoMs = Date.now() - Date.parse(last.ts);
  const ago =
    agoMs < 3600e3
      ? `${Math.max(1, Math.round(agoMs / 60e3))} min ago`
      : agoMs < 86400e3
        ? `${Math.round(agoMs / 3600e3)}h ago`
        : `${Math.round(agoMs / 86400e3)} days ago`;
  const week = evs.filter((e) => Date.now() - Date.parse(e.ts) < 7 * 86400e3);
  const weekRot = week.reduce((s, e) => s + e.rotSeconds, 0);
  // phrased to be un-misreadable: "Nh ago" is elapsed-since, not time-spent
  const lines = [
    `- their last rot break was ${ago} and lasted ${dur(last.rotSeconds)}${last.feed ? ` on the ${last.feed} feed` : ''}`,
    `- in total this week they've rotted for ${dur(weekRot)} across ${week.length} break${week.length === 1 ? '' : 's'} while Claude worked`,
  ];
  const budgetLine = budgetContextLine(loadConfig().budget, evs, Date.now());
  if (budgetLine) lines.push(budgetLine);
  return lines.join('\n');
}

/**
 * What to call the project you're rotting in — the scope key for every stat and
 * every Engram memory.
 *
 * The git repo ROOT, not the directory you happen to be sitting in. Plain
 * basename looked fine until you noticed how many repos contain a folder called
 * `frontend`: four, on the machine this was found on, all filing into one shared
 * bucket. `aura/frontend` and `OmniSearch/frontend` became the same project, so
 * `recap --all` blended them and "still on you" labelled both `(frontend)`,
 * which tells you nothing about where to go and fix it.
 *
 * Walks up for a `.git` rather than shelling out to git, so it costs nothing and
 * works with no git installed. Falls back to the basename outside a repo.
 */
export function repoLabel(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.basename(dir);
    const up = path.dirname(dir);
    if (up === dir) return path.basename(cwd); // hit the filesystem root
    dir = up;
  }
}
