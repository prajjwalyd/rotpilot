/**
 * Feed registry. All feeds are READ-ONLY: we scroll to watch, never
 * like/follow/comment.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type CDP from 'chrome-remote-interface';
import { pressKey, FEED_PROBE_JS } from '../chrome/driver.js';
import { CONFIG_DIR } from '../config.js';

export interface Feed {
  name: string;
  url: () => string;
  /** Advance one clip. Resolves with which tier actually landed it, for the log. */
  next: (client: CDP.Client) => Promise<string>;
  /** Go back one clip (arrow-up in the TV panel). Absent = not scrollable. */
  prev?: (client: CDP.Client) => Promise<string>;
}

function assetsDir(): string {
  // dist/cli.js → ../assets
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');
}

const localLoop: Feed = {
  name: 'localLoop',
  url: () => {
    const player = path.join(assetsDir(), 'player.html');
    const userMp4 = path.join(CONFIG_DIR, 'loop.mp4');
    const src = fs.existsSync(userMp4) ? `?src=${encodeURIComponent(`file://${userMp4}`)}` : '';
    return `file://${player}${src}`;
  },
  next: async () => 'loop', // it loops; nothing to advance
};

/**
 * Step a scroll-snap short/reel feed by one clip.
 *
 * Every tier is VERIFIED before we call it done: after each attempt we watch the
 * clip signature (current video src + snap-container scrollTop) for up to 800ms
 * and only stop once it actually changed. Escalation was the whole problem
 * before — a Next control that merely EXISTS would short-circuit the reliable
 * scroll path, so a disabled, covered, or re-skinned button meant the same clip
 * looped forever while the log happily reported a successful advance.
 *
 * Tiers, none of which need the page to be focused:
 *   1. click the on-page Next/Prev control (resolved to a real clickable — aria
 *      labels often sit on an inner <svg>, e.g. Instagram's)
 *   2. wheel + scrollBy on the clip's own snap container, one viewport
 *   3. scrollIntoView the neighbouring <video> directly
 * then, back in the driver, a CDP arrow key as the final fallback.
 */
async function snapStep(client: CDP.Client, dir: 'up' | 'down', selectors: string[]): Promise<string> {
  const sign = dir === 'down' ? 1 : -1;
  const expr = `(async () => {
    const p = ${FEED_PROBE_JS};
    await p.quiet(4);              // quiet baseline: no momentum from before us
    const before = p.sig();
    const landed = async (act) => { act(); await p.quiet(14); return p.sig() !== before; };

    for (const s of ${JSON.stringify(selectors)}) {
      const el = document.querySelector(s);
      if (!el) continue;
      if (await landed(() => (el.closest('button, [role="button"]') || el).click())) return 'btn';
      break; // present but ineffective — stop clicking, escalate
    }

    const c = p.container(p.cur()) || document.scrollingElement || document.body;
    if (c) {
      const dy = (c.clientHeight || innerHeight) * ${sign};
      if (await landed(() => {
        c.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
        if (typeof c.scrollBy === 'function') c.scrollBy({ top: dy, behavior: 'smooth' });
      })) return 'scroll';
    }

    const vs = [...document.querySelectorAll('video')];
    const nxt = vs[vs.indexOf(p.cur()) + ${sign}];
    if (nxt && typeof nxt.scrollIntoView === 'function') {
      if (await landed(() => nxt.scrollIntoView({ block: 'center', behavior: 'smooth' }))) return 'sibling';
    }
    return 'stuck';
  })()`;
  let did = 'stuck';
  try {
    const r = await client.Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
    did = ((r as any)?.result?.value as string) ?? 'stuck';
  } catch {
    did = 'eval-failed';
  }
  // nothing on-page worked: the key needs the player focused, so it's last, but
  // it's still better than sitting on the same clip
  if (did === 'stuck' || did === 'eval-failed') {
    await pressKey(client, dir === 'down' ? 'ArrowDown' : 'ArrowUp');
    return did + '+key';
  }
  return did;
}

const SHORTS_NEXT = [
  '#navigation-button-down button',
  'button[aria-label="Next video"]',
  'button[aria-label="Next Short"]',
  'ytd-shorts #navigation-button-down button',
];
const SHORTS_PREV = [
  '#navigation-button-up button',
  'button[aria-label="Previous video"]',
  'ytd-shorts #navigation-button-up button',
];

const shorts: Feed = {
  name: 'shorts',
  url: () => 'https://www.youtube.com/shorts',
  next: (client) => snapStep(client, 'down', SHORTS_NEXT),
  prev: (client) => snapStep(client, 'up', SHORTS_PREV),
};

// IG puts the aria-label on an inner <svg>; snapStep resolves it to the closest
// clickable, and the scroll tiers cover layout changes
const IG_NEXT = ['svg[aria-label="Next"]', 'button[aria-label="Next"]', '[aria-label="Next"]'];
const IG_PREV = ['svg[aria-label="Go back"]', 'button[aria-label="Go back"]', '[aria-label="Previous"]'];

const instagram: Feed = {
  name: 'instagram',
  url: () => 'https://www.instagram.com/reels/',
  next: (client) => snapStep(client, 'down', IG_NEXT),
  prev: (client) => snapStep(client, 'up', IG_PREV),
};

const FEEDS: Record<string, Feed> = { localLoop, shorts, instagram };

export function getFeed(name: string): Feed {
  return FEEDS[name] ?? localLoop;
}
