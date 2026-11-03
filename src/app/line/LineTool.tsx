// 線画 tool: a scanned line drawing → line / point color / base layers.
// Levels, speck and gap settings re-run the analysis (in a worker); taps on the stage paint regions.
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref, type PointerEvent as RPointerEvent } from 'react';
import { writePsd } from 'ag-psd';
import { type LineArt, type LineSettings, analyze, autoLevels, hexRGB, lineAlpha, luminance, strokeWidth } from '../../core/lineart';
import LineWorker from '../../core/lineart.worker?worker&inline';
import type { PsdDoc } from '../../core/psdcore';
import { AddHint, DraftInput, Lbl, Seg, StatusText, ThemeRow } from '../ui';
import { tr } from '../i18n';
import { saveFiles, saveFailText } from '../save';
import type { Status } from '../image/exporter';

export interface LineToolApi { open(f: File): void; export(): void }
export interface LineState { open: boolean; busy: boolean }
// a tap: paint the region under (x, y) with `c`, or erase it (null)
type Op = { x: number; y: number; c: string | null };
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
  const point = new Map<number, string>(), flip = new Set<number>();
  for (const o of ops) {
    const r = la.region[Math.round(o.y) * la.W + Math.round(o.x)]; if (r == null || r < 0) continue;
    if (o.c) point.set(r, o.c);
    else if (point.has(r)) point.delete(r);
    else flip.has(r) ? flip.delete(r) : flip.add(r);
  }
  return { point, base: (r: number) => !la.outside[r] !== flip.has(r) };
}

type Layers = { line: Uint8ClampedArray; point: Uint8ClampedArray; base: Uint8ClampedArray; all: Uint8ClampedArray };
function layersOf(la: LineArt, ops: Op[], lineC: string, baseC: string): Layers {
  const N = la.W * la.H, { point, base } = paintOf(la, ops);
  const L = hexRGB(lineC), B = hexRGB(baseC), cols: ([number, number, number] | null)[] = [], bases: boolean[] = [];
  for (let r = 0; r < la.count; r++) { const c = point.get(r); cols.push(c ? hexRGB(c) : null); bases.push(base(r)); }
  const line = new Uint8ClampedArray(N * 4), pt = new Uint8ClampedArray(N * 4), bs = new Uint8ClampedArray(N * 4), all = new Uint8ClampedArray(N * 4);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = la.region[i], a = la.alpha[i], c = cols[r];
    line[p] = L[0]; line[p + 1] = L[1]; line[p + 2] = L[2]; line[p + 3] = a;
    let R = 0, G = 0, Bl = 0, A = 0;
    if (bases[r]) { bs[p] = R = B[0]; bs[p + 1] = G = B[1]; bs[p + 2] = Bl = B[2]; bs[p + 3] = A = 255; }
    if (c) { pt[p] = R = c[0]; pt[p + 1] = G = c[1]; pt[p + 2] = Bl = c[2]; pt[p + 3] = A = 255; }
    // line over the fills (straight alpha)
    const la_ = a / 255, oa = la_ + (A / 255) * (1 - la_);
    if (oa > 0) {
      all[p] = (L[0] * la_ + R * (A / 255) * (1 - la_)) / oa; all[p + 1] = (L[1] * la_ + G * (A / 255) * (1 - la_)) / oa; all[p + 2] = (L[2] * la_ + Bl * (A / 255) * (1 - la_)) / oa;
      all[p + 3] = oa * 255;
    }
  }
  return { line, point: pt, base: bs, all };
}

