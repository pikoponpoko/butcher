// Reshapes the line layer: hand-wobble smoothing, line thickness, and the push brush that presses a wavy
// stretch of line straight. Pure pixel code, runs in the worker.
//
// The line's outline (opacity 0.5, traced with marching squares) is moved as polylines and drawn back
// antialiased from its signed distance, so the line's inside comes out solid (scan grain is gone).
// Everything is in image px; pixel (x, y) has its center at (x + 0.5, y + 0.5).
import { distSq, runComponents } from './lineart';

// smooth: 0 off, 1–3 weak / medium / strong. thick: -1 thinner, 0 as is, 1–2 thicker
export interface ShapeSettings { smooth: number; thick: number }
export interface Push { p: number[]; r: number }

const SMOOTH = [0, 0.5, 0.8, 1.1], MAXD = [0, 0.12, 0.2, 0.28], THICK = [-0.1, 0, 0.12, 0.25];

// ---------- outline tracing (marching squares at 0.5, outside the image counts as paper)

// for each case (tl 8, tr 4, br 2, bl 1) and entry edge (0 top, 1 right, 2 bottom, 3 left): the exit edge.
// Crossings run with the ink on the left. Saddles 5 / 10: index 16 / 17 = ink joined through the middle.
const EXIT: Int8Array[] = (() => {
  const t: Int8Array[] = [];
  for (let c = 0; c < 18; c++) t.push(new Int8Array(4).fill(-1));
  // corners clockwise from top-left; edge k runs from corner k to corner k+1
  for (let c = 0; c < 16; c++) {
    if (c === 5 || c === 10) continue;
    const ins = [c & 8, c & 4, c & 2, c & 1].map(Boolean); let en = -1, ex = -1;
    for (let k = 0; k < 4; k++) { const a = ins[k], b = ins[(k + 1) % 4]; if (!a && b) en = k; if (a && !b) ex = k; }
    if (en >= 0) t[c][en] = ex;
  }
  // 10 = tl + br: apart → left→top, right→bottom; joined → right→top, left→bottom
  t[10][3] = 0; t[10][1] = 2; t[17][1] = 0; t[17][3] = 2;
  // 5 = tr + bl: apart → top→right, bottom→left; joined → top→left, bottom→right
  t[5][0] = 1; t[5][2] = 3; t[16][0] = 3; t[16][2] = 1;
  return t;
})();

export function contours(alpha: Uint8Array, W: number, H: number, x0 = 0, y0 = 0, w = W, h = H): Float64Array[] {
  const v = (x: number, y: number) => x < x0 || y < y0 || x >= x0 + w || y >= y0 + h ? 0 : alpha[y * W + x];
  const CW = w + 1, seen = new Uint8Array(CW * (h + 1)), loops: Float64Array[] = [];
  const caseAt = (x: number, y: number) => {
    const a = v(x, y), b = v(x + 1, y), c = v(x + 1, y + 1), d = v(x, y + 1);
    let k = (a >= 128 ? 8 : 0) | (b >= 128 ? 4 : 0) | (c >= 128 ? 2 : 0) | (d >= 128 ? 1 : 0);
    if (k === 5 || k === 10) { if (a + b + c + d >= 512) k = k === 5 ? 16 : 17; }
    return k;
  };
  // the crossing on edge e of the cell with top-left corner (x, y)
  const at = (x: number, y: number, e: number, out: number[]) => {
    let ax = x, ay = y, bx = x + 1, by = y;
    if (e === 1) { ax = x + 1; ay = y; bx = x + 1; by = y + 1; } else if (e === 2) { ax = x + 1; ay = y + 1; bx = x; by = y + 1; } else if (e === 3) { ax = x; ay = y + 1; bx = x; by = y; }
    const va = v(ax, ay), vb = v(bx, by), t = va === vb ? 0.5 : (127.5 - va) / (vb - va);
    out.push(ax + (bx - ax) * t + 0.5, ay + (by - ay) * t + 0.5);
  };
  const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  for (let cy = y0 - 1; cy < y0 + h; cy++) for (let cx = x0 - 1; cx < x0 + w; cx++) {
    const k0 = caseAt(cx, cy); if (k0 === 0 || k0 === 15) continue;
    for (let e0 = 0; e0 < 4; e0++) {
      if (EXIT[k0][e0] < 0) continue;
      const ci0 = (cy - y0 + 1) * CW + (cx - x0 + 1); if (seen[ci0] & (1 << e0)) continue;
      const pts: number[] = [];
      let x = cx, y = cy, e = e0;
      for (let guard = 0; guard < 4 * CW * (h + 1); guard++) {
        const ci = (y - y0 + 1) * CW + (x - x0 + 1); if (seen[ci] & (1 << e)) break;
        seen[ci] |= 1 << e;
        const k = caseAt(x, y), ex = EXIT[k][e]; if (ex < 0) break;
        at(x, y, ex, pts);
        x += DX[ex]; y += DY[ex]; e = (ex + 2) % 4;
      }
      if (pts.length >= 6) loops.push(Float64Array.from(pts));
    }
  }
  return loops;
}

