// 線画 tool: a scanned line drawing → line / point color / base layers.
// Levels, speck and gap settings re-run the analysis (in a worker); taps on the stage paint regions.
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref, type PointerEvent as RPointerEvent } from 'react';
import { writePsd } from 'ag-psd';
import { type LineArt, type LineSettings, autoLevels, hexRGB, lineAlpha, luminance, regionsOf, strokeWidth } from '../../core/lineart';
import { type Push, shapedLine } from '../../core/lineshape';
import LineWorker from '../../core/lineart.worker?worker&inline';
import type { PsdDoc } from '../../core/psdcore';
import { AddHint, DraftInput, Lbl, Seg, StatusText, ThemeRow } from '../ui';
import { tr } from '../i18n';
import { saveFiles, saveFailText } from '../save';
import type { Status } from '../image/exporter';

// send(): hands the finished layers to the image tool when they changed since the last send
export interface LineToolApi { open(f: File): void; export(): void; send(): void }
export interface LineState { open: boolean; busy: boolean }
// history: a tap paints the region under (x, y) with `c` or erases it (null); `j` adds a join, `rm` takes one away
// `b` is a brush stroke (points, radius `r`) that paints `c` or erases (null) pixel by pixel over the regions
// `fx`: a gradient from `c` to `c2`, or a dot screen tone (in the line color, `cov` = ink share, `per` = dot pitch px)
// that fades out from (x0, y0) to (x1, y1) when those are given
export type Fx = { k: 'grad'; c2: string; x0: number; y0: number; x1: number; y1: number } | { k: 'tone'; cov: number; per: number; x0?: number; y0?: number; x1?: number; y1?: number };
type Tap = { x: number; y: number; c: string | null; fx?: Fx };
// `g`: a traced sweep — one point per region it crossed (x, y, x, y…), all painted `c` (or cleared) as one step
type Sweep = { g: number[]; c: string | null; fx?: Fx };
// `push`: a ならす stroke (path, brush radius `r`) that presses the line's outline smooth across the drag
type Op = Tap | Sweep | { j: number[] } | { rm: number[] } | { b: number[]; r: number; c: string | null } | { push: number[]; r: number };
const isTap = (o: Op): o is Tap => 'x' in o;
// joins in effect after replaying the history
function joinsOf(ops: Op[]) {
  const on: number[][] = [];
  for (const o of ops) if ('j' in o) on.push(o.j); else if ('rm' in o) { const i = on.indexOf(o.rm); if (i >= 0) on.splice(i, 1); }
  return on;
}
const pushesOf = (ops: Op[]): Push[] => ops.flatMap(o => 'push' in o ? [{ p: o.push, r: o.r }] : []);
// The traced path as a join: evenly resampled and smoothed (hand shake), stretched so its ends sit on the
// snapped line ends, and near each snapped end bent to leave along that line's direction.
// a / b: [x, y, dx, dy] of the line end (dx, dy pointing out of the line), or null when that end didn't snap.
export function joinCurve(d: number[], a: number[] | null, b: number[] | null, n = 64) {
  const m = d.length / 2, acc = [0];
  for (let i = 1; i < m; i++) acc.push(acc[i - 1] + Math.hypot(d[i * 2] - d[i * 2 - 2], d[i * 2 + 1] - d[i * 2 - 1]));
  const total = acc[m - 1] || 1, P: number[] = [];
  for (let k = 0, i = 0; k <= n; k++) {
    const at = total * k / n; while (i < m - 2 && acc[i + 1] < at) i++;
    const f = acc[i + 1] > acc[i] ? (at - acc[i]) / (acc[i + 1] - acc[i]) : 0, j = Math.min(i + 1, m - 1);
    P.push(d[i * 2] + (d[j * 2] - d[i * 2]) * f, d[i * 2 + 1] + (d[j * 2 + 1] - d[i * 2 + 1]) * f);
  }
  for (let pass = 0; pass < 6; pass++) for (let k = 1; k < n; k++) for (let c = 0; c < 2; c++) P[k * 2 + c] = (P[k * 2 - 2 + c] + 2 * P[k * 2 + c] + P[k * 2 + 2 + c]) / 4;
  const A = a ? [a[0], a[1]] : [P[0], P[1]], B = b ? [b[0], b[1]] : [P[n * 2], P[n * 2 + 1]];
  const s0 = [A[0] - P[0], A[1] - P[1]], s1 = [B[0] - P[n * 2], B[1] - P[n * 2 + 1]];
  for (let k = 0; k <= n; k++) { const t = k / n; for (let c = 0; c < 2; c++) P[k * 2 + c] += s0[c] * (1 - t) + s1[c] * t; }
  const ease = (t: number) => t >= 1 ? 1 : t * t * (3 - 2 * t), span = 0.3, step = total / n;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    if (a && t < span) { const w = ease(t / span), l = step * k; P[k * 2] = (a[0] + a[2] * l) * (1 - w) + P[k * 2] * w; P[k * 2 + 1] = (a[1] + a[3] * l) * (1 - w) + P[k * 2 + 1] * w; }
    if (b && 1 - t < span) { const w = ease((1 - t) / span), l = step * (n - k); P[k * 2] = (b[0] + b[2] * l) * (1 - w) + P[k * 2] * w; P[k * 2 + 1] = (b[1] + b[3] * l) * (1 - w) + P[k * 2 + 1] * w; }
  }
  return P;
}
const RECENT_KEY = 'butcher.line.recent';
function loadRecent(): string[] { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 8) : []; } catch { return []; } }
type Src = { name: string; W: number; H: number; rgba: Uint8ClampedArray; L: Uint8Array; sw: number };
export const LINE_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

