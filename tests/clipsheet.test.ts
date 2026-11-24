// Meshy 4-view sheets: a small .clip written here (CSFCHUNK + tiles + layer database) read back by clipsheet.
import { beforeAll, expect, test } from 'vitest';
import { deflateSync } from 'node:zlib';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { NotSheet, SHEET, charName, readSheet, renderSheet, squareOf, viewNames, viewPixels } from '../src/core/clipsheet';

let SQL: SqlJsStatic;
beforeAll(async () => { SQL = await initSqlJs(); });

const TILE = 256;
type Px = (x: number, y: number) => number[] | null; // bitmap coordinates → RGBA (masks: [value]) or nothing
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const str16 = (s: string) => Buffer.concat([u32(s.length), Buffer.from([...s].flatMap(c => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255]))]);

// Offscreen.Attribute: section sizes, "Parameter" (size, tile grid, packing), "InitColor" (fill of empty tiles)
function attribute(W: number, H: number, kind: 'rgba' | 'gray', init: number) {
  const a = new Array(16).fill(0); a[1] = 1; a[2] = kind === 'rgba' ? 4 : 0;
  const par = Buffer.concat([str16('Parameter'), u32(W), u32(H), u32(Math.ceil(W / TILE)), u32(Math.ceil(H / TILE)), ...a.map(u32)]);
  const ini = Buffer.concat([str16('InitColor'), u32(0), u32(init)]);
  return Buffer.concat([u32(16), u32(par.length), u32(ini.length), u32(0), par, ini]);
}
// The tile stream: color tiles are 256² alpha then 256² BGRx, mask tiles 256² values; tiles with nothing are left out
function blocks(W: number, H: number, kind: 'rgba' | 'gray', px: Px) {
  const cols = Math.ceil(W / TILE), rows = Math.ceil(H / TILE), out: Buffer[] = [];
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    const t = Buffer.alloc(kind === 'rgba' ? TILE * TILE * 5 : TILE * TILE);
    let any = false;
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const bx = tx * TILE + x, by = ty * TILE + y; if (bx >= W || by >= H) continue;
      const p = px(bx, by); if (!p) continue;
      const s = y * TILE + x; any = true;
      if (kind === 'gray') t[s] = p[0];
      else { t[s] = p[3]; t[TILE * TILE + s * 4] = p[2]; t[TILE * TILE + s * 4 + 1] = p[1]; t[TILE * TILE + s * 4 + 2] = p[0]; }
    }
    const z = any ? deflateSync(t) : null;
    const body = Buffer.concat([str16('BlockDataBeginChunk'), u32(ty * cols + tx), u32(0), u32(0), u32(0), u32(z ? 1 : 0), ...(z ? [u32(z.length + 4), le32(z.length), z] : [])]);
    out.push(Buffer.concat([u32(body.length + 4), body]));
  }
  return Buffer.concat(out);
}

interface L { name: string; folder?: L[]; hidden?: boolean; x?: number; y?: number; W?: number; H?: number; px?: Px; init?: number; fill?: number[]; mask?: { W: number; H: number; px: Px; init?: number } }
// A .clip file: canvas W×H, the root folder's children listed bottom to top
function clipFile(W: number, H: number, top: L[]) {
  const db = new SQL.Database(), ext: [string, Buffer][] = [];
  db.run(`create table Canvas (MainId integer, CanvasWidth real, CanvasHeight real, CanvasRootFolder integer);
    create table Layer (MainId integer, LayerName text, LayerFolder integer, LayerVisibility integer, LayerOpacity integer, LayerComposite integer, LayerClip integer,
      LayerFirstChildIndex integer, LayerNextIndex integer, LayerOffsetX integer, LayerOffsetY integer, LayerRenderOffscrOffsetX integer, LayerRenderOffscrOffsetY integer,
      LayerMaskOffsetX integer, LayerMaskOffsetY integer, LayerMaskOffscrOffsetX integer, LayerMaskOffscrOffsetY integer, LayerRenderMipmap integer, LayerLayerMaskMipmap integer,
      FilterLayerInfo blob, DrawColorEnable integer, DrawColorMainRed integer, DrawColorMainGreen integer, DrawColorMainBlue integer);
    create table Mipmap (MainId integer, BaseMipmapInfo integer); create table MipmapInfo (MainId integer, Offscreen integer); create table Offscreen (MainId integer, Attribute blob, BlockData text);`);
  let id = 0;
  const bitmap = (W: number, H: number, kind: 'rgba' | 'gray', init: number, px: Px) => {
    const m = ++id, key = 'extrnlid' + m;
    ext.push([key, blocks(W, H, kind, px)]);
    db.run('insert into Offscreen values (?,?,?)', [m, attribute(W, H, kind, init), key]);
    db.run('insert into MipmapInfo values (?,?)', [m, m]); db.run('insert into Mipmap values (?,?)', [m, m]);
    return m;
  };
  const add = (l: L | null, kids: L[]): number => {
    const me = ++id, ids = kids.map(k => add(k, k.folder || []));
    ids.forEach((c, i) => db.run('update Layer set LayerNextIndex=? where MainId=?', [ids[i + 1] || 0, c]));
    const render = l && !l.folder && !l.fill && l.px ? bitmap(l.W!, l.H!, 'rgba', l.init || 0, l.px) : 0;
    const mask = l?.mask ? bitmap(l.mask.W, l.mask.H, 'gray', l.mask.init || 0, l.mask.px) : 0;
    const c = (v: number) => Math.round(v / 255 * 4294967295);
    db.run('insert into Layer values (?,?,?,?,256,0,0,?,0,?,?,0,0,0,0,0,0,?,?,null,?,?,?,?)', [me, l?.name ?? '', l && !l.folder ? 0 : 1, l?.hidden ? 0 : 1, ids[0] || 0,
      l?.x || 0, l?.y || 0, render, mask, l?.fill ? 1 : 0, c(l?.fill?.[0] || 0), c(l?.fill?.[1] || 0), c(l?.fill?.[2] || 0)]);
    return me;
  };
  const root = add(null, top);
  db.run('insert into Canvas values (1,?,?,?)', [W, H, root]);
  const chunk = (name: string, body: Buffer) => Buffer.concat([Buffer.from(name, 'latin1'), u64(body.length), body]);
  const out = Buffer.concat([Buffer.from('CSFCHUNK'), Buffer.alloc(16),
    ...ext.map(([k, d]) => chunk('CHNKExta', Buffer.concat([u64(k.length), Buffer.from(k, 'latin1'), u64(d.length), d]))),
    chunk('CHNKSQLi', Buffer.from(db.export())), chunk('CHNKFoot', Buffer.alloc(0))]);
  db.close();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length) as ArrayBuffer;
}