// ---------- polyline helpers (closed loops, x, y interleaved)

function resample(p: Float64Array, step = 0.5): Float64Array {
  const m = p.length / 2; let L = 0;
  for (let i = 0; i < m; i++) { const j = (i + 1) % m; L += Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]); }
  const n = Math.max(8, Math.floor(L / step)), out = new Float64Array(n * 2), d = L / n;
  let i = 0, acc = 0, seg = Math.hypot(p[2] - p[0], p[3] - p[1]);
  for (let k = 0; k < n; k++) {
    const at = k * d;
    while (acc + seg < at && i < m - 1) { acc += seg; i++; const j = (i + 1) % m; seg = Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]); }
    const j = (i + 1) % m, f = seg > 0 ? Math.min(1, (at - acc) / seg) : 0;
    out[k * 2] = p[i * 2] + (p[j * 2] - p[i * 2]) * f; out[k * 2 + 1] = p[i * 2 + 1] + (p[j * 2 + 1] - p[i * 2 + 1]) * f;
  }
  return out;
}
const lengthOf = (p: Float64Array) => { const n = p.length / 2; let L = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; L += Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]); } return L; };

// Gaussian along a closed loop (three box passes), on `dim` interleaved channels
function blurWrap(a: Float64Array, dim: number, sigma: number): Float64Array {
  const n = a.length / dim; let r = Math.round((Math.sqrt(1 + 4 * sigma * sigma) - 1) / 2);
  r = Math.min(r, (n - 1) >> 1); if (r < 1) return a.slice();
  let src = a.slice(), dst = new Float64Array(a.length);
  const k = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let c = 0; c < dim; c++) {
      let s = 0; for (let j = -r; j <= r; j++) s += src[((j % n + n) % n) * dim + c];
      for (let i = 0; i < n; i++) {
        dst[i * dim + c] = s * k;
        s += src[((i + r + 1) % n) * dim + c] - src[((i - r) % n + n) % n * dim + c];
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}
// smoothing that doesn't shrink a loop: g + (g − G(g))
function taubin(p: Float64Array, s: number) { const g = blurWrap(p, 2, s), gg = blurWrap(g, 2, s); for (let i = 0; i < g.length; i++) g[i] = 2 * g[i] - gg[i]; return g; }
// sliding minimum over 2r + 1 samples of a closed loop
function minWrap(a: Float64Array, r: number): Float64Array {
  const n = a.length, out = new Float64Array(n); r = Math.min(r, (n - 1) >> 1);
  const q = new Int32Array(n + 2 * r + 1); let h = 0, t = 0;
  for (let j = -r; j < n + r; j++) {
    const v = a[(j % n + n) % n];
    while (t > h && a[((q[t - 1] % n) + n) % n] >= v) t--;
    q[t++] = j;
    if (q[h] <= j - 2 * r - 1) h++;
    const i = j - r; if (i >= 0 && i < n) out[i] = a[((q[h] % n) + n) % n];
  }
  return out;
}
// moves p0 toward g by `wt` (per point), at most `maxd` px; the limit eases in along the loop so it
// never leaves a step. `nrm`: move only along these unit vectors.
function moveToward(p0: Float64Array, g: Float64Array, maxd: number, ease: number, wt?: Float64Array, nrm?: Float64Array) {
  const n = p0.length / 2, d = new Float64Array(n * 2), f = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let dx = g[i * 2] - p0[i * 2], dy = g[i * 2 + 1] - p0[i * 2 + 1];
    if (nrm) { const s = dx * nrm[i * 2] + dy * nrm[i * 2 + 1]; dx = s * nrm[i * 2]; dy = s * nrm[i * 2 + 1]; }
    d[i * 2] = dx; d[i * 2 + 1] = dy; const m = Math.hypot(dx, dy); f[i] = m > maxd ? maxd / m : 1;
  }
  const kk = Math.max(2, Math.round(ease)), ff = blurWrap(minWrap(f, kk), 1, kk), out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) { const k = ff[i] * (wt ? wt[i] : 1); out[i * 2] = p0[i * 2] + d[i * 2] * k; out[i * 2 + 1] = p0[i * 2 + 1] + d[i * 2 + 1] * k; }
  return out;
}

