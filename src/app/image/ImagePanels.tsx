// Image tool panels: layers / slices (left), stage (center), export settings (right).
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject, type PointerEvent as RPointerEvent } from 'react';
import * as PsdCore from '../../core/psdcore';
import { type Doc, type Node, type Slice, WARN_JA, clampSlice, curSlice, dedupe, nameOf, nextSliceName, newSliceId, pathOf, thumbOf } from './model';
import { toCanvas } from './exporter';
import type { ImageTool } from './useImageTool';
import { DraftInput, Seg, StatusText } from '../ui';

const ICON = {
  chev: <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>,
  eye: <svg width="14" height="10" viewBox="0 0 14 10"><path d="M1 5c1.6-2.7 3.6-4 6-4s4.4 1.3 6 4c-1.6 2.7-3.6 4-6 4S2.6 7.7 1 5Z" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="7" cy="5" r="1.8" fill="currentColor" /></svg>,
  eyeOff: <svg width="14" height="10" viewBox="0 0 14 10"><path d="M1 5c1.6-2.7 3.6-4 6-4s4.4 1.3 6 4c-1.6 2.7-3.6 4-6 4S2.6 7.7 1 5Z" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M2 9 12 1" stroke="currentColor" strokeWidth="1.2" /></svg>,
  folder: <svg width="18" height="14" viewBox="0 0 18 14"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h4l1.5 2h7.5A1.5 1.5 0 0 1 17 4.5v7A1.5 1.5 0 0 1 15.5 13h-13A1.5 1.5 0 0 1 1 11.5Z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>,
};
const collapsed = new WeakSet<Node>();
const CHK = 'conic-gradient(var(--chk-b) 25%, transparent 0 50%, var(--chk-b) 0 75%, transparent 0)';

// ---------- left: layers / slices
function RenameInput({ t, n, done }: { t: ImageTool; n: Node; done: () => void }) {
  const [v, setV] = useState(nameOf(n)), ended = useRef(false), ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current!.focus(); ref.current!.select(); }, []);
  const end = (ok: boolean) => { if (ended.current) return; ended.current = true; if (ok) { const s = v.trim(); t.begin(); n._rename = s && s !== n.name ? s : undefined; t.end(); } done(); };
  return <input ref={ref} className="rn" value={v} aria-label="名前" onChange={e => setV(e.target.value)}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') end(true); else if (e.key === 'Escape') end(false); }}
    onBlur={() => end(true)} onClick={e => e.stopPropagation()} />;
}

function LayerTree({ t }: { t: ImageTool }) {
  const d = t.doc!, [renaming, setRenaming] = useState<Node | null>(null);
  const rows: ReactNode[] = [];
  const setChecked = (n: Node, on: boolean) => { const f = (c: Node) => { on ? d.checked.add(c._id) : d.checked.delete(c._id); (c.children || []).forEach(f); }; t.edit(() => f(n)); };
  (function walk(ch: Node[], depth: number) {
    for (let i = ch.length - 1; i >= 0; i--) {
      const n = ch[i];
      const u = n.children ? null : thumbOf(n);
      const thumbStyle: CSSProperties | undefined = u ? { backgroundImage: `url(${u}), ${CHK}`, backgroundSize: 'contain, 6px 6px', backgroundRepeat: 'no-repeat, repeat', backgroundPosition: 'center, 0 0' } : undefined;
      const bm = n.blendMode, w = PsdCore.collectWarnings(n).filter(x => x !== 'text');
      rows.push(
        <div key={n._id} className={'row' + (n.hidden ? ' hid' : '') + (t.sel === n ? ' sel' : '')} style={{ paddingLeft: 8 + depth * 14 + 'px' }}
          onClick={() => t.setSel(t.sel === n ? null : n)}>
          <span className="eye" title={n.hidden ? '非表示' : '表示'}>{n.hidden ? ICON.eyeOff : ICON.eye}</span>
          <button className={'tw' + (collapsed.has(n) ? ' closed' : '')} aria-label="開閉" style={n.children ? undefined : { visibility: 'hidden' }}
            onClick={n.children ? e => { e.stopPropagation(); collapsed.has(n) ? collapsed.delete(n) : collapsed.add(n); t.bump(); } : undefined}>{n.children ? ICON.chev : null}</button>
          {n.children ? <span className="thumb folder">{ICON.folder}</span> : <span className="thumb" style={thumbStyle} />}
          {renaming === n ? <RenameInput t={t} n={n} done={() => { setRenaming(null); t.bump(); }} /> :
            <span className={'name' + (n._rename != null ? ' renamed' : '')} title={n._rename != null ? `元の名前：${n.name || ''}` : undefined}
              onDoubleClick={e => { e.stopPropagation(); setRenaming(n); }}>{nameOf(n) || '(名前なし)'}</span>}
          {n.clipping && <span className="tag">クリップ</span>}
          {bm && bm !== 'normal' && bm !== 'pass through' && <span className="tag">{bm}</span>}
          {w.length > 0 && <span className="tag w" title={w.map(x => WARN_JA[x] || x).join('\n')}>警告</span>}
          <input type="checkbox" className="ck" checked={d.checked.has(n._id)} aria-label="書き出し対象"
            onClick={e => e.stopPropagation()} onChange={e => setChecked(n, e.target.checked)} />
        </div>,
      );
      if (n.children && !collapsed.has(n)) walk(n.children, depth + 1);
    }
  })(d.psd.children || [], 0);
  return <div className="tree lp" id="tree">{rows}</div>;
}

