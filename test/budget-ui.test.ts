/**
 * The ration meter and the CLI primitives. Both are pure, and both have quiet
 * failure modes: a budget that silently counts rot from before you set it, or a
 * bar whose width drifts once colour escapes are in the string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, humanDuration, budgetUsage, dailyStreak } from '../src/memory/budget.js';
import { bars, progressBar, wrapText, metricRow } from '../src/ui.js';
import type { BreakEvent } from '../src/memory/store.js';

const DAY = 86_400_000;
const ev = (ts: number, rotSeconds: number): BreakEvent => ({
  ts: new Date(ts).toISOString(),
  feed: 'shorts',
  reason: 'permission',
  workSeconds: rotSeconds,
  rotSeconds,
});
const midnight = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

test('parseDuration takes only an explicit amount', () => {
  assert.equal(parseDuration('10m'), 600);
  assert.equal(parseDuration('1h'), 3600);
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('5x'), null, 'garbage must not silently become a budget');
  assert.equal(parseDuration(''), null);
});

test('humanDuration round-trips the amounts we print', () => {
  assert.equal(humanDuration(600), '10m');
  assert.equal(humanDuration(3600), '1h');
});

test('a fresh budget does not inherit rot from earlier the same day', () => {
  // regression: usage counted from the period start, so setting a 10m budget at
  // 4pm instantly reported you over from the morning's rot
  const now = Date.now();
  const today = midnight(now);
  const budget = { limitSec: 600, period: 'day' as const, since: new Date(now - 60_000).toISOString() };
  const before = budgetUsage(budget, [ev(today + 60_000, 1200)], now);
  assert.equal(before.used, 0, 'rot from before `since` must not count');
  const after = budgetUsage(budget, [ev(now - 30_000, 1200)], now);
  assert.equal(after.used, 1200);
  assert.ok(after.over > 0 && after.frac > 1);
});

test('usage reports remaining under the limit and over past it', () => {
  const now = Date.now();
  const budget = { limitSec: 600, period: 'day' as const, since: new Date(now - DAY).toISOString() };
  const under = budgetUsage(budget, [ev(now - 60_000, 300)], now);
  assert.equal(under.over, 0);
  assert.equal(under.remaining, 300);
  const over = budgetUsage(budget, [ev(now - 60_000, 900)], now);
  assert.equal(over.over, 300);
  assert.equal(over.remaining, 0);
});

test('a weekly budget is not a daily one', () => {
  const now = Date.now();
  const budget = { limitSec: 3600, period: 'week' as const, since: new Date(now - 30 * DAY).toISOString() };
  const u = budgetUsage(budget, [ev(now - 3 * DAY, 1800), ev(now - 60_000, 900)], now);
  assert.equal(u.used, 2700, 'the whole trailing week counts');
  assert.equal(dailyStreak(budget, [], now), 0, 'streaks are a daily-budget idea');
});

test('a streak counts COMPLETED days under the ration, not today', () => {
  const now = Date.now();
  const budget = { limitSec: 600, period: 'day' as const, since: new Date(now - 10 * DAY).toISOString() };
  const quiet = [ev(now - 3 * DAY, 60), ev(now - 2 * DAY, 60), ev(now - DAY, 60)];
  assert.ok(dailyStreak(budget, quiet, now) >= 3);
  // today is deliberately excluded: it is still in progress, and the live meter
  // already shows it. Blowing the ration today does not retroactively erase
  // yesterday's restraint.
  const blownToday = [...quiet, ev(now - 60_000, 5000)];
  assert.equal(dailyStreak(budget, blownToday, now), dailyStreak(budget, quiet, now));
  // blowing a COMPLETED day does end it
  const blownYesterday = [ev(now - DAY, 5000)];
  assert.equal(dailyStreak(budget, blownYesterday, now), 0);
});

test('bars scale to the largest value and keep a fixed-width track', () => {
  const rows = bars([
    { label: 'Mon', value: 0, display: '0s' },
    { label: 'Tue', value: 50, display: '50s' },
    { label: 'Wed', value: 100, display: '100s' },
  ]);
  assert.equal(rows.length, 3);
  const width = (s: string) => (s.match(/[█░]/g) ?? []).length;
  assert.equal(width(rows[0]), width(rows[2]), 'every track is the same width');
  assert.equal((rows[0].match(/█/g) ?? []).length, 0, 'zero draws no fill');
  assert.equal((rows[2].match(/░/g) ?? []).length, 0, 'the max fills the track');
});

test('progressBar clamps, and overflow is drawn inside the track', () => {
  const width = (s: string) => (s.match(/[█░]/g) ?? []).length;
  assert.equal(width(progressBar(0)), width(progressBar(0.5)));
  assert.equal(width(progressBar(5)), width(progressBar(0.5)), 'a 5x overrun must not widen the bar');
  assert.equal((progressBar(0).match(/█/g) ?? []).length, 0);
});

test('colour is stripped when stdout is not a TTY, so pipes stay clean', () => {
  // the suite runs piped, which is exactly the condition
  for (const s of [metricRow('label', 'value', 'note'), progressBar(0.5), bars([{ label: 'a', value: 1, display: '1' }])[0]]) {
    assert.ok(!/\x1b\[/.test(s), `unexpected escape in ${JSON.stringify(s)}`);
  }
});

test('wrapText respects the width it is given', () => {
  const out = wrapText('word '.repeat(60), '  ', 40);
  for (const line of out.split('\n')) assert.ok(line.length <= 44, `too long: ${line.length}`);
});