// ---------- drawing outlines back

// inside (even–odd at pixel centers) and the distance to the outline, up to `band` px, in the box x0…x0+w, y0…y0+h.
// `tag`: a value per outline point, and `near` gets the tag of the closest one.
function raster(loops: Float64Array[], x0: number, y0: number, w: number, h: number, band: number, tag?: Float32Array[]) {
  const N = w * h, inside = new Uint8Array(N), dist = new Float32Array(N).fill(band), near = tag ? new Float32Array(N) : null;
  const cnt = new Int32Array(h + 1);
  const rows = (ay: number, by: number) => { const lo = Math.min(ay, by) - y0, hi = Math.max(ay, by) - y0; return [Math.max(0, Math.ceil(lo - 0.5)), Math.min(h, Math.ceil(hi - 0.5))]; };
  for (const p of loops) { const n = p.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; if (p[i * 2 + 1] === p[j * 2 + 1]) continue; const [a, b] = rows(p[i * 2 + 1], p[j * 2 + 1]); for (let y = a; y < b; y++) cnt[y + 1]++; } }
  for (let y = 0; y < h; y++) cnt[y + 1] += cnt[y];
  const xs = new Float64Array(cnt[h]), fill = cnt.slice(0, h);
  for (const p of loops) {
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1]; if (ay === by) continue;
      const [a, b] = rows(ay, by);
      for (let y = a; y < b; y++) { const yc = y + y0 + 0.5; xs[fill[y]++] = ax + (yc - ay) * (bx - ax) / (by - ay) - x0; }
    }
  }
  for (let y = 0; y < h; y++) {
    const r = xs.subarray(cnt[y], cnt[y + 1]).sort(), o = y * w;
    for (let k = 0; k + 1 < r.length; k += 2) { const a = Math.max(0, Math.ceil(r[k] - 0.5)), b = Math.min(w, Math.ceil(r[k + 1] - 0.5)); if (b > a) inside.fill(1, o + a, o + b); }
  }
  // distance to the nearest outline segment (every other point is plenty for the distance)
  const st = band > 2 ? 2 : 1;
  loops.forEach((p, li) => {
    const n = p.length / 2, tg = tag?.[li];
    for (let i = 0; i < n; i += st) {
      const j = (i + st) % n, ax = p[i * 2] - x0, ay = p[i * 2 + 1] - y0, dx = p[j * 2] - x0 - ax, dy = p[j * 2 + 1] - y0 - ay, l2 = dx * dx + dy * dy || 1e-9, t0 = tg ? tg[i] : 0;
      const X0 = Math.max(0, Math.floor(Math.min(ax, ax + dx) - band)), X1 = Math.min(w - 1, Math.ceil(Math.max(ax, ax + dx) + band));
      const Y0 = Math.max(0, Math.floor(Math.min(ay, ay + dy) - band)), Y1 = Math.min(h - 1, Math.ceil(Math.max(ay, ay + dy) + band));
      for (let y = Y0; y <= Y1; y++) {
        const py = y + 0.5 - ay, o = y * w;
        for (let x = X0; x <= X1; x++) {
          const px = x + 0.5 - ax; let t = (px * dx + py * dy) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = px - dx * t, ey = py - dy * t, d = Math.sqrt(ex * ex + ey * ey);
          if (d < dist[o + x]) { dist[o + x] = d; if (near) near[o + x] = t0; }
        }
      }
    }
  });
  return { inside, dist, near };
}