function SliceList({ t, nameRef }: { t: ImageTool; nameRef: RefObject<HTMLInputElement | null> }) {
  const d = t.doc!;
  return (
    <div className="slist sp" id="slist">
      {!d.slices.length && <div className="empty">画像上をドラッグして作成</div>}
      {d.slices.map(s => (
        <div key={s.id} className={'row' + (s.id === d.sliceSel ? ' sel' : '')} onClick={() => { d.sliceSel = s.id; t.sliceChanged(); }}>
          <span className="name" onDoubleClick={e => { e.stopPropagation(); d.sliceSel = s.id; t.sliceChanged(); setTimeout(() => { nameRef.current?.focus(); nameRef.current?.select(); }); }}>{s.name}</span>
          <span className="tag num">{`${s.w}×${s.h}`}</span>
          <input type="checkbox" className="ck" checked={s.on} aria-label="書き出し対象" onClick={e => e.stopPropagation()} onChange={e => { const on = e.target.checked; t.edit(() => { s.on = on; }); }} />
        </div>
      ))}
    </div>
  );
}

function SliceProps({ t, s, round, setRound, nameRef }: { t: ImageTool; s: Slice; round: boolean; setRound: (v: boolean) => void; nameRef: RefObject<HTMLInputElement | null> }) {
  const d = t.doc!;
  // X/Y are the slice center; W/H resize around the center fixed when the field gained focus
  const c = useRef({ x: 0, y: 0 });
  const num = (key: 'x' | 'y' | 'w' | 'h') => (v: string) => {
    const n = +v; if (!isFinite(n) || v === '') return;
    if (key === 'x' || key === 'y') { c.current[key] = n; s[key] = Math.round(n - (key === 'x' ? s.w : s.h) / 2); }
    else { s[key] = Math.round(n); if (key === 'w') s.x = Math.round(c.current.x - s.w / 2); else s.y = Math.round(c.current.y - s.h / 2); }
    clampSlice(s, d.psd.width, d.psd.height); t.sliceChanged();
  };
  const val = { x: s.x + s.w / 2, y: s.y + s.h / 2, w: s.w, h: s.h };
  return (
    <div className="sprops sp" id="sprops" onFocus={e => { if (e.target.tagName === 'INPUT') { c.current = { x: s.x + s.w / 2, y: s.y + s.h / 2 }; t.begin(); } }} onBlur={e => { if (e.target.tagName === 'INPUT') t.end(); }}>
      <div className="r">
        <input ref={nameRef} id="sName" type="text" aria-label="スライス名" value={s.name}
          onChange={e => { s.name = e.target.value; t.sliceChanged(); }}
          onBlur={() => { if (!s.name.trim()) { s.name = nextSliceName(d); t.sliceChanged(); } }}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }} />
        <div className="seg"><button id="sRound" aria-pressed={round} title="丸く切り抜いたときの見え方" onClick={() => setRound(!round)}>丸</button></div>
        <button className="link" id="sDel" onClick={t.deleteSlice}>削除</button>
      </div>
      <div className="g">
        {(['x', 'y', 'w', 'h'] as const).map(k => (
          <Fragment key={k}>
            <span>{k.toUpperCase()}</span>
            <DraftInput id={'s' + k.toUpperCase()} className="n" type="number" min={k === 'w' || k === 'h' ? 1 : undefined} step={k === 'x' || k === 'y' ? 0.5 : undefined} value={val[k]} onDraft={num(k)} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function LayersPanel({ t, round, setRound, fold, setFold }: { t: ImageTool; round: boolean; setRound: (v: boolean) => void; fold: boolean; setFold: (v: boolean) => void }) {
  const fileRef = useRef<HTMLInputElement>(null), nameRef = useRef<HTMLInputElement>(null);
  const layer = t.pane === 'layer', d = t.doc, s = curSlice(d);
  const selAll = () => { if (!d) return; t.edit(() => (function a(ch?: Node[]) { for (const n of ch || []) { d.checked.add(n._id); a(n.children); } })(d.psd.children)); };
  return (
    <aside className="panel layers" aria-label="レイヤー">
      <div className="ph">
        <Seg id="pane" value={t.pane} options={[['layer', 'レイヤー'], ['slice', 'スライス']]} onChange={t.setPane} />
        <span className="lp" hidden={!layer}><button className="link" id="selAll" onClick={selAll}>すべて</button><button className="link" id="selNone" onClick={() => { if (d) t.edit(() => d.checked.clear()); }}>解除</button></span>
        <span className="sp" hidden={layer}><button className="link" id="slLoad" onClick={() => fileRef.current!.click()}>読込</button><button className="link" id="slSave" onClick={t.saveSlices}>保存</button>
          <input ref={fileRef} id="slFile" type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) t.loadSlices(f); }} /></span>
        <button className="link fold" id="fold" aria-label={fold ? '開く' : '畳む'} aria-expanded={!fold} onClick={() => setFold(!fold)}>{ICON.chev}</button>
      </div>
      {d && layer && <LayerTree key={t.cur} t={t} />}
      {d && !layer && <SliceList t={t} nameRef={nameRef} />}
      {d && !layer && s && <SliceProps key={s.id} t={t} s={s} round={round} setRound={setRound} nameRef={nameRef} />}
    </aside>
  );
}