// one worker for the session; null when this environment can't start one (then the main thread runs it)
let worker: Worker | null | undefined;
function getWorker() {
  if (worker === undefined) { try { worker = new LineWorker(); } catch { worker = null; } }
  return worker;
}

// which regions get the base and which a point color, replaying the taps in order
function paintOf(la: LineArt, ops: Op[]) {
  const point = new Map<number, { c: string; fx?: Fx }>(), flip = new Set<number>();
  const at = (x: number, y: number) => { const r = la.region[Math.round(y) * la.W + Math.round(x)]; return r == null || r < 0 ? -1 : r; };
  const base = (r: number) => !la.outside[r] !== flip.has(r);
  for (const o of ops) {
    if ('g' in o) {
      // a sweep only takes the point color off; the base stays
      for (let i = 0; i + 1 < o.g.length; i += 2) {
        const r = at(o.g[i], o.g[i + 1]); if (r < 0) continue;
        if (o.c) point.set(r, { c: o.c, fx: o.fx });
        else point.delete(r);
      }
      continue;
    }
    if (!isTap(o)) continue;
    const r = at(o.x, o.y); if (r < 0) continue;
    if (o.c) point.set(r, { c: o.c, fx: o.fx });
    else if (point.has(r)) point.delete(r);
    else flip.has(r) ? flip.delete(r) : flip.add(r);
  }
  return { point, base };
}

// brush strokes in order: 0 = untouched, 1 = erased, 2 + k = cols[k]
function brushOf(la: LineArt, ops: Op[]) {
  const cols: string[] = []; let mask: Uint8Array | null = null;
  for (const o of ops) {
    if (!('b' in o)) continue;
    mask ??= new Uint8Array(la.W * la.H);
    let v = 1; if (o.c) { let k = cols.indexOf(o.c); if (k < 0) { k = cols.length; cols.push(o.c); } v = Math.min(255, k + 2); }
    const r = o.r, r2 = r * r, pts = o.b;
    const dab = (cx: number, cy: number) => {
      for (let y = Math.max(0, Math.ceil(cy - r)); y <= Math.min(la.H - 1, Math.floor(cy + r)); y++) {
        const dy = y - cy, w = Math.sqrt(Math.max(0, r2 - dy * dy)), row = y * la.W;
        for (let x = Math.max(0, Math.ceil(cx - w)); x <= Math.min(la.W - 1, Math.floor(cx + w)); x++) mask![row + x] = v;
      }
    };
    dab(pts[0], pts[1]);
    for (let i = 2; i + 1 < pts.length; i += 2) {
      const x0 = pts[i - 2], y0 = pts[i - 1], dx = pts[i] - x0, dy = pts[i + 1] - y0, n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, r / 3)));
      for (let k = 1; k <= n; k++) dab(x0 + dx * k / n, y0 + dy * k / n);
    }
  }
  return { mask, cols };
}

type Layers = { line: Uint8ClampedArray; point: Uint8ClampedArray; base: Uint8ClampedArray; all: Uint8ClampedArray };

// position along a gradient: 0 at (x0, y0), 1 at (x1, y1)
const along = (f: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number) => {
  const dx = f.x1 - f.x0, dy = f.y1 - f.y0, t = ((x - f.x0) * dx + (y - f.y0) * dy) / (dx * dx + dy * dy || 1);
  return t < 0 ? 0 : t > 1 ? 1 : t;
};
// ink of a 45° dot screen at (x, y), antialiased: 0..1
export function toneAt(x: number, y: number, cov: number, per: number) {
  const u = (x + y) * Math.SQRT1_2 / per, v = (y - x) * Math.SQRT1_2 / per;
  const du = u - Math.round(u), dv = v - Math.round(v), d = Math.sqrt(du * du + dv * dv) * per, rad = Math.sqrt(Math.min(0.95, cov) / Math.PI) * per;
  const a = rad - d + 0.5; return cov <= 0 ? 0 : a <= 0 ? 0 : a >= 1 ? 1 : a;
}