// sliding maximum over a (2r + 1)² square
function maxSquare(a: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H), q = new Int32Array(Math.max(W, H));
  const line = (get: (i: number) => number, set: (i: number, v: number) => void, n: number) => {
    let h = 0, t = 0, j = 0;
    for (let i = 0; i < n; i++) {
      for (; j < n && j <= i + r; j++) { const v = get(j); while (t > h && get(q[t - 1]) <= v) t--; q[t++] = j; }
      while (q[h] < i - r) h++;
      set(i, get(q[h]));
    }
  };
  for (let y = 0; y < H; y++) { const o = y * W; line(i => a[o + i], (i, v) => { tmp[o + i] = v; }, W); }
  for (let x = 0; x < W; x++) line(i => tmp[i * W + x], (i, v) => { out[i * W + x] = v; }, H);
  return out;
}

// A smaller copy (box average) for steps that don't need every pixel, and reading it back bilinearly.
function shrink(a: ArrayLike<number>, W: number, H: number, k: number) {
  const w = Math.ceil(W / k), h = Math.ceil(H / k), sum = new Float32Array(w * h), cnt = new Float32Array(w * h);
  for (let y = 0, i = 0; y < H; y++) { const o = (y / k | 0) * w; for (let x = 0; x < W; x++, i++) { const j = o + (x / k | 0); sum[j] += a[i]; cnt[j]++; } }
  for (let j = 0; j < w * h; j++) sum[j] /= cnt[j];
  return { s: sum, w, h };
}
function sample(s: Float32Array, w: number, h: number, k: number, x: number, y: number) {
  const fx = Math.max(0, Math.min(w - 1, (x + 0.5) / k - 0.5)), fy = Math.max(0, Math.min(h - 1, (y + 0.5) / k - 0.5));
  const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), u = fx - x0, v = fy - y0;
  return (s[y0 * w + x0] * (1 - u) + s[y0 * w + x1] * u) * (1 - v) + (s[y1 * w + x0] * (1 - u) + s[y1 * w + x1] * u) * v;
}

// Ink parts thicker than a stroke (eyes, noses): an opening with a disc of radius 0.9w, grown by 0.3w.
// Found on a smaller copy; returns 0/1 per pixel.
function blobMask(alpha: Uint8Array, W: number, H: number, w: number): Uint8Array {
  const k = Math.max(1, Math.min(4, Math.floor(w / 5))), sm = shrink(alpha, W, H, k), n = sm.w * sm.h, paper = new Uint8Array(n);
  for (let i = 0; i < n; i++) paper[i] = sm.s[i] >= 128 ? 0 : 1;
  const r = Math.max(1, 0.9 * w / k), dIn = distSq(paper, sm.w, sm.h), core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = dIn[i] > r * r ? 1 : 0;
  const R = r + Math.max(1, 0.3 * w / k), dOut = distSq(core, sm.w, sm.h), small = new Float32Array(n);
  for (let i = 0; i < n; i++) small[i] = dOut[i] <= R * R ? 1 : 0;
  const out = new Uint8Array(W * H);
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) out[i] = small[(y / k | 0) * sm.w + (x / k | 0)] ? 1 : 0;
  return out;
}

// ---------- the line settings

