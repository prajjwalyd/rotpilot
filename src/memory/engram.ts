/**
 * OPTIONAL Engram memory (docs.weaviate.io/engram) — "what you missed".
 *
 * rotpilot's premise is that you are NOT watching while Claude works. With
 * your explicit opt-in, the transcript slice that streamed by during each rot
 * window is sent to your Engram project as CONVERSATION input, and Engram's
 * extraction pipeline splits it into the only two memories the gag needs:
 *   loose_ends    what still needs YOU: questions asked into the void,
 *                 approvals waited on, warnings you scrolled past
 *   claude_work   what Claude actually did — the receipts behind it
 * `rotpilot recap` reads them back; `rotpilot recap <question>` is a semantic
 * search across every project you ever rotted through. The did-vs-needs-you
 * split is made by extraction reading the dialogue — not by rotpilot.
 *
 * Consent model: the API key alone only enables recap READS. Transcript
 * ingestion — your prompts and Claude's work, which can include code, leaving
 * the machine for your own project — happens only after
 * `rotpilot engram transcripts on` (config engram.shareTranscripts).
 *
 * Every write is fire-and-forget: a non-awaited fetch with a silent catch and
 * a 5s timeout, so a dead network can never slow a live session. Pipeline
 * runs queue service-side and can take minutes — recap shows what has been
 * committed so far, never blocks on a run. (The INSTANT "while you rotted"
 * line on the pause screen is local — see transcript.ts — and needs none of
 * this.)
 *
 * API surface (from the published OpenAPI spec, verified live 2026-07; base is
 * /v1 even though the spec's servers field omits it):
 *   POST /memories        {input: {conversation:{messages[], metadata}},
 *                          user_id, properties} → {run_id, status}.
 *                          `properties` must carry every scope key the group
 *                          uses ({project}).
 *   POST /memories/search {query, retrieval_config{retrieval_type, limit},
 *                          topics?: [name | {name, properties}], user_id}
 *   POST /memories/list   {limit?, topics?, user_id} — same topics shape;
 *                          property filters NARROW, so omitting them reads a
 *                          project-scoped topic across all projects
 *   GET  /runs/{run_id}   → {status, error}
 */
import fs from 'node:fs';
import { loadConfig, ENGRAM_KEY_PATH, ensureConfigDir } from '../config.js';
import { transcriptWindow, type ConvMessage } from './transcript.js';
import { log } from '../log.js';

const BASE = 'https://api.engram.weaviate.io/v1';

/** rot windows shorter than this carry no missable work — don't ship them */
const MIN_ROT_WINDOW_S = 10;

/**
 * Key resolution: the ENGRAM_API_KEY env var wins; otherwise the key saved once
 * via `rotpilot engram key` (0600 file in the config dir). The file makes the
 * key visible to the daemon no matter what environment a hook spawned it with.
 */
let cachedKey: string | null | undefined;

function apiKey(): string | null {
  if (process.env.ENGRAM_API_KEY) return process.env.ENGRAM_API_KEY;
  if (cachedKey !== undefined) return cachedKey;
  try {
    cachedKey = fs.readFileSync(ENGRAM_KEY_PATH, 'utf8').trim() || null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

/** Persist the key (0600) so it survives shells that never exported it. */
export function saveApiKey(key: string): void {
  ensureConfigDir();
  fs.writeFileSync(ENGRAM_KEY_PATH, key.trim() + '\n', { mode: 0o600 });
  cachedKey = key.trim();
}

export function clearApiKey(): boolean {
  cachedKey = undefined;
  try {
    fs.rmSync(ENGRAM_KEY_PATH);
    return true;
  } catch {
    return false;
  }
}

export function engramEnabled(): boolean {
  return apiKey() != null;
}

/** The topic design `rotpilot engram` asks you to create with the project.
 * The topic SET — names, scope, bounded-ness — is fixed at project creation and
 * rotpilot targets these names/scopes exactly; the DESCRIPTIONS (the extraction
 * prompts) can be refined later in the console without recreating the project.
 * Both unbounded, both user + property "project" — one scope choice, two
 * descriptions, done. */
export const TOPIC_DESIGN = [
  {
    name: 'loose_ends',
    // `powers` is shown in the setup guide: the topic set is immutable after
    // creation, so a reader deciding whether to bother with the second one needs
    // to know which feature they would be permanently giving up.
    powers: 'the "still on you" half of recap',
    description:
      'Things that still need the user: questions Claude Code asked, approvals or input it waited for, ' +
      'warnings it raised, and follow-ups it suggested that remain unresolved.',
  },
  {
    name: 'claude_work',
    powers: 'recap --all, across past sessions',
    description:
      'Substantive work Claude Code completed while the user was away, and its outcome: features ' +
      'built, bugs fixed, files edited, tests or commands run and their results, decisions made. ' +
      'Record the OUTCOME, not the process — exclude routine exploration such as reading files, ' +
      'searching the codebase, or listing directories.',
  },
] as const;

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
  };
}

