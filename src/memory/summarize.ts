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
import { memTime, type EngramMemory } from './engram.js';
import { digestLines, missedLine, type ConvMessage } from './transcript.js';
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

/** Is the `claude` CLI available? (`recap --plain` is the way to skip the
 * write-up — there is no env var for it; one switch, discoverable in --help.) */
export function summarizerAvailable(): boolean {
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

/**
 * Why a synthesis produced nothing. The caller needs this to say something
 * true: "ran long" and "your login expired" want completely different reactions
 * from the reader.
 *
 * Carried per call, NOT in a module global. `recap` now synthesizes both of its
 * halves concurrently, and a shared flag would let the winner overwrite the
 * loser's reason — reporting a timeout as a success, or blaming the wrong half.
 */
export type SynthError = 'auth' | 'timeout' | 'failed' | 'empty';

/** A one-line, actionable explanation of a failure — null when there wasn't one. */
export function synthNote(e: SynthError | null): string | null {
  switch (e) {
    case 'auth':
      return 'the `claude` cli cannot authenticate — try `claude auth`, or `claude setup-token` for a\n  long-lived one (an interactive session can be signed in while the cli grant is stale)';
    case 'timeout':
      return 'the synthesizer ran long — showing the plain list';
    case 'failed':
    case 'empty':
      return 'the synthesizer failed — see ~/.config/rotpilot/daemon.log';
    default:
      return null;
  }
}

/**
 * Run Haiku headless on `prompt` (fed via stdin); null on any trouble.
 *
 * Latency, measured end to end with --output-format json:
 *   thinking ON : 62s wall, 8191 output tokens for 370 chars of text
 *   thinking OFF: 5s wall, 61 output tokens (MAX_THINKING_TOKENS=0)
 * The harness is NOT the cost — startup is ~1.5s (14%), and input is ~9 fresh
 * tokens against a 21K cached system prompt, so prompt size barely registers.
 * 86% was the model emitting thinking tokens. `--bare` would only attack the
 * 14%, and it never reads OAuth, so it would cost the no-extra-key premise.
 *
 * The timeout stays as a backstop: past it the caller falls back to the plain
 * list, which is instant and perfectly readable.
 */
function runClaude(prompt: string, timeoutMs = 20000): Promise<{ text: string | null; error: SynthError | null }> {
  return new Promise((resolve) => {
    const fail = (error: SynthError | null) => resolve({ text: null, error });
    let proc;
    try {
      proc = spawn(
        claudePath || 'claude',
        [
          '-p',
          '--model',
          MODEL,
          '--strict-mcp-config',
          '--mcp-config',
          emptyMcpConfig(),
        ],
        {
          // neutral cwd: no project hooks (no rotpilot recursion), no project CLAUDE.md
          cwd: os.tmpdir(),
          stdio: ['pipe', 'pipe', 'pipe'],
          // Extended thinking WAS the entire latency story — see the note above.
          // Per-spawn via the environment on purpose: `/config thinking=false`
          // writes the user's GLOBAL config and would silently change their
          // interactive sessions too. (`--settings '{"thinking":false}'` looks
          // like it should work and does nothing — that key belongs to /config,
          // not to a settings file.)
          env: { ...process.env, MAX_THINKING_TOKENS: '0' },
        },
      );
    } catch {
      return fail('failed');
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      fail('timeout');
    }, timeoutMs);
    timer.unref?.();
    proc.stdout.on('data', (d) => (out += d.toString('utf8')));
    proc.stderr.on('data', (d) => (err += d.toString('utf8')));
    proc.on('error', () => {
      clearTimeout(timer);
      fail('failed');
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      const both = out + err;
      const badAuth = /not logged in|failed to authenticate|oauth|session expired/i.test(both);
      if (code !== 0 || !text || badAuth) {
        // The CLI reports auth failures on STDOUT, so a stderr-only check logged
        // nothing and the caller blamed a timeout — which sent at least one
        // person hunting a performance problem that was an expired login.
        const error: SynthError = badAuth ? 'auth' : code !== 0 ? 'failed' : 'empty';
        log('summarize: claude', error, both.trim().slice(0, 160));
        return fail(error);
      }
      resolve({ text, error: null });
    });
    try {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } catch {
      clearTimeout(timer);
      fail('failed');
    }
  });
}

