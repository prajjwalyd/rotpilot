/**
 * rotpilot's CLI look — one place for the palette and output primitives so
 * every command reads the same. Colors strip themselves when output isn't a
 * TTY or NO_COLOR is set, so piped output stays clean.
 *
 * The palette + status glyphs are hand-rolled (no color lib needed). There are
 * no frames: a lime ▎ marks every heading and whitespace does the separating,
 * so the whole app shares one motif with zero runtime footprint (still 2
 * runtime deps).
 */
import { wordmark } from './art.js';

const colorOn =
  !process.env.NO_COLOR && process.env.TERM !== 'dumb' && !!process.stdout.isTTY;

const sgr =
  (open: string) =>
  (s: string | number): string =>
    colorOn ? `\x1b[${open}m${s}\x1b[0m` : String(s);

// palette — lime is the single accent, everything else is mono (bold/dim) or a
// semantic status color. one accent, no clutter. lime is truecolor and both
// kitty + ghostty are truecolor, so it matches the wordmark exactly.
export const bold = sgr('1');
export const dim = sgr('2');
export const brand = sgr('1;38;2;163;230;53'); // bold lime #a3e635 — the accent
export const yellow = sgr('38;5;220'); // warm secondary, used sparingly (🔥, warnings)
export const green = sgr('38;5;42');
const red = sgr('38;5;203');

// ── output components ─────────────────────────────────────────────────────
// One motif, no frames: a lime ▎ marks every heading, aligned columns carry the
// data, whitespace separates. `card()` stacks a titled block; the rest are body
// pieces that go inside one.

const MARK = '▎';

/** The single heading style app-wide: a lime ▎ before the label. */
export function heading(text: string): string {
  return brand(`${MARK} ${text}`);
}

/** A metric row — dim label, bold value, dim note — in fixed columns so notes
 * line up regardless of value width (pad BEFORE coloring). Indented 2 to sit
 * under a heading. */
export function metricRow(label: string, value: string, note = ''): string {
  return `  ${dim(label.padEnd(20))}${bold(value.padEnd(9))}${note ? '  ' + dim(note) : ''}`;
}

interface Bar {
  label: string;
  value: number;
  display: string;
}

/** A horizontal bar block: lime fill on a dim track, dim label + value. */
export function bars(rows: Bar[], width = 18): string[] {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => {
    const n = max > 0 ? Math.round((r.value / max) * width) : 0;
    return `  ${dim(r.label.padEnd(4))}${brand('█'.repeat(n))}${dim('░'.repeat(width - n))} ${dim(r.display)}`;
  });
}

/** A dim inline breakdown line: "done: 23  ·  idle: 3". */
export function meta(parts: string[]): string {
  return `  ${dim(parts.join('  ·  '))}`;
}

/** The wordmark, sized to the terminal, with an optional subtitle under it. The
 * signature masthead — same art the TV panel paints, so the CLI and the video
 * panel are visibly one product. */
export function masthead(sub?: string): void {
  const cols = process.stdout.columns || 80;
  const wm = wordmark(cols - 2, colorOn);
  console.log('');
  for (const line of wm.lines) console.log('  ' + line);
  if (sub) console.log('  ' + dim(sub));
}

/** A frameless card: a lime ▎ title, then sections — each an optional ▎ heading
 * plus body lines — separated by blank lines. No box; the marker and the
 * whitespace do the framing. Every vanity report (stats, status, recap) stacks
 * through here so they share one shape. */
export interface CardSection {
  heading?: string;
  body: string[];
}
export function card(title: string, sections: CardSection[]): string {
  const out: string[] = [heading(title)];
  for (const s of sections) {
    out.push(''); // blank line separating sections (and sitting under the title)
    if (s.heading) {
      out.push(heading(s.heading));
      out.push(''); // blank line under every sub-heading, before its content
    }
    out.push(...s.body);
  }
  return out.join('\n');
}

/** Inline emphasis for body prose: the "literals are bold" rule made concrete.
 * `code spans` (backticks stripped) and numbers (55, 720–724, 17.0s) go bold so
 * paths, identifiers, and figures pop out of the grey. Numbers first, on clean
 * text — then code — so the number pass never sees (and mangles) an SGR escape.
 * With color off, backticks are still stripped so prose reads cleanly. */
export function emphasize(text: string): string {
  if (!colorOn) return text.replace(/`([^`]+)`/g, '$1');
  return text
    .replace(/\b\d[\d.,:]*(?:[–-]\d[\d.,:]*)?\w*/g, (n) => {
      const tail = n.match(/[.,:]+$/); // keep trailing punctuation out of the bold
      return tail ? bold(n.slice(0, -tail[0].length)) + tail[0] : bold(n);
    })
    .replace(/`([^`]+)`/g, (_m, c) => bold(c));
}

/** Reflow prose to `width`, every line prefixed with `indent`, with inline
 * emphasis applied after wrapping (so the zero-width escapes never skew the
 * column math). */
export function wrapText(s: string, indent = '  ', width = 76): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`(.{1,${width}})(\\s+|$)`, 'g'), `${indent}$1\n`)
    .trimEnd()
    .split('\n')
    .map(emphasize)
    .join('\n');
}

// status lines — the same glyphs everywhere
export const ok = (s: string): string => `${green('✓')} ${s}`;
export const no = (s: string): string => `${red('✗')} ${s}`;
export const warn = (s: string): string => `${yellow('⚠')}  ${s}`;
export const note = (s: string): string => `${dim('·')} ${dim(s)}`;

// list + flow pieces — one shape everywhere. bullets sit under a heading (indent
// 2); steps lead with a lime index; tips are dim › suggestions with the runnable
// command in bold, so "here's what to run next" always looks the same.

/** An unordered list item: a dim · bullet + text, indented under a heading. */
export const bullet = (s: string): string => `  ${dim('·')} ${s}`;

/** A numbered step for setup flows: a lime index + text. */
export const step = (n: number, s: string): string => `  ${brand(String(n))}  ${s}`;

/** A suggestion / next-action line: a dim › lead with the runnable command in
 * bold. Set it off from surrounding content with a blank line. */
export function tip(lead: string, command?: string): string {
  const head = `  ${dim(`› ${lead}`)}`;
  return command ? `${head} ${bold(command)}` : head;
}

/** A one-line status spinner on stderr (no-op when stderr isn't a TTY, so it
 * never pollutes piped stdout). Frame in lime at column 0 — aligned with the ▎
 * headings — and the message dim at column 2, aligned with body text; the line
 * is wiped each tick so nothing smears. Returns a stop() that clears the line. */
export function spinner(msg: string): () => void {
  if (!process.stderr.isTTY) return () => {};
  const frames = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
  let i = 0;
  const iv = setInterval(() => process.stderr.write(`\r\x1b[2K${brand(frames[i++ % frames.length])} ${dim(msg)}`), 80);
  iv.unref?.();
  return () => {
    clearInterval(iv);
    process.stderr.write('\r\x1b[2K');
  };
}
