/**
 * Claude Code session-transcript parsing (JSONL, one event per line).
 * Extracts the slice of conversation that streamed by during a rot window —
 * used twice: locally for the instant "while you rotted: …" line on the pause
 * screen (no network, no key), and as the payload for the opt-in Engram
 * "what you missed" memory.
 */
import fs from 'node:fs';

export interface ConvMessage {
  role: 'system' | 'user' | 'assistant';
  content?: string;
  created_at?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Keep ONLY the field that says what a tool call did, taken from the full input
 * and clipped as a value.
 *
 * The old path stringified the whole input and cut the blob at 300 chars, which
 * sliced through the middle of string values — and the extractor needs a closing
 * quote to match. Every Bash call with a long command therefore rendered as the
 * content-free "run a command": 17 of 32 action lines in a real session, more
 * than half the recap's action budget spent saying nothing.
 */
function salientInput(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const keep = (k: string, v: string, max: number): string => JSON.stringify({ [k]: clip(v.replace(/\s+/g, ' '), max) });
  if (EDIT_TOOLS.has(name)) {
    const f = str('file_path') ?? str('notebook_path');
    if (f) return keep('file_path', shortPath(f), 80);
  }
  if (COMMAND_TOOLS.has(name)) {
    const c = str('command');
    if (c) return keep('command', commandHead(c), 70);
  }
  for (const k of ['pattern', 'query', 'url', 'description', 'prompt']) {
    const v = str(k);
    if (v) return keep(k, v, 80);
  }
  return '{}';
}

/**
 * The SHAPE of a command, not its payload. A recap reader wants "ran pytest",
 * never 400 characters of python heredoc — so cut at the first separator and
 * keep the head. `curl … | python3 -c '…'` becomes `curl …`.
 */
function commandHead(c: string): string {
  const segs = c
    .split(/\n|\||;|&&/)
    .map((s) => s.trim())
    .filter(Boolean);
  // `cd /tmp && python3 …` did python, not cd. Skip the scaffolding verbs and
  // report the first segment that actually does something.
  const NOISE = /^(cd|echo|pwd|ls|export|source|set|true)\b/;
  return segs.find((s) => !NOISE.test(s)) ?? segs[0] ?? c.trim();
}

/** Last two segments of a path: `/Users/me/proj/src/a.ts` → `src/a.ts`. Absolute
 * paths are 60+ chars of prefix nobody reads, repeated on every action line. */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

// Read-only exploration tools change nothing, so shipping them to Engram just
// mints "Read the file X" / "searched for Y" memories that bloat claude_work
// and fill the recap page toward its cap with filler. Any finding worth keeping
// is in Claude's narration; the receipts that matter are edits and commands.
const NOISE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite']);

/**
 * Messages inside [sinceMs, untilMs]. Keeps user prompts and Claude's
 * narration + consequential tool calls (edits, commands — names and clipped
 * arguments carry the "what changed" detail); drops subagent sidechains, meta
 * entries, read-only exploration (NOISE_TOOLS), and tool RESULTS (huge, and the
 * narration already states outcomes).
 */
export function transcriptWindow(
  transcriptPath: string,
  sinceMs: number,
  untilMs: number,
  maxMessages = 80,
): ConvMessage[] {
  const out: ConvMessage[] = [];
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta) continue;
    const ts = Date.parse(e.timestamp ?? '');
    if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue;
    const m = e.message;
    if (!m?.role) continue;
    const blocks: any[] = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (m.role === 'user') {
      // tool results also arrive as user-role entries — text-less ones are those
      if (text) out.push({ role: 'user', content: clip(text, 1500), created_at: e.timestamp });
      continue;
    }
    const toolCalls = blocks
      .filter((b) => b?.type === 'tool_use' && b.id && b.name && !NOISE_TOOLS.has(String(b.name)))
      .map((b) => ({
        id: String(b.id),
        type: 'function' as const,
        function: { name: String(b.name), arguments: salientInput(String(b.name), b.input) },
      }));
    if (!text && toolCalls.length === 0) continue;
    out.push({
      role: 'assistant',
      content: clip(text, 1500),
      created_at: e.timestamp,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  }
  return out.slice(-maxMessages); // cap the payload; the tail is what they missed most recently
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'BashOutput']);

/** Pull the one field that says what a tool call actually DID out of its clipped
 * (often mid-string-truncated) JSON args — regex, not JSON.parse, so a truncated
 * blob still yields the file path or command instead of nothing. */
