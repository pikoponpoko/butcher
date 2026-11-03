// Line art → three layers: line (black with alpha), point colors, base fill.
// Pure pixel code (no DOM), so it runs in tests and in the app alike.
//
// 1. levels: luminance below `black` is solid ink, above `white` is paper (transparent), linear in between.
// 2. specks: ink islands smaller than a `speck` px square are removed, paper pinholes a quarter of that are filled.
// 3. regions: the paper is split into regions as if every line were `gap` px thicker on each side, so
//    breaks in the line narrower than about 2×gap don't join two areas. The thickened areas are then
//    grown back (competing, breadth-first) so each region reaches the real line, and finally climb
//    into the line up to its center line, so fills sit under the line with no paper showing between.

export interface LineSettings { black: number; white: number; speck: number; gap: number }
export interface LineArt {
  W: number; H: number;
  alpha: Uint8Array;   // line opacity 0–255
  region: Int32Array;  // region id per pixel
  outside: Uint8Array; // per region: 1 = touches the image border
  count: number;
  gaps: number[][];    // bridged breaks, [x0, y0, x1, y1] in image px
  ends: number[];      // loose line ends: x, y, dx, dy (unit vector pointing out of the line), in image px
}

const INF = 1e20;

// Squared Euclidean distance to the nearest `true` pixel (Felzenszwalb & Huttenlocher).
// Rows first (a simple two-way sweep); columns are then copied out in blocks so memory is read in order.
export function distSq(mask: Uint8Array, W: number, H: number): Float32Array {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const o = y * W; let d = INF;
    for (let x = 0; x < W; x++) { d = mask[o + x] ? 0 : d + 1; out[o + x] = d; }
    d = INF;
    for (let x = W - 1; x >= 0; x--) { d = mask[o + x] ? 0 : d + 1; const m = Math.min(d, out[o + x]); out[o + x] = m >= INF / 2 ? INF : m * m; }
  }
  const B = 32, col = new Float64Array(B * H), res = new Float64Array(B * H), v = new Int32Array(H), z = new Float64Array(H + 1);
  for (let x0 = 0; x0 < W; x0 += B) {
    const nb = Math.min(B, W - x0);
    for (let y = 0; y < H; y++) { const o = y * W + x0; for (let b = 0; b < nb; b++) col[b * H + y] = out[o + b]; }
    for (let b = 0; b < nb; b++) {
      const f = b * H;
      let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < H; q++) {
        if (col[f + q] >= INF) continue; // empty column cells never win
        const fq = col[f + q] + q * q; let s = (fq - (col[f + v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (k > 0 && s <= z[k]) { k--; s = (fq - (col[f + v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        if (k === 0 && col[f + v[0]] >= INF) { v[0] = q; z[0] = -INF; z[1] = INF; continue; }
        if (s <= z[k]) { v[k] = q; z[k + 1] = INF; continue; }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < H; q++) { while (z[k + 1] < q) k++; const r = q - v[k]; res[f + q] = Math.min(r * r + col[f + v[k]], INF); }
    }
    for (let y = 0; y < H; y++) { const o = y * W + x0; for (let b = 0; b < nb; b++) out[o + b] = res[b * H + y]; }
  }
  return out;
}

export function luminance(rgba: ArrayLike<number>, W: number, H: number): Uint8Array {
  const L = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const a = rgba[p + 3] / 255, l = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    L[i] = Math.round(l * a + 255 * (1 - a)); // transparent = paper
  }
  return L;
}

// Paper = the brightest histogram peak, ink = the dark end; levels sit between them.
export function autoLevels(L: Uint8Array): { black: number; white: number } {
  const h = new Float64Array(256); for (let i = 0; i < L.length; i++) h[L[i]]++;
  let paper = 255, best = -1;
  for (let v = 96; v < 256; v++) { let s = 0; for (let k = -3; k <= 3; k++) s += h[Math.max(0, Math.min(255, v + k))]; if (s > best) { best = s; paper = v; } }
  // ink: 5th percentile of pixels clearly darker than paper
  let dark = 0; for (let v = 0; v < paper - 40; v++) dark += h[v];
  let ink = 0;
  if (dark > 0) { let c = 0; for (let v = 0; v < paper - 40; v++) { c += h[v]; if (c >= dark * 0.3) { ink = v; break; } } }
  const span = Math.max(30, paper - ink);
  return { black: Math.round(ink + span * 0.25), white: Math.round(ink + span * 0.7) };
}

// 4-connected components of `mask` (two-pass union-find); labels are 1… (0 = not in mask), with per-label sizes.
function components(mask: Uint8Array, W: number, H: number, weight?: Uint8Array) {
  const N = W * H, lab = new Int32Array(N), par = new Int32Array((N >> 1) + 2);
  let next = 1;
  const find = (a: number) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
    if (!mask[i]) continue;
    const l = x > 0 ? lab[i - 1] : 0, u = y > 0 ? lab[i - W] : 0;
    if (l) {
      lab[i] = l;
      if (u && u !== l) { const ra = find(l), rb = find(u); if (ra !== rb) { if (ra < rb) par[rb] = ra; else par[ra] = rb; } }
    } else if (u) lab[i] = u;
    else { lab[i] = next; par[next] = next; next++; }
  }
  const map = new Int32Array(next); let n = 0;
  for (let a = 1; a < next; a++) { const r = find(a); map[a] = r === a ? ++n : map[r]; }
  const sizes = new Array<number>(n + 1).fill(0);
  if (weight) { for (let i = 0; i < N; i++) if (lab[i]) { const m = lab[i] = map[lab[i]]; sizes[m] += weight[i]; } }
  else for (let i = 0; i < N; i++) if (lab[i]) { const m = lab[i] = map[lab[i]]; sizes[m]++; }
  return { lab, sizes };
}

// Runs of `mask` row by row, joined into 4-connected components (fast on large, mostly uniform areas).
// Returns each run as [y·W + x0, length, component] and the components' sizes (or weight sums).
function runComponents(mask: Uint8Array, W: number, H: number, weight?: Uint8Array) {
  const runs: number[] = [], par: number[] = [];
  const find = (a: number) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  let prevA = 0, prevB = 0;
  for (let y = 0; y < H; y++) {
    const o = y * W, curA = runs.length;
    let j = prevA;
    for (let x = 0; x < W;) {
      if (!mask[o + x]) { x++; continue; }
      const x0 = x; while (x < W && mask[o + x]) x++;
      const id = par.length; par.push(id); runs.push(o + x0, x - x0, id);
      // join runs of the row above that overlap [x0, x)
      while (j < prevB && runs[j] - (o - W) + runs[j + 1] <= x0) j += 3;
      for (let k = j; k < prevB && runs[k] - (o - W) < x; k += 3) { const ra = find(runs[k + 2]), rb = find(id); if (ra !== rb) par[Math.max(ra, rb)] = Math.min(ra, rb); }
    }
    prevA = curA; prevB = runs.length;
  }
  const sizes = new Float64Array(par.length);
  for (let r = 0; r < runs.length; r += 3) {
    const c = runs[r + 2] = find(runs[r + 2]);
    if (weight) { let w = 0; for (let i = runs[r], e = i + runs[r + 1]; i < e; i++) w += weight[i]; sizes[c] += w; } else sizes[c] += runs[r + 1];
  }
  return { runs, sizes };
}

// Line opacity after levels and speck removal.
export function lineAlpha(L: Uint8Array, W: number, H: number, s: Pick<LineSettings, 'black' | 'white' | 'speck'>): Uint8Array {
  const N = W * H, a = new Uint8Array(N), b = Math.min(s.black, s.white - 1), span = Math.max(1, s.white - b);
  const lut = new Uint8Array(256); for (let v = 0; v < 256; v++) { const t = (s.white - v) / span; lut[v] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255); }
  for (let i = 0; i < N; i++) a[i] = lut[L[i]];
  if (s.speck > 0) {
    // ink islands: everything with any opacity, sized by its solid (>= 50%) pixels
    const any = new Uint8Array(N), core = new Uint8Array(N);
    for (let i = 0; i < N; i++) { any[i] = a[i] > 0 ? 1 : 0; core[i] = a[i] >= 128 ? 1 : 0; }
    const area = s.speck * s.speck, ink = runComponents(any, W, H, core);
    for (let r = 0; r < ink.runs.length; r += 3) if (ink.sizes[ink.runs[r + 2]] < area) a.fill(0, ink.runs[r], ink.runs[r] + ink.runs[r + 1]);
    // paper pinholes inside ink (not touching the border)
    const paper = new Uint8Array(N); for (let i = 0; i < N; i++) paper[i] = a[i] < 128 ? 1 : 0;
    const p = runComponents(paper, W, H), edge = new Uint8Array(p.sizes.length);
    for (let r = 0; r < p.runs.length; r += 3) {
      const i = p.runs[r], x = i % W, y = i / W | 0;
      if (y === 0 || y === H - 1 || x === 0 || x + p.runs[r + 1] === W) edge[p.runs[r + 2]] = 1;
    }
    for (let r = 0; r < p.runs.length; r += 3) { const c = p.runs[r + 2]; if (!edge[c] && p.sizes[c] < area / 4) a.fill(255, p.runs[r], p.runs[r] + p.runs[r + 1]); }
  }
  return a;
}

// Zhang–Suen thinning: 1-pixel-wide center lines of the ink.
export function skeleton(ink: Uint8Array, W: number, H: number): Uint8Array {
  const sk = ink.slice(); let list: number[] = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (sk[y * W + x]) list.push(y * W + x);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x === 0 || y === 0 || x === W - 1 || y === H - 1) sk[y * W + x] = 0;
  const del: number[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (const i of list) {
        if (!sk[i]) continue;
        const p2 = sk[i - W], p3 = sk[i - W + 1], p4 = sk[i + 1], p5 = sk[i + W + 1], p6 = sk[i + W], p7 = sk[i + W - 1], p8 = sk[i - 1], p9 = sk[i - W - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9; if (b < 2 || b > 6) continue;
        const a = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) + (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
        if (a !== 1) continue;
        if (pass === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
        del.push(i);
      }
      for (const i of del) sk[i] = 0;
      if (del.length) changed = true;
    }
    list = list.filter(i => sk[i]);
  }
  return sk;
}

const N8 = (W: number) => [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];

// Bridges breaks in the line: from each loose end of the center line, a short straight segment to the
// nearest center line ahead of it (a break of up to `gap` px, at most 60° off the stroke direction).
// Returns the segments as [x0, y0, x1, y1].
export function findGaps(ink: Uint8Array, W: number, H: number, gap: number, width: number): { gaps: number[][]; ends: number[] } {
  const sk = skeleton(ink, W, H), nb = N8(W), out: number[][] = [], ends: number[] = [];
  // ring of 8 neighbours in order, for counting separate branches around a pixel
  const ring = [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1];
  const branches = (i: number, skip: number) => {
    let n = 0, cnt = 0;
    for (let k = 0; k < 8; k++) {
      const a = sk[i + ring[k]] && mark[i + ring[k]] !== skip, b = sk[i + ring[(k + 1) % 8]] && mark[i + ring[(k + 1) % 8]] !== skip;
      if (a) cnt++; if (!a && b) n++;
    }
    return cnt === 8 ? 1 : n;
  };
  const back = Math.max(4, Math.round(width * 2)), mark = new Int32Array(W * H);
  // prune: short side branches (forks at blunt line ends, bumps on thick lines) and dots go away
  const P = Math.max(2, Math.round(width * 0.75));
  {
    let pts: number[] = []; for (let i = 0; i < W * H; i++) if (sk[i]) pts.push(i);
    for (let it = 0; it < P; it++) {
      const del = pts.filter(i => { let d = 0; for (const o of nb) d += sk[i + o]; return d === 0 || (d <= 3 && branches(i, -1) === 1); });
      for (const i of del) sk[i] = 0;
      pts = pts.filter(i => sk[i]);
    }
  }
  // `gap` is the visible break; center lines end about half a line width (plus the pruning) short on each side
  const reach = gap + width + 2 * P, R = Math.ceil(reach);
  // short center-line pieces (eyes, mouths, specks) are details, not outlines: never bridged from or to
  const depth = distSq(ink.map(v => 1 - v), W, H);
  const piece = new Int32Array(W * H), dot: boolean[] = [false], st: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!sk[i] || piece[i]) continue;
    const id = dot.length; let n = 0, dm = 0; piece[i] = id; st.push(i);
    while (st.length) { const p = st.pop()!; n++; dm = Math.max(dm, depth[p]); for (const d of nb) { const q = p + d; if (sk[q] && !piece[q]) { piece[q] = id; st.push(q); } } }
    dot.push(n < 2 * Math.sqrt(dm) || n < 2 * back);
  }
  let stamp = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const e = y * W + x; if (!sk[e]) continue;
    stamp++;
    let deg = 0; for (const d of nb) deg += sk[e + d];
    if (deg > 3 || branches(e, -1) !== 1) continue;
    // walk back along the line: a junction or another end close by means a spur or a dot, not a break
    mark[e] = stamp;
    let p = e, steps = 0, ok = true, tail = e;
    const walk = Math.max(back, R + P);
    while (steps < walk) {
      const cand: number[] = [];
      for (const d of nb) { const q = p + d; if (sk[q] && mark[q] !== stamp) cand.push(q); }
      if (!cand.length) { if (dot[piece[e]] || steps < back) ok = false; break; }
      if (cand.length > 1 && branches(p, stamp) > 1) break;
      // all candidates count as walked (the line is 2 px wide at stair steps); go on from the farthest
      for (const q of cand) mark[q] = stamp;
      let next = cand[0], far = -1;
      for (const q of cand) { let f = 0; for (const d of nb) if (sk[q + d] && mark[q + d] !== stamp) f++; if (f > far) { far = f; next = q; } }
      p = next; steps++; if (steps <= back) tail = p;
    }
    if (!ok) continue;
    const dx = x - tail % W, dy = y - (tail / W | 0), dl = Math.hypot(dx, dy); if (dl < 1) continue;
    ends.push(x, y, dx / dl, dy / dl);
    if (gap <= 0) continue;
    let best = -1, bd = Infinity;
    for (let ty = Math.max(1, y - R); ty <= Math.min(H - 2, y + R); ty++) for (let tx = Math.max(1, x - R); tx <= Math.min(W - 2, x + R); tx++) {
      const t = ty * W + tx; if (!sk[t] || mark[t] === stamp || dot[piece[t]]) continue;
      const vx = tx - x, vy = ty - y, d = Math.hypot(vx, vy); if (d > reach || d < 1) continue;
      if ((vx * dx + vy * dy) / (d * dl) < 0.5) continue;
      // prefer meeting another loose end
      let tn = 0; for (const q of nb) tn += sk[t + q];
      const score = tn === 1 ? d * 0.7 : d;
      if (score < bd) { bd = score; best = t; }
    }
    if (best >= 0) out.push([x, y, best % W, best / W | 0]);
  }
  return { gaps: out, ends };
}