// what the stage shows: fills under the line, one pass over a 32-bit view
function composite(la: LineArt, ops: Op[], lineC: string, baseC: string): Uint8ClampedArray {
  const { point, base } = paintOf(la, ops), L = hexRGB(lineC), B = hexRGB(baseC);
  const fill = new Int32Array(la.count * 3).fill(-1);
  for (let r = 0; r < la.count; r++) { const c = point.get(r); const v = c ? hexRGB(c) : base(r) ? B : null; if (v) fill.set(v, r * 3); }
  const N = la.W * la.H, out = new Uint8ClampedArray(N * 4);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = la.region[i] * 3, a = la.alpha[i];
    if (fill[r] < 0) { if (a) { out[p] = L[0]; out[p + 1] = L[1]; out[p + 2] = L[2]; out[p + 3] = a; } continue; }
    const t = a / 255, u = 1 - t;
    out[p] = L[0] * t + fill[r] * u; out[p + 1] = L[1] * t + fill[r + 1] * u; out[p + 2] = L[2] * t + fill[r + 2] * u; out[p + 3] = 255;
  }
  return out;
}

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
  const [mode, setMode] = useState<'paint' | 'erase'>('paint');
  const [view, setView] = useState<'src' | 'res'>('res');
  const [fmt, setFmt] = useState<'psd' | 'png'>('psd');
  const [status, setStatus] = useState<Status>([]);
  const [busy, setBusy] = useState(false);
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
      ops.current = []; redo.current = [];
      setLa(null); setView('res');
      setSrc({ name: f.name, W, H, rgba, L, sw });
      // defaults from the drawing: specks under one line width, breaks up to two
      setS({ ...lv, speck: Math.max(2, Math.round(sw)), gap: Math.max(2, Math.round(sw * 2)) });
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
      const done = (r: LineArt) => { if (id !== seq.current) return; setLa(r); setRunning(false); };
      const w = getWorker();
      if (w) {
        const on = (e: MessageEvent) => { if (e.data?.id !== id) return; w.removeEventListener('message', on); done(e.data.la); };
        w.addEventListener('message', on); w.postMessage({ id, s });
      } else setTimeout(() => done(analyze(src.rgba, src.W, src.H, s, src.L)), 0);
    }, 120);
    return () => clearTimeout(t);
  }, [src, s.black, s.white, s.speck, s.gap]);

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
    if (pts.size === 1) g.current = { max: 1, t0: performance.now(), moved: false, start: { x: e.clientX, y: e.clientY }, v0, d0: 1, m0: { x: 0, y: 0 } };
    else if (g.current) {
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
    } else {
      const dx = e.clientX - q.start.x, dy = e.clientY - q.start.y;
      if (!q.moved && Math.hypot(dx, dy) > 8) q.moved = true;
      if (q.moved && zv) setZv(clampV({ K: q.v0.K, L: q.v0.L + dx, T: q.v0.T + dy }));
    }
  }
  function up(e: RPointerEvent) {
    const q = g.current; if (!pts.delete(e.pointerId) || !q) return;
    if (pts.size) return;
    g.current = null;
    if (q.moved || e.type === 'pointercancel') return;
    if (q.max >= 2) { if (performance.now() - q.t0 < 400) step(q.max === 2); return; }
    tap(e.clientX, e.clientY);
  }
  function tap(cx: number, cy: number) {
    if (!la || view === 'src') return;
    const r = cv.current!.getBoundingClientRect(), x = (cx - r.left) / r.width * W, y = (cy - r.top) / r.height * H;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    ops.current.push({ x, y, c: mode === 'paint' ? pointC : null }); redo.current = []; repaint();
  }
  function step(back: boolean) {
    const [from, to] = back ? [ops.current, redo.current] : [redo.current, ops.current];
    const o = from.pop(); if (!o) return; to.push(o); repaint();
  }
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
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
  const toImage = () => { const L = layersNow(); if (src && L) onOpenImage(`${stem()}.psd`, layeredDoc(L, src.W, src.H)); };
  useImperativeHandle(ref, () => ({ open, export: doExport }));

  const num = (k: keyof LineSettings, lo: number, hi: number) => (v: string) => { const n = Math.round(+v); if (v !== '' && isFinite(n)) setS(p => ({ ...p, [k]: Math.max(lo, Math.min(hi, n)) })); };
  const level = (k: 'black' | 'white') => (
    <span className="lv">
      <input type="range" min="0" max="255" value={s[k]} aria-label={tr(k === 'black' ? '黒' : '白')}
        onChange={e => { const v = +e.target.value; setS(p => k === 'black' ? { ...p, black: Math.min(v, p.white - 1) } : { ...p, white: Math.max(v, p.black + 1) }); }} />
      <DraftInput className="n" type="number" min="0" max="255" value={s[k]} onDraft={num(k, 0, 255)} />
    </span>
  );
  const ready = !!src && !!la;
  const sum = src ? `${src.W}×${src.H}` : '';

  return (
    <section className={'gif line' + (src ? ' on' : '')} id="line">
      <main className="center" style={{ display: 'flex' }}>
        <div className={'stage' + (src ? zv ? ' zoomed' : '' : ' pick')} id="lStage" ref={stageRef} onClick={src ? undefined : onPick}
          style={src ? { '--sw': src.W, '--sh': src.H } as CSSProperties : undefined}
          role={src ? undefined : 'button'} tabIndex={src ? undefined : 0} aria-label={src ? undefined : tr('開く')}
          onKeyDown={src ? undefined : e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <canvas ref={cv} id="lPv" width="1" height="1" hidden={!src} style={box} />
          <AddHint hidden={!!src} formats="PNG · JPEG · WebP" />
        </div>
        <div className="status">
          <span id="lName">{src ? src.name : ''}</span>
          <span id="lSize" className="num">{sum}</span>
          <span id="lState" className="muted">{running ? tr('処理中') : ''}</span>
          <Seg id="lView" hidden={!src} value={view} options={[['src', tr('元')], ['res', tr('結果')]]} onChange={setView} />
          <button className="link" id="lToImg" hidden={!src} disabled={!ready || busy} onClick={toImage}><Lbl>{tr('画像タブで開く')}</Lbl></button>
        </div>
      </main>
      <aside className="panel inspector" aria-label={tr('線画')}>
        <div className="insp">
          <fieldset className="lock" disabled={busy}>
          <div className="sec">
            <div className="prop lvrow"><span><Lbl>{tr('黒')}</Lbl></span>{level('black')}</div>
            <div className="prop lvrow"><span><Lbl>{tr('白')}</Lbl></span>{level('white')}</div>
            <div className="prop pair"><span><Lbl>{tr('ごみ取り')}</Lbl></span><span className="unit"><DraftInput className="n" type="number" min="0" max="200" value={s.speck} onDraft={num('speck', 0, 200)} />px</span></div>
            <div className="prop pair"><span><Lbl>{tr('隙間')}</Lbl></span><span className="unit"><DraftInput className="n" type="number" min="0" max="400" value={s.gap} onDraft={num('gap', 0, 400)} />px</span></div>
          </div>
          <div className="sec">
            <div className="prop use"><Seg id="lMode" value={mode} options={[['paint', tr('塗る')], ['erase', tr('消す')]]} onChange={setMode} /></div>
            <label className="prop pair"><span><Lbl>{tr('色')}</Lbl></span><input type="color" className="col" value={pointC} onChange={e => { setPointC(e.target.value); setMode('paint'); }} /></label>
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
