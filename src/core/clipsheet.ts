// Meshy 4-view sheets (Meshy四面図_<name>.clip): four square panels side by side on a 14688 px wide canvas.
// Every layer of such a sheet is canvas-sized, so the full-canvas RGBA that clipreader builds would need gigabytes.
// Here the tiles are only indexed when the file is read; each panel then decodes just the tiles over it,
// composites the visible drawing layers (guides, background and the colour sheet left out) on transparency.
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
import { chunks } from './clipreader';
import { compositeDocument, type PsdDoc, type PsdNode, type PixelImage } from './psdcore';

export interface Rect { x: number; y: number; w: number; h: number }
// Panel i covers x0 + i*size … in canvas pixels; the symmetry axis is the panel's middle.
export const SHEET = { W: 14688, x0: 539, y0: 539, size: 3482, n: 4 } as const;
// left to right on the sheet: 正面, 側面（右）, 背面, 側面（左）
export const VIEW_NAMES = ['Main', 'Right', 'Back', 'Left'] as const;
// top-level items that are not part of the drawing (paper layers, 用紙, are left out too)
export const SKIP_TOP = ['ガイド', '背景', '総合彩色見本'];
// alpha from which a pixel counts as drawing (the faintest black that showed on white). Fainter specks, as soft erasers
// leave them, don't widen the square; outside the drawing's box they are dropped.
const SEEN = 6;
const TILE = 256;

export class NotSheet extends Error { constructor(public W: number, public H: number) { super('not a sheet'); } }
export interface SheetView { box: Rect | null; rgba: Uint8ClampedArray | null }
export interface SheetResult { W: number; H: number; views: SheetView[]; warnings: { layer: string; type: string }[] }

type Row = Record<string, any>;
const rows = (db: Database, sql: string, args?: SqlValue[]): Row[] => { const st = db.prepare(sql); if (args) st.bind(args); const r: Row[] = []; while (st.step()) r.push(st.getAsObject()); st.free(); return r; };
const text = (v: string | Uint8Array) => typeof v === 'string' ? v : new TextDecoder().decode(v);

async function inflate(bytes: Uint8Array) {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// A layer bitmap: its tiles (still compressed) and where its top-left sits on the canvas.
interface Bitmap { W: number; H: number; cols: number; rows: number; x: number; y: number; init: number; fmt: 'rgba' | 'gray' | 'other'; tiles: (Uint8Array | null)[] }

// Offscreen.Attribute: section sizes, then "Parameter" (size, tile grid, pixel packing) and "InitColor" (fill of empty tiles).
function attrOf(a: Uint8Array) {
  const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const str = (p: number) => { const n = dv.getUint32(p); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(p + 4 + i * 2)); return { s, end: p + 4 + n * 2 }; };
  const hs = dv.getUint32(0), psz = dv.getUint32(4);
  const par = str(hs); if (par.s !== 'Parameter') return null;
  const p = par.end, at = (k: number) => dv.getUint32(p + 16 + k * 4);
  const ini = str(hs + psz); if (ini.s !== 'InitColor') return null;
  const pack = at(1) + '/' + at(2), oneBit = at(8) === 32;
  return {
    W: dv.getUint32(p), H: dv.getUint32(p + 4), cols: dv.getUint32(p + 8), rows: dv.getUint32(p + 12),
    fmt: (oneBit ? 'other' : pack === '1/4' ? 'rgba' : at(1) + at(2) === 1 ? 'gray' : 'other') as Bitmap['fmt'],
    init: dv.getUint32(ini.end + 4) ? 255 : 0,
  };
}

// The tile list of an external chunk, without inflating: [size][19]"BlockDataBeginChunk"[index][3 × ?][has][len][zlen LE][zlib]…
function tileIndex(data: Uint8Array, n: number) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength), out: (Uint8Array | null)[] = new Array(n).fill(null);
  let q = 0, k = 0;
  while (q + 8 <= data.length) {
    const size = dv.getUint32(q), nl = dv.getUint32(q + 4);
    if (nl !== 19 || size < 8) break; // BlockStatus / BlockCheckSum follow the tiles
    const b = q + 8 + nl * 2, index = dv.getUint32(b), has = dv.getUint32(b + 16);
    const i = index < n ? index : k;
    if (has && i < n) { const zlen = dv.getUint32(b + 24, true); out[i] = data.subarray(b + 28, Math.min(data.length, b + 28 + zlen)); }
    q += size; k++;
  }
  return out;
}

