// Panel detection for framed comics (e.g. 4-koma): finds axis-aligned rectangular frames drawn on a
// plain background. No React here.
export interface Rect { x: number; y: number; w: number; h: number }

// background = transparency when the border is mostly transparent, otherwise the most common opaque color
// (paper usually dominates; the border alone can be all frame line when the image is cropped tight)
export function background(px: Uint8ClampedArray, W: number, H: number): number | null {
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
export function inkMask(px: Uint8ClampedArray, W: number, H: number): Uint8Array {
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

// 8-connected ink components: label per pixel (0 = background) and the count of labels
function labels(m: Uint8Array, W: number, H: number): { lab: Int32Array; n: number } {
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
  const id = new Int32Array(par.length); let n = 0;
  for (let i = 1; i < par.length; i++) { const r = find(i); id[i] = r === i ? ++n : id[r]; }
  for (let p = 0; p < lab.length; p++) if (lab[p]) lab[p] = id[lab[p]];
  return { lab, n };
}

// bounding boxes of 8-connected ink components (keyed by label, 1-based); `src` limits which pixels count
function boxes(lab: Int32Array, n: number, W: number, H: number, src?: (p: number) => boolean): (Rect | null)[] {
  const b = new Int32Array((n + 1) * 4).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, v = lab[p]; if (!v || (src && !src(p))) continue;
    const i = v * 4;
    if (b[i] < 0) { b[i] = b[i + 2] = x; b[i + 1] = b[i + 3] = y; continue; }
    if (x < b[i]) b[i] = x; if (x > b[i + 2]) b[i + 2] = x; if (y < b[i + 1]) b[i + 1] = y; if (y > b[i + 3]) b[i + 3] = y;
  }
  const out: (Rect | null)[] = [];
  for (let v = 1; v <= n; v++) { const i = v * 4; out.push(b[i] < 0 ? null : { x: b[i], y: b[i + 1], w: b[i + 2] - b[i] + 1, h: b[i + 3] - b[i + 1] + 1 }); }
  return out;
}
function components(m: Uint8Array, W: number, H: number): Rect[] {
  const { lab, n } = labels(m, W, H);
  return boxes(lab, n, W, H).filter((r): r is Rect => !!r);
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

function panelsOf(m: Uint8Array, W: number, H: number): Rect[] {
  const min = Math.max(16, Math.round(Math.min(W, H) * 0.08));
  const found: Rect[] = [];
  for (const r of components(m, W, H)) {
    if (r.w < min || r.h < min || r.w * r.h < W * H * 0.01) continue;
    if (!framed(m, W, r)) continue;
    splitShared(m, W, r, found);
  }
  const panels = found.filter(r => r.w >= min && r.h >= min && !(r.w >= W && r.h >= H));
  return order(panels.filter(r => !panels.some(b => inside(r, b))));
}
export function detectPanels(px: Uint8ClampedArray, W: number, H: number): Rect[] {
  return panelsOf(inkMask(px, W, H), W, H);
}

// box dilation by r (separable running max)
function dilate(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const a = new Uint8Array(W * H), b = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { let last = -1e9; const o = y * W;
    for (let x = 0; x < W; x++) if (m[o + x]) last = x; else if (x - last <= r) a[o + x] = 1;
    last = 1e9; for (let x = W - 1; x >= 0; x--) { if (m[o + x]) { last = x; a[o + x] = 1; } else if (last - x <= r) a[o + x] = 1; } }
  for (let x = 0; x < W; x++) { let last = -1e9;
    for (let y = 0; y < H; y++) if (a[y * W + x]) { last = y; b[y * W + x] = 1; } else if (y - last <= r) b[y * W + x] = 1;
    last = 1e9; for (let y = H - 1; y >= 0; y--) if (a[y * W + x]) last = y; else if (last - y <= r) b[y * W + x] = 1; }
  return b;
}

// Separate drawings on a sheet (e.g. hand-drawn stickers scanned on white paper): ink close together
// (within ~0.4% of the short side) and small marks inside another drawing's bounds count as one drawing.
// Small marks (text, dust) and frames are left out. Rects are padded by the gap and kept inside the image.
function drawingsOf(m: Uint8Array, W: number, H: number): Rect[] {
  const S = Math.min(W, H), g = Math.max(2, Math.round(S * 0.01)), f = Math.max(1, Math.ceil(Math.sqrt(W * H / 4e6)));
  const w = Math.ceil(W / f), h = Math.ceil(H / f), sm = new Uint8Array(w * h);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) sm[((y / f) | 0) * w + ((x / f) | 0)] = 1;
  // groups of ink close together, measured on the original (undilated) ink of each group
  const { lab, n } = labels(dilate(sm, w, h, Math.max(1, Math.round(S * 0.002 / f))), w, h);
  const coarse = boxes(lab, n, w, h, p => !!sm[p]);
  let rs: Rect[] = [];
  for (let v = 1; v <= n; v++) {
    const q = coarse[v - 1]; if (!q) continue;
    // tighten to the real ink at full resolution
    const X0 = q.x * f, Y0 = q.y * f, X1 = Math.min(W, (q.x + q.w) * f), Y1 = Math.min(H, (q.y + q.h) * f);
    let x0 = W, y0 = H, x1 = -1, y1 = -1, ink = 0;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) if (m[y * W + x] && lab[((y / f) | 0) * w + ((x / f) | 0)] === v) {
      ink++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // thin guide frames and rulers are mostly empty
    if (x1 >= 0 && ink >= (x1 - x0 + 1) * (y1 - y0 + 1) * 0.015) rs.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  // small marks inside a drawing (eyes inside an outline) belong to it
  rs = rs.filter(r => !rs.some(b => inside(r, b) && r.w * r.h < b.w * b.h * 0.2));
  const min = Math.max(8, Math.round(S * 0.03));
  rs = rs.filter(r => Math.min(r.w, r.h) >= min && !(r.w >= W * 0.9 && r.h >= H * 0.9) && !framed(m, W, r));
  const pad = (r: Rect): Rect => { const x = Math.max(0, r.x - g), y = Math.max(0, r.y - g); return { x, y, w: Math.min(W, r.x + r.w + g) - x, h: Math.min(H, r.y + r.h + g) - y }; };
  // rows top to bottom, left to right
  const rows: Rect[][] = [];
  for (const r of [...rs].sort((a, b) => a.y - b.y)) { const row = rows.find(w => overlapY(w[0], r)); if (row) row.push(r); else rows.push([r]); }
  return rows.flatMap(row => row.sort((a, b) => a.x - b.x)).map(pad);
}
export function detectDrawings(px: Uint8ClampedArray, W: number, H: number): Rect[] {
  return drawingsOf(inkMask(px, W, H), W, H);
}

// Auto slices: comic panels when the frames hold most of the ink, otherwise one slice per drawing
// (a sheet of drawings around a guide frame finds the guide as a "panel", but most ink lies outside it).
export function detectSlices(px: Uint8ClampedArray, W: number, H: number): Rect[] {
  const m = inkMask(px, W, H), panels = panelsOf(m, W, H);
  let ink = 0, inP = 0;
  for (let p = 0; p < m.length; p++) ink += m[p];
  for (const r of panels) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) inP += m[y * W + x];
  if (panels.length && inP >= ink * 0.6) return panels;
  const dr = drawingsOf(m, W, H);
  return dr.length ? dr : panels;
}
