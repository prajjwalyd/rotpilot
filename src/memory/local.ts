/**
 * Tier-0 recap: read the CURRENT Claude Code session's own transcript and
 * summarize what streamed past while you rotted — no Engram, no key, no opt-in,
 * works from the very first rot. This is the 95% case ("what did I miss just
 * now"). The two things one local transcript can't do — recall past sessions and
 * answer questions across repos — are what the optional Engram integration adds.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { transcriptWindow, type ConvMessage } from './transcript.js';

/** Claude Code stores each session at
 * `~/.claude/projects/<cwd, with / and . as ->/<session-id>.jsonl`. Return the
 * most-recently-written transcript for `cwd` — the live (or last) session — or
 * null when the directory or a readable transcript isn't there. */
function currentTranscript(cwd: string): string | null {
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestMtime = -Infinity;
  for (const f of entries) {
    const p = path.join(dir, f);
    try {
      const mt = fs.statSync(p).mtimeMs;
      if (mt > bestMtime) {
        bestMtime = mt;
        best = p;
      }
    } catch {}
  }
  return best;
}

/** Messages from the current session in [sinceMs, now] — filtered (no noise,
 * no tool results) and capped tighter than the Engram path, since this feeds a
 * read-time synth. [] when there's no transcript or nothing in the window. */
export function localWindow(cwd: string, sinceMs: number): ConvMessage[] {
  const p = currentTranscript(cwd);
  if (!p) return [];
  try {
    return transcriptWindow(p, sinceMs, Date.now(), 60);
  } catch {
    return [];
  }
}