function userId(): string {
  return loadConfig().engram.userId || 'rotpilot-local';
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Local weekday + date + time, minute precision: "Friday 2026-07-03 19:45".
 * The weekday is spelled out because extraction otherwise invents one. */
function localStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The API's own words for the last failed call — `engram check` surfaces
 * this so a misconfigured project diagnoses itself. */
let lastError: string | null = null;

export function lastEngramError(): string | null {
  return lastError;
}

async function post<T>(path: string, body: Record<string, unknown>, timeoutMs = 5000): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res
        .json()
        .then((e: any) => e?.detail ?? e?.title ?? '')
        .catch(() => '');
      lastError = `${res.status}${detail ? ` — ${detail}` : ''}`;
      log(`engram ${path} failed`, lastError);
      return null;
    }
    lastError = null;
    return (await res.json()) as T;
  } catch (e) {
    lastError = String((e as Error)?.message ?? e);
    return null;
  }
}

export interface EngramMemory {
  id: string;
  content: string;
  topic?: string;
  score?: number;
  created_at?: string;
  /** last time Engram touched this memory — its merge pipeline moves this
   * forward when a repeat of the same ask folds in, so it tracks "still
   * outstanding" where created_at only records when it was first raised */
  updated_at?: string;
  properties?: Record<string, string>;
}

/**
 * When a memory was last a live concern, as a numeric sort key.
 *
 * `updated_at` over `created_at` on purpose: Engram's merge pipeline folds a
 * repeat of the same ask into the existing memory and moves `updated_at`
 * forward, so it answers "is this still outstanding" where `created_at` only
 * says when it was first raised. Undated memories sort last (-Infinity).
 */
export function memTime(m: { created_at?: string; updated_at?: string }): number {
  const t = Date.parse(m.updated_at ?? m.created_at ?? '');
  return Number.isFinite(t) ? t : -Infinity;
}

/** Topic selector for search/list: a name, optionally with a scope filter. */
export type TopicRef = string | { name: string; properties: Record<string, string> };

export function searchMemories(
  query: string,
  opts: { topics?: TopicRef[]; limit?: number } = {},
): Promise<{ memories: EngramMemory[]; total: number } | null> {
  return post('/memories/search', {
    query,
    user_id: userId(),
    ...(opts.topics ? { topics: opts.topics } : {}),
    retrieval_config: { retrieval_type: 'hybrid', limit: opts.limit ?? 8 },
  });
}

export function listMemories(
  opts: { topics?: TopicRef[]; limit?: number } = {},
): Promise<{ memories: EngramMemory[]; total: number } | null> {
  return post('/memories/list', {
    user_id: userId(),
    limit: opts.limit ?? 10,
    ...(opts.topics ? { topics: opts.topics } : {}),
  });
}