export function shapeLine(alpha: Uint8Array, W: number, H: number, w: number, s: ShapeSettings): Uint8Array {
  const sm = Math.max(0, Math.min(3, s.smooth | 0)), th = Math.max(-1, Math.min(2, s.thick | 0));
  if (!sm && !th) return alpha;
  let loops = contours(alpha, W, H).map(p => resample(p));
  if (sm) {
    const S = SMOOTH[sm] * w, md = MAXD[sm] * w;
    loops = loops.map(p0 => {
      const sg = Math.min(S, lengthOf(p0) / (2 * Math.PI) * 0.35) / 0.5;
      return sg > 0.5 ? moveToward(p0, taubin(p0, sg), md, sg) : p0;
    });
  }
  const off = THICK[th + 1] * w, N = W * H;
  if (!th) {
    const { inside, dist } = raster(loops, 0, 0, W, H, 1.5), out = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const sd = inside[i] ? -dist[i] : dist[i], a = 0.5 - sd; out[i] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255); }
    return out;
  }
  // per outline point: how far it moves (out when thicker, in when thinner), eased along the outline so
  // the amount never changes in a step. Eyes and noses change by 30% of the amount only.
  const blob = blobMask(alpha, W, H, w), at = (p: Float64Array, i: number) => Math.min(H - 1, Math.max(0, p[i * 2 + 1] | 0)) * W + Math.min(W - 1, Math.max(0, p[i * 2] | 0));
  const ease = (f: Float64Array) => blurWrap(f, 1, w / 0.5);
  let amount: (p: Float64Array, i: number) => number;
  // thinner: in proportion to the local half-width (the depth inside the ink, at its widest within 0.6w,
  // found on a smaller copy); thin parts never go below the new typical width
  const k = Math.max(1, Math.min(4, Math.floor(w / 5))), dd = shrink(alpha, W, H, k), n = dd.w * dd.h, paper = new Uint8Array(n);
  let dep: Float32Array = new Float32Array(0), hs: Float32Array = dep;
  if (off < 0) {
    for (let j = 0; j < n; j++) paper[j] = dd.s[j] >= 128 ? 0 : 1;
    const edt = distSq(paper, dd.w, dd.h); dep = new Float32Array(n);
    for (let j = 0; j < n; j++) dep[j] = paper[j] ? 0 : Math.sqrt(edt[j]) * k - k / 2;
    hs = maxSquare(dep, dd.w, dd.h, Math.max(1, Math.round(0.6 * w / k)));
    const ratio = Math.max(0.3, 1 + 2 * off / w);
    amount = (p, i) => { const x = p[i * 2] - 0.5, y = p[i * 2 + 1] - 0.5, hi = sample(hs, dd.w, dd.h, k, x, y), hn = Math.max(hi * ratio, Math.min(hi, w / 2 * ratio)); return -(hi - hn); };
  } else amount = () => off;
  let most = 0;
  const tags = loops.map(p => {
    const m = p.length / 2, f = new Float64Array(m), b = new Float64Array(m);
    for (let i = 0; i < m; i++) { f[i] = amount(p, i); b[i] = blob[at(p, i)]; }
    const fe = ease(f), be = ease(b), t = new Float32Array(m);
    for (let i = 0; i < m; i++) { t[i] = fe[i] * (1 - 0.7 * Math.min(1, be[i] * 2)); most = Math.max(most, Math.abs(t[i])); }
    return t;
  });
  const band = most + 2, { inside, dist, near } = raster(loops, 0, 0, W, H, band, tags), out = new Uint8Array(N);
  const put = (i: number, a: number) => { out[i] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255); };
  // paper closed in by the line and smaller than w² (a nostril) stays paper when thickening
  const keep = new Uint8Array(N);
  if (off > 0) {
    const pp = new Uint8Array(N); for (let i = 0; i < N; i++) pp[i] = 1 - inside[i];
    const c = runComponents(pp, W, H), edge = new Uint8Array(c.sizes.length);
    for (let r = 0; r < c.runs.length; r += 3) { const i = c.runs[r], x = i % W, y = i / W | 0; if (y === 0 || y === H - 1 || x === 0 || x + c.runs[r + 1] === W) edge[c.runs[r + 2]] = 1; }
    for (let r = 0; r < c.runs.length; r += 3) { const q = c.runs[r + 2]; if (!edge[q] && c.sizes[q] < w * w) keep.fill(1, c.runs[r], c.runs[r] + c.runs[r + 1]); }
  }
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
    let sd = inside[i] ? -dist[i] : dist[i];
    // deep inside a big blob, beyond the band
    if (off < 0 && inside[i] && dist[i] >= band) sd = -Math.max(band, sample(dep, dd.w, dd.h, k, x, y));
    put(i, 0.5 - sd + (keep[i] ? 0 : near![i]));
  }
  return out;
}

// ---------- push brush

// The traced path, every w/2 px and smoothed over about one line width (finger shake), as x, y pairs.
function brushPath(p: number[], w: number): number[] {
  const m = p.length / 2; if (m < 2) return p.slice();
  const acc = [0]; for (let i = 1; i < m; i++) acc.push(acc[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]));
  const L = acc[m - 1]; if (L < 1) return p.slice(0, 2).concat(p.slice(-2));
  const n = Math.max(2, Math.ceil(L / Math.max(1, w / 2))), q: number[] = [];
  for (let k = 0, i = 0; k <= n; k++) {
    const at = L * k / n; while (i < m - 2 && acc[i + 1] < at) i++;
    const f = acc[i + 1] > acc[i] ? (at - acc[i]) / (acc[i + 1] - acc[i]) : 0;
    q.push(p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * f, p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * f);
  }
  for (let pass = 0; pass < 8; pass++) for (let k = 1; k < n; k++) for (let c = 0; c < 2; c++) q[k * 2 + c] = (q[k * 2 - 2 + c] + 2 * q[k * 2 + c] + q[k * 2 + 2 + c]) / 4;
  return q;
}