// Draws a segment into a mask, `t` px thick (8-connected steps at t = 1 still block a 4-connected fill).
function stroke(m: Uint8Array, W: number, H: number, s: number[], t: number) {
  const [x0, y0, x1, y1] = s, n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)), r = (t - 1) / 2;
  for (let k = 0; k <= n; k++) {
    const cx = x0 + (x1 - x0) * k / Math.max(1, n), cy = y0 + (y1 - y0) * k / Math.max(1, n);
    for (let yy = Math.round(cy - r); yy <= Math.round(cy + r); yy++) for (let xx = Math.round(cx - r); xx <= Math.round(cx + r); xx++)
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) m[yy * W + xx] = 1;
  }
}

// Paper areas: 4-connected regions of non-ink, each grown into the line up to its center.
function fillRegions(ink: Uint8Array, W: number, H: number) {
  const N = W * H, paper = new Uint8Array(N); for (let i = 0; i < N; i++) paper[i] = 1 - ink[i];
  const c = components(paper, W, H), region = new Int32Array(N).fill(-1), q = new Int32Array(N);
  const count = c.sizes.length - 1;
  if (!count) return { region: region.fill(0), count: 1, sizes: [N], outside: new Uint8Array([1]) };
  // outside = paper that reaches the image border (a line running off the edge doesn't count)
  const outside = new Uint8Array(count), edge = (i: number) => { if (c.lab[i]) outside[c.lab[i] - 1] = 1; };
  for (let x = 0; x < W; x++) { edge(x); edge(N - W + x); }
  for (let y = 0; y < H; y++) { edge(y * W); edge(y * W + W - 1); }
  let head = 0, tail = 0;
  for (let i = 0; i < N; i++) if (c.lab[i]) { region[i] = c.lab[i] - 1; q[tail++] = i; }
  // climb into the line, never downhill, so each side stops at the line's center
  const DI = distSq(paper, W, H);
  const up = (p: number, n: number) => { if (region[n] < 0 && DI[n] >= DI[p]) { region[n] = region[p]; q[tail++] = n; } };
  while (head < tail) {
    const p = q[head++], x = p % W;
    if (x > 0) up(p, p - 1); if (x < W - 1) up(p, p + 1); if (p >= W) up(p, p - W); if (p < N - W) up(p, p + W);
  }
  // leftovers (flat ridges): take any neighbour
  head = tail = 0;
  for (let i = 0; i < N; i++) if (region[i] >= 0) q[tail++] = i;
  const any = (p: number, n: number) => { if (region[n] < 0) { region[n] = region[p]; q[tail++] = n; } };
  while (head < tail) {
    const p = q[head++], x = p % W;
    if (x > 0) any(p, p - 1); if (x < W - 1) any(p, p + 1); if (p >= W) any(p, p - W); if (p < N - W) any(p, p + W);
  }
  return { region, count, sizes: c.sizes.slice(1), outside };
}