function salientArg(name: string, argsJson: string): string {
  const grab = (key: string): string | null => {
    const m = argsJson.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? m[1] : null;
  };
  if (EDIT_TOOLS.has(name)) {
    const f = grab('file_path') ?? grab('notebook_path');
    return f ? `edit ${f}` : 'edit a file';
  }
  if (COMMAND_TOOLS.has(name)) {
    const c = grab('command');
    return c ? `run ${clip(c.replace(/\s+/g, ' '), 120)}` : 'run a command';
  }
  const q = grab('pattern') ?? grab('query') ?? grab('url') ?? grab('description') ?? grab('prompt');
  return q ? `${name}: ${clip(q, 80)}` : name;
}

/**
 * Compact, token-lean rendering of a transcript window for the LOCAL recap
 * synthesizer — Claude's prose plus one short line per consequential tool call
 * ("→ edit posts.py", "→ run npm test"), oldest→newest, kept within a char
 * budget from the RECENT end so a long session never buries Haiku in context.
 */
export function renderMessages(messages: ConvMessage[], maxChars = 9000): string {
  const blocks: string[] = [];
  let used = 0;
  // Editing one file six times is one fact, not six lines. Walking newest→oldest
  // means the kept copy is the most recent, and the count rides along with it.
  const seen = new Map<string, { line: string; n: number }>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const lines: string[] = [];
    if (m.role === 'user') {
      if (m.content) lines.push(`you: ${m.content}`);
    } else if (m.role === 'assistant') {
      if (m.content) lines.push(`claude: ${m.content}`);
      for (const t of m.tool_calls ?? []) {
        const act = `  → ${salientArg(t.function.name, t.function.arguments)}`;
        const hit = seen.get(act);
        if (hit) {
          hit.n++;
          continue; // already counted on the newer copy
        }
        const entry = { line: act, n: 1 };
        seen.set(act, entry);
        lines.push(act);
      }
    }
    if (!lines.length) continue;
    const block = lines.join('\n');
    if (used + block.length > maxChars && blocks.length) break; // keep the most recent within budget
    used += block.length + 1;
    blocks.push(block);
  }
  // Stamp repeat counts now that every occurrence is tallied. Keyed on the WHOLE
  // line: a substring replace puts the ×N mid-line whenever one action line is a
  // prefix of a longer one ("run python3 - <<'EOF'" inside "…EOF' > /tmp/q.json").
  return blocks
    .reverse()
    .join('\n')
    .split('\n')
    .map((l) => {
      const hit = seen.get(l);
      return hit && hit.n > 1 ? `${l} ×${hit.n}` : l;
    })
    .join('\n');
}

/**
 * The instant dopamine: price a rot window in one dim line for the pause
 * screen — "3 edits · 2 commands · 1 question waiting". Local and free, so it
 * works from the first snap-back with no Engram anything. Returns null when
 * the window contained nothing to brag about.
 */
/** How many of Claude's messages in this window asked the user something. Stored
 * per break so `stats` can price what the local transcript is about to forget. */
export function countQuestions(messages: ConvMessage[]): number {
  return messages.filter((m) => m.role === 'assistant' && m.content?.includes('?')).length;
}

export function missedLine(messages: ConvMessage[]): string | null {
  let edits = 0;
  let commands = 0;
  let questions = 0;
  let claudeMsgs = 0;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    claudeMsgs++;
    if (m.content?.includes('?')) questions++;
    for (const t of m.tool_calls ?? []) {
      if (EDIT_TOOLS.has(t.function.name)) edits++;
      else if (COMMAND_TOOLS.has(t.function.name)) commands++;
    }
  }
  const parts: string[] = [];
  if (edits) parts.push(`${edits} edit${edits === 1 ? '' : 's'}`);
  if (commands) parts.push(`${commands} command${commands === 1 ? '' : 's'}`);
  if (questions) parts.push(`${questions} question${questions === 1 ? '' : 's'} waiting`);
  if (!parts.length && claudeMsgs) parts.push(`${claudeMsgs} message${claudeMsgs === 1 ? '' : 's'} from claude`);
  return parts.length ? `while you rotted: ${parts.join(' · ')}` : null;
}

/** Parse the last `rotSeconds` of a transcript; [] on any trouble. */
export function rotWindowMessages(transcriptPath: string | undefined, rotSeconds: number): ConvMessage[] {
  if (!transcriptPath || rotSeconds <= 0) return [];
  try {
    const until = Date.now();
    return transcriptWindow(transcriptPath, until - rotSeconds * 1000 - 2000, until);
  } catch {
    return [];
  }
}
