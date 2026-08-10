/**
 * `rotpilot _tv` — runs INSIDE the dedicated kitty window (the daemon has no
 * tty, so the renderer lives where the pixels are). Connects to the daemon
 * socket, registers itself, and paints the PNG frames the daemon streams.
 * `rotpilot _tv --test` skips the socket and plays a synthetic RGBA animation
 * to prove the render path end-to-end without Chrome or the daemon.
 */
import net from 'node:net';
import { KittyRenderer, pngDims } from './kitty.js';
import { queryTermSize, type TermSize } from './terminal.js';
import { wordmark } from '../art.js';
import { SOCKET_PATH } from '../config.js';

const ESC = '\x1b';

function enterScreen(): void {
  process.stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J${ESC}[H`);
}
function exitScreen(): void {
  process.stdout.write(`${ESC}[?25h${ESC}[?1049l`);
}
/** Fit an image into the terminal preserving aspect ratio (letterboxed, centered). */
function fitRect(
  size: TermSize,
  imgW: number,
  imgH: number,
): { cols: number; rows: number; atRow: number; atCol: number } {
  const cellW = size.pxw / size.cols;
  const cellH = size.pxh / size.rows;
  const scale = Math.min(size.pxw / imgW, size.pxh / imgH);
  const cols = Math.max(1, Math.min(size.cols, Math.round((imgW * scale) / cellW)));
  const rows = Math.max(1, Math.min(size.rows, Math.round((imgH * scale) / cellH)));
  return {
    cols,
    rows,
    atRow: Math.floor((size.rows - rows) / 2) + 1,
    atCol: Math.floor((size.cols - cols) / 2) + 1,
  };
}

// SGR styles — matching the CLI palette (ui.ts): lime accent, mono body. Both
// kitty and ghostty are truecolor, so these are identical in either terminal.
const S_HEAD = `${ESC}[1m${ESC}[38;2;163;230;53m`; // bold lime #a3e635 — the accent
const S_BODY = `${ESC}[0m${ESC}[38;5;252m`; // bright grey
const S_MISSED = `${ESC}[1m${ESC}[38;5;231m`; // bold white — the "while you rotted" receipt stands out
const S_DIM = `${ESC}[2m${ESC}[38;5;245m`; // dim grey
const S_RESET = `${ESC}[0m`;

/** Wrap a string to a max width on word boundaries. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

type Block =
  | { kind: 'art'; lines: string[]; width: number }
  | { kind: 'line'; text: string; style: string }
  | { kind: 'gap'; rows: number };

/** The wordmark as a block, sized to the panel. Same art the CLI masthead
 * paints — plain text + one truecolor, so kitty and ghostty render it
 * identically (no OSC-66 kitty-only path, no banner fallback). */
function brandBlock(size: TermSize): Block {
  const wm = wordmark(size.cols - 2, true); // the TV always owns a tty → color on
  return { kind: 'art', lines: wm.lines, width: wm.width };
}

/** Render stacked, centered blocks. Art blocks (the wordmark) occupy one row per
 * line; the pre-rendered ANSI carries its own color, so we only position it. */
function paint(size: TermSize, blocks: Block[]): void {
  const height = blocks.reduce(
    (h, b) => h + (b.kind === 'art' ? b.lines.length : b.kind === 'gap' ? b.rows : 1),
    0,
  );
  let row = Math.max(1, Math.floor((size.rows - height) / 2) + 1);
  let out = `${ESC}[2J`;
  for (const b of blocks) {
    if (b.kind === 'gap') {
      row += b.rows;
      continue;
    }
    if (b.kind === 'art') {
      const col = Math.max(1, Math.floor((size.cols - b.width) / 2) + 1);
      for (const ln of b.lines) {
        out += `${ESC}[${row};${col}H${ln}`;
        row += 1;
      }
    } else {
      const col = Math.max(1, Math.floor((size.cols - b.text.length) / 2) + 1);
      out += `${ESC}[${row};${col}H${b.style}${b.text}${S_RESET}`;
      row += 1;
    }
  }
  process.stdout.write(out);
}

function pauseScreen(
  size: TermSize,
  joke: string,
  missed?: string,
  remainingSec?: number,
  manual = false,
): void {
  const w = Math.max(12, size.cols - 4);
  // a pause you asked for has no auto-resume behind it — say so plainly instead
  // of promising claude will pick it back up
  const status = manual
    ? 'stays paused until you say otherwise'
    : remainingSec == null
      ? 'resumes when claude gets back to work'
      : remainingSec > 0
        ? `resuming in ${remainingSec}s`
        : 'resuming…';
  const blocks: Block[] = [
    brandBlock(size),
    { kind: 'gap', rows: 1 },
    // "— claude needs you" is 32 cols against a panel that is often ~26, so the
    // commonest pause reason was the one the terminal broke mid-word
    ...fitLines(manual ? '⏸  ROT PAUSED — by you' : '⏸  ROT PAUSED — claude needs you', w, S_HEAD),
    { kind: 'gap', rows: 1 },
    ...wrap(joke, w).map((t): Block => ({ kind: 'line', text: t, style: S_BODY })),
    // the local "while you rotted: …" receipt — the reason to look up
    ...(missed
      ? [
          { kind: 'gap', rows: 1 } as Block,
          ...wrap(missed, w).map((t): Block => ({ kind: 'line', text: t, style: S_MISSED })),
        ]
      : []),
    { kind: 'gap', rows: 2 },
    ...wrap(status, w).map((t): Block => ({ kind: 'line', text: t, style: S_DIM })),
    { kind: 'gap', rows: 1 },
    // One key per line. As a single "press r to resume · q to dismiss" this was
    // wider than the panel, so the TERMINAL wrapped it — on the character, and
    // the last hint read "dis / miss".
    ...keyHints(['press  r  to resume', 'press  q  to dismiss'], w),
  ];
  paint(size, blocks);
}

/**
 * A line that keeps its hand-tuned spacing when it fits, and is only word-
 * wrapped when the panel is genuinely too narrow.
 *
 * Two things pull against each other here. The panel width is the user's split,
 * not ours, so a fixed string wider than `w` gets wrapped by the TERMINAL — on
 * the character, so "dismiss" came out "dis/miss". But `wrap()` splits on
 * /\s+/ and rejoins with single spaces, which would eat the double spaces that
 * set off a key letter ("press  r  to resume"). So: pass through untouched when
 * it fits, wrap only when it must.
 */
function fitLines(text: string, w: number, style: string): Block[] {
  const parts = text.length <= w ? [text] : wrap(text, w);
  return parts.map((t): Block => ({ kind: 'line', text: t, style }));
}

/** Key hints, one per line — never two keys on one line, which is what made the
 * footer too wide to fit in the first place. */
function keyHints(hints: string[], w: number): Block[] {
  return hints.flatMap((h) => fitLines(h, w, S_DIM));
}

function waitingScreen(size: TermSize): void {
  const w = Math.max(12, size.cols - 4);
  paint(size, [
    brandBlock(size),
    { kind: 'gap', rows: 2 },
    ...fitLines('waiting for claude to get to work', w, S_DIM),
  ]);
}

/** Greeting shown the moment claude starts (before any work) so the panel feels
 * like part of claude from the start. Gradient wordmark + a witty line. */
function greetingScreen(size: TermSize, msg: string): void {
  const w = Math.max(12, size.cols - 4);
  paint(size, [
    brandBlock(size),
    { kind: 'gap', rows: 2 },
    ...wrap(msg, w).map((t): Block => ({ kind: 'line', text: t, style: S_BODY })),
    { kind: 'gap', rows: 2 },
    ...fitLines('the rot begins when claude does', w, S_DIM),
    { kind: 'gap', rows: 1 },
    ...keyHints(['press  q  to dismiss'], w),
  ]);
}

export async function runTv(test: boolean, fpsArg?: number): Promise<void> {
  enterScreen();
  let size = await queryTermSize();
  const renderer = new KittyRenderer((s) => process.stdout.write(s));
  const cleanup = () => {
    try {
      renderer.clear();
      exitScreen();
    } catch {}
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  if (test) {
    await testLoop(renderer, () => size, fpsArg ?? 24);
    cleanup();
    return;
  }

  let fps = 20;
  let latest: Buffer | null = null;
  let dirty = false;
  let showingText = true;
  let screen: {
    mode: 'waiting' | 'paused' | 'idle';
    joke?: string;
    missed?: string;
    remaining?: number;
    manual?: boolean;
  } = {
    mode: 'waiting',
  };
  let timer: NodeJS.Timeout | null = null;
  let countdown: NodeJS.Timeout | null = null;
  const stopCountdown = () => {
    if (countdown) {
      clearInterval(countdown);
      countdown = null;
    }
  };

  const startLoop = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (dirty && latest) {
        dirty = false;
        if (showingText) {
          process.stdout.write(`${ESC}[2J`); // wipe the text screen before frames return
          showingText = false;
        }
        const dims = pngDims(latest);
        const r = dims ? fitRect(size, dims.w, dims.h) : { cols: size.cols, rows: size.rows, atRow: 1, atCol: 1 };
        renderer.drawFrame(latest, { fmt: 'png' }, r.cols, r.rows, r.atRow, r.atCol);
      }
    }, Math.round(1000 / fps));
  };

  waitingScreen(size);

  const sock = net.createConnection(SOCKET_PATH);
  const send = (m: unknown) => {
    try {
      sock.write(JSON.stringify(m) + '\n');
    } catch {}
  };
  sock.on('connect', () => send({ t: 'tv-hello', ...size }));

  // Keys inside the TV: q / esc / ctrl-c = "stop feeding me" (snoozes until the
  // next prompt); ↑/↓ = drive the feed by hand.
  const armKeys = () => {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
  };
  process.stdin.on('data', (d) => {
    const s = d.toString('utf8');
    // Arrows before the stop check: they arrive as a CSI sequence ('\x1b[B'),
    // which is not bare '\x1b', so esc-to-quit still only fires on a real esc.
    // Both forms — terminals send SS3 ('\x1bOB') in application cursor mode.
    if (s === '\x1b[B' || s === '\x1bOB') return send({ t: 'scroll', dir: 'down' });
    if (s === '\x1b[A' || s === '\x1bOA') return send({ t: 'scroll', dir: 'up' });
    // p / r — hold and release the rot yourself, the same resident pause claude
    // triggers when it needs you
    if (s === 'p') return send({ t: 'user-pause' });
    if (s === 'r') return send({ t: 'user-resume' });
    // exact keystrokes only — CSI responses to our size queries also land here
    if (s === 'q' || s === 'x' || s === '\x1b' || s === '\x03') {
      send({ t: 'user-stop' });
    }
  });
  armKeys();

  process.stdout.on('resize', async () => {
    size = await queryTermSize();
    renderer.clear();
    send({ t: 'tv-resize', ...size });
    // if a text screen is up (not video), repaint it at the new size
    if (showingText) {
      if (screen.mode === 'paused' && screen.joke)
        pauseScreen(size, screen.joke, screen.missed, screen.remaining, screen.manual);
      else if (screen.mode === 'idle' && screen.joke) greetingScreen(size, screen.joke);
      else waitingScreen(size);
    }
    armKeys(); // queryTermSize pauses stdin; re-arm the q key
  });

  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.t === 'frame') {
        latest = Buffer.from(msg.data, 'base64');
        dirty = true;
        stopCountdown();
      } else if (msg.t === 'paused') {
        latest = null;
        dirty = false;
        renderer.clear();
        stopCountdown();
        const joke = String(msg.msg ?? 'claude needs you.');
        const missed = typeof msg.missed === 'string' && msg.missed ? msg.missed : undefined;
        const cd = typeof msg.countdownSec === 'number' && msg.countdownSec > 0 ? msg.countdownSec : undefined;
        const manual = msg.manual === true;
        screen = { mode: 'paused', joke, missed, remaining: cd, manual };
        pauseScreen(size, joke, missed, cd, manual);
        showingText = true;
        if (cd) {
          countdown = setInterval(() => {
            if (screen.mode !== 'paused' || screen.remaining == null) return stopCountdown();
            screen.remaining -= 1;
            pauseScreen(size, joke, missed, Math.max(0, screen.remaining));
            if (screen.remaining <= 0) stopCountdown(); // daemon resumes; frames take over
          }, 1000);
        }
      } else if (msg.t === 'idle') {
        // greeting shown at session start, before any work
        latest = null;
        dirty = false;
        renderer.clear();
        stopCountdown();
        const g = String(msg.msg ?? 'rotpilot online.');
        screen = { mode: 'idle', joke: g };
        greetingScreen(size, g);
        showingText = true;
      } else if (msg.t === 'clear') {
        latest = null;
        dirty = false;
        renderer.clear();
        stopCountdown();
        screen = { mode: 'waiting' };
        waitingScreen(size);
        showingText = true;
      } else if (msg.t === 'tv-config') {
        if (typeof msg.fps === 'number') fps = msg.fps;
        startLoop();
      }
    }
  });
  startLoop();

  await new Promise<void>((resolve) => {
    sock.on('close', () => resolve());
    sock.on('error', () => resolve());
  });
  cleanup();
}

/** Synthetic animation: scrolling gradient + bouncing block, raw RGBA frames.
 * Runs with q=0 so kitty reports OK/error per frame — headless proof that
 * every frame was accepted and rendered. */
async function testLoop(_renderer: KittyRenderer, getSize: () => TermSize, fps: number): Promise<void> {
  const renderer = new KittyRenderer((s) => process.stdout.write(s), 0);
  let okCount = 0;
  const errors: string[] = [];
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    let rbuf = '';
    process.stdin.on('data', (d) => {
      rbuf += d.toString('utf8');
      let m: RegExpMatchArray | null;
      while ((m = rbuf.match(/\x1b_G([^\x1b]*)\x1b\\/))) {
        const resp = m[1];
        if (resp.endsWith(';OK')) okCount++;
        else if (errors.length < 10) errors.push(resp);
        rbuf = rbuf.slice((m.index ?? 0) + m[0].length);
      }
    });
  }
  await realTestLoop(renderer, getSize, fps, () => ({ okCount, errors }));
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }
}

async function realTestLoop(
  renderer: KittyRenderer,
  getSize: () => TermSize,
  fps: number,
  responses: () => { okCount: number; errors: string[] },
): Promise<void> {
  const W = 640;
  const H = 360;
  const frame = Buffer.alloc(W * H * 4);
  let bx = 50, by = 50, vx = 6.5, vy = 4.2;
  let t = 0;
  const seconds = 20;
  const total = seconds * fps;
  const interval = 1000 / fps;
  const start = Date.now();

  for (let n = 0; n < total; n++) {
    t += 1;
    for (let y = 0; y < H; y++) {
      const gy = (y * 255 / H) | 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        frame[i] = (x + t * 3) & 255;
        frame[i + 1] = gy;
        frame[i + 2] = ((x + y - t * 2) & 255) ^ 128;
        frame[i + 3] = 255;
      }
    }
    bx += vx;
    by += vy;
    if (bx < 0 || bx > W - 60) vx = -vx;
    if (by < 0 || by > H - 60) vy = -vy;
    const x0 = Math.max(0, bx | 0), y0 = Math.max(0, by | 0);
    for (let y = y0; y < Math.min(H, y0 + 60); y++) {
      for (let x = x0; x < Math.min(W, x0 + 60); x++) {
        const i = (y * W + x) * 4;
        frame[i] = 255;
        frame[i + 1] = 255;
        frame[i + 2] = 255;
      }
    }
    const size = getSize();
    const r = fitRect(size, W, H);
    renderer.drawFrame(frame, { fmt: 'rgba', w: W, h: H }, r.cols, r.rows, r.atRow, r.atCol);
    const target = start + (n + 1) * interval;
    const wait = target - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  const elapsed = (Date.now() - start) / 1000;
  process.stdout.write(`\n test done: ${total} frames in ${elapsed.toFixed(1)}s = ${(total / elapsed).toFixed(1)} fps\n`);
  await new Promise((r) => setTimeout(r, 800)); // let trailing responses arrive
  try {
    const fs = await import('node:fs');
    const { CONFIG_DIR } = await import('../config.js');
    const r = responses();
    fs.writeFileSync(
      `${CONFIG_DIR}/tv-test.json`,
      JSON.stringify({
        frames: total,
        seconds: elapsed,
        achievedFps: total / elapsed,
        targetFps: fps,
        rssMb: Math.round(process.memoryUsage().rss / 1e6),
        kittyOkResponses: r.okCount,
        kittyErrors: r.errors,
        size: getSize(),
      }),
    );
  } catch {}
  await new Promise((r) => setTimeout(r, 700));
}
