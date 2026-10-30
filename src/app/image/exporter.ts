// Image export: encode composites (trim / slice crop / resize) and write them to a ZIP, single files or a folder.
import JSZip from 'jszip';
import * as PsdCore from '../../core/psdcore';
import { saveBlob, saveFailText } from '../save';
import { type SnsSize, SNS_IMAGE, snsImageExt, snsPicked } from '../sns';
import { type Doc, type Mode, type Node, type Slice, type Rendered, WARN_JA, dedupe, nameOf, renderNode, safe, stem, targetsOf } from './model';

export interface Settings {
  mode: Mode; fmt: 'png' | 'jpeg' | 'webp'; quality: string; size: 'orig' | 'w' | 'h' | 'sns'; sns: string[]; snsFit: 'cover' | 'contain'; px: string; basis: 'canvas' | 'image'; trim: boolean;
  prefix: string; suffix: string; hidden: boolean; tree: boolean; slFill: boolean; allFiles: boolean; incWarn: boolean; out: 'zip' | 'each' | 'dir';
}
// Status line in the inspector footer: plain text or colored parts.
export type StatusPart = { t: string; c?: 'ok' | 'warn' | 'err' };
export type Status = StatusPart[];

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
// Most common color along the border of a rect, or null when the border is mostly transparent.
function borderColor(c: HTMLCanvasElement, x: number, y: number, w: number, h: number) {
  const px = c.getContext('2d')!.getImageData(x, y, w, h).data, bins = new Map<number, number[]>(); let n = 0, op = 0;
  const add = (i: number, j: number) => {
    const p = (j * w + i) * 4; n++; if (px[p + 3] < 255) return; op++;
    const k = (px[p] >> 4) << 8 | (px[p + 1] >> 4) << 4 | px[p + 2] >> 4, b = bins.get(k) || [0, 0, 0, 0];
    b[0] += px[p]; b[1] += px[p + 1]; b[2] += px[p + 2]; b[3]++; bins.set(k, b);
  };
  for (let i = 0; i < w; i++) { add(i, 0); if (h > 1) add(i, h - 1); }
  for (let j = 1; j < h - 1; j++) { add(0, j); if (w > 1) add(w - 1, j); }
  if (op * 2 < n) return null;
  let best: number[] | null = null; for (const b of bins.values()) if (!best || b[3] > best[3]) best = b;
  return `rgb(${Math.round(best![0] / best![3])},${Math.round(best![1] / best![3])},${Math.round(best![2] / best![3])})`;
}
async function encode(o: Settings, rgba: Uint8ClampedArray, W: number, H: number, crop?: Slice | null, sns?: SnsSize | null) {
  let c = toCanvas(rgba, W, H), x = 0, y = 0, w = W, h = H;
  if (crop) { c = toCanvas(cropPixels(rgba, W, H, crop, o.slFill), crop.w, crop.h); w = crop.w; h = crop.h; }
  else if (o.trim) { const b = PsdCore.alphaBounds(rgba, W, H); if (!b) return null; ({ x, y, w, h } = b); }
  const fmt = sns ? (snsImageExt(sns) === 'jpg' ? 'jpeg' : 'png') : o.fmt;
  const out = document.createElement('canvas'), ctx = out.getContext('2d')!;
  let dx = 0, dy = 0, dw: number, dh: number;
  if (sns) {
    // cover crops the center; contain pads with the image's border color (transparent when the border is)
    out.width = sns.w; out.height = sns.h;
    const k = o.snsFit === 'cover' ? Math.max(sns.w / w, sns.h / h) : Math.min(sns.w / w, sns.h / h);
    dw = w * k; dh = h * k; dx = (sns.w - dw) / 2; dy = (sns.h - dh) / 2;
  } else {
    const px = Math.max(1, +o.px || 1);
    const s = o.size === 'orig' ? 1 : o.basis === 'canvas' ? px / (o.size === 'w' ? W : H) : px / (o.size === 'w' ? w : h);
    out.width = dw = Math.max(1, Math.round(w * s)); out.height = dh = Math.max(1, Math.round(h * s));
  }
  ctx.imageSmoothingQuality = 'high';
  const pad = sns && o.snsFit === 'contain' ? borderColor(c, x, y, w, h) : null;
  if (fmt === 'jpeg' || pad) { ctx.fillStyle = pad || '#ffffff'; ctx.fillRect(0, 0, out.width, out.height); }
  ctx.drawImage(c, x, y, w, h, dx, dy, dw, dh);
  const q = Math.min(100, Math.max(1, +o.quality || 90)) / 100;
  return await new Promise<Blob | null>(res => out.toBlob(res, 'image/' + fmt, q));
}
async function writeTo(dir: FileSystemDirectoryHandle, path: string, blob: Blob) {
  const parts = path.split('/'), file = parts.pop()!;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(file, { create: true })).createWritable(); await w.write(blob); await w.close();
}
const extOf = (o: Settings, v?: SnsSize | null) => v ? snsImageExt(v) : o.fmt === 'jpeg' ? 'jpg' : o.fmt;
// One entry per file written for each target: the SNS sizes, or the plain export.
export const variantsOf = (o: Settings): (SnsSize | null)[] => o.size === 'sns' ? snsPicked(SNS_IMAGE, o.sns) : [null];
const tagOf = (v: SnsSize | null) => v ? '_' + v.id : '';

