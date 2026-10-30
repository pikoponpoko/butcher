// Image export: encode composites (trim / slice crop / resize) and write them to a ZIP, single files or a folder.
import JSZip from 'jszip';
import * as PsdCore from '../../core/psdcore';
import { saveBlob, saveFailText } from '../save';
import { type Doc, type Mode, type Node, type Slice, type Rendered, WARN_JA, dedupe, nameOf, renderNode, safe, stem, targetsOf } from './model';

export interface Settings {
  mode: Mode; fmt: 'png' | 'jpeg' | 'webp' | 'ico'; quality: string; size: 'orig' | 'w' | 'h'; px: string; basis: 'canvas' | 'image'; trim: boolean;
  prefix: string; suffix: string; hidden: boolean; tree: boolean; slFill: boolean; allFiles: boolean; incWarn: boolean; out: 'zip' | 'each' | 'dir';
}
// Status line in the inspector footer: plain text or colored parts.
export type StatusPart = { t: string; c?: 'ok' | 'warn' | 'err' };
export type Status = StatusPart[];

const extOf = (o: Settings) => o.fmt === 'jpeg' ? 'jpg' : o.fmt;
function toCanvas(rgba: Uint8ClampedArray, W: number, H: number) { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0); return c; }
export { toCanvas };

// Cut a canvas-space rect (outside the canvas = transparent). With fill, pixels that aren't fully opaque are
// filled with the most common color along the edge of the transparent area (the background color).
function cropPixels(rgba: Uint8ClampedArray, W: number, H: number, r: Slice, fill: boolean) {
  const out = new Uint8ClampedArray(r.w * r.h * 4), src = new Uint32Array(rgba.buffer, rgba.byteOffset, W * H), dst = new Uint32Array(out.buffer);
  for (let j = 0; j < r.h; j++) {
    const sy = r.y + j; if (sy < 0 || sy >= H) continue;
    for (let i = 0; i < r.w; i++) { const sx = r.x + i; if (sx >= 0 && sx < W) dst[j * r.w + i] = src[sy * W + sx]; }
  }
  if (fill) fillTransparent(out, r.w, r.h);
  return out;
}
function fillTransparent(px: Uint8ClampedArray, w: number, h: number) {
  const bins = new Map<number, number[]>(); let any = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4; if (px[p + 3] !== 255) { any = true; continue; }
    let edge = false;
    for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h && px[(ny * w + nx) * 4 + 3] < 255) { edge = true; break; }
    }
    if (!edge) continue;
    const k = (px[p] >> 4) << 8 | (px[p + 1] >> 4) << 4 | px[p + 2] >> 4, b = bins.get(k) || [0, 0, 0, 0];
    b[0] += px[p]; b[1] += px[p + 1]; b[2] += px[p + 2]; b[3]++; bins.set(k, b);
  }
  if (!any || !bins.size) return;
  let best: number[] | null = null; for (const b of bins.values()) if (!best || b[3] > best[3]) best = b;
  const c = [best![0] / best![3], best![1] / best![3], best![2] / best![3]];
  for (let p = 0; p < px.length; p += 4) {
    const a = px[p + 3]; if (a === 255) continue; const k = a / 255;
    px[p] = px[p] * k + c[0] * (1 - k); px[p + 1] = px[p + 1] * k + c[1] * (1 - k); px[p + 2] = px[p + 2] * k + c[2] * (1 - k); px[p + 3] = 255;
  }
}
// Encoded files for one image: `tail` follows the file stem (".png", or for Favicon ".ico" / "-180.png" ...).
type Encoded = { tail: string; blob: Blob }[];
const ICO_SIZES = [16, 32, 48], FAVICON_PNG = [180, 192, 512];

