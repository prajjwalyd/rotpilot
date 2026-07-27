/**
 * Read-time synthesis for `rotpilot recap`. Engram stores atomic, searchable
 * memory fragments; this turns a pile of them into ONE fun, sardonic briefing
 * — the payoff of the gag: you rotted, and here's the adult-in-the-room
 * catching you up while rubbing it in.
 *
 * It borrows the user's OWN Claude (the `claude` CLI they already have, since
 * rotpilot is a Claude Code companion) running Haiku — no extra API key, no
 * new dependency. Isolated on purpose: `--strict-mcp-config` with an empty
 * config skips MCP load, and it runs from a neutral cwd so rotpilot's own
 * project hooks never fire (no recursion). Every failure mode — no `claude`,
 * not logged in, timeout, empty output — returns null, and recap falls back
 * to a plain (still de-noised) list. The synthesis is a bonus, never a
 * dependency.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CONFIG_DIR, ensureConfigDir } from '../config.js';
import type { EngramMemory } from './engram.js';
import { renderMessages, type ConvMessage } from './transcript.js';
import { log } from '../log.js';

export const MODEL = process.env.ROTPILOT_SUMMARY_MODEL || 'claude-haiku-4-5';

let claudeChecked = false;
let claudePath: string | null = null;

/** Resolve an executable on PATH without spawning a shell (a shelled-out
 * `command -v` triggers Node's DEP0190 warning). */
