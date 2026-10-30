// CLIP STUDIO PAINT (.clip) reader: converts to the same node shape psdcore consumes.
// Format notes (reverse-engineered, unofficial): CSFCHUNK container holding zlib-compressed
// 256x256 pixel tiles (CHNKExta) and an SQLite database (CHNKSQLi) describing layers.
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
import type { PixelImage, PsdDoc, PsdNode } from './psdcore';

type Row = Record<string, any>;
export interface ClipDoc extends PsdDoc { previewPng?: Uint8Array }

const TILE = 256;

export function chunks(buf: ArrayBuffer) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), ext = new Map<string, Uint8Array>();
  const tag = (p: number) => String.fromCharCode(...u8.subarray(p, p + 8));
  if (tag(0) !== 'CSFCHUNK') throw new Error('CLIP STUDIOのファイルではありません');
  let p = 24, db: Uint8Array | null = null;
  while (p + 16 <= u8.length) {
    const name = tag(p), size = Number(dv.getBigUint64(p + 8));
    const body = p + 16;
    if (name === 'CHNKExta') {
      const idLen = Number(dv.getBigUint64(body));
      const id = String.fromCharCode(...u8.subarray(body + 8, body + 8 + idLen));
      const dLen = Number(dv.getBigUint64(body + 8 + idLen));
      ext.set(id, u8.subarray(body + 16 + idLen, body + 16 + idLen + dLen));
    } else if (name === 'CHNKSQLi') db = u8.subarray(body, body + size);
    p = body + size;
  }
  if (!db) throw new Error('レイヤー情報が見つかりません');
  return { ext, db };
}

async function inflate(bytes: Uint8Array) {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// Tile list inside one external chunk: [{ index, data|null }]
async function tiles(data: Uint8Array) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength), out: { index: number; data: Uint8Array | null }[] = [];
  let q = 0;
  while (q + 8 <= data.length) {
    const start = q, size = dv.getUint32(q), nl = dv.getUint32(q + 4);
    if (nl !== 19) break; // "BlockDataBeginChunk"
    q += 8 + nl * 2;
    const index = dv.getUint32(q), has = dv.getUint32(q + 16);
    q += 20;
    let px: Uint8Array | null = null;
    if (has) { const zlen = dv.getUint32(q + 4, true); px = await inflate(data.subarray(q + 8, q + 8 + zlen)); }
    out.push({ index, data: px });
    q = start + size;
  }
  return out;
}

const rows = (db: Database, sql: string, args?: SqlValue[]): Row[] => { const st = db.prepare(sql); if (args) st.bind(args); const r: Row[] = []; while (st.step()) r.push(st.getAsObject()); st.free(); return r; };
const text = (v: string | Uint8Array) => typeof v === 'string' ? v : new TextDecoder().decode(v);

async function offscreenRGBA(db: Database, ext: Map<string, Uint8Array>, mipmapId: number, W: number, H: number, kind: 'color' | 'mask', warn: string[]): Promise<PixelImage | null> {
  if (!mipmapId) return null;
  const mm = rows(db, 'select BaseMipmapInfo from Mipmap where MainId=?', [mipmapId])[0];
  if (!mm) return null;
  const mi = rows(db, 'select Offscreen from MipmapInfo where MainId=?', [mm.BaseMipmapInfo])[0];
  const off = mi && rows(db, 'select BlockData from Offscreen where MainId=?', [mi.Offscreen])[0];
  if (!off || !off.BlockData) return null;
  const chunk = ext.get(text(off.BlockData));
  if (!chunk) return null;
  const list = await tiles(chunk);
  const cols = Math.ceil(W / TILE), rowsN = Math.ceil(H / TILE);
  if (list.length !== cols * rowsN) { warn.push('clipLayout'); return null; }
  const out = new Uint8ClampedArray(W * H * 4);
  for (const t of list) {
    if (!t.data) continue;
    const tx = (t.index % cols) * TILE, ty = Math.floor(t.index / cols) * TILE;
    const isMask = t.data.length === TILE * TILE;
    if (kind === 'color' && t.data.length !== TILE * TILE * 5) { warn.push('clipPixelFormat'); return null; }
    for (let y = 0; y < TILE && ty + y < H; y++) for (let x = 0; x < TILE && tx + x < W; x++) {
      const s = y * TILE + x, d = ((ty + y) * W + tx + x) * 4;
      if (isMask || kind === 'mask') { const v = t.data[s]; out[d] = out[d + 1] = out[d + 2] = v; out[d + 3] = 255; }
      else { const c = TILE * TILE + s * 4; out[d] = t.data[c + 2]; out[d + 1] = t.data[c + 1]; out[d + 2] = t.data[c]; out[d + 3] = t.data[s]; }
    }
  }
  return { width: W, height: H, data: out };
}

// Only "normal" (0) is verified against CLIP STUDIO output so far.
const BLEND: Record<number, string> = { 0: 'normal' };

export async function readClip(buf: ArrayBuffer, SQL: SqlJsStatic): Promise<ClipDoc> {
  const { ext, db: dbBytes } = chunks(buf);
  const db = new SQL.Database(dbBytes);
  try {
    const cv = rows(db, 'select CanvasWidth,CanvasHeight,CanvasRootFolder from Canvas')[0];
    const W = Math.round(cv.CanvasWidth), H = Math.round(cv.CanvasHeight);
    const layers = new Map(rows(db, 'select * from Layer').map(l => [l.MainId, l]));
    async function build(id: number): Promise<PsdNode> {
      const L = layers.get(id)!, warn: string[] = [];
      const folder = !!L.LayerFolder;
      const node: PsdNode = {
        name: L.LayerName || '', hidden: !(L.LayerVisibility & 1), opacity: (L.LayerOpacity ?? 256) / 256,
        clipping: !!L.LayerClip, left: 0, top: 0, right: W, bottom: H, _warn: warn,
      };
      const bm = BLEND[L.LayerComposite];
      node.blendMode = bm || 'normal';
      if (!bm) warn.push('clipBlendUnverified');
      if (L.LayerOffsetX || L.LayerOffsetY || L.LayerRenderOffscrOffsetX || L.LayerRenderOffscrOffsetY) warn.push('clipOffset');
      if (folder) {
        node.blendMode = L.LayerComposite === 0 ? 'pass through' : node.blendMode;
        node.children = [];
        for (let c = L.LayerFirstChildIndex; c; c = layers.get(c)?.LayerNextIndex ?? 0) node.children!.push(await build(c));
      } else {
        if (L.LayerType !== 1) warn.push('clipLayerType');
        node.imageData = await offscreenRGBA(db, ext, L.LayerRenderMipmap, W, H, 'color', warn);
        if (!node.imageData) warn.push('noPixels');
      }
      if (L.LayerLayerMaskMipmap) {
        const m = await offscreenRGBA(db, ext, L.LayerLayerMaskMipmap, W, H, 'mask', warn);
        if (m) { node.mask = { left: 0, top: 0, right: W, bottom: H, defaultColor: 0, imageData: m }; warn.push('clipMaskUnverified'); }
      }
      return node;
    }
    const rootNode = await build(cv.CanvasRootFolder);
    const pv = rows(db, 'select ImageData from CanvasPreview')[0];
    return { width: W, height: H, children: rootNode.children, previewPng: pv && pv.ImageData };
  } finally { db.close(); }
}