export interface SheetLayer {
  id: number; name: string; hidden: boolean; opacity: number; blend: string; clip: boolean; folder: boolean;
  children: SheetLayer[]; render: Bitmap | null; mask: Bitmap | null; fill: [number, number, number] | null; warn: string[];
}

// CLIP STUDIO composite modes (Layer.LayerComposite), named as psdcore names them
const BLEND: Record<number, string> = {
  0: 'normal', 1: 'darken', 2: 'multiply', 3: 'color burn', 4: 'linear burn', 5: 'subtract', 6: 'darker color', 7: 'lighten', 8: 'screen',
  9: 'color dodge', 10: 'color dodge', 11: 'linear dodge', 12: 'linear dodge', 13: 'lighter color', 14: 'overlay', 15: 'soft light',
  16: 'hard light', 17: 'vivid light', 18: 'linear light', 19: 'pin light', 20: 'hard mix', 21: 'difference', 22: 'exclusion',
  23: 'hue', 24: 'saturation', 25: 'color', 26: 'luminosity', 30: 'pass through', 36: 'divide',
};

export interface Sheet { W: number; H: number; layers: SheetLayer[] }

// Layer tree and tile index of a .clip (no pixels decoded). Top-level guides / background / colour sheet and paper are left out.
export function readSheet(buf: ArrayBuffer, SQL: SqlJsStatic): Sheet {
  const { ext, db: dbBytes } = chunks(buf);
  const db = new SQL.Database(dbBytes);
  try {
    const cv = rows(db, 'select CanvasWidth,CanvasHeight,CanvasRootFolder from Canvas')[0];
    const W = Math.round(cv.CanvasWidth), H = Math.round(cv.CanvasHeight);
    if (W !== SHEET.W || H < SHEET.y0 + SHEET.size) throw new NotSheet(W, H);
    const all = new Map(rows(db, 'select * from Layer').map(l => [l.MainId as number, l]));
    const bitmap = (mipmapId: number, x: number, y: number, warn: string[]): Bitmap | null => {
      if (!mipmapId) return null;
      const mm = rows(db, 'select BaseMipmapInfo from Mipmap where MainId=?', [mipmapId])[0];
      const mi = mm && rows(db, 'select Offscreen from MipmapInfo where MainId=?', [mm.BaseMipmapInfo])[0];
      const off = mi && rows(db, 'select Attribute,BlockData from Offscreen where MainId=?', [mi.Offscreen])[0];
      if (!off || !off.Attribute) return null;
      const a = attrOf(off.Attribute as Uint8Array);
      if (!a) { warn.push('clipLayout'); return null; }
      const chunk = off.BlockData ? ext.get(text(off.BlockData)) : undefined;
      const n = a.cols * a.rows;
      return { ...a, x, y, tiles: chunk ? tileIndex(chunk, n) : new Array(n).fill(null) };
    };
    const build = (id: number, top: boolean): SheetLayer | null => {
      const L = all.get(id); if (!L) return null;
      const name = String(L.LayerName ?? '');
      if (top && (SKIP_TOP.includes(name.trim()) || (L.DrawColorEnable && !L.LayerFolder))) return null;
      const warn: string[] = [], folder = !!L.LayerFolder;
      let blend = BLEND[L.LayerComposite as number];
      if (!blend) { warn.push('clipBlendUnverified'); blend = 'normal'; }
      else if (L.LayerComposite === 10 || L.LayerComposite === 12) warn.push('clipBlendApprox');
      if (folder && (L.LayerComposite === 0 || L.LayerComposite === 30)) blend = 'pass through';
      else if (!folder && blend === 'pass through') blend = 'normal';
      const n: SheetLayer = {
        id, name, hidden: !((L.LayerVisibility ?? 1) & 1), opacity: (L.LayerOpacity ?? 256) / 256, blend, clip: !!L.LayerClip, folder,
        children: [], render: null, mask: null, fill: null, warn,
      };
      const ox = (L.LayerOffsetX ?? 0) | 0, oy = (L.LayerOffsetY ?? 0) | 0;
      if (folder) {
        for (let c = L.LayerFirstChildIndex, guard = 0; c && guard < 100000; c = all.get(c)?.LayerNextIndex ?? 0, guard++) { const ch = build(c, false); if (ch) n.children.push(ch); }
      } else if (L.FilterLayerInfo) warn.push('adjustment');
      else if (L.DrawColorEnable) {
        const c = (k: string) => Math.round((Number(L['DrawColorMain' + k]) || 0) / 4294967295 * 255);
        n.fill = [c('Red'), c('Green'), c('Blue')];
      } else {
        n.render = bitmap(L.LayerRenderMipmap, ox + ((L.LayerRenderOffscrOffsetX ?? 0) | 0), oy + ((L.LayerRenderOffscrOffsetY ?? 0) | 0), warn);
        if (n.render && n.render.fmt !== 'rgba') { warn.push('clipPixelFormat'); n.render = null; }
      }
      if (L.LayerLayerMaskMipmap) {
        n.mask = bitmap(L.LayerLayerMaskMipmap, ox + ((L.LayerMaskOffsetX ?? 0) | 0) + ((L.LayerMaskOffscrOffsetX ?? 0) | 0), oy + ((L.LayerMaskOffsetY ?? 0) | 0) + ((L.LayerMaskOffscrOffsetY ?? 0) | 0), warn);
        if (n.mask && n.mask.fmt !== 'gray') { warn.push('clipPixelFormat'); n.mask = null; }
        if (n.mask) warn.push('clipMaskUnverified');
      }
      return n;
    };
    // the root folder's children (bottom to top) are the top level
    const layers: SheetLayer[] = [];
    for (let c = all.get(cv.CanvasRootFolder)?.LayerFirstChildIndex, guard = 0; c && guard < 100000; c = all.get(c)?.LayerNextIndex ?? 0, guard++) { const l = build(c, true); if (l) layers.push(l); }
    return { W, H, layers };
  } finally { db.close(); }
}