// ---------- center: preview + slice editing
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
type Drag = { id: number; type: 'new' | 'move' | 'resize'; s: Slice; o: { x: number; y: number; w?: number; h?: number }; p: { x: number; y: number }; h?: string; added?: boolean };

export function Stage({ t, round }: { t: ImageTool; round: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null), pvRef = useRef<HTMLCanvasElement>(null);
  const [avail, setAvail] = useState({ w: 0, h: 0 });
  const [drop, setDrop] = useState(false);
  const drag = useRef<Drag | null>(null), bounds = useRef({ x0: 0, y0: 0, x1: 1, y1: 1 });
  // touch: 2-finger tap = undo, 3-finger tap = redo, a second finger during a slice drag = Shift + Alt.
  // A touch drag starts only after the finger moves, so a multi-finger tap never edits a slice.
  const touches = useRef(new Map<number, { x: number; y: number }>()).current;
  const gest = useRef({ max: 0, t0: 0, moved: false, cancel: false });
  const pend = useRef<{ id: number; target: Element; p: { x: number; y: number } } | null>(null);
  const d = t.doc, pv = t.preview, slicing = t.pane === 'slice';

  useLayoutEffect(() => {
    const s = stageRef.current!;
    const ro = new ResizeObserver(() => { const cs = getComputedStyle(s); setAvail({ w: s.clientWidth - parseFloat(cs.paddingLeft) * 2, h: s.clientHeight - parseFloat(cs.paddingTop) * 2 }); });
    ro.observe(s); return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const c = pvRef.current!; if (!pv) return;
    c.width = pv.W; c.height = pv.H; c.getContext('2d')!.drawImage(toCanvas(pv.rgba, pv.W, pv.H), 0, 0);
  }, [pv]);
  useEffect(() => {
    // file drag over the window shows the drop hint on the stage
    let depth = 0;
    const has = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => { if (has(e)) { depth++; setDrop(true); } };
    const leave = () => { if (--depth <= 0) { depth = 0; setDrop(false); } };
    const end = () => { depth = 0; setDrop(false); };
    addEventListener('dragenter', enter); addEventListener('dragleave', leave); addEventListener('drop', end);
    return () => { removeEventListener('dragenter', enter); removeEventListener('dragleave', leave); removeEventListener('drop', end); };
  }, []);

  // in slice mode, fit the union of the canvas and all slices so out-of-canvas slices stay visible (frozen while dragging)
  const W = pv?.W ?? 1, H = pv?.H ?? 1;
  if (!drag.current) {
    let x0 = 0, y0 = 0, x1 = W, y1 = H;
    if (slicing && d) for (const s of d.slices) { x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x + s.w); y1 = Math.max(y1, s.y + s.h); }
    bounds.current = { x0, y0, x1, y1 };
  }
  const { x0, y0, x1, y1 } = bounds.current;
  const fit = avail.w > 0 && avail.h > 0 && pv ? Math.min(avail.w / (x1 - x0), avail.h / (y1 - y0), 8) : 0;
  const dw = Math.floor(W * fit), dh = Math.floor(H * fit), k = dw / W;
  const cvStyle: CSSProperties | undefined = fit ? { transform: `translate(${Math.round(((W - x1) - x0) * fit / 2)}px, ${Math.round(((H - y1) - y0) * fit / 2)}px)` } : undefined;

  const pt = (e: RPointerEvent) => { const r = pvRef.current!.getBoundingClientRect(), q = r.width / pvRef.current!.width; return { x: (e.clientX - r.left) / q, y: (e.clientY - r.top) / q }; };
  function startDrag(id: number, target: Element, p: { x: number; y: number }) {
    if (!d) return; const DW = d.psd.width, DH = d.psd.height;
    const hd = target.closest<HTMLElement>('.hd'), sr = target.closest<HTMLElement>('.sr');
    t.begin();
    if (hd) { const s = curSlice(d)!; drag.current = { id, type: 'resize', h: hd.dataset.h, s, o: { ...s }, p }; }
    else if (sr) { const s = d.slices.find(x => x.id === +sr.dataset.id!)!; d.sliceSel = s.id; drag.current = { id, type: 'move', s, o: { ...s }, p }; t.sliceChanged(); }
    else {
      const x = Math.max(-DW, Math.min(2 * DW, Math.round(p.x))), y = Math.max(-DH, Math.min(2 * DH, Math.round(p.y)));
      drag.current = { id, type: 'new', s: { id: newSliceId(), name: nextSliceName(d), x, y, w: 0, h: 0, on: true }, o: { x, y }, p };
    }
  }
  function down(e: RPointerEvent<HTMLDivElement>) {
    const touch = e.pointerType === 'touch';
    if (touch) {
      if (!touches.size) gest.current = { max: 0, t0: performance.now(), moved: false, cancel: false };
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); gest.current.max = Math.max(gest.current.max, touches.size);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (!slicing || !d || e.button !== 0 || (e.target as Element).closest('.warnbox')) return;
    if (touch) { if (touches.size === 1 && !drag.current) pend.current = { id: e.pointerId, target: e.target as Element, p: pt(e) }; e.preventDefault(); return; }
    startDrag(e.pointerId, e.target as Element, pt(e));
    e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault();
  }
  function move(e: RPointerEvent) {
    const t0 = touches.get(e.pointerId);
    if (t0 && Math.hypot(e.clientX - t0.x, e.clientY - t0.y) > 8) {
      gest.current.moved = true;
      const pd = pend.current; if (pd && pd.id === e.pointerId) { pend.current = null; startDrag(pd.id, pd.target, pd.p); }
    }
    const g = drag.current; if (!g || !d || g.id !== e.pointerId) return;
    // Shift keeps the aspect ratio, Alt anchors on the center
    const shift = e.shiftKey || touches.size >= 2, alt = e.altKey || touches.size >= 2;
    const p = pt(e), DW = d.psd.width, DH = d.psd.height, X0 = -DW, X1 = 2 * DW, Y0 = -DH, Y1 = 2 * DH, dx = p.x - g.p.x, dy = p.y - g.p.y, s = g.s, o = g.o as Slice;
    if (g.type === 'new') {
      const x2 = Math.max(X0, Math.min(X1, Math.round(p.x))), y2 = Math.max(Y0, Math.min(Y1, Math.round(p.y)));
      if (alt) {
        // the start point is the center
        const mx = Math.min(o.x - X0, X1 - o.x), my = Math.min(o.y - Y0, Y1 - o.y);
        let hw = Math.min(Math.abs(x2 - o.x), mx), hh = Math.min(Math.abs(y2 - o.y), my);
        if (shift) hw = hh = Math.min(Math.max(hw, hh), mx, my);
        Object.assign(s, { x: o.x - hw, y: o.y - hh, w: 2 * hw, h: 2 * hh });
      } else {
        let w = Math.abs(x2 - o.x), h = Math.abs(y2 - o.y);
        if (shift) { w = h = Math.min(Math.max(w, h), x2 < o.x ? o.x - X0 : X1 - o.x, y2 < o.y ? o.y - Y0 : Y1 - o.y); }
        Object.assign(s, { x: x2 < o.x ? o.x - w : o.x, y: y2 < o.y ? o.y - h : o.y, w, h });
      }
      if (!g.added && s.w >= 2 && s.h >= 2) { g.added = true; d.slices.push(s); d.sliceSel = s.id; }
      if (g.added) t.sliceChanged();
      return;
    }
    if (g.type === 'move') { s.x = Math.round(o.x + dx); s.y = Math.round(o.y + dy); clampSlice(s, DW, DH); }
    else if (alt) {
      // resize symmetrically around the center
      const h = g.h!, cx = o.x + o.w / 2, cy = o.y + o.h / 2, mx = Math.min(cx - X0, X1 - cx), my = Math.min(cy - Y0, Y1 - cy);
      let hw = h.includes('e') ? o.w / 2 + dx : h.includes('w') ? o.w / 2 - dx : o.w / 2, hh = h.includes('s') ? o.h / 2 + dy : h.includes('n') ? o.h / 2 - dy : o.h / 2;
      hw = Math.max(0.5, hw); hh = Math.max(0.5, hh);
      if (shift) { const r = o.w / o.h; if (h.length === 2) { if (hw / r > hh) hh = hw / r; else hw = hh * r; } else if (h === 'e' || h === 'w') hh = hw / r; else hw = hh * r; const q = Math.min(1, mx / hw, my / hh); hw *= q; hh *= q; }
      else { hw = Math.min(hw, mx); hh = Math.min(hh, my); }
      const w = Math.max(1, Math.round(2 * hw)), hgt = Math.max(1, Math.round(2 * hh));
      Object.assign(s, { x: Math.round(cx - w / 2), y: Math.round(cy - hgt / 2), w, h: hgt });
    }
    else {
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h; const h = g.h!;
      if (h.includes('w')) x1 = Math.min(x2 - 1, Math.max(X0, Math.round(o.x + dx)));
      if (h.includes('e')) x2 = Math.max(x1 + 1, Math.min(X1, Math.round(o.x + o.w + dx)));
      if (h.includes('n')) y1 = Math.min(y2 - 1, Math.max(Y0, Math.round(o.y + dy)));
      if (h.includes('s')) y2 = Math.max(y1 + 1, Math.min(Y1, Math.round(o.y + o.h + dy)));
      if (shift) {
        // keep the original aspect ratio, anchored on the opposite side/corner
        const r = o.w / o.h, ax = h.includes('w') ? o.x + o.w : h.includes('e') ? o.x : o.x + o.w / 2, ay = h.includes('n') ? o.y + o.h : h.includes('s') ? o.y : o.y + o.h / 2;
        let w = x2 - x1, hh = y2 - y1;
        if (h.length === 2) { if (w / r > hh) hh = w / r; else w = hh * r; } else if (h === 'e' || h === 'w') hh = w / r; else w = hh * r;
        const fx = h.includes('w') ? ax - X0 : h.includes('e') ? X1 - ax : 2 * Math.min(ax - X0, X1 - ax), fy = h.includes('n') ? ay - Y0 : h.includes('s') ? Y1 - ay : 2 * Math.min(ay - Y0, Y1 - ay);
        const q = Math.min(1, fx / w, fy / hh); w = Math.max(1, Math.round(w * q)); hh = Math.max(1, Math.round(hh * q));
        x1 = h.includes('w') ? ax - w : h.includes('e') ? ax : Math.round(ax - w / 2); y1 = h.includes('n') ? ay - hh : h.includes('s') ? ay : Math.round(ay - hh / 2);
        x2 = x1 + w; y2 = y1 + hh;
      }
      Object.assign(s, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
    t.sliceChanged();
  }
  function up(e: RPointerEvent) {
    if (touches.delete(e.pointerId)) {
      if (e.type === 'pointercancel') gest.current.cancel = true;
      if (pend.current?.id === e.pointerId) pend.current = null;
      const gs = gest.current;
      if (!touches.size && gs.max >= 2 && !gs.moved && !gs.cancel && performance.now() - gs.t0 < 500) { if (gs.max === 2) t.undo(); else t.redo(); }
    }
    const g = drag.current; if (!g || !d || g.id !== e.pointerId) return;
    drag.current = null; if (g.type === 'new' && !g.added) d.sliceSel = null; t.end(); t.sliceChanged();
  }

  useEffect(() => {
    if (!slicing || !d) return;
    const key = (e: KeyboardEvent) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
      const s = curSlice(d); if (!s) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { t.deleteSlice(); e.preventDefault(); return; }
      const m = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key]; if (!m) return;
      const q = e.shiftKey ? 10 : 1; t.edit(() => { s.x += m[0] * q; s.y += m[1] * q; clampSlice(s, d.psd.width, d.psd.height); }); e.preventDefault();
    };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  });

  const ws = pv ? dedupe(pv.warnings.filter(w => w.type !== 'text')) : [];
  const bb = pv ? PsdCore.alphaBounds(pv.rgba, pv.W, pv.H) : null;
  const sc = slicing ? curSlice(d) : null;
  return (
    <main className="center">
      <div className={'stage' + (slicing ? ' slicing' : '')} id="stage" ref={stageRef} style={pv ? { '--ar': `${x1 - x0} / ${y1 - y0}` } as CSSProperties : undefined} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="cv" style={cvStyle}>
          <canvas id="pv" ref={pvRef} width="1" height="1" style={fit ? { width: dw + 'px', height: dh + 'px' } : undefined} />
          <div className={'sl' + (slicing ? ' on' : '') + (round ? ' round' : '')} id="sl">
            {slicing && d && d.slices.map(s => (
              <div key={s.id} className={'sr' + (s.id === d.sliceSel ? ' sel' : '') + (s.on ? '' : ' off')} data-id={s.id}
                style={{ left: s.x * k + 'px', top: s.y * k + 'px', width: s.w * k + 'px', height: s.h * k + 'px' }}>
                <b>{s.name}</b>
                {s.id === d.sliceSel && <i className="ct" />}
                {s.id === d.sliceSel && HANDLES.map(h => (
                  <i key={h} className="hd" data-h={h} style={{ left: (h.includes('w') ? 0 : h.includes('e') ? 100 : 50) + '%', top: (h.includes('n') ? 0 : h.includes('s') ? 100 : 50) + '%', cursor: h + '-resize' }} />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="warnbox" id="pvInfo" hidden={!ws.length}>
          {ws.map((w, i) => <div key={i}>{`${w.path}：${WARN_JA[w.type] || w.type}${w.detail ? `（${w.detail}）` : ''}`}</div>)}
        </div>
        <div className="drop" id="drop" hidden={!drop}>ここにドロップ</div>
      </div>
      <div className="status">
        <span id="pvName">{d ? t.sel ? [...pathOf(t.sel), nameOf(t.sel)].join(' / ') : `${d.name}  ${d.psd.width}×${d.psd.height}` : ''}</span>
        <span id="pvSize" className="num" style={{ marginLeft: 'auto' }}>{sc ? `${sc.w}×${sc.h}  x${sc.x + sc.w / 2} y${sc.y + sc.h / 2}` : pv ? (bb ? `${bb.w}×${bb.h}  x${bb.x} y${bb.y}` : '空') + `  ${pv.ms}ms` : ''}</span>
        <span id="pvState">{pv && (ws.length ? <span className="warn">{`警告 ${ws.length}`}</span> : <span className="ok">警告なし</span>)}</span>
        <button className="link" id="saveOne" onClick={t.saveOne}>保存</button>
      </div>
    </main>
  );
}

// ---------- right: export settings
export function Inspector({ t }: { t: ImageTool }) {
  const { o, set } = t, layer = t.pane === 'layer';
  const sw = (id: string, key: 'trim' | 'hidden' | 'tree' | 'slFill' | 'allFiles' | 'incWarn', label: ReactNode, cls?: string, hidden?: boolean, onToggle?: () => void) => (
    <label className={'sw' + (cls ? ' ' + cls : '')} htmlFor={id} hidden={hidden}>{label}<input id={id} type="checkbox" checked={o[key]} onChange={e => { set(key, e.target.checked); onToggle?.(); }} /></label>
  );
  return (
    <aside className="panel inspector" aria-label="書き出し設定">
      <div className="insp">
        <div className="sec">
          <div className="prop pair nl lp" hidden={!layer}><span>方式</span><Seg id="mode" value={o.mode} options={[['layer', 'レイヤー'], ['folder', 'フォルダ'], ['both', '両方']]} onChange={v => set('mode', v)} /></div>
          <div className="prop pair nl"><span>形式</span><Seg id="fmt" value={o.fmt} options={[['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']]} onChange={v => set('fmt', v)} /></div>
          <label className="prop" htmlFor="quality" id="qualityRow" hidden={o.fmt === 'png'}><span>画質</span><span className="unit"><input id="quality" className="n" type="number" min="1" max="100" value={o.quality} onChange={e => set('quality', e.target.value)} /></span></label>
        </div>
        <div className="sec">
          <div className="prop pair"><span>サイズ</span><Seg id="size" value={o.size} options={[['orig', '原寸'], ['w', '幅'], ['h', '高さ']]} onChange={v => set('size', v)} /></div>
          <div className="prop" id="sizeRow" hidden={o.size === 'orig'}><span></span><span className="unit" style={{ gridColumn: '2 / -1' }}><input id="px" className="n" type="number" min="1" max="20000" value={o.px} aria-label="ピクセル" onChange={e => set('px', e.target.value)} />px
            <select id="basis" aria-label="基準" style={{ marginLeft: '4px' }} value={o.basis} onChange={e => set('basis', e.target.value as 'canvas')}><option value="canvas">キャンバス</option><option value="image">画像ごと</option></select></span></div>
          {sw('trim', 'trim', <span>余白カット</span>, 'prop pair lp', !layer)}
        </div>
        <div className="sec">
          <label className="prop pair fill" htmlFor="prefix"><span>接頭辞</span><input id="prefix" className="t" type="text" value={o.prefix} onChange={e => set('prefix', e.target.value)} /></label>
          <label className="prop pair fill" htmlFor="suffix"><span>接尾辞</span><input id="suffix" className="t" type="text" value={o.suffix} onChange={e => set('suffix', e.target.value)} /></label>
        </div>
        <div className="sec">
          {sw('hidden', 'hidden', '非表示レイヤーを含む')}
          {sw('tree2', 'tree', 'フォルダ階層を保持', 'lp', !layer)}
          {sw('slFill', 'slFill', '透明部分を周囲の色で補完', 'sp', layer)}
          {sw('allFiles', 'allFiles', '開いているファイルをすべて処理')}
        </div>
      </div>
      <div className="foot">
        <div className="sumrow"><span id="sum" className="num">{`${t.summary.n} ファイル`}{t.summary.w > 0 && <> · <span className="warn">{`警告あり ${t.summary.w}`}</span></>}</span><span id="status" className="muted"><StatusText s={t.status} /></span></div>
        {sw('incWarn', 'incWarn', '警告のある画像も書き出す', undefined, !t.summary.w)}
        <div className="act">
          <Seg id="out" value={o.out} options={[['zip', 'ZIP'], ['each', '個別'], ['dir', 'フォルダ']]} hiddenValues={t.outDir ? [] : ['dir']} onChange={v => set('out', v)} />
          <button className="btn primary" id="export" disabled={t.busy} onClick={t.doExport}>書き出し</button>
        </div>
      </div>
    </aside>
  );
}
export type { Doc };