// `joins`: polylines [x0, y0, x1, y1, …] drawn by hand that close the drawing like a line (never shown)
export function regions(alpha: Uint8Array, W: number, H: number, gap: number, width = strokeWidth(alpha, W, H), joins: number[][] = []): Omit<LineArt, 'alpha'> {
  const N = W * H, ink = new Uint8Array(N);
  for (let i = 0; i < N; i++) ink[i] = alpha[i] >= 128 ? 1 : 0;
  const t = Math.max(2, Math.round(width / 2));
  for (const j of joins) for (let i = 0; i + 3 < j.length; i += 2) stroke(ink, W, H, [j[i], j[i + 1], j[i + 2], j[i + 3]], t);
  const found = findGaps(ink, W, H, gap, width), ends = found.ends;
  let gaps = found.gaps;
  let r: ReturnType<typeof fillRegions>;
  if (gaps.length) {
    // drop bridges that cut off a sliver (a bridge to an eye or a bump closes a small wedge)
    const closed = ink.slice(); for (const g of gaps) stroke(closed, W, H, g, t);
    r = fillRegions(closed, W, H);
    const min = (gap + width) * (gap + width) * 0.6;
    const keep = gaps.filter(([x0, y0, x1, y1]) => {
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, l = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / l, ny = (x1 - x0) / l, o = t + 1;
      const at = (sx: number, sy: number) => { const x = Math.round(mx + nx * sx), y = Math.round(my + ny * sy); return x >= 0 && y >= 0 && x < W && y < H && !closed[y * W + x] ? r.region[y * W + x] : -1; };
      const a = at(o, o), b = at(-o, -o);
      return a < 0 || b < 0 || a === b || Math.min(r.sizes[a], r.sizes[b]) >= min;
    });
    if (keep.length !== gaps.length) {
      gaps = keep; const c2 = ink.slice(); for (const g of gaps) stroke(c2, W, H, g, t);
      r = fillRegions(c2, W, H);
    }
  } else r = fillRegions(ink, W, H);
  const { region, count, outside } = r;
  return { W, H, region, outside, count, gaps, ends };
}

