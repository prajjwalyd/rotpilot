/** NDJSON over a unix domain socket. One socket serves hooks, the TV client, and the CLI. */
import net from 'node:net';
import fs from 'node:fs';
import { SOCKET_PATH } from '../config.js';

export type Msg = Record<string, unknown> & { t: string };

export function serve(onMsg: (msg: Msg, sock: net.Socket) => void): net.Server {
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {}
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