export async function saveCurrent(o: Settings, d: Doc, n: Node | null, s: Slice | null): Promise<Status> {
  const r = renderNode(d, n, o.hidden);
  const base = s ? s.name : n ? nameOf(n) : stem(d.name), vs = variantsOf(o);
  if (!vs.length) return [{ t: 'サイズを選んでください', c: 'err' }];
  for (const v of vs) {
    const blob = await encode(o, r.rgba, r.W, r.H, s, v);
    if (!blob) return [{ t: '空の画像です', c: 'err' }];
    const res = await saveBlob(o.prefix + safe(base) + o.suffix + tagOf(v) + '.' + extOf(o, v), blob);
    if (res !== 'ok') return [{ t: saveFailText(res) }];
  }
  return [{ t: `${vs.length} ファイルを書き出し`, c: 'ok' }];
}

declare global { function showDirectoryPicker(o?: { mode?: string }): Promise<FileSystemDirectoryHandle> }
// Returns the final status; `progress` reports per-file progress, `noDir` is called when folder output isn't available.
export async function exportAll(o: Settings, docs: Doc[], progress: (s: Status) => void, noDir: () => void): Promise<Status> {
  const zip = new JSZip(), report: string[] = [], vs = variantsOf(o);
  if (!vs.length) return [{ t: 'サイズを選んでください', c: 'err' }];
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
        const rel = o.mode === 'both' ? (t.kind === 'folder' ? 'folders/' : 'layers/') : '';
        const dirPath = base + rel + (o.tree ? t.path.map(safe).map(p => p + '/').join('') : (t.path.length ? t.path.map(safe).join('_') + '_' : ''));
        const name0 = dirPath + o.prefix + stemName + o.suffix;
        if (ws.length) report.push(`${name0}\n` + ws.map(w => `  - ${w.path}: ${WARN_JA[w.type] || w.type}${w.detail ? ` (${w.detail})` : ''}`).join('\n'));
        if (ws.length && !o.incWarn) { skipped += vs.length; continue; }
        for (const v of vs) {
          const path = name0 + tagOf(v) + '.' + extOf(o, v);
          const blob = await encode(o, r.rgba, r.W, r.H, t.s, v);
          if (!blob) { report.push(`${path}\n  - 空の画像のため省略`); break; }
          if (dir) await writeTo(dir, path, blob);
          else if (o.out === 'each') { const res = await saveBlob(path.replace(/\//g, '_'), blob); if (res !== 'ok') return [{ t: saveFailText(res) }]; }
          else zip.file(path, blob);
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