// A join is a fill edge, not a line: on the visible paper near it, each pixel takes the region on its side
// of the curve, so the edge follows the curve smoothly instead of the coarse grid it was found on.
function smoothJoins(region: Int32Array, alpha: Uint8Array, W: number, H: number, joins: number[][], R: number) {
  for (const j of joins) {
    const n = j.length / 2 - 1; if (n < 1) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < j.length; i += 2) { x0 = Math.min(x0, j[i]); x1 = Math.max(x1, j[i]); y0 = Math.min(y0, j[i + 1]); y1 = Math.max(y1, j[i + 1]); }
    const X0 = Math.max(0, Math.floor(x0 - R)), X1 = Math.min(W - 1, Math.ceil(x1 + R)), Y0 = Math.max(0, Math.floor(y0 - R)), Y1 = Math.min(H - 1, Math.ceil(y1 + R));
    const set: [number, number][] = [];
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const i = y * W + x; if (alpha[i] >= 128) continue;
      let best = R * R, side = 0, px = 0, py = 0, nx = 0, ny = 0;
      for (let s = 0; s < n; s++) {
        const ax = j[s * 2], ay = j[s * 2 + 1], dx = j[s * 2 + 2] - ax, dy = j[s * 2 + 3] - ay, l2 = dx * dx + dy * dy || 1;
        let t = ((x - ax) * dx + (y - ay) * dy) / l2;
        // past the ends of the curve the line itself decides
        if ((s === 0 && t < 0) || (s === n - 1 && t > 1)) continue;
        t = Math.max(0, Math.min(1, t));
        const qx = ax + dx * t, qy = ay + dy * t, d = (x - qx) ** 2 + (y - qy) ** 2;
        if (d < best) { best = d; const l = Math.sqrt(l2); nx = -dy / l; ny = dx / l; side = (x - qx) * nx + (y - qy) * ny >= 0 ? 1 : -1; px = qx; py = qy; }
      }
      if (!side) continue;
      const sx = Math.round(px + nx * side * (R + 1)), sy = Math.round(py + ny * side * (R + 1));
      if (sx >= 0 && sy >= 0 && sx < W && sy < H) set.push([i, region[sy * W + sx]]);
    }
    for (const [i, r] of set) region[i] = r;
  }
}