export async function runStatus(runId: string): Promise<{ status: string; error?: string } | null> {
  try {
    const res = await fetch(`${BASE}/runs/${encodeURIComponent(runId)}`, {
      headers: headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { status: string; error?: string };
  } catch {
    return null;
  }
}

/**
 * Ship one rot window ("what you missed") to Engram as conversation input.
 * Gated on BOTH the key and the explicit transcript opt-in. Fire-and-forget.
 */
export function sendRotWindow(w: {
  transcriptPath?: string;
  project?: string;
  feed: string;
  rotSeconds: number;
}): void {
  const cfg = loadConfig();
  if (!engramEnabled() || !cfg.engram.shareTranscripts) return;
  if (!w.transcriptPath || w.rotSeconds < MIN_ROT_WINDOW_S) return;
  const until = Date.now();
  const since = until - w.rotSeconds * 1000 - 2000; // pad: catch the message that kicked the window off
  let messages: ConvMessage[];
  try {
    messages = transcriptWindow(w.transcriptPath, since, until);
  } catch {
    return; // transcript unreadable — never let memory hurt the session
  }
  // nothing Claude said or did = nothing missed
  if (!messages.some((m) => m.role === 'assistant')) return;
  const project = w.project ?? 'unknown';
  messages.unshift({
    role: 'system',
    content:
      `Context: while Claude Code worked on the project "${project}", the user was away watching the ` +
      `${w.feed} feed for ${w.rotSeconds} seconds (until ${localStamp()}). ` +
      'This is the part of the session they missed.',
  });
  void post('/memories', {
    input: { conversation: { messages, metadata: { project, feed: w.feed } } },
    user_id: userId(),
    properties: { project },
  });
}

/** `engram check`'s exercise of the write path: a tiny synthetic,
 * clearly-marked conversation, scoped to the fake "rotpilot-check" project so
 * whatever extraction makes of it never appears in a real recap. */
export function sendCheckConversation(): Promise<{ run_id: string; status: string } | null> {
  return post('/memories', {
    input: {
      conversation: {
        messages: [
          {
            role: 'system',
            content:
              "Context: this is rotpilot's self-test of the conversation ingestion path, run on " +
              `${localStamp()}. It is not a real Claude Code session.`,
          },
          { role: 'user', content: 'Did the rotpilot conversation pipeline work?' },
          { role: 'assistant', content: 'Yes — rotpilot verified conversation ingestion end to end.' },
        ],
        metadata: { project: 'rotpilot-check', feed: 'none' },
      },
    },
    user_id: userId(),
    properties: { project: 'rotpilot-check' },
  });
}

// ───────────────────────────── retrieval ─────────────────────────────

/** Newest first. created_at is per-ingestion-batch (one rot window = one commit
 * = one timestamp), so this orders by rot-window recency — exactly "what you
 * missed lately". Ties (same window) keep their returned order. */
function byRecent(a: EngramMemory, b: EngramMemory): number {
  return (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0);
}

/**
 * What Claude DID in one project, across every past session — the `--all` half
 * of `recap`. Newest first. Null only when the key is missing or the API is
 * unreachable; empty `work` means Engram simply has nothing yet.
 *
 * Work only, never loose ends: those are the *other* half of the card and come
 * from `looseEnds()`, which spans every project rather than this one.
 *
 * Freshness, and the catch: `list` takes no ordering, no date filter and no
 * pagination (probed live against the strict schema; the official SDK has no
 * list method at all), so we pull a page and sort by created_at DESC ourselves.
 * The catch is WHICH page — the server truncates OLDEST-FIRST. Verified: a
 * limit of 5 against a corpus spanning Jul 2–27 returns Jul 2–3. So once one
 * project stores more than PAGE_MAX work memories, the newest — precisely what
 * this half exists to show — are the ones that fall off, and nothing in the API
 * can reach them. `capped` says the page came back full so the caller can warn
 * instead of quietly showing stale work as if it were current.
 */
export async function getRecap(project: string): Promise<{ work: EngramMemory[]; capped: boolean } | null> {
  if (!engramEnabled()) return null;
  const r = await listMemories({ topics: [{ name: 'claude_work', properties: { project } }], limit: PAGE_MAX });
  if (!r) return null;
  return { work: [...r.memories].sort(byRecent).slice(0, 8), capped: r.memories.length >= PAGE_MAX };
}

/**
 * Every loose end across EVERY project, oldest first.
 *
 * This is the one thing a local transcript physically cannot do. Claude Code's
 * per-session JSONL rotates, so the questions Claude asked while you were
 * rotting die with the session that asked them. Engram keeps them, and its
 * merge pipeline folds the same question asked across three sessions into one
 * memory instead of three.
 *
 * Oldest first on purpose: the thing you've ignored longest leads.
 */
export interface LooseEnds {
  /** oldest-still-outstanding first, inside the window */
  items: EngramMemory[];
  /** how many survive the window, before the display cap */
  inWindow: number;
  /** how many came back, at any age — see `capped` */
  total: number;
  /** the server's page was full, so `total` is a floor, not a count. Engram caps
   * `limit` at PAGE_MAX and offers no offset or cursor, so there is no way to
   * see past it; reporting a truncated number as exact would read as the whole
   * picture when it isn't.
   *
   * Truncation drops the NEWEST, which for this list is the harmless end: the
   * oldest are the most overdue and lead the list anyway. (`getRecap` wants the
   * opposite and is hurt by the same behaviour — see its note.) */
  capped: boolean;
  days: number;
}

/** Engram's hard ceiling: `limit` is rejected above this and there is no offset
 * or cursor — verified live against the API, which validates strictly. */
const PAGE_MAX = 100;

export async function looseEnds(opts: { days?: number; limit?: number } = {}): Promise<LooseEnds | null> {
  if (!engramEnabled()) return null;
  const { days = 14, limit = 6 } = opts;
  // no property filter = every project you've ever rotted in
  const r = await listMemories({ topics: ['loose_ends'], limit: PAGE_MAX });
  if (!r) return null;
  const mine = r.memories.filter((m) => m.properties?.project !== 'rotpilot-check');
  // A window, because oldest-first over ALL history showed only the fossils: with
  // 50 stored, the five 30-day-old ones filled half the list and the 45 recent
  // (actionable) ones never appeared. Cheaper prompt AND a more useful list.
  const cutoff = Date.now() - days * 86_400_000;
  const live = mine.filter((m) => memTime(m) >= cutoff);
  return {
    items: live.sort((a, b) => memTime(a) - memTime(b)).slice(0, limit),
    inWindow: live.length,
    total: mine.length,
    capped: r.memories.length >= PAGE_MAX,
    days,
  };
}

/** Semantic search across everything Claude did while the user rotted —
 * ALL projects (property filters omitted on purpose). Filters out the
 * self-test memories `engram check` writes under the fake rotpilot-check
 * project, which would otherwise surface in cross-project search. */
export async function searchRecap(question: string): Promise<{ memories: EngramMemory[]; total: number } | null> {
  const r = await searchMemories(question, { topics: ['loose_ends', 'claude_work'], limit: 10 });
  if (!r) return null;
  const memories = r.memories.filter((m) => m.properties?.project !== 'rotpilot-check').slice(0, 8);
  return { memories, total: memories.length };
}
