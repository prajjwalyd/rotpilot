/**
 * Feed registry. All feeds are READ-ONLY: we scroll to watch, never
 * like/follow/comment.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type CDP from 'chrome-remote-interface';
import { pressKey } from '../chrome/driver.js';
import { CONFIG_DIR } from '../config.js';

export interface Feed {
  name: string;
  url: () => string;
  next: (client: CDP.Client) => Promise<void>;
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
  next: async () => {}, // it loops; nothing to advance
};

// Robustly advance a scroll-snap short/reel feed. A blind CDP ArrowDown only
// works if the player happens to be the focused element — when it isn't, the
// key does nothing and the current clip loops forever. Three tiers, none of
// which need focus:
//   1. click the on-page Next control (resolved to a real clickable — aria
//      labels often sit on an inner <svg>, e.g. Instagram's)
//   2. scroll the video's own scroll-snap ancestor by one viewport (found by
//      walking UP from the visible <video>, so it works on any snap feed
//      without site-specific container selectors)
//   3. ArrowDown as a last resort
async function advanceSnapFeed(client: CDP.Client, buttonSelectors: string[]): Promise<void> {
  const expr = `(() => {
    const sels = ${JSON.stringify(buttonSelectors)};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) continue;
      const btn = el.closest('button, [role="button"]') || el;
      btn.click();
      return 'btn';
    }
    const vs = [...document.querySelectorAll('video')];
    const v = vs.find((x) => x.offsetWidth > 0) || vs[0];
    let el = v ? v.parentElement : null;
    while (el && el.scrollHeight - el.clientHeight < 100) el = el.parentElement;
    const c = el || document.scrollingElement || document.body;
    if (c) {
      c.dispatchEvent(new WheelEvent('wheel', { deltaY: c.clientHeight || window.innerHeight, bubbles: true }));
      if (typeof c.scrollBy === 'function') c.scrollBy({ top: c.clientHeight || window.innerHeight, behavior: 'smooth' });
      return el ? 'snap-scroll' : 'page-scroll';
    }
    return 'none';
  })()`;
  let did = 'none';
  try {
    const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true });
    did = ((r as any)?.result?.value as string) ?? 'none';
  } catch {}
  // belt-and-braces: if nothing on-page matched, still try the key
  if (did === 'none') await pressKey(client, 'ArrowDown');
}

const shorts: Feed = {
  name: 'shorts',
  url: () => 'https://www.youtube.com/shorts',
  next: (client) =>
    advanceSnapFeed(client, [
      '#navigation-button-down button',
      'button[aria-label="Next video"]',
      'button[aria-label="Next Short"]',
      'ytd-shorts #navigation-button-down button',
    ]),
};

const instagram: Feed = {
  name: 'instagram',
  url: () => 'https://www.instagram.com/reels/',
  // IG puts the aria-label on an inner <svg>; advanceSnapFeed resolves it to
  // the closest clickable, and the snap-scroll tier covers layout changes
  next: (client) =>
    advanceSnapFeed(client, ['svg[aria-label="Next"]', 'button[aria-label="Next"]', '[aria-label="Next"]']),
};

const FEEDS: Record<string, Feed> = { localLoop, shorts, instagram };

export function getFeed(name: string): Feed {
  return FEEDS[name] ?? localLoop;
}