function findOnPath(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/** Is the `claude` CLI available? Disable entirely with ROTPILOT_SUMMARY=0. */
export function summarizerAvailable(): boolean {
  if (process.env.ROTPILOT_SUMMARY === '0') return false;
  if (claudeChecked) return claudePath != null;
  claudeChecked = true;
  claudePath = findOnPath('claude');
  return claudePath != null;
}

/** An empty MCP config file (written once) so `claude` skips MCP startup. */
function emptyMcpConfig(): string {
  const p = path.join(CONFIG_DIR, 'empty-mcp.json');
  try {
    if (!fs.existsSync(p)) {
      ensureConfigDir();
      fs.writeFileSync(p, '{"mcpServers":{}}');
    }
  } catch {}
  return p;
}

/** Run Haiku headless on `prompt`, prompt via stdin. null on any trouble.
 * The full recap prompt takes ~10-17s idle, but spikes well past 30s when the
 * session is busy (daemon capturing frames + Chrome running) — which is exactly
 * when recap runs — so give it generous headroom before falling back. */
function runClaude(prompt: string, timeoutMs = 60000): Promise<string | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        claudePath || 'claude',
        ['-p', '--model', MODEL, '--strict-mcp-config', '--mcp-config', emptyMcpConfig()],
        // neutral cwd: no project hooks (no rotpilot recursion), no project CLAUDE.md
        { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      return resolve(null);
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    proc.stdout.on('data', (d) => (out += d.toString('utf8')));
    proc.stderr.on('data', (d) => (err += d.toString('utf8')));
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      // "Not logged in", a non-zero exit, or empty output → fall back silently
      if (code !== 0 || !text || /not logged in/i.test(out) || /not logged in/i.test(err)) {
        if (err.trim()) log('summarize: claude failed', err.trim().slice(0, 200));
        return resolve(null);
      }
      resolve(text);
    });
    try {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

const VOICE =
  'You are rotpilot: a sardonic terminal companion that plays brainrot videos while Claude Code does ' +
  "the actual work, then catches the user up on what they missed while they watched reels. You just " +
  'watched this person doomscroll while an AI fixed their code. Dry, funny, a little mean — think ' +
  '"claude finished. one of you had to." Keep every technical specific EXACT (file names, line numbers, ' +
  'the actual bug) and NEVER invent facts not in the fragments. Drop mechanical noise (opening files, ' +
  'running searches). Second person ("you"). Terse. Lowercase. No markdown "#" headers, no preamble.';

/** Engram's `created_at` as a numeric sort key (one rot window = one commit).
 * Undated memories sort last (-Infinity). */
function fragTime(iso?: string): number {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : -Infinity;
}

/** Fragments, newest-first. Recency is carried by ORDER, not a printed date:
 * an absolute date label would fight the date extraction bakes into the content
 * (commit day vs. work day can differ) and give Haiku a second, conflicting
 * clock. The prompts just tell it the list is newest-first — retrieval still
 * ranks by relevance; the freshest fragment simply leads the context. */
function frags(mems: EngramMemory[]): string {
  return [...mems]
    .sort((a, b) => fragTime(b.created_at) - fragTime(a.created_at))
    .map((m) => `[${m.topic ?? '?'}] ${m.content}`)
    .join('\n');
}

/** rotContext (from the local rot store) lets Haiku reference real rot
 * durations/recency instead of guessing from a memory's date. */
function ctxBlock(rotContext?: string): string {
  return rotContext ? `\nthe user's actual rot stats (facts you may cite):\n${rotContext}\n` : '';
}

// exact section-header rule so the CLI can reliably style the headers (Haiku
// otherwise drifts between "claude handled", "Claude handled:", "**...**", etc.)
const HEADER_RULE =
  'Write each section header on its OWN line, EXACTLY "claude handled" and "your move" — lowercase, ' +
  'no colon, no asterisks, no markdown, nothing else on the line.';

/** The exact prompt sent to Haiku for a project recap (also what `--raw` shows). */
export function recapPrompt(
  project: string,
  looseEnds: EngramMemory[],
  work: EngramMemory[],
  rotContext?: string,
): string {
  return (
    `${VOICE}\n${ctxBlock(rotContext)}\nBelow are memory fragments of what Claude did in the project ` +
    `"${project}" while the user was away. Write the recap in this exact shape:\n` +
    '1. ONE punchy roast line about them rotting while claude worked — reference what claude actually did ' +
    '(and their rot stats if it makes the burn land).\n' +
    '2. a section headed "claude handled" — 1-3 tight bullets of what got DONE (the flex).\n' +
    '3. a section headed "your move" — 1-3 bullets of what still needs THEM (decisions, approvals, ' +
    'unfinished work), framed like handing them the bill. If a loose end looks resolved or superseded by ' +
    'later work in the fragments, leave it out. Omit this section entirely if nothing is unresolved.\n' +
    `${HEADER_RULE}\n\n` +
    'The fragments below are ordered newest-first; when two describe the same thing, the one ' +
    'higher in the list is more recent, so trust it.\n' +
    `fragments:\n${frags([...looseEnds, ...work])}`
  );
}

/** The exact prompt sent to Haiku for question mode (also what `--raw` shows). */
export function answerPrompt(question: string, mems: EngramMemory[], rotContext?: string): string {
  return (
    `${VOICE}\n${ctxBlock(rotContext)}\nThe user — back from rotting — asks: "${question}"\n` +
    'Answer it from the fragments and rot stats below in 1-4 sentences (or a few tight bullets if that fits ' +
    'better). Lead with the answer. If the material genuinely does not cover it, say so with a shrug — do ' +
    'not make anything up. The fragments are ordered newest-first — when they conflict or describe ' +
    `state that changed, trust the one nearer the top.\n\nfragments:\n${frags(mems)}`
  );
}

/** The project briefing: a roast line + "claude handled" + "your move". */
export function funRecap(
  project: string,
  looseEnds: EngramMemory[],
  work: EngramMemory[],
  rotContext?: string,
): Promise<string | null> {
  return runClaude(recapPrompt(project, looseEnds, work, rotContext));
}

/** Question mode: answer the user's question from the retrieved fragments. */
export function funAnswer(question: string, mems: EngramMemory[], rotContext?: string): Promise<string | null> {
  return runClaude(answerPrompt(question, mems, rotContext));
}

/** The exact prompt for a LOCAL (Tier-0) recap: same voice + shape as the Engram
 * recap, but the input is a compact slice of the live session transcript rather
 * than pre-extracted memory fragments. Also what `recap --raw` shows locally. */
export function localRecapPrompt(project: string, messages: ConvMessage[], rotContext?: string): string {
  return (
    `${VOICE}\n${ctxBlock(rotContext)}\nBelow is the slice of the Claude Code session in the project ` +
    `"${project}" that scrolled past while the user rotted — their prompts, Claude's narration, and the ` +
    `edits/commands it ran (oldest to newest, "→" lines are tool actions). Write the recap in this exact shape:\n` +
    '1. ONE punchy roast line about them rotting while claude worked — reference what claude actually did.\n' +
    '2. a section headed "claude handled" — 1-3 tight bullets of what got DONE (the flex).\n' +
    '3. a section headed "your move" — 1-3 bullets of what still needs THEM (open questions, approvals, ' +
    'unfinished work). Omit this section entirely if nothing is unresolved.\n' +
    `${HEADER_RULE}\n\nsession:\n${renderMessages(messages)}`
  );
}

/** Tier-0 recap of the current session, synthesized by the local Haiku. */
export function funLocalRecap(project: string, messages: ConvMessage[], rotContext?: string): Promise<string | null> {
  return runClaude(localRecapPrompt(project, messages, rotContext));
}
