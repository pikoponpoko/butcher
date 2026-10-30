// Image tool data: open documents, layer names, slices and export targets. No React here.
import { readPsd } from 'ag-psd';
import type { SqlJsStatic } from 'sql.js';
import * as PsdCore from '../../core/psdcore';
import type { PsdDoc, PsdNode } from '../../core/psdcore';
import { readClip } from '../../core/clipreader';

// Layer nodes carry UI-only fields next to the parsed data.
export interface Node extends PsdNode { children?: Node[]; _id: number; _parent: Node | null; _rename?: string; _thumb?: string | null }
export interface Slice { id: number; name: string; x: number; y: number; w: number; h: number; on: boolean }
export interface Doc { name: string; psd: PsdDoc & { children?: Node[] }; checked: Set<number>; slices: Slice[]; sliceSel: number | null; isImage?: boolean }
export type Mode = 'layer' | 'folder' | 'both' | 'slice';
export type ExportTarget = { kind: 'slice'; s: Slice; path: string[]; n?: undefined } | { kind: 'folder' | 'layer'; n: Node; path: string[]; s?: undefined };

// Test PSDs (samples/), each inlined into its own chunk loaded on first selection.
const SAMPLE_FILES = import.meta.glob<string>('../../../samples/*.psd', { query: '?inline', import: 'default' });
export const SAMPLES = Object.keys(SAMPLE_FILES).map(k => k.split('/').pop()!);
export async function sampleBuf(k: string) {
  const b = atob((await SAMPLE_FILES[`../../../samples/${k}`]()).split(',')[1]), u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u.buffer;
}

export const WARN_JA: Record<string, string> = {
  effects: 'レイヤー効果は描画されません', adjustment: '調整レイヤーは適用されません', blendIf: 'ブレンド条件は適用されません',
  knockout: 'ノックアウトは適用されません', vectorMask: 'ベクトルマスクは適用されません', smartFilter: 'スマートフィルターは保存済みの画像を使用',
  noPixels: 'ピクセルデータがありません', vectorOnly: 'シェイプ・塗りつぶしの画像がありません', passThroughOpacity: '通過グループの不透明度は近似',
  specialFillOpacity: 'この描画モードの塗りは近似', specialOpacity: 'この描画モードの不透明度は近似', blendMode: '未対応の描画モード',
  maskFeather: 'マスクのぼかしは適用されません', artboard: 'アートボードの背景・切り抜きは適用されません',
  clipBlendUnverified: '合成モードは未検証（通常として処理）', clipMaskUnverified: 'CLIP STUDIOのマスクは未検証', clipOffset: 'レイヤーの位置情報は未検証',
  clipLayerType: 'この種類のレイヤーは未検証', clipLayout: 'タイル配置を読み取れません', clipPixelFormat: 'この色形式は未対応',
};

let sqlReady: Promise<SqlJsStatic> | null = null;
function ensureSQL() {
  if (!sqlReady) sqlReady = Promise.all([import('sql.js'), import('sql.js/dist/sql-wasm.wasm?url')])
    .then(([m, w]) => m.default({ locateFile: () => w.default }))
    .catch(() => { sqlReady = null; throw new Error('読み込み用ライブラリを取得できません'); });
  return sqlReady;
}
const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
export const SRC_RE = /\.(psd|psb|clip|png|jpe?g|webp|gif|bmp)$/i;
export async function openFile(name: string, buf: ArrayBuffer): Promise<Doc> {
  if (/\.clip$/i.test(name)) return makeDoc(name, await readClip(buf, await ensureSQL()));
  if (IMG_RE.test(name)) {
    const bmp = await createImageBitmap(new Blob([buf])), c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d')!; ctx.drawImage(bmp, 0, 0); const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = makeDoc(name, { width: c.width, height: c.height, children: [], imageData: { width: c.width, height: c.height, data: img.data } });
    d.isImage = true; return d;
  }
  return makeDoc(name, readPsd(buf, { useImageData: true }) as PsdDoc);
}
function makeDoc(name: string, psd: PsdDoc): Doc {
  let id = 0; const checked = new Set<number>();
  (function tag(ch: PsdNode[] | undefined, par: Node | null) { for (const n of (ch || []) as Node[]) { n._id = ++id; n._parent = par; checked.add(n._id); tag(n.children, n); } })(psd.children, null);
  return { name, psd: psd as Doc['psd'], checked, slices: loadSlicesLocal(name, psd), sliceSel: null };
}

