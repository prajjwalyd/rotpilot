import fs from 'node:fs';
import { LOG_PATH, ensureConfigDir } from './config.js';

let stream: fs.WriteStream | null = null;

export function log(...args: unknown[]): void {
  if (!stream) {
    ensureConfigDir();
    stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  }
  const line = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? String(a)) : JSON.stringify(a)))
    .join(' ');
  stream.write(`${new Date().toISOString()} ${line}\n`);
}
