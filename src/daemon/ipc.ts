/** NDJSON over a unix domain socket. One socket serves hooks, the TV client, and the CLI. */
import net from 'node:net';
import fs from 'node:fs';
import { SOCKET_PATH } from '../config.js';

export type Msg = Record<string, unknown> & { t: string };

/**
 * Bind the daemon socket — refusing to steal it from a daemon that is still alive.
 *
 * This used to unlink the socket path unconditionally and bind over it, which
 * meant a second daemon silently took the socket from a running first one. The
 * loser kept running: still holding its Chrome, still prewarming, but deaf to
 * every hook forever, and invisible to `rotpilot stop` (which only knows the pid
 * file). Two daemons then fight over one Chrome profile, because killStaleChrome
 * pkills on the profile dir — each relaunch murders the other's browser, and the
 * churn is enough to peg WindowServer and desync the video from the audio.
 *
 * A stale socket file (daemon killed hard) still gets cleaned up — but only
 * after a probe proves nobody is listening.
 */
export function serve(onMsg: (msg: Msg, sock: net.Socket) => void): net.Server {
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          onMsg(JSON.parse(line), sock);
        } catch {}
      }
    });
    sock.on('error', () => {});
  });
  server.on('error', (e) => {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') return;
    // Someone already holds the path. Alive, or a leftover file?
    const probe = net.connect(SOCKET_PATH);
    probe.on('connect', () => {
      probe.destroy();
      process.exit(0); // a live daemon owns it — we are the duplicate, stand down
    });
    probe.on('error', () => {
      try {
        fs.unlinkSync(SOCKET_PATH); // nobody listening: safe to take over
      } catch {}
      server.listen(SOCKET_PATH);
    });
  });
  server.listen(SOCKET_PATH);
  return server;
}

export function send(sock: net.Socket, msg: Msg): void {
  try {
    sock.write(JSON.stringify(msg) + '\n');
  } catch {}
}

/**
 * Fire-and-forget client used by the hook command. Connects, sends one message,
 * exits. Must never throw and must be fast: dead daemon → silent no-op.
 * Resolves true if the message was written to a live daemon.
 */
export function fireAndForget(msg: Msg, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      sock.destroy();
      done(false);
    }, timeoutMs);
    const sock = net.createConnection(SOCKET_PATH, () => {
      sock.end(JSON.stringify(msg) + '\n', () => done(true));
    });
    sock.on('error', () => done(false));
  });
}

/** Request/response client for `status` / `stop`. */
export function request(msg: Msg, timeoutMs = 2000): Promise<Msg | null> {
  return new Promise((resolve) => {
    let buf = '';
    const done = (m: Msg | null) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(m);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const sock = net.createConnection(SOCKET_PATH, () => {
      sock.write(JSON.stringify(msg) + '\n');
    });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try {
          done(JSON.parse(buf.slice(0, nl)));
        } catch {
          done(null);
        }
      }
    });
    sock.on('error', () => done(null));
  });
}