// Regions are found on a smaller copy when lines are thick: the region borders sit at the middle of the
// line, so a few pixels of rounding stay hidden under it.
export function analyze(rgba: ArrayLike<number>, W: number, H: number, s: LineSettings, L = luminance(rgba, W, H), joins: number[][] = []): LineArt {
  return regionsOf(lineAlpha(L, W, H, s), W, H, s.gap, undefined, joins);
}
// the region step alone, for a line layer that is already known (only the gap setting changed)
export function regionsOf(alpha: Uint8Array, W: number, H: number, gap: number, sw = strokeWidth(alpha, W, H), joins: number[][] = []): LineArt {
  const k = Math.max(1, Math.min(4, Math.floor(sw / 5)));
  if (k === 1) { const r = regions(alpha, W, H, gap, sw, joins); smoothJoins(r.region, alpha, W, H, joins, Math.max(2, Math.round(sw / 2)) / 2 + 2); return { alpha, ...r }; }
  const w = Math.ceil(W / k), h = Math.ceil(H / k), small = new Uint8Array(w * h), sum = new Uint32Array(w * h), cnt = new Uint32Array(w * h);
  const xi = new Int32Array(W); for (let x = 0; x < W; x++) xi[x] = x / k | 0;
  for (let y = 0, i = 0; y < H; y++) { const o = (y / k | 0) * w; for (let x = 0; x < W; x++, i++) { const j = o + xi[x]; sum[j] += alpha[i]; cnt[j]++; } }
  for (let j = 0; j < w * h; j++) small[j] = Math.round(sum[j] / cnt[j]);
  const r = regions(small, w, h, gap / k, sw / k, joins.map(j => j.map(v => v / k))), region = new Int32Array(W * H);
  for (let y = 0, i = 0; y < H; y++) { const o = (y / k | 0) * w; for (let x = 0; x < W; x++, i++) region[i] = r.region[o + xi[x]]; }
  smoothJoins(region, alpha, W, H, joins, Math.max(2, Math.round(sw / k / 2)) * k / 2 + k + 1);
  return { alpha, W, H, region, outside: r.outside, count: r.count, gaps: r.gaps.map(g => g.map(v => v * k + k / 2)), ends: r.ends.map((v, i) => i % 4 < 2 ? v * k + k / 2 : v) };
}

