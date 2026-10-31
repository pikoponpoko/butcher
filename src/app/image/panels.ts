// Panel detection for framed comics (e.g. 4-koma): finds axis-aligned rectangular frames drawn on a
// plain background. No React here.
export interface Rect { x: number; y: number; w: number; h: number }

// background = transparency when the border is mostly transparent, otherwise the most common opaque color
// (paper usually dominates; the border alone can be all frame line when the image is cropped tight)
function background(px: Uint8ClampedArray, W: number, H: number): number | null {
  let clear = 0, n = 0;
  const a = (x: number, y: number) => { n++; if (px[(y * W + x) * 4 + 3] < 128) clear++; };
  for (let x = 0; x < W; x++) { a(x, 0); a(x, H - 1); }
  for (let y = 1; y < H - 1; y++) { a(0, y); a(W - 1, y); }
  if (clear * 2 > n) return null;
  const count = new Map<number, number>(), step = Math.max(1, Math.floor(W * H / 250000));
  for (let p = 0; p < W * H; p += step) {
    const i = p * 4; if (px[i + 3] < 128) continue;
    const k = (px[i] >> 3) << 10 | (px[i + 1] >> 3) << 5 | (px[i + 2] >> 3); count.set(k, (count.get(k) || 0) + 1);
  }
  let best = 0, bk = 0; for (const [k, c] of count) if (c > best) { best = c; bk = k; }
  return ((bk >> 10) & 31) << 19 | ((bk >> 5) & 31) << 11 | (bk & 31) << 3 | 0x040404;
}

// 1 = ink (differs from the background), 0 = background
function inkMask(px: Uint8ClampedArray, W: number, H: number): Uint8Array {
  const m = new Uint8Array(W * H), bg = background(px, W, H), T = 40;
  const br = bg === null ? 0 : bg >> 16 & 255, bgc = bg === null ? 0 : bg >> 8 & 255, bb = bg === null ? 0 : bg & 255;
  for (let p = 0, i = 0; p < m.length; p++, i += 4) {
    const a = px[i + 3];
    if (bg === null) { m[p] = a >= 128 ? 1 : 0; continue; }
    if (a < 128) continue;
    m[p] = Math.abs(px[i] - br) > T || Math.abs(px[i + 1] - bgc) > T || Math.abs(px[i + 2] - bb) > T ? 1 : 0;
  }
  return m;
}

// bounding boxes of 8-connected ink components (union-find over runs would be faster; per-pixel is fine at comic sizes)
function components(m: Uint8Array, W: number, H: number): Rect[] {
  const lab = new Int32Array(W * H), par: number[] = [0];
  const find = (a: number) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  const uni = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) par[Math.max(a, b)] = Math.min(a, b); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; if (!m[p]) continue;
    let l = 0;
    const take = (q: number) => { const v = lab[q]; if (!v) return; if (!l) l = v; else if (v !== l) uni(l, v); };
    if (x > 0) take(p - 1);
    if (y > 0) { take(p - W); if (x > 0) take(p - W - 1); if (x < W - 1) take(p - W + 1); }
    if (!l) { l = par.length; par.push(l); }
    lab[p] = l;
  }
  const box = new Map<number, [number, number, number, number]>();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = lab[y * W + x]; if (!v) continue;
    const r = find(v), b = box.get(r);
    if (!b) box.set(r, [x, y, x, y]); else { if (x < b[0]) b[0] = x; if (x > b[2]) b[2] = x; if (y < b[1]) b[1] = y; if (y > b[3]) b[3] = y; }
  }
  return [...box.values()].map(([x0, y0, x1, y1]) => ({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }));
}

// share of positions along each side of r that have ink within `d` px inside the edge
function framed(m: Uint8Array, W: number, r: Rect): boolean {
  const d = Math.max(2, Math.round(Math.min(r.w, r.h) * 0.02));
  const side = (len: number, at: (i: number, k: number) => number) => {
    let hit = 0;
    for (let i = 0; i < len; i++) for (let k = 0; k < d; k++) if (m[at(i, k)]) { hit++; break; }
    return hit / len;
  };
  const x1 = r.x + r.w - 1, y1 = r.y + r.h - 1;
  return side(r.w, (i, k) => (r.y + k) * W + r.x + i) >= 0.9 && side(r.w, (i, k) => (y1 - k) * W + r.x + i) >= 0.9
    && side(r.h, (i, k) => (r.y + i) * W + r.x + k) >= 0.9 && side(r.h, (i, k) => (r.y + i) * W + x1 - k) >= 0.9;
}