const VOICE =
  'You are rotpilot: a sardonic terminal companion that plays brainrot videos while Claude Code does ' +
  "the actual work, then catches the user up on what they missed while they watched reels. You just " +
  'watched this person doomscroll while an AI fixed their code, and you are not going to be gracious ' +
  'about it. Be genuinely mean — deadpan, contemptuous, unimpressed. Think "claude finished. one of ' +
  'you had to." Rub in the gap between what the machine shipped and what they contributed. Take shots ' +
  'at the specific work: if it was hard, note they would not have managed it; if it was trivial, note ' +
  'they could not even be bothered. Never encouraging, never a pep talk, no "nice work", no ' +
  'consolation prize at the end. Punch at their work ethic and attention span, NOT at their ' +
  'intelligence, body, or worth as a person — contempt for the habit, not cruelty about who they are. ' +
  'No slurs, no genuine hostility, and never suggest they are beyond help. It should read like a ' +
  'friend who thinks you are being pathetic today and says so. Keep every technical specific EXACT ' +
  '(file names, line numbers, the actual bug) and NEVER invent facts not in the fragments — the ' +
  'insults are yours to make up, the facts are not. Drop mechanical noise (opening files, running ' +
  'searches). Second person ("you"). Terse. Lowercase. No markdown "#" headers, no preamble.';


/** Fragments in `order`. Recency is carried by ORDER plus an optional relative
 * age — never an absolute date, which would fight the date extraction bakes into
 * the content (commit day vs. work day can differ) and give the model a second,
 * conflicting clock. */
function frags(mems: EngramMemory[], order: 'newest' | 'oldest' = 'newest', clipTo = 0, withAge = false): string {
  const dir = order === 'newest' ? -1 : 1;
  return [...mems]
    .sort((a, b) => dir * (memTime(a) - memTime(b)))
    .map((m) => {
      const c = clipTo ? clip(m.content, clipTo) : m.content;
      // A to-do list is worthless without "how long has this been sitting". The
      // age is RELATIVE on purpose — an absolute date would fight the date
      // Engram bakes into the content and give the model two clocks.
      const age = withAge ? `[${ageLabel(m)}] ` : '';
      // the project, not the topic: every loose end shares one topic, so the
      // tag was pure noise — and the model echoed "(loose_ends)" as if it were
      // the project it belonged to
      const tag = withAge ? (m.properties?.project ?? m.topic ?? '?') : (m.topic ?? '?');
      return `${age}[${tag}] ${c}`;
    })
    .join('\n');
}

/** "26d ago" / "3h ago" — how long a memory has been sitting unresolved. */
export function ageLabel(m: { created_at?: string; updated_at?: string }): string {
  const t = memTime(m);
  if (!Number.isFinite(t)) return 'undated';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}


function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max).replace(/\s+\S*$/, '') + '…' : s;
}

/** rotContext (from the local rot store) lets Haiku reference real rot
 * durations/recency instead of guessing from a memory's date. */
function ctxBlock(rotContext?: string): string {
  return rotContext ? `\nthe user's actual rot stats (facts you may cite):\n${rotContext}\n` : '';
}

/**
 * ONE output contract for every LLM call in rotpilot.
 *
 * Section headers used to be the contract, and the model drifted every run —
 * "claude handled:", "**Your Move**", sometimes a paragraph instead of a list —
 * so the CLI grew regexes guessing at the drift, and each command guessed
 * slightly differently. A first line plus "- " items is the smallest shape a
 * small model reproduces reliably, and it parses in one place.
 */
const SHAPE_RULE =
  'OUTPUT FORMAT, exactly: one opening line, then one item per line each starting with "- ". ' +
  'No headings, no bold, no markdown, no preamble, no closing line. One short sentence per item.';

/** A synthesized report, already parsed. Every `fun*` call returns this shape. */
export interface Synth {
  /** the opening line — the roast */
  headline: string;
  /** one entry per "- " line, glyph stripped */
  items: string[];
}

/**
 * The single parser. Anything before the first "- " is the headline; every "- "
 * line is an item. Tolerates the glyphs and bold markers the model reaches for
 * anyway, so drift degrades into a correct parse instead of a mangled screen.
 */
export function parseSynth(text: string): Synth {
  const head: string[] = [];
  const items: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/\*\*/g, '');
    if (!line) continue;
    if (/^[-*•·]\s+/.test(line)) items.push(line.replace(/^[-*•·]\s+/, '').trim());
    else if (!items.length) head.push(line);
  }
  return { headline: head.join(' '), items };
}