// One pass for both the stage (composite only) and the output (separate layers too).
// Fills: base, then the point color / gradient / tone over it, then the line on top (straight alpha).
function render(la: LineArt, ops: Op[], lineC: string, baseC: string, sep: boolean) {
  const N = la.W * la.H, W = la.W, { point, base } = paintOf(la, ops), L = hexRGB(lineC), B = hexRGB(baseC);
  const pc = new Int32Array(la.count * 3).fill(-1), fx: (Fx | undefined)[] = [], c2: number[][] = [], bases = new Uint8Array(la.count);
  for (let r = 0; r < la.count; r++) {
    const q = point.get(r); bases[r] = base(r) ? 1 : 0;
    if (q) { pc.set(hexRGB(q.c), r * 3); fx[r] = q.fx; if (q.fx?.k === 'grad') c2[r] = hexRGB(q.fx.c2); }
  }
  const br = brushOf(la, ops), bc = br.cols.map(hexRGB), toBase = br.cols.map(c => c.toLowerCase() === baseC.toLowerCase());
  const all = new Uint8ClampedArray(N * 4), line = sep ? new Uint8ClampedArray(N * 4) : all, pt = sep ? new Uint8ClampedArray(N * 4) : all, bs = sep ? new Uint8ClampedArray(N * 4) : all;
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = la.region[i], a = la.alpha[i], m = br.mask ? br.mask[i] : 0, r3 = r * 3;
    let hb = bases[r], PR = 0, PG = 0, PB = 0, PA = 0;
    if (m === 1) hb = 0;
    else if (m > 1) { if (toBase[m - 2]) hb = 1; else { const c = bc[m - 2]; PR = c[0]; PG = c[1]; PB = c[2]; PA = 1; } }
    else if (pc[r3] >= 0) {
      const f = fx[r];
      if (!f) { PR = pc[r3]; PG = pc[r3 + 1]; PB = pc[r3 + 2]; PA = 1; }
      else {
        const x = i % W, y = (i - x) / W;
        if (f.k === 'grad') { const t = along(f, x, y), u = 1 - t, e = c2[r]; PR = pc[r3] * u + e[0] * t; PG = pc[r3 + 1] * u + e[1] * t; PB = pc[r3 + 2] * u + e[2] * t; PA = 1; }
        else { const cov = f.x1 == null ? f.cov : f.cov * (1 - along(f as any, x, y)); PA = toneAt(x, y, cov, f.per); PR = L[0]; PG = L[1]; PB = L[2]; }
      }
    }
    // the fill under the line: point over base
    let FR = PR, FG = PG, FB = PB, FA = PA;
    if (hb) { const u = 1 - PA; FR = PR * PA + B[0] * u; FG = PG * PA + B[1] * u; FB = PB * PA + B[2] * u; FA = 1; }
    if (sep) {
      line[p] = L[0]; line[p + 1] = L[1]; line[p + 2] = L[2]; line[p + 3] = a;
      if (hb) { bs[p] = B[0]; bs[p + 1] = B[1]; bs[p + 2] = B[2]; bs[p + 3] = 255; }
      if (PA) { pt[p] = PR; pt[p + 1] = PG; pt[p + 2] = PB; pt[p + 3] = PA * 255; }
    }
    const t = a / 255, oa = t + FA * (1 - t);
    if (oa > 0) {
      const k = FA * (1 - t);
      all[p] = (L[0] * t + FR * k) / oa; all[p + 1] = (L[1] * t + FG * k) / oa; all[p + 2] = (L[2] * t + FB * k) / oa; all[p + 3] = oa * 255;
    } else if (!sep) { all[p] = all[p + 1] = all[p + 2] = all[p + 3] = 0; }
  }
  return { line, point: pt, base: bs, all };
}
const layersOf = (la: LineArt, ops: Op[], lineC: string, baseC: string): Layers => render(la, ops, lineC, baseC, true);
// what the stage shows
const composite = (la: LineArt, ops: Op[], lineC: string, baseC: string) => render(la, ops, lineC, baseC, false).all;

const img = (data: Uint8ClampedArray, W: number, H: number) => ({ width: W, height: H, data });
// three layers, bottom first, as the image tool and ag-psd read them
export function layeredDoc(L: Layers, W: number, H: number): PsdDoc {
  const layer = (name: string, data: Uint8ClampedArray) => ({ name, left: 0, top: 0, right: W, bottom: H, opacity: 1, blendMode: 'normal', imageData: img(data, W, H) });
  return { width: W, height: H, imageData: img(L.all, W, H), children: [layer(tr('ベース'), L.base), layer(tr('ポイントカラー'), L.point), layer(tr('線画'), L.line)] };
}

async function pngOf(rgba: Uint8ClampedArray, W: number, H: number) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  c.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0);
  const b = await new Promise<Blob | null>(r => c.toBlob(r, 'image/png')); c.width = c.height = 0;
  if (!b) throw new Error('png'); return b;
}

