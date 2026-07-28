/**
 * rotpilot's wordmark: the compact Pagga logotype in flat lime, in one place so
 * the CLI masthead and the TV panel render it IDENTICALLY. Plain text + a single
 * truecolor, so kitty and ghostty look the same.
 *
 * The block-art string is generated (figlet 'Pagga'). Change LIME to re-brand.
 */

// brand accent — lime #a3e635
const LIME = '38;2;163;230;53';

const PAGGA = "░█▀▄░█▀█░▀█▀░█▀█░▀█▀░█░░░█▀█░▀█▀\n░█▀▄░█░█░░█░░█▀▀░░█░░█░░░█░█░░█░\n░▀░▀░▀▀▀░░▀░░▀░░░▀▀▀░▀▀▀░▀▀▀░░▀░";
const PAGGA_W = 32;

/** Paint every non-empty line flat lime (or leave plain when !useColor). */
function paintLime(text: string, useColor: boolean): string {
  if (!useColor) return text;
  return text
    .split('\n')
    .map((l) => (l.trim() ? `\x1b[${LIME}m${l}\x1b[0m` : l))
    .join('\n');
}

export interface Wordmark {
  /** lime-painted (or plain) lines, ready to place */
  lines: string[];
  /** visible width in columns — for centering (the ANSI is zero-width) */
  width: number;
  /** number of rows the wordmark occupies */
  rows: number;
}

/** The rotpilot wordmark sized to fit `maxCols`: the Pagga logotype when there's
 * room, a letter-spaced plain fallback when it's really narrow. Same logic on
 * CLI and TV → consistent. */
export function wordmark(maxCols: number, useColor: boolean): Wordmark {
  if (maxCols < PAGGA_W) {
    const plain = maxCols >= 15 ? [...'rotpilot'].join(' ') : 'rotpilot';
    return { lines: [paintLime(plain, useColor)], width: [...plain].length, rows: 1 };
  }
  const rawLines = PAGGA.split('\n');
  return { lines: paintLime(PAGGA, useColor).split('\n'), width: PAGGA_W, rows: rawLines.length };
}
