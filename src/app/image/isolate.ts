// Keep only the drawing a slice is meant for: ink that reaches the slice edge belongs to a neighboring drawing
// (unless it is the slice's own drawing, cut by a tight slice) and is replaced with the background.
// No React here.
import { type Rect, background, inkMask } from './panels';

export interface Isolated { px: Uint8ClampedArray; ink: Rect | null; clear: boolean }

export function isolateDrawing(src: Uint8ClampedArray, w: number, h: number): Isolated {
  const bg = background(src, w, h), m = inkMask(src, w, h), px = src.slice();
  // 8-connected labels
  const lab = new Int32Array(w * h), par: number[] = [0];
  const find = (a: number) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x; if (!m[p]) continue;
    let l = 0;
    const take = (q: number) => { const v = lab[q]; if (!v) return; if (!l) l = v; else if (v !== l) { const a = find(l), b = find(v); if (a !== b) par[Math.max(a, b)] = Math.min(a, b); } };
    if (x > 0) take(p - 1);
    if (y > 0) { take(p - w); if (x > 0) take(p - w - 1); if (x < w - 1) take(p - w + 1); }
    if (!l) { l = par.length; par.push(l); }
    lab[p] = l;
  }
  type C = { n: number; x0: number; y0: number; x1: number; y1: number; edge: boolean };
  const cs = new Map<number, C>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x; if (!lab[p]) continue;
    const r = lab[p] = find(lab[p]); let c = cs.get(r);
    if (!c) cs.set(r, c = { n: 0, x0: x, y0: y, x1: x, y1: y, edge: false });
    c.n++; if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.edge = true;
  }
  // the slice's own drawing: the largest ink whose bounds cover the slice center, else the largest inner ink
  const cx = (w - 1) / 2, cy = (h - 1) / 2, all = [...cs.entries()];
  const best = (f: (c: C) => boolean) => all.filter(([, c]) => f(c)).sort((a, b) => b[1].n - a[1].n)[0]?.[0];
  const main = best(c => c.x0 <= cx && cx <= c.x1 && c.y0 <= cy && cy <= c.y1) ?? best(c => !c.edge) ?? best(() => true);
  const drop = new Set(all.filter(([k, c]) => c.edge && k !== main).map(([k]) => k));
  // marks inside a removed neighbor (its eyes) go with it, unless they are also inside the own drawing
  const within = (c: C, o: C) => c.x0 >= o.x0 && c.x1 <= o.x1 && c.y0 >= o.y0 && c.y1 <= o.y1;
  const own = main === undefined ? undefined : cs.get(main)!, gone = [...drop].map(k => cs.get(k)!);
  for (const [k, c] of all) if (!c.edge && k !== main && !(own && within(c, own)) && gone.some(o => within(c, o))) drop.add(k);

  if (drop.size) {
    // the removed ink plus its anti-aliased / scanned halo, never touching kept ink
    const r = Math.max(2, Math.round(Math.min(w, h) * 0.008)), rm = new Uint8Array(w * h);
    for (let p = 0; p < rm.length; p++) if (lab[p] && drop.has(lab[p])) rm[p] = 1;
    const a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) { const o = y * w; let last = -1e9;
      for (let x = 0; x < w; x++) { if (rm[o + x]) last = x; if (x - last <= r) a[o + x] = 1; }
      last = 1e9; for (let x = w - 1; x >= 0; x--) { if (rm[o + x]) last = x; if (last - x <= r) a[o + x] = 1; } }
    const b = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) { let last = -1e9;
      for (let y = 0; y < h; y++) { if (a[y * w + x]) last = y; if (y - last <= r) b[y * w + x] = 1; }
      last = 1e9; for (let y = h - 1; y >= 0; y--) { if (a[y * w + x]) last = y; if (last - y <= r) b[y * w + x] = 1; } }
    // paper: random samples of the opaque non-ink pixels, so the grain continues (a flat color shows as a patch)
    const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h), d32 = new Uint32Array(px.buffer, px.byteOffset, w * h);
    let pool: number[] = [];
    if (bg !== null) {
      const step = Math.max(1, Math.floor(w * h / 20000));
      for (let p = 0; p < m.length; p += step) if (!m[p] && !b[p] && src[p * 4 + 3] === 255) pool.push(p);
      const lum = (p: number) => src[p * 4] * 2 + src[p * 4 + 1] * 5 + src[p * 4 + 2];
      pool.sort((x, y) => lum(y) - lum(x)); pool = pool.slice(0, Math.ceil(pool.length * 0.9)).map(p => s32[p]); // without stray ink halos
      if (!pool.length) pool = [new Uint32Array(new Uint8Array([bg >> 16 & 255, bg >> 8 & 255, bg & 255, 255]).buffer)[0]];
    }
    // copy paper from a nearby clean spot so its texture lines up; random samples where none is near
    const offs: number[][] = [], step = Math.max(4, r * 3);
    for (let k = 1; k <= 12; k++) for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) offs.push([ux * k * step, uy * k * step]);
    const clean = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && !m[y * w + x] && !b[y * w + x] && src[(y * w + x) * 4 + 3] === 255;
    let seed = 0x9e3779b9, last = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!b[p] || (lab[p] && !drop.has(lab[p]))) continue;
      if (bg === null) { d32[p] = 0; continue; }
      let o = offs[last];
      if (!clean(x + o[0], y + o[1])) { let i = 0; for (; i < offs.length && !clean(x + offs[i][0], y + offs[i][1]); i++); if (i < offs.length) { last = i; o = offs[i]; } else o = null as unknown as number[]; }
      if (o) { d32[p] = s32[(y + o[1]) * w + x + o[0]]; continue; }
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      d32[p] = pool[(seed >>> 0) % pool.length];
    }
  }
  // bounds of the kept ink, 1px wider for the soft edge
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (const [k, c] of all) if (!drop.has(k)) { x0 = Math.min(x0, c.x0); y0 = Math.min(y0, c.y0); x1 = Math.max(x1, c.x1); y1 = Math.max(y1, c.y1); }
  const ink = x1 < 0 ? null : (() => { const X0 = Math.max(0, x0 - 1), Y0 = Math.max(0, y0 - 1); return { x: X0, y: Y0, w: Math.min(w - 1, x1 + 1) - X0 + 1, h: Math.min(h - 1, y1 + 1) - Y0 + 1 }; })();
  return { px, ink, clear: bg === null };
}