const P = (i: number) => SHEET.x0 + i * SHEET.size; // canvas x of panel i
const solid = (c: number[]): Px => () => c;
const BLACK = [0, 0, 0, 255];

test('renders each panel from the layers over it, leaving out guides, background and the colour sheet', async () => {
  const buf = clipFile(SHEET.W, 4096, [
    { name: '背景', fill: [255, 255, 255] },
    // a paper layer: no tiles, empty tiles filled white
    { name: '用紙', x: P(0) + 900, y: SHEET.y0 + 700, W: 512, H: 512, init: 1, px: () => null },
    { name: 'ガイド', folder: [{ name: '枠', x: 0, y: 0, W: 600, H: 600, px: solid(BLACK) }] },
    { name: '色', x: P(0) + 1000, y: SHEET.y0 + 800, W: 200, H: 300, px: solid([200, 100, 50, 255]) },
    { name: '線画', folder: [
      { name: '正面', x: P(2) + 1500, y: SHEET.y0 + 1000, W: 64, H: 64, px: solid(BLACK) },
      { name: '下描き', hidden: true, x: P(1) + 100, y: SHEET.y0 + 100, W: 300, H: 300, px: solid(BLACK) },
      // the mask shows the left half only
      { name: '側面', x: P(3) + 1700, y: SHEET.y0 + 2000, W: 100, H: 100, px: solid(BLACK), mask: { W: 100, H: 100, px: x => x < 50 ? [255] : null } },
    ] },
    { name: '総合彩色見本', x: P(3), y: SHEET.y0, W: 1000, H: 1000, px: solid(BLACK) },
  ]);
  const sheet = readSheet(buf, SQL);
  expect(sheet.layers.map(l => l.name)).toEqual(['用紙', '色', '線画']);
  const r = await renderSheet(buf, SQL);
  expect(r.views.map(v => v.box)).toEqual([{ x: 1000, y: 800, w: 200, h: 300 }, null, { x: 1500, y: 1000, w: 64, h: 64 }, { x: 1700, y: 2000, w: 50, h: 100 }]);
  expect([...r.views[0].rgba!.subarray(0, 4)]).toEqual([200, 100, 50, 255]);
  expect([...r.views[3].rgba!.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
  expect(r.warnings).toEqual([{ layer: '側面', type: 'clipMaskUnverified' }]);
});

test('a sheet with nothing drawn has no views', async () => {
  const r = await renderSheet(clipFile(SHEET.W, 4096, [{ name: '線画', hidden: true, x: P(0), y: SHEET.y0, W: 64, H: 64, px: solid(BLACK) }]), SQL);
  expect(r.views.every(v => !v.box && !v.rgba)).toBe(true);
  expect(squareOf(r.views.map(v => v.box), 0.05)).toBeNull();
});

test('other canvases are not sheets', () => {
  const e = (() => { try { readSheet(clipFile(1000, 800, []), SQL); } catch (x) { return x; } })();
  expect(e).toBeInstanceOf(NotSheet);
  expect([(e as NotSheet).W, (e as NotSheet).H]).toEqual([1000, 800]);
});

test('one square for all four views, centred on the panel axis', () => {
  const boxes = [{ x: 1000, y: 800, w: 200, h: 300 }, null, { x: 1500, y: 1000, w: 64, h: 64 }, { x: 1700, y: 2000, w: 50, h: 100 }];
  // widest reach from the axis (1741): 741 to the left; tallest: 800 … 2100
  expect(squareOf(boxes, 0)).toEqual({ x: 1000, y: 709, size: 1482 });
  expect(squareOf(boxes, 0.1)).toEqual({ x: 851, y: 560, size: 1780 });
  expect(squareOf([null, null, null, null], 0)).toBeNull();
});

test('the output is the square on white with the drawing in place', () => {
  const v = { box: { x: 10, y: 20, w: 2, h: 1 }, rgba: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) };
  const out = viewPixels(v, { x: 9, y: 19, size: 4 });
  const at = (x: number, y: number) => [...out.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
  expect(at(1, 1)).toEqual([255, 0, 0, 255]);
  expect(at(2, 1)).toEqual([0, 0, 255, 255]);
  expect(at(0, 0)).toEqual([255, 255, 255, 255]);
  expect(at(3, 3)).toEqual([255, 255, 255, 255]);
});

test('names', () => {
  expect(charName('Meshy四面図_ねこ.clip')).toBe('ねこ');
  expect(charName('Meshy四面図＿夫.CLIP')).toBe('夫');
  expect(charName('sample.clip')).toBe('sample');
  expect(viewNames(false)).toEqual(['Main', 'Right', 'Back', 'Left']);
  expect(viewNames(true)).toEqual(['Main', 'Left', 'Back', 'Right']);
});
