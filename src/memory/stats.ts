/** `rotpilot stats` — the screenshot-worthy vanity report, in a framed card. */
import { readEvents, type BreakEvent } from './store.js';
import { loadConfig } from '../config.js';
import { dim, bold, masthead, card, metricRow, meta, progressBar, heatCell, type CardSection } from '../ui.js';
import { humanDuration, localMidnight, budgetUsage, dailyStreak } from './budget.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;

function fmt(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const s = sec % 60;
    return s ? `${Math.floor(sec / 60)}m ${s}s` : `${sec / 60}m`;
  }
  const m = Math.floor((sec % 3600) / 60);
  return m ? `${Math.floor(sec / 3600)}h ${m}m` : `${Math.floor(sec / 3600)}h`;
}

const total = (evs: BreakEvent[]): number => evs.reduce((s, e) => s + e.rotSeconds, 0);
const rotBetween = (events: BreakEvent[], from: number, to: number): number =>
  total(events.filter((e) => { const t = Date.parse(e.ts); return t >= from && t < to; }));

/** "this week vs usual": compare the rolling week to the mean of prior weeks
 * that actually have data, so a first week doesn't read as a spike. '' until
 * there's a prior week to compare against. */
function trendNote(events: BreakEvent[], now: number, thisWeek: number): string {
  const first = Math.min(...events.map((e) => Date.parse(e.ts)));
  const prior: number[] = [];
  for (let w = 1; w <= 8; w++) {
    const end = now - w * 7 * DAY_MS;
    if (end < first) break;
    prior.push(rotBetween(events, end - 7 * DAY_MS, end));
  }
  const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
  if (avg <= 0) return '';
  const pct = Math.round(((thisWeek - avg) / avg) * 100);
  if (Math.abs(pct) < 10) return 'about usual';
  return pct > 0 ? `↑ ${pct}% vs usual` : `↓ ${-pct}% vs usual`;
}

/** An 8-week rot heatmap (weekday rows × week columns) + a "hardest weekday"
 * read-out, replacing the old 7-bar chart with something worth screenshotting. */
function heatmapSection(events: BreakEvent[], now: number): CardSection {
  const WEEKS = 8;
  const dayRot = new Map<number, number>();
  for (const e of events) {
    const k = localMidnight(Date.parse(e.ts));
    dayRot.set(k, (dayRot.get(k) ?? 0) + e.rotSeconds);
  }
  const today = localMidnight(now);
  const gridStart = today - (new Date(today).getDay() + (WEEKS - 1) * 7) * DAY_MS; // Sunday, WEEKS-1 weeks back
  const max = Math.max(1, ...[...dayRot.entries()].filter(([k]) => k >= gridStart).map(([, v]) => v));
  const level = (sec: number): number => (sec <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((sec / max) * 4))));

  const rows: string[] = [];
  const byWeekday = new Array(7).fill(0);
  for (let wd = 0; wd < 7; wd++) {
    const cells: string[] = [];
    for (let wk = 0; wk < WEEKS; wk++) {
      const day = gridStart + (wk * 7 + wd) * DAY_MS;
      const sec = dayRot.get(day) ?? 0;
      byWeekday[wd] += sec;
      cells.push(day > today ? ' ' : heatCell(level(sec)));
    }
    rows.push(`  ${dim(DAYS[wd])} ${cells.join(' ')}`);
  }

  const hardest = byWeekday.indexOf(Math.max(...byWeekday));
  const caption = byWeekday[hardest] > 0
    ? `${WEEKS} weeks · you rot hardest on ${DAYS_LONG[hardest]}s`
    : `${WEEKS} weeks · each cell one day`;
  return { heading: 'the heatmap of shame', body: [...rows, '', meta([caption])] };
}

/** The rot ration: a live meter for the current period + a days-under streak.
 * No budget set → a one-line nudge. This is a limit rotpilot holds you to, not
 * a promise you made — the warden doling out sanctioned rot. */
function budgetSection(events: BreakEvent[], now: number): CardSection {
  const budget = loadConfig().budget;
  if (!budget) {
    return {
      heading: 'the ration',
      body: [
        dim('  no rot budget set — hand rotpilot a limit to hold you to:'),
        dim('  rotpilot budget --daily 10m'),
      ],
    };
  }
  const u = budgetUsage(budget, events, now);
  const status = u.over > 0 ? `${humanDuration(u.over)} over` : `${humanDuration(u.remaining)} left`;
  const body = [
    `  ${dim(u.label.padEnd(5))} ${progressBar(u.frac)} ${bold(humanDuration(u.used))} ${dim(`/ ${humanDuration(u.limit)} · ${status}`)}`,
  ];
  const streak = dailyStreak(budget, events, now);
  if (streak > 0) body.push(dim(`  ${streak}-day streak under ration`));
  return { heading: 'the ration', body };
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
  const week = events.filter((e) => Date.parse(e.ts) >= now - 7 * DAY_MS);

  const longest = events.reduce((a, b) => (b.rotSeconds > a.rotSeconds ? b : a));
  const perms = events.filter((e) => e.reason === 'permission' && e.responseLatencyMs != null);
  const fastest = perms.length ? Math.min(...perms.map((e) => e.responseLatencyMs!)) : null;
  const workTotal = events.reduce((s, e) => s + e.workSeconds, 0);
  const ratio = workTotal > 0 ? total(events) / workTotal : 0;

  const reasons = new Map<string, number>();
  for (const e of events) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);

  const sections: CardSection[] = [];

  const trend = trendNote(events, now, total(week));
  const weekNote = `${week.length} breaks${trend ? ` · ${trend}` : ''}`;
  const top = [
    metricRow('rot this week', fmt(total(week)), weekNote),
    metricRow('rot all time', fmt(total(events)), `${events.length} breaks`),
    metricRow('longest single rot', fmt(longest.rotSeconds), `${longest.feed}${longest.repo ? ' · fixing ' + longest.repo : ''}`),
    metricRow('rot ratio', ratio.toFixed(2), 'sec rotted per sec claude worked'),
  ];
  if (fastest != null) {
    top.push(metricRow('fastest snap-back', `${(fastest / 1000).toFixed(1)}s`, 'reel → permission prompt'));
  }
  sections.push({ body: top });

  sections.push(heatmapSection(events, now));
  sections.push({ heading: 'snapped back by', body: [meta([...reasons.entries()].map(([r, n]) => `${r}: ${n}`))] });
  sections.push(budgetSection(events, now));

  if (loadConfig().engram.shareTranscripts) {
    sections.push({ body: [dim("  everything claude did while you weren't looking: rotpilot recap")] });
  }

  masthead();
  console.log('');
  console.log(card('the damage', sections));
  console.log('');
}
