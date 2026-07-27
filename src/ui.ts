/**
 * rotpilot's CLI look — one place for the palette and output primitives so
 * every command reads the same. Colors strip themselves when output isn't a
 * TTY or NO_COLOR is set, so piped output stays clean.
 *
 * The palette + status glyphs are hand-rolled (no color lib needed); the one
 * borrowed tool is `boxen`, for the framed report cards. It's a devDependency,
 * BUNDLED into dist by tsup, so the published package still ships only two
 * runtime deps. Standardised look, no runtime footprint.
 */
import boxen from 'boxen';
import { wordmark } from './art.js';

export const colorOn =
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
export const red = sgr('38;5;203');

/** The brand lime as hex (#a3e635) — for boxen borders, which want a true
 * color, not an SGR string. */
export const BRAND_HEX = '#a3e635';

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

/** The one report frame. Every vanity card (stats, status, recap) goes through
 * here so they share a border, padding, and title style. boxen draws the box on
 * any terminal and drops the border color (via chalk) when output isn't a TTY,
 * matching how the palette above strips itself. */
export function box(content: string, title?: string): string {
  // boxen paints the whole top border via `borderColor` as one SGR span — but a
  // `\x1b[0m` reset inside the title (which brand()/bold() emit) cuts that span
  // short, leaving every dash AFTER the title uncolored: a stray white line.
  // So bold the title with 1m/22m (bold on/off — no color, no reset) and let
  // boxen's borderColor paint the title AND the border lime, uniformly.
  const t = title ? (colorOn ? `\x1b[1m${title}\x1b[22m` : title) : undefined;
  return boxen(content, {
    title: t,
    titleAlignment: 'left',
    padding: { top: 1, bottom: 1, left: 2, right: 2 },
    borderStyle: 'round',
    borderColor: BRAND_HEX,
  });
}

/** Reflow prose to `width`, every line prefixed with `indent`. */
export function wrapText(s: string, indent = '  ', width = 76): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`(.{1,${width}})(\\s+|$)`, 'g'), `${indent}$1\n`)
    .trimEnd();
}

// status lines — the same glyphs everywhere
export const ok = (s: string): string => `${green('✓')} ${s}`;
export const no = (s: string): string => `${red('✗')} ${s}`;
export const warn = (s: string): string => `${yellow('⚠')}  ${s}`;
export const note = (s: string): string => `${dim('·')} ${dim(s)}`;

/** Braille spinner on stderr (no-op when stderr isn't a TTY, so it never
 * pollutes piped stdout). Returns a stop() that clears the line. */
export function spinner(msg: string): () => void {
  if (!process.stderr.isTTY) return () => {};
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const iv = setInterval(() => process.stderr.write(`\r${dim(`${frames[i++ % frames.length]} ${msg}`)} `), 80);
  iv.unref?.();
  return () => {
    clearInterval(iv);
    process.stderr.write('\r\x1b[2K');
  };
}
