/** `rotpilot stats` — the screenshot-worthy vanity report, in a framed card. */
import { readEvents, readVows, type BreakEvent } from './store.js';
import { loadConfig } from '../config.js';
import { dim, masthead, card, metricRow, bars, meta, type CardSection } from '../ui.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmt(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export async function printStats(): Promise<void> {
  const events = readEvents();
  if (events.length === 0) {
    masthead();
    console.log('');
    console.log(
      card('stats', [
        { body: [dim('  no rot recorded yet.'), dim('  run claude, let it cook, rot responsibly.')] },
      ]),
    );
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

  const perms = events.filter((e) => e.reason === 'permission' && e.responseLatencyMs != null);
  const fastest = perms.length ? Math.min(...perms.map((e) => e.responseLatencyMs!)) : null;
  const workTotal = events.reduce((s, e) => s + e.workSeconds, 0);
  const ratio = workTotal > 0 ? total(events) / workTotal : 0;

  const reasons = new Map<string, number>();
  for (const e of events) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);

  const sections: CardSection[] = [];

  // headline metrics (no sub-heading — they sit right under the card title)
  const top = [
    metricRow('rot this week', fmt(total(week)), `${week.length} breaks`),
    metricRow('rot all time', fmt(total(events)), `${events.length} breaks`),
    metricRow('longest single rot', fmt(longest.rotSeconds), `${longest.feed}${longest.repo ? ' · fixing ' + longest.repo : ''}`),
    metricRow('rot ratio', ratio.toFixed(2), 'sec rotted per sec claude worked'),
  ];
  if (fastest != null) {
    top.push(metricRow('fastest snap-back', `${(fastest / 1000).toFixed(1)}s`, 'reel → permission prompt'));
  }
  sections.push({ body: top });

  sections.push({
    heading: 'rot by weekday · last 7 days',
    body: bars(DAYS.map((label, d) => ({ label, value: byDay.get(d) ?? 0, display: fmt(byDay.get(d) ?? 0) }))),
  });

  sections.push({
    heading: 'snapped back by',
    body: [meta([...reasons.entries()].map(([r, n]) => `${r}: ${n}`))],
  });

  const vows = readVows();
  const vowBody: string[] = [];
  if (!vows.length) {
    vowBody.push(dim('  nothing vowed yet — put a promise on record:'));
    vowBody.push(dim('  rotpilot vow "10 minutes a day, max"'));
  }
  for (const v of vows) {
    vowBody.push(`  ${dim('·')} "${v.text}" ${dim(`(vowed ${v.ts.slice(0, 10)})`)}`);
    const since = Date.parse(v.ts);
    const evs = events.filter((e) => Date.parse(e.ts) >= since);
    vowBody.push(
      evs.length
        ? dim(`    receipts: ${fmt(total(evs))} of rot across ${evs.length} break${evs.length === 1 ? '' : 's'} since then`)
        : dim('    receipts: clean since then. for now.'),
    );
  }
  sections.push({ heading: 'rotpilot remembers', body: vowBody });

  if (loadConfig().engram.shareTranscripts) {
    sections.push({ body: [dim("  everything claude did while you weren't looking: rotpilot recap")] });
  }

  masthead();
  console.log('');
  console.log(card('the damage', sections));
  console.log('');
}
