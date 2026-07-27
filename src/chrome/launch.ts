/**
 * Launch real, headful Chrome with an isolated profile and no automation
 * flags (clean fingerprint: never headless, never --enable-automation).
 * Anti-throttle flags are mandatory so an occluded window keeps playing video.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { CHROME_PROFILE_DIR, loadConfig } from '../config.js';

const MAC_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
];

export function findChrome(): string | null {
  for (const p of MAC_CHROME_PATHS) if (fs.existsSync(p)) return p;
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export interface ChromeProc {
  proc: ChildProcess;
  port: number;
}

/**
 * Chrome is a per-profile singleton: if any process still holds our profile
 * (crashed daemon, unclean exit), a fresh spawn just opens a tab in it and
 * exits — tabs stack and CDP never comes up. Our profile dir belongs
 * exclusively to rotpilot, so killing whoever holds it is always correct.
 */
export function killStaleChrome(): Promise<void> {
  return new Promise((resolve) => {
    execFile('pkill', ['-f', `user-data-dir=${CHROME_PROFILE_DIR}`], () => {
      for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try {
          fs.rmSync(path.join(CHROME_PROFILE_DIR, f), { force: true });
        } catch {}
      }
      setTimeout(resolve, 500);
    });
  });
}

export async function launchChrome(extraFlags: string[] = []): Promise<ChromeProc> {
  const bin = findChrome();
  if (!bin) throw new Error('Google Chrome not found in /Applications');
  await killStaleChrome();
  const port = await freePort();
  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });

  const flags = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${CHROME_PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-session-crashed-bubble',
    // anti-throttle: the window lives behind the terminal, video must keep playing
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // keep rendering even when the terminal fully covers the engine window —
    // without this, macOS occlusion detection throttles the covered window and
    // the feed freezes. This is what lets it be a real (findable in Mission
    // Control) but hidden-behind-your-terminal window instead of headless.
    '--disable-features=CalculateNativeWinOcclusion',
    // clean fingerprint. NOTE: we intentionally do NOT pass
    // --disable-blink-features=AutomationControlled — it's the flag that
    // triggers Chrome's "unsupported command-line flag" warning banner, and
    // it's only needed to counteract --enable-automation, which we never set.
    // navigator.webdriver is patched via CDP in the driver instead.
    '--autoplay-policy=no-user-gesture-required',
    // audio: audible while actively playing (the driver's silence guard mutes
    // it whenever prewarmed/paused/hidden). muteFeed kills it entirely.
    ...(loadConfig().muteFeed ? ['--mute-audio'] : []),
    // HEADFUL on purpose: a real window, findable in Mission Control, sitting
    // behind the terminal (the occlusion flag above keeps it rendering there).
    // Headless would be invisible yet still audible — a phantom noise source.
    // portrait: 480 wide content, ~853 tall after chrome's ~87px of UI → ≈9:16
    '--window-size=480,940',
    '--window-position=80,80',
    ...extraFlags,
    'about:blank',
  ];

  // Launch in the background via `open -g` so Chrome never steals focus
  // (spawning the binary directly activates the app). `-n` forces a fresh
  // instance for our isolated profile. The returned `proc` is the short-lived
  // `open` launcher, not Chrome itself — liveness is tracked via the CDP
  // connection in the driver, and teardown kills Chrome by profile path.
  const appPath = bin.slice(0, bin.indexOf('.app') + 4); // /Applications/Google Chrome.app
  const proc =
    appPath.endsWith('.app')
      ? spawn('open', ['-g', '-n', '-a', appPath, '--args', ...flags], { stdio: 'ignore' })
      : spawn(bin, flags, { stdio: 'ignore' }); // fallback if the .app path can't be derived

  // wait for the DevTools endpoint
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return { proc, port };
    } catch {}
    await new Promise((r) => setTimeout(r, 100)); // tight poll: launch is on the play-latency path
  }
  try {
    proc.kill();
  } catch {}
  await killStaleChrome(); // open -g detaches Chrome from `proc`; kill by profile
  throw new Error('Chrome did not expose the DevTools endpoint in time');
}
