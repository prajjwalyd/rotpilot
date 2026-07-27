/**
 * Rot-budget math, shared by `rotpilot budget`, the stats meter, and the recap
 * synthesizer's context. A budget comes ONLY from an explicit value the user
 * typed (`10m`), never from guessing at prose — one token, one meaning.
 */
import type { Budget } from '../config.js';
import type { BreakEvent } from './store.js';

const DAY_MS = 86_400_000;

/** Strict duration → whole seconds: "10m", "90m", "1h", "1.5h", "30s", or a
 * bare number (minutes). null when it doesn't cleanly parse. */
export function parseDuration(s: string): number | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs|hour|hours)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = (m[2] ?? 'm').toLowerCase();
  const mult = u.startsWith('h') ? 3600 : u.startsWith('s') ? 1 : 60;
  return Math.round(n * mult);
}

/** Human-readable duration: 600 → "10m", 5400 → "1h 30m", 45 → "45s". */
export function humanDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** Local midnight (ms) for the day containing `ms`. */
export function localMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const rotBetween = (events: BreakEvent[], from: number, to: number): number =>
  events.reduce((s, e) => {
    const t = Date.parse(e.ts);
    return t >= from && t < to ? s + e.rotSeconds : s;
  }, 0);

export interface BudgetUsage {
  used: number;
  limit: number;
  frac: number;
  over: number; // seconds past the limit, 0 if within
  remaining: number; // seconds left, 0 if over
  label: string; // 'today' | 'this week'
}

/** Rot used this period vs the budget. Counts from the later of period-start and
 * when the budget was set, so a fresh budget doesn't inherit the day's prior rot. */
export function budgetUsage(budget: Budget, events: BreakEvent[], now: number): BudgetUsage {
  const periodStart = budget.period === 'day' ? localMidnight(now) : now - 7 * DAY_MS;
  const since = Math.max(periodStart, Date.parse(budget.since));
  const used = rotBetween(events, since, now + 1);
  const over = Math.max(0, used - budget.limitSec);
  return {
    used,
    limit: budget.limitSec,
    frac: used / budget.limitSec,
    over,
    remaining: Math.max(0, budget.limitSec - used),
    label: budget.period === 'day' ? 'today' : 'this week',
  };
}

/** Consecutive whole days before today (back to when the budget was set) that
 * stayed under the daily limit. A zero-rot day counts as under. 0 for weekly. */
export function dailyStreak(budget: Budget, events: BreakEvent[], now: number): number {
  if (budget.period !== 'day') return 0;
  const setDay = localMidnight(Date.parse(budget.since));
  let streak = 0;
  for (let i = 1; i < 90; i++) {
    const dayStart = localMidnight(now) - i * DAY_MS;
    if (dayStart < setDay) break;
    if (rotBetween(events, dayStart, dayStart + DAY_MS) <= budget.limitSec) streak++;
    else break;
  }
  return streak;
}

/** One factual line for the recap synthesizer to weaponize — the budget and how
 * the user is doing against it right now. null when no budget is set. */
export function budgetContextLine(budget: Budget | undefined, events: BreakEvent[], now: number): string | null {
  if (!budget) return null;
  const u = budgetUsage(budget, events, now);
  const per = budget.period === 'day' ? 'day' : 'week';
  return u.over > 0
    ? `- they set a rot budget of ${humanDuration(u.limit)} per ${per}, and ${u.label} they've already blown past it — ${humanDuration(u.used)} used, ${humanDuration(u.over)} OVER`
    : `- they set a rot budget of ${humanDuration(u.limit)} per ${per}; ${u.label} they've used ${humanDuration(u.used)}, ${humanDuration(u.remaining)} still to spare`;
}