// Drag along a line: the stretch of line under the brush moves across the drag, so that its middle
// follows the (smoothed) path. Both edges move together, so the line keeps its width; other lines inside
// the brush stay. One pass goes `strength` of the way. Returns a new alpha; only pixels near the path change.
export function pushLine(alpha: Uint8Array, W: number, H: number, w: number, push: Push, strength = 0.7): Uint8Array {
  const P = brushPath(push.p, w), R = Math.max(1, push.r), out = alpha.slice(), K = P.length / 2;
  if (K < 2) return out;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let i = 0; i < P.length; i += 2) { bx0 = Math.min(bx0, P[i]); bx1 = Math.max(bx1, P[i]); by0 = Math.min(by0, P[i + 1]); by1 = Math.max(by1, P[i + 1]); }
  // normals of the path, and where the line under each path point sits across it: the ink run along the
  // normal that holds (or is closest to) the path point → its middle `c` and half-width `h`
  const nx = new Float64Array(K), ny = new Float64Array(K), c = new Float64Array(K).fill(NaN), h = new Float64Array(K);
  const ink = (x: number, y: number) => { const xi = Math.floor(x), yi = Math.floor(y); return xi >= 0 && yi >= 0 && xi < W && yi < H && alpha[yi * W + xi] >= 128; };
  for (let k = 0; k < K; k++) {
    const a = Math.max(0, k - 1), b = Math.min(K - 1, k + 1), tx = P[b * 2] - P[a * 2], ty = P[b * 2 + 1] - P[a * 2 + 1], l = Math.hypot(tx, ty) || 1;
    nx[k] = -ty / l; ny[k] = tx / l;
    let best = Infinity, run0 = NaN;
    const reach = R + w;
    for (let s = -reach, was = false; s <= reach + 0.5; s += 0.5) {
      const on = s <= reach && ink(P[k * 2] + nx[k] * s, P[k * 2 + 1] + ny[k] * s);
      if (on && !was) run0 = s;
      if (!on && was) { const e = s - 0.5, m = (run0 + e) / 2, d = run0 <= 0 && e >= 0 ? 0 : Math.min(Math.abs(run0), Math.abs(e)); if (d < best && d <= R) { best = d; c[k] = m; h[k] = (e - run0) / 2 + 0.25; } }
      was = on;
    }
  }
  // fill gaps from neighbours, then ease along the path
  let any = false;
  for (let k = 0; k < K; k++) if (!isNaN(c[k])) any = true;
  if (!any) return out;
  for (let k = 0; k < K; k++) if (isNaN(c[k])) {
    let a = k - 1; while (a >= 0 && isNaN(c[a])) a--;
    let b = k + 1; while (b < K && isNaN(c[b])) b++;
    const A = a >= 0 ? a : b, B = b < K ? b : a, f = A === B ? 0 : (k - A) / (B - A);
    c[k] = c[A] * (1 - f) + c[B] * f; h[k] = h[A] * (1 - f) + h[B] * f;
  }
  for (let pass = 0; pass < 4; pass++) for (let k = 1; k < K - 1; k++) { c[k] = (c[k - 1] + 2 * c[k] + c[k + 1]) / 4; h[k] = (h[k - 1] + 2 * h[k] + h[k + 1]) / 4; }
  const M = R + 4 * w;
  const x0 = Math.max(0, Math.floor(bx0 - M)), y0 = Math.max(0, Math.floor(by0 - M)), x1 = Math.min(W, Math.ceil(bx1 + M)), y1 = Math.min(H, Math.ceil(by1 + M));
  if (x1 <= x0 || y1 <= y0) return out;
  const cw = x1 - x0, ch = y1 - y0;
  const loops = contours(alpha, W, H, x0, y0, cw, ch).map(p0 => {
    let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
    for (let i = 0; i < p0.length; i += 2) { lx0 = Math.min(lx0, p0[i]); lx1 = Math.max(lx1, p0[i]); ly0 = Math.min(ly0, p0[i + 1]); ly1 = Math.max(ly1, p0[i + 1]); }
    if (lx0 > bx1 + R || lx1 < bx0 - R || ly0 > by1 + R || ly1 < by0 - R) return p0;
    const p = resample(p0), n = p.length / 2, mv = new Float64Array(n * 2);
    let moved = false;
    for (let i = 0; i < n; i++) {
      const x = p[i * 2], y = p[i * 2 + 1]; let best = Infinity, bk = 0, bt = 0;
      for (let k = 0; k + 1 < K; k++) {
        const ax = P[k * 2], ay = P[k * 2 + 1], vx = P[k * 2 + 2] - ax, vy = P[k * 2 + 3] - ay, l2 = vx * vx + vy * vy || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)), d = Math.hypot(x - ax - vx * t, y - ay - vy * t);
        if (d < best) { best = d; bk = k; bt = t; }
      }
      if (best > R + w) continue;
      const k1 = bk + 1, cc = c[bk] * (1 - bt) + c[k1] * bt, hh = h[bk] * (1 - bt) + h[k1] * bt;
      const qx = nx[bk] * (1 - bt) + nx[k1] * bt, qy = ny[bk] * (1 - bt) + ny[k1] * bt, ql = Math.hypot(qx, qy) || 1;
      const ux = qx / ql, uy = qy / ql, d = (x - P[bk * 2] - (P[k1 * 2] - P[bk * 2]) * bt) * ux + (y - P[bk * 2 + 1] - (P[k1 * 2 + 1] - P[bk * 2 + 1]) * bt) * uy;
      // only the edges of the line being pushed
      if (Math.abs(Math.abs(d - cc) - hh) > Math.max(2, 0.35 * w)) continue;
      // fades out past the ends of the path
      const ends = (bk === 0 && bt === 0) || (k1 === K - 1 && bt === 1) ? Math.max(0, 1 - best / R) : 1;
      const f = strength * ends; if (f <= 0) continue;
      mv[i * 2] = -cc * ux * f; mv[i * 2 + 1] = -cc * uy * f; moved = true;
    }
    if (!moved) return p;
    // the move eases in and out along the outline
    const e = blurWrap(mv, 2, w / 2 / 0.5);
    for (let i = 0; i < n * 2; i++) p[i] += e[i];
    return p;
  });
  const { inside, dist } = raster(loops, x0, y0, cw, ch, 1.5);
  // write back only near the path (the rest is the same outline drawn again)
  const lim = R + 2 * w, near = new Uint8Array(cw * ch);
  for (let k = 0; k + 3 < P.length; k += 2) {
    const ax = P[k] - x0, ay = P[k + 1] - y0, vx = P[k + 2] - P[k], vy = P[k + 3] - P[k + 1], l2 = vx * vx + vy * vy || 1e-9;
    const X0 = Math.max(0, Math.floor(Math.min(ax, ax + vx) - lim)), X1 = Math.min(cw - 1, Math.ceil(Math.max(ax, ax + vx) + lim));
    const Y0 = Math.max(0, Math.floor(Math.min(ay, ay + vy) - lim)), Y1 = Math.min(ch - 1, Math.ceil(Math.max(ay, ay + vy) + lim));
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const j = y * cw + x; if (near[j]) continue;
      const px = x + 0.5 - ax, py = y + 0.5 - ay, t = Math.max(0, Math.min(1, (px * vx + py * vy) / l2));
      if (Math.hypot(px - vx * t, py - vy * t) <= lim) near[j] = 1;
    }
  }
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const j = y * cw + x; if (!near[j]) continue;
    const sd = inside[j] ? -dist[j] : dist[j], a = 0.5 - sd;
    out[(y + y0) * W + x + x0] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
  }
  return out;
}

// the whole line step: settings, then the pushes in order
export function shapedLine(alpha: Uint8Array, W: number, H: number, w: number, s: ShapeSettings, pushes: Push[] = []): Uint8Array {
  let a = shapeLine(alpha, W, H, w, s);
  for (const p of pushes) a = pushLine(a, W, H, w, p);
  return a;
}