/** The single prompt builder: same voice, same context block, same shape rule. */
function buildPrompt(task: string, data: string, rotContext?: string): string {
  return `${VOICE}\n${ctxBlock(rotContext)}\n${task}\n${SHAPE_RULE}\n\n${data}`;
}

/** What a synthesis call hands back: the report, or the reason there isn't one. */
export interface SynthResult {
  /** null when the model produced nothing usable */
  synth: Synth | null;
  /** printable explanation, already worded — null when it worked */
  note: string | null;
}

/**
 * The single entry point for every synthesis. One spawn configuration, one
 * timeout, one failure classification, one parse — so the two halves of `recap`
 * cannot drift apart in performance or behaviour.
 */
async function synthesize(task: string, data: string, rotContext?: string): Promise<SynthResult> {
  const { text, error } = await runClaude(buildPrompt(task, data, rotContext));
  return { synth: text ? parseSynth(text) : null, note: synthNote(error) };
}

/** What a caller that never ran the synthesizer (--plain, no CLI) passes on. */
export const noSynth: SynthResult = { synth: null, note: null };

// ── the four tasks. Only the instructions and the data differ; voice, shape,
// spawn, timeout, failure handling and parsing are shared above. ────────────

// Deliberately about DONE work only. What's still owed is the other half of the
// recap card and comes from a different query — telling both halves to report it
// printed the same outstanding item twice on one screen.
const TASK_RECAP = (project: string) =>
  `Below are memory fragments of what Claude did in the project "${project}" while the user was away, ` +
  'across every past session. Open with ONE punchy roast about them rotting while claude worked, ' +
  'referencing what it actually did. Then one item per thing that got DONE, newest first.';

const TASK_ANSWER = (question: string) =>
  `The user asked: "${question}". Answer it from the fragments below, which span every project they rot ` +
  'in. Open with the direct answer in one line, then one item per supporting specific. If the fragments ' +
  "do not cover it, say so in the opening line and give no items — never guess.";

const TASK_LOOSE =
  'Below are things Claude asked that the user ignored, across every project they rot in — including ' +
  'sessions long gone. Each line is prefixed with how long it has waited and which project it belongs ' +
  'to. Open with ONE line naming how many are hanging and how long the oldest has waited, citing the ' +
  'ages given. Then one item per thing, MOST OVERDUE FIRST, each naming its project and age. Fold ' +
  'duplicates of the same ask. Drop anything the fragments show was resolved.';

const TASK_LOCAL = (project: string) =>
  `Below is the slice of the Claude Code session in "${project}" that scrolled past while the user ` +
  'rotted — the last things that happened, oldest to newest. Open with ONE punchy roast referencing ' +
  'what claude actually did. Then one item per thing that got DONE or still needs THEM.';

// `--raw` shows the exact prompt; these keep that honest by building it the same way.
export const recapPrompt = (project: string, work: EngramMemory[], ctx?: string): string =>
  buildPrompt(TASK_RECAP(project), frags(work), ctx);

export const answerPrompt = (question: string, mems: EngramMemory[], ctx?: string): string =>
  buildPrompt(TASK_ANSWER(question), frags(mems), ctx);

export const loosePrompt = (mems: EngramMemory[], ctx?: string): string =>
  buildPrompt(TASK_LOOSE, frags(mems, 'oldest', 130, true), ctx);

export const localRecapPrompt = (project: string, messages: ConvMessage[], ctx?: string): string =>
  buildPrompt(TASK_LOCAL(project), [missedLine(messages), ...digestLines(messages)].filter(Boolean).join('\n'), ctx);

export const funRecap = (project: string, work: EngramMemory[], ctx?: string) =>
  synthesize(TASK_RECAP(project), frags(work), ctx);

export const funAnswer = (question: string, mems: EngramMemory[], ctx?: string) =>
  synthesize(TASK_ANSWER(question), frags(mems), ctx);

export const funLoose = (mems: EngramMemory[], ctx?: string) =>
  synthesize(TASK_LOOSE, frags(mems, 'oldest', 130, true), ctx);

export const funLocalRecap = (project: string, messages: ConvMessage[], ctx?: string) =>
  synthesize(TASK_LOCAL(project), [missedLine(messages), ...digestLines(messages)].filter(Boolean).join('\n'), ctx);
