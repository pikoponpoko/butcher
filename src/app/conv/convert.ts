// 変換 tool: batch format / size / rotation / flip conversion of plain images. Everything runs on the device.
import { type Sign, drawSign } from '../sign';
import { decode } from './decode';

export type ConvFmt = 'orig' | 'jpeg' | 'png' | 'webp';
export type ConvSize = 'orig' | 'long' | 'w' | 'h' | 'pct';
export type Rot = '0' | '90' | '180' | '270';
export type Naming = 'orig' | 'seq';
export interface NameRule { naming: Naming; prefix: string; suffix: string; seqText: string; seqStart: string; seqDigits: string }
export interface ConvSettings extends NameRule {
  fmt: ConvFmt; quality: string; size: ConvSize; px: string; pct: string; noUp: boolean; rot: Rot; flipH: boolean; flipV: boolean; out: 'zip' | 'each' | 'dir';
}
export const CONV_INIT: ConvSettings = {
  fmt: 'jpeg', quality: '90', size: 'orig', px: '1920', pct: '50', noUp: true, rot: '0', flipH: false, flipV: false, out: 'zip',
  naming: 'orig', prefix: '', suffix: '', seqText: 'image_', seqStart: '1', seqDigits: '3',
};

export { CONV_RE } from './decode';
const int = (s: string, lo: number, hi: number, d: number) => { const n = Math.round(+s); return s.trim() !== '' && isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

// File stem for the i-th output (0-based): the original name with prefix / suffix, or text + zero-padded number.
export function ruleName(r: NameRule, orig: string, i: number) {
  if (r.naming === 'orig') return r.prefix + orig + r.suffix;
  const n = int(r.seqStart, 0, 1e9, 1) + i, d = int(r.seqDigits, 1, 10, 3);
  return r.seqText + String(n).padStart(d, '0');
}

// Output pixel size for a source of W×H. Rotation by 90/270 swaps the sides first; the size rule applies to the result.
export function outSize(o: Pick<ConvSettings, 'size' | 'px' | 'pct' | 'noUp' | 'rot'>, W: number, H: number) {
  const sw = o.rot === '90' || o.rot === '270';
  const w = sw ? H : W, h = sw ? W : H, px = int(o.px, 1, 20000, 1920);
  let k = 1;
  if (o.size === 'pct') k = int(o.pct, 1, 1000, 100) / 100;
  else if (o.size === 'long') k = px / Math.max(w, h);
  else if (o.size === 'w') k = px / w;
  else if (o.size === 'h') k = px / h;
  if (o.noUp && k > 1) k = 1;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

const EXT: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
// 元 keeps JPEG / PNG / WebP; GIF, BMP and AVIF become PNG.
export function fmtFor(f: ConvFmt, name: string): 'jpeg' | 'png' | 'webp' {
  if (f !== 'orig') return f;
  return /\.jpe?g$/i.test(name) ? 'jpeg' : /\.webp$/i.test(name) ? 'webp' : 'png';
}
export const extFor = (f: ConvFmt, name: string) => EXT[fmtFor(f, name)];
export const stemOf = (name: string) => name.replace(/\.[^./\\]+$/, '');

export class NoEncoder extends Error { constructor(public fmt: string) { super('no encoder'); } }

// Decode (EXIF orientation applied), resize, rotate, flip, stamp the signature and encode one file.
export async function convertFile(o: ConvSettings, file: Blob, name: string, sign: Sign): Promise<{ blob: Blob; w: number; h: number; W: number; H: number }> {
  const src = await decode(file, name);
  const W = src.width, H = src.height, { w, h } = outSize(o, W, H), sw = o.rot === '90' || o.rot === '270';
  const dw = sw ? h : w, dh = sw ? w : h;
  // the browser's high-quality resampler; drawImage below only moves pixels
  let bmp = src;
  if (dw !== W || dh !== H) {
    try { bmp = await createImageBitmap(src, { resizeWidth: dw, resizeHeight: dh, resizeQuality: 'high' }); src.close(); } catch { bmp = src; }
  }
  const fmt = fmtFor(o.fmt, name), c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  if (fmt === 'jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
  ctx.save();
  ctx.translate(w / 2, h / 2);
  // flips mirror the rotated result (左右 = across the output's vertical axis)
  ctx.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1);
  ctx.rotate(+o.rot * Math.PI / 180);
  ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  bmp.close();
  drawSign(ctx, 0, 0, w, h, sign);
  const q = int(o.quality, 1, 100, 90) / 100;
  const blob = await new Promise<Blob | null>(res => c.toBlob(res, 'image/' + fmt, q));
  c.width = c.height = 0;
  if (!blob) throw new Error('encode');
  if (blob.type !== 'image/' + fmt) throw new NoEncoder(fmt);
  return { blob, w, h, W, H };
}