// Typical line width: 2 × solid area / outline length (a stroke of width w and length l has area wl, outline ≈ 2l).
export function strokeWidth(alpha: Uint8Array, W: number, H: number): number {
  let area = 0, edge = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (alpha[i] < 128) continue; area++;
    if (x > 0 && alpha[i - 1] < 128) edge++; if (x < W - 1 && alpha[i + 1] < 128) edge++;
    if (y > 0 && alpha[i - W] < 128) edge++; if (y < H - 1 && alpha[i + W] < 128) edge++;
  }
  // outline length counted in pixel edges overstates curved outlines by about 4/π
  return edge ? 2 * area / (edge * Math.PI / 4) : 1;
}

export type RGB = [number, number, number];
export const hexRGB = (h: string): RGB => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };

export function lineRGBA(la: LineArt, c: RGB): Uint8ClampedArray {
  const out = new Uint8ClampedArray(la.W * la.H * 4);
  for (let i = 0, p = 0; i < la.alpha.length; i++, p += 4) { out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2]; out[p + 3] = la.alpha[i]; }
  return out;
}
// one color (or none) per region
export function fillRGBA(la: LineArt, color: (r: number) => RGB | null): Uint8ClampedArray {
  const out = new Uint8ClampedArray(la.W * la.H * 4), cols: (RGB | null)[] = [];
  for (let r = 0; r < la.count; r++) cols.push(color(r));
  for (let i = 0, p = 0; i < la.region.length; i++, p += 4) { const c = cols[la.region[i]]; if (c) { out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2]; out[p + 3] = 255; } }
  return out;
}
