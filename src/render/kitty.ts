/**
 * Kitty graphics protocol encoder.
 * Frames are PNG buffers (from CDP screencast) or raw RGBA (test mode).
 * We double-buffer across two image ids and bump z each frame so the new
 * placement paints over the old one before the old is deleted — no flicker,
 * no quota blowup. All commands use q=2 (suppress responses) so we never
 * have to read replies.
 */
import zlib from 'node:zlib';

const ESC = '\x1b';
const CHUNK = 4096;

export type FrameMeta =
  | { fmt: 'png' }
  | { fmt: 'rgba'; w: number; h: number };

function apc(ctrl: string, payload = ''): string {
  return `${ESC}_G${ctrl}${payload ? ';' + payload : ''}${ESC}\\`;
}

/** Transmit a frame and display it at the current cursor position, scaled into cols×rows cells. */
function encodeFrame(
  data: Buffer,
  meta: FrameMeta,
  opts: { id: number; z: number; cols: number; rows: number; q?: number },
): string {
  let fmtKeys: string;
  let body = data;
  if (meta.fmt === 'png') {
    fmtKeys = 'f=100';
  } else {
    body = zlib.deflateSync(data);
    fmtKeys = `f=32,s=${meta.w},v=${meta.h},o=z`;
  }
  const b64 = body.toString('base64');
  let out = '';
  for (let i = 0; i < b64.length; i += CHUNK) {
    const chunk = b64.slice(i, i + CHUNK);
    const more = i + CHUNK < b64.length ? 1 : 0;
    if (i === 0) {
      out += apc(
        `a=T,${fmtKeys},i=${opts.id},q=${opts.q ?? 2},C=1,c=${opts.cols},r=${opts.rows},z=${opts.z},m=${more}`,
        chunk,
      );
    } else {
      out += apc(`m=${more}`, chunk);
    }
  }
  return out;
}

/** Read width/height from a PNG header (IHDR is always first). */
export function pngDims(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Delete an image (placements + data) by id. */
function encodeDelete(id: number): string {
  return apc(`a=d,d=I,i=${id},q=2`);
}

/** Delete all images and free their data. */
function encodeClearAll(): string {
  return apc('a=d,d=A,q=2');
}

/** Stateful renderer that owns the double-buffering. Writes to the provided sink. */
export class KittyRenderer {
  private ids: [number, number] = [7001, 7002];
  private cur = 0;
  private z = 1;

  constructor(
    private write: (s: string) => void,
    private q: number = 2,
  ) {}

  drawFrame(data: Buffer, meta: FrameMeta, cols: number, rows: number, atRow = 1, atCol = 1): void {
    const id = this.ids[this.cur];
    const prev = this.ids[this.cur ^ 1];
    let out = `${ESC}[${atRow};${atCol}H`; // cursor to placement origin (C=1 keeps it there)
    out += encodeFrame(data, meta, { id, z: this.z, cols, rows, q: this.q });
    if (this.z > 1) out += encodeDelete(prev);
    this.write(out);
    this.cur ^= 1;
    this.z += 1;
  }

  clear(): void {
    this.z = 1;
    this.write(encodeClearAll());
  }
}