export function LineTool({ active, ref, onPick, onState, onOpenImage }: {
  active: boolean; ref: Ref<LineToolApi>; onPick: () => void; onState: (st: LineState) => void; onOpenImage: (name: string, psd: PsdDoc) => void;
}) {
  const [src, setSrc] = useState<Src | null>(null);
  const [s, setS] = useState<LineSettings>({ black: 64, white: 180, speck: 4, gap: 20 });
  const [la, setLa] = useState<LineArt | null>(null);
  const [running, setRunning] = useState(false);
  const [lineC, setLineC] = useState('#000000'), [baseC, setBaseC] = useState('#ffffff'), [pointC, setPointC] = useState('#a2eaba');
  const [mode, setMode] = useState<'paint' | 'erase' | 'join' | 'push' | 'pick'>('paint');
  const [smooth, setSmooth] = useState('1'), [thick, setThick] = useState('0'); // ブレ補正 off / weak / medium / strong, 太さ -1…2
  const [pushB, setPushB] = useState(48); // ならす brush diameter, image px
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [jv, setJv] = useState(0); // bumped when the joins change
  const [drag, setDrag] = useState<number[] | null>(null); // the join or brush stroke being traced, image px
  const [brush, setBrush] = useState(16); // brush diameter, image px
  const [stroke, setStroke] = useState<'area' | 'brush'>('area'); // what a drag does with ベタ / 消す
  const [fill, setFill] = useState<'solid' | 'grad' | 'tone'>('solid');
  const [pointC2, setPointC2] = useState('#ffffff'), [cov, setCov] = useState(20), [per, setPer] = useState(8);
  const [view, setView] = useState<'src' | 'res'>('res');
  const [fmt, setFmt] = useState<'psd' | 'png'>('psd');
  const [status, setStatus] = useState<Status>([]);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false); // the stage over the whole window, with the paint tools under it
  const ops = useRef<Op[]>([]), redo = useRef<Op[]>([]);
  const seq = useRef(0);

  useEffect(() => { onState({ open: !!src, busy }); }, [src, busy]);

  async function open(f: File) {
    try {
      setStatus([{ t: f.name }]);
      const bmp = await createImageBitmap(f);
      const W = bmp.width, H = bmp.height, c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d')!; ctx.drawImage(bmp, 0, 0); bmp.close();
      const rgba = ctx.getImageData(0, 0, W, H).data; c.width = c.height = 0;
      const L = luminance(rgba, W, H), lv = autoLevels(L), sw = strokeWidth(lineAlpha(L, W, H, { ...lv, speck: 0 }), W, H);
      ops.current = []; redo.current = []; setJv(0);
      setLa(null); setView('res');
      setSrc({ name: f.name, W, H, rgba, L, sw });
      // defaults from the drawing: specks under half a line width, breaks up to two
      setBrush(Math.max(4, Math.round(sw))); setPushB(Math.max(8, Math.round(sw * 3.2))); setPer(Math.max(4, Math.round(sw / 4.5)));
      setS({ ...lv, speck: Math.max(2, Math.round(sw / 2)), gap: Math.max(2, Math.round(sw * 2)) });
      getWorker()?.postMessage({ src: { L, W, H } });
      setStatus([]);
    } catch (e: any) { setStatus([{ t: tr('{f}: 読み込めません（{e}）', { f: f.name, e: String(e?.message || e) }), c: 'err' }]); }
  }

  // re-run the analysis shortly after the settings change; only the latest run is shown
  useEffect(() => {
    if (!src) return;
    const id = ++seq.current;
    const t = setTimeout(() => {
      setRunning(true);
      const joins = joinsOf(ops.current), pushes = pushesOf(ops.current), shape = { smooth: +smooth, thick: +thick };
      const done = (r: LineArt) => { if (id !== seq.current) return; setLa(r); setRunning(false); };
      const w = getWorker();
      if (w) {
        const on = (e: MessageEvent) => { if (e.data?.id !== id) return; w.removeEventListener('message', on); done(e.data.la); };
        w.addEventListener('message', on); w.postMessage({ id, s, shape, pushes, joins });
      } else setTimeout(() => {
        const a0 = lineAlpha(src.L, src.W, src.H, s), sw = strokeWidth(a0, src.W, src.H), a = shapedLine(a0, src.W, src.H, sw, shape, pushes);
        done(regionsOf(a, src.W, src.H, s.gap, a === a0 ? sw : strokeWidth(a, src.W, src.H), joins));
      }, 0);
    }, 120);
    return () => clearTimeout(t);
  }, [src, s.black, s.white, s.speck, s.gap, smooth, thick, jv]);

  // the stage shows the composite; the separate layers are made only for output
  const shown = useRef<Uint8ClampedArray | null>(null);
  const [ver, setVer] = useState(0);
  useEffect(() => { shown.current = la ? composite(la, ops.current, lineC, baseC) : null; setVer(v => v + 1); }, [la, lineC, baseC]);
  const repaint = () => { if (la) { shown.current = composite(la, ops.current, lineC, baseC); setVer(v => v + 1); } };
  const layersNow = () => la ? layersOf(la, ops.current, lineC, baseC) : null;

  // ---------- stage: fit, pinch / ctrl+wheel zoom, drag to pan, tap to paint
  const stageRef = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  const [avail, setAvail] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stageRef.current!;
    const ro = new ResizeObserver(() => { const cs = getComputedStyle(el); setAvail({ w: el.clientWidth - parseFloat(cs.paddingLeft) * 2, h: el.clientHeight - parseFloat(cs.paddingTop) * 2 }); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const c = cv.current!; if (!src) return;
    if (c.width !== src.W || c.height !== src.H) { c.width = src.W; c.height = src.H; }
    const data = view === 'src' || !shown.current ? src.rgba : shown.current;
    const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, src.W, src.H); ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, src.W, src.H), 0, 0);
  }, [src, ver, view]);

  type View = { K: number; L: number; T: number };
  const [zv, setZv] = useState<View | null>(null);
  const W = src?.W ?? 1, H = src?.H ?? 1;
  const fit = src && avail.w > 0 && avail.h > 0 ? Math.min(avail.w / W, avail.h / H, 8) : 0;
  useEffect(() => setZv(null), [src, avail.w, avail.h]);
  const box: CSSProperties | undefined = !fit ? undefined : zv ? { position: 'absolute', left: 0, top: 0, width: W * zv.K, height: H * zv.K, transform: `translate(${zv.L}px, ${zv.T}px)` }
    : { width: Math.floor(W * fit), height: Math.floor(H * fit) };
  const local = (x: number, y: number) => { const r = stageRef.current!.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; };
  const viewNow = (): View => { const r = cv.current!.getBoundingClientRect(), o = local(r.left, r.top); return { K: r.width / W, L: o.x, T: o.y }; };
  const clampV = (v: View): View => {
    const el = stageRef.current!, ax = (z: number, size: number, at: number) => z <= size ? (size - z) / 2 : Math.min(0, Math.max(size - z, at));
    return { K: v.K, L: ax(W * v.K, el.clientWidth, v.L), T: ax(H * v.K, el.clientHeight, v.T) };
  };
  const zoomAt = (v0: View, K: number, m0: { x: number; y: number }, m: { x: number; y: number }) => {
    K = Math.max(fit, Math.min(Math.max(fit, 32), K)); const r = K / v0.K;
    setZv(K <= fit * 1.01 ? null : clampV({ K, L: m.x - (m0.x - v0.L) * r, T: m.y - (m0.y - v0.T) * r }));
  };
  useEffect(() => {
    const el = stageRef.current!;
    const wheel = (e: WheelEvent) => {
      if (!fit) return;
      if (e.ctrlKey) { e.preventDefault(); const v0 = viewNow(), m = local(e.clientX, e.clientY); zoomAt(v0, v0.K * Math.exp(-e.deltaY * 0.01), m, m); }
      else if (zv) { e.preventDefault(); setZv(v => v && clampV({ K: v.K, L: v.L - e.deltaX, T: v.T - e.deltaY })); }
    };
    const tmove = (e: TouchEvent) => { if (e.touches.length >= 2 || zv) e.preventDefault(); };
    el.addEventListener('wheel', wheel, { passive: false }); el.addEventListener('touchmove', tmove, { passive: false });
    return () => { el.removeEventListener('wheel', wheel); el.removeEventListener('touchmove', tmove); };
  });

  const pts = useRef(new Map<number, { x: number; y: number }>()).current;
  const g = useRef<{ max: number; t0: number; moved: boolean; start: { x: number; y: number }; v0: View; d0: number; m0: { x: number; y: number } } | null>(null);
  function down(e: RPointerEvent) {
    if (!src || (e.pointerType === 'mouse' && e.button !== 0)) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const v0 = viewNow();
    if (pts.size === 1) {
      g.current = { max: 1, t0: performance.now(), moved: false, start: { x: e.clientX, y: e.clientY }, v0, d0: 1, m0: { x: 0, y: 0 } };
      if (mode !== 'pick' && la && view === 'res') { const p = imgAt(e.clientX, e.clientY); setDrag([p.x, p.y]); }
    } else if (g.current) {
      setDrag(null);
      const [a, b] = [...pts.values()];
      g.current.max = Math.max(g.current.max, pts.size); g.current.v0 = v0;
      g.current.d0 = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)); g.current.m0 = local((a.x + b.x) / 2, (a.y + b.y) / 2);
    }
  }
  function move(e: RPointerEvent) {
    const q = g.current; if (!q || !pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (Math.abs(d - q.d0) > 10) q.moved = true;
      if (q.moved) zoomAt(q.v0, q.v0.K * d / q.d0, q.m0, local((a.x + b.x) / 2, (a.y + b.y) / 2));
    } else if (drag) {
      const p = imgAt(e.clientX, e.clientY), lx = drag[drag.length - 2], ly = drag[drag.length - 1];
      if (!q.moved && Math.hypot(e.clientX - q.start.x, e.clientY - q.start.y) > 6) q.moved = true;
      if (Math.hypot(p.x - lx, p.y - ly) * viewNow().K >= 3) {
        const d = [...drag, p.x, p.y]; setDrag(d);
        if (q.moved && sweeping()) { const o = sweepOf(d); if (o && o.g.length !== live.current) { live.current = o.g.length; preview(o); } }
      }
    } else {
      const dx = e.clientX - q.start.x, dy = e.clientY - q.start.y;
      if (!q.moved && Math.hypot(dx, dy) > 8) q.moved = true;
      if (q.moved && zv) setZv(clampV({ K: q.v0.K, L: q.v0.L + dx, T: q.v0.T + dy }));
    }
  }
  function up(e: RPointerEvent) {
    const q = g.current; if (!pts.delete(e.pointerId) || !q) return;
    if (pts.size) {
      // a finger lifted mid-pinch: carry on from the current zoom (the rest pans / pinches from here)
      const rest = [...pts.values()]; q.v0 = viewNow(); q.start = rest[0];
      if (rest.length >= 2) { q.d0 = Math.max(1, Math.hypot(rest[0].x - rest[1].x, rest[0].y - rest[1].y)); q.m0 = local((rest[0].x + rest[1].x) / 2, (rest[0].y + rest[1].y) / 2); }
      return;
    }
    g.current = null;
    if (drag) {
      const d = drag; setDrag(null);
      const wasLive = live.current; live.current = 0;
      if (e.type === 'pointercancel' || q.max >= 2) { if (wasLive) repaint(); return; }
      if (mode === 'join') { addJoin(d); return; }
      if (mode === 'push') { if (q.moved && d.length >= 4) push({ push: d, r: pushB / 2 }); return; }
      // a drag sweeps every region it crosses (or paints with the brush); a tap fills one region
      if (q.moved) {
        if (sweeping()) { const o = sweepOf(d); if (o) { if (o.c) { if (o.fx?.k === 'grad') remember(o.fx.c2); remember(o.c); } push(o); } else if (wasLive) repaint(); return; }
        if (mode === 'paint') remember(pointC); push({ b: d, r: brush / 2, c: mode === 'paint' ? pointC : null }); return;
      }
    }
    if (q.moved || e.type === 'pointercancel') return;
    if (q.max >= 2) { if (performance.now() - q.t0 < 400) step(q.max === 2); return; }
    tap(e.clientX, e.clientY);
  }
  const live = useRef(0); // points in the sweep being previewed
  const sweeping = () => (mode === 'paint' || mode === 'erase') && (stroke === 'area' || (mode === 'paint' && fill !== 'solid'));
  // the regions a traced path crosses, one point each (taken off the line ink, so brushing past a line doesn't
  // reach over it). The paper outside the drawing stays transparent.
  // gradient / tone run from the start to the end of the path across all of them
  function sweepOf(d: number[]): Sweep | null {
    if (!la) return null;
    const seen = new Set<number>(), g: number[] = [];
    const visit = (x: number, y: number) => {
      const xi = Math.round(x), yi = Math.round(y); if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
      const i = yi * W + xi, r = la.region[i]; if (r < 0 || seen.has(r) || la.alpha[i] >= 128 || la.outside[r]) return;
      seen.add(r); g.push(xi, yi);
    };
    visit(d[0], d[1]);
    for (let i = 2; i + 1 < d.length; i += 2) {
      const x0 = d[i - 2], y0 = d[i - 1], dx = d[i] - x0, dy = d[i + 1] - y0, n = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
      for (let k = 1; k <= n; k++) visit(x0 + dx * k / n, y0 + dy * k / n);
    }
    if (!g.length) return null;
    if (mode === 'erase') return { g, c: null };
    const line = { x0: d[0], y0: d[1], x1: d[d.length - 2], y1: d[d.length - 1] };
    const fx: Fx | undefined = fill === 'grad' ? { k: 'grad', c2: pointC2, ...line } : fill === 'tone' ? { k: 'tone', cov: cov / 100, per, ...line } : undefined;
    return { g, c: pointC, fx };
  }
  const preview = (o: Sweep) => { if (la) { shown.current = composite(la, [...ops.current, o], lineC, baseC); setVer(v => v + 1); } };
  function imgAt(cx: number, cy: number) { const r = cv.current!.getBoundingClientRect(); return { x: (cx - r.left) / r.width * W, y: (cy - r.top) / r.height * H }; }
  // ops that change the line or its regions (the analysis runs again)
  const isJoin = (o: Op) => 'j' in o || 'rm' in o || 'push' in o;
  const push = (o: Op) => { ops.current.push(o); redo.current = []; if (isJoin(o)) setJv(v => v + 1); else repaint(); };
  // a traced join: ends that land near a loose line end snap to it and follow its direction
  function addJoin(d: number[]) {
    if (!la || !src) return;
    const K = viewNow().K, reach = Math.max(src.sw * 2, 24 / K), n = d.length;
    const near = (x: number, y: number, skip = -1) => {
      let best = -1, bd = reach;
      for (let i = 0; i < la.ends.length; i += 4) { const dd = Math.hypot(la.ends[i] - x, la.ends[i + 1] - y); if (i !== skip && dd < bd) { bd = dd; best = i; } }
      return best;
    };
    const a = near(d[0], d[1]), b = near(d[n - 2], d[n - 1], a);
    if (n < 4) return;
    const path = joinCurve(d, a >= 0 ? la.ends.slice(a, a + 4) : null, b >= 0 ? la.ends.slice(b, b + 4) : null);
    if (path.length < 4 || Math.hypot(path[path.length - 2] - path[0], path[path.length - 1] - path[1]) * K < 8) return;
    push({ j: path });
  }
  // the join under a point, if any (for 消す)
  function joinAt(x: number, y: number) {
    const lim = Math.max(src ? src.sw : 4, 12 / viewNow().K);
    let hit: number[] | null = null, bd = lim;
    for (const j of joinsOf(ops.current)) for (let i = 0; i + 3 < j.length; i += 2) {
      const ax = j[i], ay = j[i + 1], dx = j[i + 2] - ax, dy = j[i + 3] - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const dd = Math.hypot(x - ax - dx * t, y - ay - dy * t); if (dd < bd) { bd = dd; hit = j; }
    }
    return hit;
  }
  function usePoint(c: string) {
    setPointC(c); setMode('paint');
  }
  function remember(c: string) {
    setRecent(p => { const n = [c, ...p.filter(x => x !== c)].slice(0, 8); try { localStorage.setItem(RECENT_KEY, JSON.stringify(n)); } catch { } return n; });
  }
  // gradient / tone on the region under (x0, y0): a drag sets its direction; a tap runs a gradient top to bottom
  // over the region and lays a flat tone
  function paintFx(x0: number, y0: number, x1?: number, y1?: number) {
    if (!la) return;
    const xi = Math.max(0, Math.min(W - 1, Math.round(x0))), yi = Math.max(0, Math.min(H - 1, Math.round(y0))), r = la.region[yi * W + xi];
    let line = x1 == null ? null : { x0, y0, x1, y1: y1! };
    if (!line && fill === 'grad') {
      let top = H, bot = -1; for (let i = 0; i < la.region.length; i++) if (la.region[i] === r) { const y = (i / W) | 0; if (y < top) top = y; if (y > bot) bot = y; }
      line = { x0: xi, y0: top, x1: xi, y1: Math.max(top + 1, bot) };
    }
    const fx: Fx = fill === 'grad' ? { k: 'grad', c2: pointC2, ...line! } : { k: 'tone', cov: cov / 100, per, ...(line || {}) };
    if (fill === 'grad') { remember(pointC2); remember(pointC); }
    push({ x: xi, y: yi, c: pointC, fx });
  }
  function tap(cx: number, cy: number) {
    if (!la || !src || view === 'src') return;
    const { x, y } = imgAt(cx, cy);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    if (mode === 'push') return;
    if (mode === 'pick') {
      const p = (Math.floor(y) * W + Math.floor(x)) * 4, d = shown.current;
      if (d && d[p + 3]) usePoint('#' + [d[p], d[p + 1], d[p + 2]].map(v => v.toString(16).padStart(2, '0')).join(''));
      return;
    }
    if (mode === 'erase' || mode === 'join') { const j = joinAt(x, y); if (j) { push({ rm: j }); return; } if (mode === 'join') return; }
    if (mode === 'paint' && fill !== 'solid') { paintFx(x, y); return; }
    if (mode === 'paint') remember(pointC);
    push({ x, y, c: mode === 'paint' ? pointC : null });
  }
  function step(back: boolean) {
    const [from, to] = back ? [ops.current, redo.current] : [redo.current, ops.current];
    const o = from.pop(); if (!o) return; to.push(o);
    if (isJoin(o)) setJv(v => v + 1); else repaint();
  }
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (e.key === 'Escape' && full) { setFull(false); e.preventDefault(); return; }
      if (!(e.ctrlKey || e.metaKey) || e.altKey || (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) step(true); else if ((k === 'z' && e.shiftKey) || k === 'y') step(false); else return;
      e.preventDefault();
    };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  });

  // ---------- output
  const stem = () => (src?.name || 'line').replace(/\.[^.]+$/, '');
  async function doExport() {
    const L = layersNow(); if (!src || !L || busy) return;
    setBusy(true);
    try {
      const name = `${stem()}.${fmt}`;
      const data = fmt === 'psd' ? new Blob([writePsd(layeredDoc(L, src.W, src.H) as any, { noBackground: true } as any)], { type: 'image/vnd.adobe.photoshop' }) : await pngOf(L.all, src.W, src.H);
      const r = await saveFiles([{ name, data }]);
      setStatus(r === 'ok' ? [{ t: tr('{s} を書き出し', { s: name }), c: 'ok' }] : [{ t: saveFailText(r), c: 'err' }]);
    } catch (e: any) { setStatus([{ t: tr('エラー: {e}', { e: String(e?.message || e) }), c: 'err' }]); }
    finally { setBusy(false); }
  }
  const sent = useRef(-1);
  const toImage = () => { const L = layersNow(); if (src && L) { sent.current = ver; onOpenImage(`${stem()}.psd`, layeredDoc(L, src.W, src.H)); } };
  const send = () => { if (src && la && !busy && sent.current !== ver) toImage(); };
  useImperativeHandle(ref, () => ({ open, export: doExport, send }));

  const num = (k: keyof LineSettings, lo: number, hi: number) => (v: string) => { const n = Math.round(+v); if (v !== '' && isFinite(n)) setS(p => ({ ...p, [k]: Math.max(lo, Math.min(hi, n)) })); };
  const level = (k: 'black' | 'white') => (
    <span className="lv">
      <input type="range" min="0" max="255" value={s[k]} aria-label={tr(k === 'black' ? '黒' : '白')}
        onChange={e => { const v = +e.target.value; setS(p => k === 'black' ? { ...p, black: Math.min(v, p.white - 1) } : { ...p, white: Math.max(v, p.black + 1) }); }} />
      <DraftInput className="n" type="number" min="0" max="255" value={s[k]} onDraft={num(k, 0, 255)} />
    </span>
  );
  const ready = !!src && !!la;
  const colors = (
    <span className="unit">
                <input type="color" className="col" aria-label={tr('色')} value={pointC} onChange={e => usePoint(e.target.value)} />
                {fill === 'grad' && <input type="color" className="col" id="lCol2" aria-label={tr('色') + ' 2'} value={pointC2} onChange={e => { setPointC2(e.target.value); setMode('paint'); }} />}
                <button className="ib" id="lPick" aria-label={tr('スポイト')} title={tr('スポイト')} aria-pressed={mode === 'pick'} onClick={() => setMode(mode === 'pick' ? 'paint' : 'pick')}>
                  <svg width="16" height="16" viewBox="0 0 16 16"><path d="M10.5 2.5l3 3M9 4l3 3M11.2 5.8L5 12l-2.5.8.8-2.5 6.2-6.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" /></svg>
                </button>
              </span>
  );
  const modes = <Seg id="lMode" value={mode} options={[['paint', tr('塗る')], ['erase', tr('消す')], ['join', tr('つなぐ')], ['push', tr('ならす')]]} onChange={setMode} />;
  const fullBtn = (
    <button className="ib" id="lFull" aria-label={tr(full ? '閉じる' : '大きく表示')} title={tr(full ? '閉じる' : '大きく表示')} onClick={() => setFull(!full)}>
      {full ? <svg width="16" height="16" viewBox="0 0 16 16"><path d="M6.5 2.5v4h-4M9.5 2.5v4h4M6.5 13.5v-4h-4M9.5 13.5v-4h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" /></svg>
        : <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 6.5v-4h4M13.5 6.5v-4h-4M2.5 9.5v4h4M13.5 9.5v4h-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" /></svg>}
    </button>
  );
  const sum = src ? `${src.W}×${src.H}` : '';

  return (
    <section className={'gif line' + (src ? ' on' : '') + (full && src ? ' full' : '')} id="line">
      <main className="center" style={{ display: 'flex' }}>
        <div className={'stage' + (src ? zv ? ' zoomed' : '' : ' pick')} id="lStage" ref={stageRef} onClick={src ? undefined : onPick}
          style={src ? { '--sw': src.W, '--sh': src.H } as CSSProperties : undefined}
          role={src ? undefined : 'button'} tabIndex={src ? undefined : 0} aria-label={src ? undefined : tr('開く')}
          onKeyDown={src ? undefined : e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <canvas ref={cv} id="lPv" width="1" height="1" hidden={!src} style={box} />
          {src && la && view === 'res' && (mode === 'join' || mode === 'erase' || drag) && <svg className="jn" style={box} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {mode === 'join' && Array.from({ length: la.ends.length / 4 }, (_, i) => <circle key={i} cx={la.ends[i * 4]} cy={la.ends[i * 4 + 1]} r={5 / (zv?.K || fit || 1)} />)}
            {joinsOf(ops.current).map((j, i) => <polyline key={i} className="dash" points={j.join(' ')} />)}
            {drag && (mode === 'join' || (sweeping() && fill === 'solid') || mode === 'erase' && stroke === 'area' ? <polyline points={drag.join(' ')} />
              : mode === 'paint' && fill !== 'solid' ? <polyline points={[drag[0], drag[1], drag[drag.length - 2], drag[drag.length - 1]].join(' ')} />
              : <polyline className="brush" points={drag.join(' ')} style={{ stroke: mode === 'paint' ? pointC : undefined, strokeWidth: (mode === 'push' ? pushB : brush) * (zv?.K || fit || 1) }} />)}
          </svg>}
          <AddHint hidden={!!src} formats="PNG · JPEG · WebP" />
        </div>
        {full && src ? <div className="status tools">
          {modes}
          {fill !== 'tone' && mode !== 'push' && colors}
          <button className="ib" aria-label={tr('元に戻す')} title={tr('元に戻す')} onClick={() => step(true)}>
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M5.5 3.5l-3 3 3 3M2.5 6.5h7a4 4 0 010 8h-2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" /></svg>
          </button>
          <button className="ib" aria-label={tr('やり直し')} title={tr('やり直し')} onClick={() => step(false)}>
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M10.5 3.5l3 3-3 3M13.5 6.5h-7a4 4 0 000 8h2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" /></svg>
          </button>
          {fullBtn}
        </div> : <div className="status">
          <span id="lName">{src ? src.name : ''}</span>
          <span id="lSize" className="num">{sum}</span>
          <span id="lState" className="muted">{running ? tr('処理中') : ''}</span>
          <Seg id="lView" hidden={!src} value={view} options={[['src', tr('元')], ['res', tr('結果')]]} onChange={setView} />
          {src && fullBtn}
          <button className="link" id="lToImg" hidden={!src} disabled={!ready || busy} onClick={toImage}><Lbl>{tr('画像タブで開く')}</Lbl></button>
        </div>}
      </main>
      <aside className="panel inspector" aria-label={tr('線画')}>
        <div className="insp">
          <fieldset className="lock" disabled={busy}>
          <div className="sec">
            <div className="prop lvrow"><span><Lbl>{tr('黒')}</Lbl></span>{level('black')}</div>
            <div className="prop lvrow"><span><Lbl>{tr('白')}</Lbl></span>{level('white')}</div>
            <div className="prop pair"><span><Lbl>{tr('ごみ取り')}</Lbl></span><span className="unit"><DraftInput className="n" type="number" min="0" max="200" value={s.speck} onDraft={num('speck', 0, 200)} />px</span></div>
            <div className="prop pair"><span><Lbl>{tr('隙間')}</Lbl></span><span className="unit"><DraftInput className="n" type="number" min="0" max="400" value={s.gap} onDraft={num('gap', 0, 400)} />px</span></div>
            <div className="prop shape"><span><Lbl>{tr('ブレ補正')}</Lbl></span><Seg id="lSmooth" value={smooth} options={[['0', tr('オフ')], ['1', tr('弱')], ['2', tr('中')], ['3', tr('強')]]} onChange={setSmooth} /></div>
            <div className="prop shape"><span><Lbl>{tr('太さ')}</Lbl></span><Seg id="lThick" value={thick} options={[['-1', tr('細')], ['0', tr('元')], ['1', tr('太1')], ['2', tr('太2')]]} onChange={setThick} /></div>
          </div>
          <div className="sec">
            <div className="prop use">{!full && modes}</div>
            <div className="prop use" hidden={mode === 'push'}><Seg id="lFill" value={fill} options={[['solid', tr('ベタ')], ['grad', tr('グラデ')], ['tone', tr('トーン')]]} onChange={v => { setFill(v); setMode('paint'); }} /></div>
            {fill === 'tone' && mode !== 'push' && <>
              <div className="prop pair"><span><Lbl>{tr('濃度')}</Lbl></span><span className="unit"><DraftInput className="n" type="number" min="1" max="90" value={cov} onDraft={v => { const n = Math.round(+v); if (v !== '' && isFinite(n)) setCov(Math.max(1, Math.min(90, n))); }} />%</span></div>
              <div className="prop pair"><span><Lbl>{tr('間隔')}</Lbl></span><span className="unit"><DraftInput className="n" type="number" min="3" max="200" value={per} onDraft={v => { const n = Math.round(+v); if (v !== '' && isFinite(n)) setPer(Math.max(3, Math.min(200, n))); }} />px</span></div>
            </>}
            <div className="prop pair" hidden={mode !== 'push'}><span><Lbl>{tr('ブラシ')}</Lbl></span>
              <span className="unit"><DraftInput className="n" type="number" min="2" max="1000" aria-label={tr('ブラシ')} value={pushB} onDraft={v => { const n = Math.round(+v); if (v !== '' && isFinite(n)) setPushB(Math.max(2, Math.min(1000, n))); }} />px</span>
            </div>
            <div className="prop pair" hidden={(fill !== 'solid' && mode === 'paint') || mode === 'push'}><span><Lbl>{tr('なぞる')}</Lbl></span>
              <span className="unit">
                <Seg id="lStroke" value={stroke} options={[['area', tr('領域')], ['brush', tr('ブラシ')]]} onChange={setStroke} />
                {stroke === 'brush' && <><DraftInput className="n" type="number" min="1" max="500" aria-label={tr('ブラシ')} value={brush} onDraft={v => { const n = Math.round(+v); if (v !== '' && isFinite(n)) setBrush(Math.max(1, Math.min(500, n))); }} />px</>}
              </span>
            </div>
            <div className="prop pair cpick" hidden={fill === 'tone' || mode === 'push'}><span><Lbl>{tr('色')}</Lbl></span>
              {!full && colors}
            </div>
            {recent.length > 0 && mode !== 'push' && <div className="prop recent"><span><Lbl>{tr('最近')}</Lbl></span><span className="sws">
              {recent.map(c => <button key={c} className="swc" aria-label={c} title={c} aria-pressed={c === pointC} style={{ background: c }} onClick={() => usePoint(c)} />)}
            </span></div>}
            <label className="prop pair"><span><Lbl>{tr('ベース')}</Lbl></span><input type="color" className="col" value={baseC} onChange={e => setBaseC(e.target.value)} /></label>
            <label className="prop pair"><span><Lbl>{tr('線')}</Lbl></span><input type="color" className="col" value={lineC} onChange={e => setLineC(e.target.value)} /></label>
          </div>
          <div className="sec">
            <div className="prop"><span><Lbl>{tr('形式')}</Lbl></span><Seg id="lFmt" value={fmt} options={[['psd', 'PSD'], ['png', 'PNG']]} onChange={setFmt} /></div>
          </div>
          </fieldset>
          <div className="sec">
            <ThemeRow />
          </div>
        </div>
        <div className="foot" hidden={!status.length}>
          <div className="sumrow"><span className="num" /><span className="muted" role="status" aria-live="polite"><StatusText s={status} /></span></div>
        </div>
      </aside>
    </section>
  );
}