async function encode(o: Settings, rgba: Uint8ClampedArray, W: number, H: number, crop?: Slice | null): Promise<Encoded | null> {
  let c = toCanvas(rgba, W, H), x = 0, y = 0, w = W, h = H;
  if (crop) { c = toCanvas(cropPixels(rgba, W, H, crop, o.slFill), crop.w, crop.h); w = crop.w; h = crop.h; }
  else if (o.trim) { const b = PsdCore.alphaBounds(rgba, W, H); if (!b) return null; ({ x, y, w, h } = b); }
  if (o.fmt === 'ico') return favicon(c, x, y, w, h);
  const px = Math.max(1, +o.px || 1);
  const s = o.size === 'orig' ? 1 : o.basis === 'canvas' ? px / (o.size === 'w' ? W : H) : px / (o.size === 'w' ? w : h);
  const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(w * s)); out.height = Math.max(1, Math.round(h * s));
  const ctx = out.getContext('2d')!; ctx.imageSmoothingQuality = 'high';
  if (o.fmt === 'jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height); }
  ctx.drawImage(c, x, y, w, h, 0, 0, out.width, out.height);
  const q = Math.min(100, Math.max(1, +o.quality || 90)) / 100;
  const blob = await new Promise<Blob | null>(res => out.toBlob(res, 'image/' + o.fmt, q));
  return blob && [{ tail: '.' + extOf(o), blob }];
}
const pngBlob = (c: HTMLCanvasElement) => new Promise<Blob>((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('PNG')), 'image/png'));
// Favicon set: the region fitted (centered, transparent margin) into a square, as a 16/32/48 .ico and 180/192/512 PNGs.
async function favicon(c: HTMLCanvasElement, x: number, y: number, w: number, h: number): Promise<Encoded> {
  const side = Math.max(w, h), sq = document.createElement('canvas'); sq.width = sq.height = side;
  sq.getContext('2d')!.drawImage(c, x, y, w, h, (side - w) >> 1, (side - h) >> 1, w, h);
  const at = async (n: number) => {
    const out = document.createElement('canvas'); out.width = out.height = n;
    const ctx = out.getContext('2d')!; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(sq, 0, 0, n, n);
    return pngBlob(out);
  };
  const ico = await Promise.all(ICO_SIZES.map(at));
  return [{ tail: '.ico', blob: await icoFile(ico, ICO_SIZES) }, ...await Promise.all(FAVICON_PNG.map(async n => ({ tail: `-${n}.png`, blob: await at(n) })))];
}
// ICO container with PNG-compressed entries.
export async function icoFile(pngs: Blob[], sizes: number[]) {
  const head = new DataView(new ArrayBuffer(6 + 16 * pngs.length));
  head.setUint16(2, 1, true); head.setUint16(4, pngs.length, true);
  let off = head.byteLength;
  pngs.forEach((p, i) => {
    const e = 6 + 16 * i, n = sizes[i] >= 256 ? 0 : sizes[i];
    head.setUint8(e, n); head.setUint8(e + 1, n); head.setUint16(e + 4, 1, true); head.setUint16(e + 6, 32, true);
    head.setUint32(e + 8, p.size, true); head.setUint32(e + 12, off, true); off += p.size;
  });
  return new Blob([head.buffer, ...pngs], { type: 'image/x-icon' });
}
async function writeTo(dir: FileSystemDirectoryHandle, path: string, blob: Blob) {
  const parts = path.split('/'), file = parts.pop()!;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(file, { create: true })).createWritable(); await w.write(blob); await w.close();
}

export async function saveCurrent(o: Settings, d: Doc, n: Node | null, s: Slice | null): Promise<Status> {
  const r = renderNode(d, n, o.hidden);
  const files = await encode(o, r.rgba, r.W, r.H, s);
  if (!files) return [{ t: '空の画像です', c: 'err' }];
  const name = o.prefix + safe(s ? s.name : n ? nameOf(n) : stem(d.name)) + o.suffix;
  let res;
  if (files.length === 1) res = await saveBlob(name + files[0].tail, files[0].blob);
  else { const zip = new JSZip(); for (const f of files) zip.file(name + f.tail, f.blob); res = await saveBlob(name + '.zip', await zip.generateAsync({ type: 'blob' })); }
  return res === 'ok' ? [{ t: `${files.length} ファイルを書き出し`, c: 'ok' }] : [{ t: saveFailText(res) }];
}