// split a frame where it is really several panels: at a thin ink line running across it (panels sharing one
// border line), or at a gutter whose ends are empty but which drawing breaking out of a frame bridges
function splitShared(m: Uint8Array, W: number, r: Rect, out: Rect[], depth = 0) {
  const cut = (horiz: boolean): [number, number] | null => {
    const len = horiz ? r.w : r.h, span = horiz ? r.h : r.w, edge = Math.max(3, Math.round(span * 0.03));
    const thin = Math.max(6, Math.round(span * 0.02)), d = Math.max(2, Math.round(len * 0.02));
    const at = (j: number, i: number) => m[horiz ? (r.y + j) * W + r.x + i : (r.y + i) * W + r.x + j];
    const ink = (j: number) => { let c = 0; for (let i = 0; i < len; i++) c += at(j, i); return c; };
    const full = (j: number) => ink(j) >= len * 0.97;
    const gap = (j: number) => {
      for (let i = 0; i < d; i++) if (at(j, i) || at(j, len - 1 - i)) return false;
      return ink(j) <= len * 0.15;
    };
    for (let j = edge; j < span - edge; j++) {
      const f = full(j); if (!f && !gap(j)) continue;
      const same = f ? full : gap;
      let e = j; while (e + 1 < span && same(e + 1)) e++;
      if (e < span - edge && (!f || e - j + 1 <= thin)) return f ? [j, e] : [e + 1, j - 1];
      j = e;
    }
    return null;
  };
  if (depth < 8) for (const horiz of [true, false]) {
    const s = cut(horiz); if (!s) continue;
    const [a, b] = s; // A keeps rows ..b, B starts at row a (a shared line belongs to both)
    const A = horiz ? { x: r.x, y: r.y, w: r.w, h: b + 1 } : { x: r.x, y: r.y, w: b + 1, h: r.h };
    const B = horiz ? { x: r.x, y: r.y + a, w: r.w, h: r.h - a } : { x: r.x + a, y: r.y, w: r.w - a, h: r.h };
    splitShared(m, W, A, out, depth + 1); splitShared(m, W, B, out, depth + 1); return;
  }
  out.push(r);
}

const inside = (a: Rect, b: Rect) => a !== b && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
const overlapX = (a: Rect, b: Rect) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > Math.min(a.w, b.w) / 2;
const overlapY = (a: Rect, b: Rect) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > Math.min(a.h, b.h) / 2;

// reading order: 4-koma columns (same-width stacks of 3 or more) right column first, top to bottom;
// otherwise rows top to bottom, right to left within a row
function order(rs: Rect[]): Rect[] {
  const cols: Rect[][] = [];
  for (const r of [...rs].sort((a, b) => b.x - a.x)) { const c = cols.find(c => overlapX(c[0], r)); if (c) c.push(r); else cols.push([r]); }
  const sameW = (c: Rect[]) => c.every(r => Math.abs(r.w - c[0].w) <= c[0].w * 0.05);
  if (cols.length > 1 && cols.every(c => c.length >= 3 && sameW(c))) return cols.flatMap(c => c.sort((a, b) => a.y - b.y));
  const rows: Rect[][] = [];
  for (const r of [...rs].sort((a, b) => a.y - b.y)) { const w = rows.find(w => overlapY(w[0], r)); if (w) w.push(r); else rows.push([r]); }
  return rows.flatMap(w => w.sort((a, b) => b.x - a.x));
}

export function detectPanels(px: Uint8ClampedArray, W: number, H: number): Rect[] {
  const m = inkMask(px, W, H), min = Math.max(16, Math.round(Math.min(W, H) * 0.08));
  const found: Rect[] = [];
  for (const r of components(m, W, H)) {
    if (r.w < min || r.h < min || r.w * r.h < W * H * 0.01) continue;
    if (!framed(m, W, r)) continue;
    splitShared(m, W, r, found);
  }
  const panels = found.filter(r => r.w >= min && r.h >= min && !(r.w >= W && r.h >= H));
  return order(panels.filter(r => !panels.some(b => inside(r, b))));
}
