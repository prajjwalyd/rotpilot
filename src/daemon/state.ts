/**
 * IDLE ─(work-start, debounced)─▶ PLAYING ─(resident snap-back)─▶ PAUSED
 *   ▲                                │  ▲                            │
 *   └────(close snap-back)───────────┘  └──(work-start, quick)───────┘
 *
 * PAUSED is a warm state: the TV panel and Chrome screencast stay alive, frames
 * are just gated off. Resuming from PAUSED is near-instant (flip a flag), which
 * is the whole point — approving a permission snaps the video back immediately.
 */

export type RotState = 'idle' | 'pending' | 'playing' | 'paused';

export interface HookCtx {
  sessionId?: string;
  cwd?: string;
  /** the session's JSONL transcript (from the hook payload) — the source for
   * the opt-in "what you missed" Engram memory */
  transcriptPath?: string;
  kittyWindowId?: string;
  kittyListenOn?: string;
  /** which supported terminal the session runs in: 'kitty' | 'ghostty' */
  term?: string;
  reason?: string;
}

export interface ExitInfo {
  reason: string;
  workSeconds: number;
  rotSeconds: number;
  ctx: HookCtx;
}

// snap-back reasons that tear the TV down instead of leaving it resident
const CLOSE_REASONS = new Set(['user', 'session-end', 'watchdog']);

export interface StateCbs {
  enter: (ctx: HookCtx) => void; // cold start: full setup + play
  resume: () => void; // from PAUSED: instant un-freeze
  pause: (info: ExitInfo) => void; // resident snap-back: freeze, keep warm
  stop: (info: ExitInfo) => void; // close snap-back: tear down
}

export class StateMachine {
  state: RotState = 'idle';
  /** sessionId that owns the current cycle (set when a cycle starts from idle) */
  owner: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private pendingKind: 'cold' | 'resume' = 'cold';
  private workStartedAt = 0;
  private playingSince = 0;
  private ctx: HookCtx = {};
  private suppressUntil = 0; // ignore work-start briefly after a done/end pause

  constructor(
    private cbs: StateCbs,
    private debounceMs = 600, // cold start: filter trivial tasks
    private resumeMs = 120, // from PAUSED: near-instant, tiny anti-flash gap
  ) {}

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  onEvent(event: string, ctx: HookCtx): void {
    // one cycle, one session. Several Claude sessions (possibly in DIFFERENT
    // terminals) feed the same daemon; without this, a kitty session and a
    // ghostty session interleave their ctx and the TV opens in whichever
    // terminal's event happened to land last. While a cycle is active, only
    // its owner (and daemon-internal events, which carry no sessionId) steer it.
    const sid = ctx.sessionId;
    if (this.state !== 'idle' && this.owner && sid && sid !== this.owner) return;
    if (this.state === 'idle' && event === 'work-start') {
      this.owner = sid;
      this.ctx = {}; // fresh cycle: no target leakage from a previous session
    }
    // merge only defined values (daemon-internal events must not clobber targets)
    for (const [k, v] of Object.entries(ctx)) {
      if (v !== undefined) (this.ctx as Record<string, unknown>)[k] = v;
    }

    switch (event) {
      case 'prompt':
        this.suppressUntil = 0; // fresh turn
        break;

      case 'work-start': {
        if (Date.now() < this.suppressUntil) return;
        if (this.state === 'idle') {
          this.pendingKind = 'cold';
          this.workStartedAt = Date.now();
          this.state = 'pending';
          this.clearTimer();
          this.timer = setTimeout(() => this.fire(), this.debounceMs);
        } else if (this.state === 'paused') {
          this.pendingKind = 'resume';
          this.state = 'pending';
          this.clearTimer();
          this.timer = setTimeout(() => this.fire(), this.resumeMs);
        }
        // pending / playing: already on the way — don't strobe
        break;
      }

      case 'snap-back': {
        const reason = ctx.reason ?? 'unknown';
        const closing = CLOSE_REASONS.has(reason);
        const info: ExitInfo = {
          reason,
          workSeconds: Math.round((Date.now() - this.workStartedAt) / 1000),
          rotSeconds: this.playingSince ? Math.round((Date.now() - this.playingSince) / 1000) : 0,
          ctx: this.ctx,
        };
        // a rot window is consumed exactly once: repeat snap-backs while paused
        // (joke refreshes) report 0 rot instead of re-counting the same window
        this.playingSince = 0;
        this.clearTimer();

        if (closing) {
          if (this.state === 'playing' || this.state === 'paused') this.cbs.stop(info);
          this.state = 'idle';
          this.owner = undefined;
        } else {
          // resident pause
          if (this.state === 'playing') {
            this.cbs.pause(info);
            this.state = 'paused';
          } else if (this.state === 'pending') {
            // caught mid-debounce: if we were resuming, fall back to paused;
            // if cold, just go idle (never actually played)
            this.state = this.pendingKind === 'resume' ? 'paused' : 'idle';
            if (this.state === 'paused') this.cbs.pause(info); // refresh joke
          } else if (this.state === 'paused') {
            this.cbs.pause(info); // update the joke to the new reason
          }
          // done/end: swallow straggler tool events for a beat
          if (reason === 'done' || reason === 'session-end') this.suppressUntil = Date.now() + 1500;
        }
        break;
      }
    }
  }

  private fire(): void {
    this.timer = null;
    const kind = this.pendingKind;
    this.state = 'playing';
    // both anchors restart per window — otherwise a pause→resume→pause cycle
    // double-counts the earlier window's rot/work into the later break
    this.playingSince = Date.now();
    if (kind === 'cold') {
      this.workStartedAt ||= Date.now();
      this.cbs.enter(this.ctx);
    } else {
      this.workStartedAt = Date.now();
      this.cbs.resume();
    }
  }
}