const inter = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
};
const union = (a: Rect | null, b: Rect | null): Rect | null => {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

// The part of a bitmap inside r (canvas coordinates), as RGBA (masks: the value in R, G, B, opaque).
// Only the tiles over r are inflated; the result is cut to the tiles that hold pixels (all of r when empty tiles are filled).
async function decode(bm: Bitmap, r: Rect, kind: 'color' | 'mask', warn: string[]): Promise<{ rect: Rect; img: PixelImage } | null> {
  const area = inter(r, { x: bm.x, y: bm.y, w: bm.W, h: bm.H });
  const filled = bm.init > 0;
  if (!area) return null;
  const tx0 = Math.max(0, Math.floor((area.x - bm.x) / TILE)), tx1 = Math.min(bm.cols - 1, Math.floor((area.x + area.w - 1 - bm.x) / TILE));
  const ty0 = Math.max(0, Math.floor((area.y - bm.y) / TILE)), ty1 = Math.min(bm.rows - 1, Math.floor((area.y + area.h - 1 - bm.y) / TILE));
  let box: Rect | null = filled ? area : null;
  const use: { t: Uint8Array; cell: Rect; tx: number; ty: number }[] = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const t = bm.tiles[ty * bm.cols + tx]; if (!t) continue;
    const cell = inter(area, { x: bm.x + tx * TILE, y: bm.y + ty * TILE, w: TILE, h: TILE }); if (!cell) continue;
    use.push({ t, cell, tx, ty }); if (!filled) box = union(box, cell);
  }
  if (!box) return null;
  const out = new Uint8ClampedArray(box.w * box.h * 4);
  if (filled) out.fill(kind === 'mask' ? bm.init : 255);
  else if (kind === 'mask') for (let i = 3; i < out.length; i += 4) out[i] = 255;
  for (const { t, cell, tx, ty } of use) {
    let px: Uint8Array;
    try { px = await inflate(t); } catch { warn.push('clipLayout'); continue; }
    const need = kind === 'color' ? TILE * TILE * 5 : TILE * TILE;
    if (px.length !== need) { warn.push('clipPixelFormat'); continue; }
    const sx0 = cell.x - (bm.x + tx * TILE), sy0 = cell.y - (bm.y + ty * TILE);
    for (let y = 0; y < cell.h; y++) {
      let s = (sy0 + y) * TILE + sx0, d = ((cell.y - box.y + y) * box.w + (cell.x - box.x)) * 4;
      if (kind === 'mask') for (let x = 0; x < cell.w; x++, s++, d += 4) { const v = px[s]; out[d] = out[d + 1] = out[d + 2] = v; out[d + 3] = 255; }
      else for (let x = 0; x < cell.w; x++, s++, d += 4) { const c = TILE * TILE + s * 4; out[d] = px[c + 2]; out[d + 1] = px[c + 1]; out[d + 2] = px[c]; out[d + 3] = px[s]; }
    }
  }
  return { rect: box, img: { width: box.w, height: box.h, data: out } };
}