declare global { function showDirectoryPicker(o?: { mode?: string }): Promise<FileSystemDirectoryHandle> }
// Returns the final status; `progress` reports per-file progress, `noDir` is called when folder output isn't available.
export async function exportAll(o: Settings, docs: Doc[], progress: (s: Status) => void, noDir: () => void): Promise<Status> {
  const zip = new JSZip(), report: string[] = [];
  let dir: FileSystemDirectoryHandle | null = null;
  if (o.out === 'dir') {
    try { dir = await showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e: any) { if (e.name === 'AbortError') return [{ t: '保存を取り消しました' }]; noDir(); return [{ t: 'この環境ではフォルダに保存できません', c: 'err' }]; }
  }
  let written = 0, skipped = 0;
  try {
    for (const d of docs) {
      const base = docs.length > 1 ? safe(stem(d.name)) + '/' : '';
      const ts = targetsOf(d, o.mode, o.hidden), used = new Set<string>();
      let full: Rendered | null = null;
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        progress([{ t: `${d.name} ${i + 1}/${ts.length}` }]);
        await new Promise(r => setTimeout(r));
        const r = t.s ? (full ||= renderNode(d, null, o.hidden)) : renderNode(d, t.n, o.hidden);
        const ws = dedupe(r.warnings.filter(w => w.type !== 'text'));
        let stemName = safe(t.s ? t.s.name : nameOf(t.n));
        if (t.s) { let k = 2; const b = stemName; while (used.has(stemName)) stemName = `${b}_${k++}`; used.add(stemName); }
        const fname = o.prefix + stemName + o.suffix;
        const rel = o.mode === 'both' ? (t.kind === 'folder' ? 'folders/' : 'layers/') : '';
        const path = base + rel + (o.tree ? t.path.map(safe).map(p => p + '/').join('') : (t.path.length ? t.path.map(safe).join('_') + '_' : '')) + fname;
        if (ws.length) report.push(`${path}.${extOf(o)}\n` + ws.map(w => `  - ${w.path}: ${WARN_JA[w.type] || w.type}${w.detail ? ` (${w.detail})` : ''}`).join('\n'));
        if (ws.length && !o.incWarn) { skipped++; continue; }
        const files = await encode(o, r.rgba, r.W, r.H, t.s);
        if (!files) { report.push(`${path}.${extOf(o)}\n  - 空の画像のため省略`); continue; }
        for (const f of files) {
          if (dir) await writeTo(dir, path + f.tail, f.blob);
          else if (o.out === 'each') { const res = await saveBlob((path + f.tail).replace(/\//g, '_'), f.blob); if (res !== 'ok') return [{ t: saveFailText(res) }]; }
          else zip.file(path + f.tail, f.blob);
          written++;
        }
      }
    }
    const done: Status = [{ t: `${written} ファイルを書き出し`, c: 'ok' }, ...(skipped ? [{ t: ' · ' }, { t: `${skipped} 件を省略`, c: 'warn' as const }] : [])];
    const none: Status = [{ t: '書き出せる画像がありません', c: 'err' }];
    if (dir && report.length) await writeTo(dir, 'warnings.txt', new Blob([report.join('\n\n') + '\n']));
    if (o.out !== 'zip') return written ? done : none;
    if (report.length) zip.file('warnings.txt', (skipped ? `警告のため書き出さなかった画像: ${skipped}\n\n` : '') + report.join('\n\n') + '\n');
    if (!written) return none;
    const data = await zip.generateAsync({ type: 'blob' });
    const name = (docs.length > 1 ? 'psd-export' : safe(stem(docs[0].name))) + '.zip';
    const res = await saveBlob(name, data);
    return res === 'ok' ? done : [{ t: saveFailText(res) }];
  } catch (e: any) { return [{ t: `エラー: ${String(e.message || e)}`, c: 'err' }]; }
}