export const nameOf = (n: Node) => n._rename ?? n.name ?? '';
export const pathOf = (n: Node) => { const p: string[] = []; for (let q = n._parent; q; q = q._parent) p.unshift(nameOf(q)); return p; };
export const stem = (n: string) => n.replace(/\.(psd|psb|clip|png|jpe?g|webp|gif|bmp)$/i, '');
export const safe = (s: string) => (s || '_').replace(/[\\/:*?"<>|]/g, '_');
export function dedupe(ws: PsdCore.Warning[]) { const s = new Set<string>(); return ws.filter(w => { const k = w.path + w.type; if (s.has(k)) return false; s.add(k); return true; }); }

export function thumbOf(n: Node) {
  if (n._thumb !== undefined) return n._thumb;
  n._thumb = null;
  const img = n.imageData; if (!img) return null;
  const s = document.createElement('canvas'); s.width = img.width; s.height = img.height;
  const d = img.data instanceof Uint8ClampedArray ? img.data : Uint8ClampedArray.from(img.data, v => v * 255 / PsdCore.depthMax(img.data));
  s.getContext('2d')!.putImageData(new ImageData(d as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const c = document.createElement('canvas'); c.width = c.height = 52; const k = Math.min(52 / img.width, 52 / img.height);
  c.getContext('2d')!.drawImage(s, (52 - img.width * k) / 2, (52 - img.height * k) / 2, img.width * k, img.height * k);
  return (n._thumb = c.toDataURL());
}

export interface Rendered { rgba: Uint8ClampedArray; W: number; H: number; warnings: PsdCore.Warning[] }
export function renderNode(d: Doc, n: Node | null, includeHidden: boolean): Rendered {
  if (!n && !(d.psd.children || []).length && d.psd.imageData) return { rgba: new Uint8ClampedArray(d.psd.imageData.data), W: d.psd.width, H: d.psd.height, warnings: [] };
  const o = { includeHidden };
  const r = n ? PsdCore.compositeNode(d.psd, n, o) : PsdCore.compositeDocument(d.psd, o);
  return { rgba: PsdCore.toRGBA8(r.buf, r.W, r.H), W: r.W, H: r.H, warnings: r.warnings };
}

export function targetsOf(d: Doc, mode: Mode, includeHidden: boolean): ExportTarget[] {
  if (mode === 'slice') return d.slices.filter(s => s.on).map(s => ({ kind: 'slice' as const, s, path: [] }));
  const out: ExportTarget[] = [];
  (function walk(ch: Node[], path: string[]) {
    for (let i = ch.length - 1; i >= 0; i--) {
      const n = ch[i];
      if (n.hidden && !includeHidden) continue;
      const on = d.checked.has(n._id);
      if (n.children) { if (on && mode !== 'layer') out.push({ kind: 'folder', n, path }); walk(n.children, path.concat(nameOf(n))); }
      else if (on && mode !== 'folder') out.push({ kind: 'layer', n, path });
    }
  })(d.psd.children || [], []);
  return out;
}
export function summarize(docs: Doc[], mode: Mode, includeHidden: boolean) {
  let n = 0, w = 0;
  for (const d of docs) for (const t of targetsOf(d, mode, includeHidden)) { n++; if (PsdCore.collectWarningsDeep(t.n || { children: d.psd.children || [] }, { includeHidden }).length) w++; }
  return { n, w };
}

// Slices: canvas-space rectangles cut from the document composite, remembered per file name + canvas size
const slKey = (name: string, psd: PsdDoc) => `slices:${name}:${psd.width}x${psd.height}`;
let slSeq = 0;
export const newSliceId = () => ++slSeq;
function loadSlicesLocal(name: string, psd: PsdDoc): Slice[] {
  try { const a = JSON.parse(localStorage.getItem(slKey(name, psd)) || '[]'); return a.map((s: Slice) => ({ ...s, id: ++slSeq, on: s.on !== false })); } catch { return []; }
}
export const sliceData = (d: Doc) => d.slices.map(({ name, x, y, w, h, on }) => ({ name, x, y, w, h, on }));
// undo history: export checks, layer renames and slices (selection is restored but is not an edit by itself)
export type Snap = { slices: Slice[]; sel: number | null; checked: number[]; ren: [number, string][] };
function eachNode(d: Doc, f: (n: Node) => void) { (function w(ch?: Node[]) { for (const n of ch || []) { f(n); w(n.children); } })(d.psd.children); }
export function snap(d: Doc): Snap {
  const ren: [number, string][] = []; eachNode(d, n => { if (n._rename != null) ren.push([n._id, n._rename]); });
  return { slices: d.slices.map(s => ({ ...s })), sel: d.sliceSel, checked: [...d.checked].sort((a, b) => a - b), ren };
}
export const sameSnap = (a: Snap, b: Snap) => JSON.stringify({ ...a, sel: 0 }) === JSON.stringify({ ...b, sel: 0 });
export function restore(d: Doc, s: Snap) {
  const ren = new Map(s.ren);
  d.slices = s.slices.map(x => ({ ...x })); d.sliceSel = s.sel; d.checked = new Set(s.checked); eachNode(d, n => { n._rename = ren.get(n._id); });
}
export function persistSlices(d: Doc) { try { localStorage.setItem(slKey(d.name, d.psd), JSON.stringify(sliceData(d))); } catch {} }
export function nextSliceName(d: Doc) { let i = d.slices.length + 1; const has = (n: string) => d.slices.some(s => s.name === n); while (has(`slice_${String(i).padStart(2, '0')}`)) i++; return `slice_${String(i).padStart(2, '0')}`; }
export function clampSlice(s: Slice, W: number, H: number) {
  // slices may extend up to one canvas beyond each edge (filled on export)
  s.w = Math.max(1, Math.min(Math.round(s.w), 3 * W)); s.h = Math.max(1, Math.min(Math.round(s.h), 3 * H));
  s.x = Math.max(-W, Math.min(Math.round(s.x), 2 * W - s.w)); s.y = Math.max(-H, Math.min(Math.round(s.y), 2 * H - s.h));
}
export const curSlice = (d: Doc | undefined) => d?.slices.find(s => s.id === d.sliceSel) || null;
