/** `rotpilot stats` — the screenshot-worthy vanity report, in a framed card. */
import { readEvents, readVows, type BreakEvent } from './store.js';
import { loadConfig } from '../config.js';
import { bold, dim, brand, yellow, green, box, masthead } from '../ui.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmt(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function bar(v: number, max: number, width = 18): string {
  const n = max > 0 ? Math.round((v / max) * width) : 0;
  return '█'.repeat(n) + '░'.repeat(width - n);
}

export async function printStats(): Promise<void> {
  const events = readEvents();
  if (events.length === 0) {
    masthead();
    console.log('');
    console.log(box('no rot recorded yet.\nrun claude, let it cook, rot responsibly.', 'stats'));
    console.log('');
    return;
  }

  const now = Date.now();
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const week = events.filter((e) => Date.parse(e.ts) >= weekAgo);
  const total = (evs: BreakEvent[]) => evs.reduce((s, e) => s + e.rotSeconds, 0);

  const longest = events.reduce((a, b) => (b.rotSeconds > a.rotSeconds ? b : a));
  const byDay = new Map<number, number>();
  for (const e of week) {
    const d = new Date(e.ts).getDay();
    byDay.set(d, (byDay.get(d) ?? 0) + e.rotSeconds);
  }
  const maxDay = Math.max(1, ...byDay.values());

  const perms = events.filter((e) => e.reason === 'permission' && e.responseLatencyMs != null);
  const fastest = perms.length ? Math.min(...perms.map((e) => e.responseLatencyMs!)) : null;
  const workTotal = events.reduce((s, e) => s + e.workSeconds, 0);
  const ratio = workTotal > 0 ? total(events) / workTotal : 0;

  const reasons = new Map<string, number>();
  for (const e of events) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);

  // one metric row: plain label + colored value, both in fixed columns so the
  // dim note column lines up regardless of value length (pad BEFORE coloring)
  const row = (k: string, v: string, color: (s: string) => string, note: string) =>
    `${dim(k.padEnd(20))}${color(v.padEnd(9))}  ${dim(note)}`;

  const lines: string[] = [];
  lines.push(row('rot this week', fmt(total(week)), brand, `${week.length} breaks`));
  lines.push(row('rot all time', fmt(total(events)), bold, `${events.length} breaks`));
  lines.push(
    row('longest single rot', fmt(longest.rotSeconds), (s) => bold(yellow(s)), `${longest.feed}${longest.repo ? ', fixing ' + longest.repo : ''}`),
  );
  lines.push(row('rot ratio', ratio.toFixed(2), bold, 'sec rotted per sec claude worked'));
  if (fastest != null) {
    lines.push(row('fastest snap-back', `${(fastest / 1000).toFixed(1)}s`, bold, 'reel → permission prompt'));
  }

  lines.push('');
  lines.push(dim('rot by weekday (last 7 days)'));
  for (let d = 0; d < 7; d++) {
    const v = byDay.get(d) ?? 0;
    lines.push(`  ${dim(DAYS[d])}  ${brand(bar(v, maxDay))} ${dim(fmt(v))}`);
  }

  lines.push('');
  const parts = [...reasons.entries()].map(([r, n]) => `${r}: ${n}`).join('  ·  ');
  lines.push(dim(`snapped back by — ${parts}`));

  const vows = readVows();
  lines.push('');
  lines.push(bold(yellow('🔥 rotpilot remembers')));
  if (!vows.length) {
    lines.push(dim('· nothing vowed yet — put a promise on record:'));
    lines.push(dim('  rotpilot vow "10 minutes a day, max"'));
  }
  for (const v of vows) {
    lines.push(`${green('·')} "${v.text}" ${dim(`(vowed ${v.ts.slice(0, 10)})`)}`);
    const since = Date.parse(v.ts);
    const evs = events.filter((e) => Date.parse(e.ts) >= since);
    lines.push(
      evs.length
        ? dim(`  receipts: ${fmt(total(evs))} of rot across ${evs.length} break${evs.length === 1 ? '' : 's'} since then`)
        : dim('  receipts: clean since then. for now.'),
    );
  }
  if (loadConfig().engram.shareTranscripts) {
    lines.push('');
    lines.push(dim("and everything claude did while you weren't looking: rotpilot recap"));
  }

  masthead();
  console.log('');
  console.log(box(lines.join('\n'), 'the damage'));
  console.log('');
}