interface Built { nodes: PsdNode[]; area: Rect | null }
// psdcore nodes for the part of the layers inside r, in canvas coordinates (shifted to the composited area later).
async function nodesIn(list: SheetLayer[], r: Rect, warn: SheetResult['warnings'], signal?: AbortSignal): Promise<Built> {
  const nodes: PsdNode[] = []; let area: Rect | null = null;
  for (const L of list) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const w: string[] = [...L.warn];
    const n: PsdNode = { name: L.name, hidden: L.hidden, opacity: L.opacity, blendMode: L.blend, clipping: L.clip };
    let own: Rect | null = null;
    if (L.folder) n.children = [];
    if (!L.hidden) {
      if (L.folder) { const b = await nodesIn(L.children, r, warn, signal); n.children = b.nodes; own = b.area; }
      else if (L.fill) {
        own = r; const d = new Uint8ClampedArray(r.w * r.h * 4);
        for (let i = 0; i < d.length; i += 4) { d[i] = L.fill[0]; d[i + 1] = L.fill[1]; d[i + 2] = L.fill[2]; d[i + 3] = 255; }
        n.imageData = { width: r.w, height: r.h, data: d }; Object.assign(n, { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h });
      } else if (L.render) {
        const got = await decode(L.render, r, 'color', w);
        if (got) { own = got.rect; n.imageData = got.img; Object.assign(n, { left: got.rect.x, top: got.rect.y, right: got.rect.x + got.rect.w, bottom: got.rect.y + got.rect.h }); }
      }
      if (L.mask && own) {
        const m = await decode(L.mask, own, 'mask', w);
        if (m) n.mask = { left: m.rect.x, top: m.rect.y, right: m.rect.x + m.rect.w, bottom: m.rect.y + m.rect.h, defaultColor: L.mask.init, imageData: m.img };
        // nothing painted on a mask that starts hidden: the layer shows nowhere
        else if (!L.mask.init) { n.imageData = null; if (n.children) n.children = []; own = null; }
      }
      // clipped layers draw only over their base, so they don't widen the area
      if (!L.clip) area = union(area, own);
    }
    for (const t of new Set(w)) warn.push({ layer: L.name, type: t });
    nodes.push(n);
  }
  return { nodes, area };
}

function shift(nodes: PsdNode[], dx: number, dy: number) {
  for (const n of nodes) {
    if (n.imageData) { n.left! -= dx; n.top! -= dy; n.right! -= dx; n.bottom! -= dy; }
    if (n.mask) { n.mask.left! -= dx; n.mask.top! -= dy; n.mask.right! -= dx; n.mask.bottom! -= dy; }
    if (n.children) shift(n.children, dx, dy);
  }
}

