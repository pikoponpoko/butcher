// 四面図: rendering in a worker (one file at a time; the page itself when a worker can't start), crops kept as PNG.
import { NotSheet, type Rect, type SheetView, type Square, renderSheet, viewRow } from '../../core/clipsheet';
import { decodePng, encodePng } from '../../core/png';
import { ensureSQL } from '../image/model';
import { loadSheetWorker } from '../lazy';

export interface Rendered { views: SheetView[]; warnings: { layer: string; type: string }[] }
export class Aborted extends Error { constructor() { super('aborted'); } }

let wasm: Promise<ArrayBuffer> | null = null;
const wasmBytes = () => wasm ||= import('sql.js/dist/sql-wasm.wasm?url').then(m => fetch(m.default))
  .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
  .catch(() => { wasm = null; throw new Error('読み込み用ライブラリを取得できません'); });

let worker: Worker | null = null, onPage = false, seq = 0;
let job: { id: number; step: (n: number) => void; done: (r: Rendered) => void; fail: (e: unknown) => void } | null = null;

async function start() {
  const [W, bin] = await Promise.all([loadSheetWorker(), wasmBytes()]);
  let w: Worker;
  try { w = new W(); } catch { onPage = true; return null; }
  w.onmessage = (e: MessageEvent) => {
    const m = e.data; if (!job || m.id !== job.id) return;
    if (m.step) { job.step(m.step); return; }
    const j = job; job = null;
    if (m.error) j.fail(typeof m.error === 'object' ? new NotSheet(m.error.W, m.error.H) : new Error(m.error));
    else j.done({ views: m.views, warnings: m.warnings });
  };
  // a crash (out of memory …) fails the file; the next one starts a new worker
  w.onerror = e => { e.preventDefault(); stopRender(new Error('読み込めません')); };
  w.postMessage({ wasm: bin });
  return w;
}

export async function renderClip(file: File, step: (n: number) => void): Promise<Rendered> {
  const buf = await file.arrayBuffer();
  if (!worker && !onPage) worker = await start();
  if (!worker) return renderSheet(buf, await ensureSQL(), step);
  const w = worker, id = ++seq;
  return new Promise((done, fail) => { job = { id, step, done, fail }; w.postMessage({ id, buf }, [buf]); });
}

// Stops the file being rendered (it fails with Aborted).
export function stopRender(err: unknown = new Aborted()) {
  worker?.terminate(); worker = null;
  const j = job; job = null; j?.fail(err);
}

const canvas = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

// A panel's drawing as PNG, and (thumb > 0) a small preview of it as a data URL.
export async function encodeCrop(rgba: Uint8ClampedArray, w: number, h: number, thumb: number) {
  let small: string | undefined;
  if (thumb) {
    const c = canvas(w, h), k = Math.min(1, thumb / Math.max(w, h)), s = canvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))), x = s.getContext('2d')!;
    c.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
    x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, s.width, s.height); small = s.toDataURL(); s.width = s.height = c.width = c.height = 0;
  }
  return { png: await encodePng(w, h, (y, out) => out.set(rgba.subarray(y * w * 4, (y + 1) * w * 4))), thumb: small };
}

// The output image: the shared square, transparent around the panel's drawing.
export async function squarePng(png: Blob, box: Rect, sq: Square) {
  const v = { box, rgba: (await decodePng(png)).data };
  return encodePng(sq.size, sq.size, (y, out) => viewRow(v, sq, y, out));
}