// Straight-alpha float RGBA as bytes (fully transparent pixels left zero), and the box of the drawing (alpha ≥ SEEN).
function toBytes(buf: Float32Array, W: number, H: number) {
  const out = new Uint8ClampedArray(W * H * 4);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0, p = 0; y < H; y++) {
    let any = false;
    for (let x = 0; x < W; x++, p += 4) {
      out[p + 3] = buf[p + 3] * 255; if (!out[p + 3]) continue;
      out[p] = buf[p] * 255; out[p + 1] = buf[p + 1] * 255; out[p + 2] = buf[p + 2] * 255;
      if (out[p + 3] >= SEEN) { any = true; if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    if (any) { if (y < y0) y0 = y; y1 = y; }
  }
  return { rgba: out, box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

export function panelRect(i: number): Rect { return { x: SHEET.x0 + i * SHEET.size, y: SHEET.y0, w: SHEET.size, h: SHEET.size }; }

// One panel composited: the drawing's box in panel coordinates and its pixels (straight-alpha RGBA), or null when blank.
export async function renderPanel(sheet: Sheet, i: number, warn: SheetResult['warnings'] = [], signal?: AbortSignal): Promise<SheetView> {
  const r = panelRect(i);
  const { nodes, area } = await nodesIn(sheet.layers, r, warn, signal);
  if (!area) return { box: null, rgba: null };
  shift(nodes, area.x, area.y);
  const doc: PsdDoc = { width: area.w, height: area.h, children: nodes };
  const { buf } = compositeDocument(doc);
  const flat = toBytes(buf, area.w, area.h);
  if (!flat.box) return { box: null, rgba: null };
  const b = flat.box, px = new Uint8ClampedArray(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) px.set(flat.rgba.subarray(((b.y + y) * area.w + b.x) * 4, ((b.y + y) * area.w + b.x + b.w) * 4), y * b.w * 4);
  return { box: { x: area.x - r.x + b.x, y: area.y - r.y + b.y, w: b.w, h: b.h }, rgba: px };
}

export async function renderSheet(buf: ArrayBuffer, SQL: SqlJsStatic, progress?: (done: number) => void, signal?: AbortSignal): Promise<SheetResult> {
  const sheet = readSheet(buf, SQL), warn: SheetResult['warnings'] = [], views: SheetView[] = [];
  for (let i = 0; i < SHEET.n; i++) {
    views.push(await renderPanel(sheet, i, warn, signal));
    progress?.(i + 1);
    await new Promise(r => setTimeout(r));
  }
  const seen = new Set<string>(), warnings = warn.filter(w => { const k = w.layer + '\n' + w.type; return !seen.has(k) && !!seen.add(k); });
  return { W: sheet.W, H: sheet.H, views, warnings };
}

// The square cut from every panel: wide enough for the widest drawing on both sides of the axis, tall enough for the
// tallest, plus `margin` (fraction of the larger side) on each side. Panel coordinates; null when all panels are blank.
export interface Square { x: number; y: number; size: number }
export function squareOf(boxes: (Rect | null)[], margin: number): Square | null {
  const axis = SHEET.size / 2;
  let half = 0, top = Infinity, bottom = -Infinity;
  for (const b of boxes) if (b) { half = Math.max(half, axis - b.x, b.x + b.w - axis); top = Math.min(top, b.y); bottom = Math.max(bottom, b.y + b.h); }
  if (!(bottom > top)) return null;
  const size = 2 * Math.ceil(Math.max(2 * half, bottom - top) * (1 + 2 * Math.max(0, margin)) / 2);
  return { x: axis - size / 2, y: Math.round((top + bottom - size) / 2), size };
}

// The output image is the square, transparent around the panel's drawing. viewRow puts its row y into out (zeroed, size × 4 bytes).
export function viewRow(v: SheetView, sq: Square, y: number, out: Uint8Array | Uint8ClampedArray) {
  const b = v.box, sy = y + sq.y - (b?.y ?? 0);
  if (!b || !v.rgba || sy < 0 || sy >= b.h) return;
  const x0 = Math.max(0, sq.x - b.x), x1 = Math.min(b.w, sq.x + sq.size - b.x); if (x1 <= x0) return;
  out.set(v.rgba.subarray((sy * b.w + x0) * 4, (sy * b.w + x1) * 4), (b.x + x0 - sq.x) * 4);
}
export function viewPixels(v: SheetView, sq: Square) {
  const S = sq.size, out = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) viewRow(v, sq, y, out.subarray(y * S * 4, (y + 1) * S * 4));
  return out;
}

// Output names per panel (left to right on the sheet); `swap` exchanges Left and Right.
export const viewNames = (swap: boolean) => swap ? ['Main', 'Left', 'Back', 'Right'] : [...VIEW_NAMES];
// "Meshy四面図_ねこ.clip" → "ねこ"
export const charName = (file: string) => file.replace(/\.clip$/i, '').replace(/^Meshy四面図[_＿\s-]*/, '') || file.replace(/\.clip$/i, '');
