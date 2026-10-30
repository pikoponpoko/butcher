// GIF / animated WebP / MP4 export from a video. The video element and the settings live in refs because
// playback, seeking and encoding drive them outside React; `bump()` re-renders.
import { useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type Ref } from 'react';
import { saveBlob, saveFailText } from '../save';
import type { Status } from '../image/exporter';
import { DraftInput, Seg, StatusText } from '../ui';
import { encodeGif, encodeMp4, encodeWebp, webpOK, type EncodeOpts } from './encoders';

type Fmt = 'gif' | 'webp' | 'mp4';
interface Template { id: string; name: string; fmt?: Fmt; w?: number; h?: number; lock?: boolean; fit?: 'cover' | 'contain'; target?: number; fps?: number; maxFrames?: number }
const TEMPLATES: Template[] = [
  { id: 'custom', name: 'カスタム' },
  { id: 'web-gif', name: 'Web GIF', fmt: 'gif', w: 800, lock: true, target: 2, fps: 15 },
  { id: 'web-webp', name: 'Web アニメWebP', fmt: 'webp', w: 800, lock: true, target: 1, fps: 20 },
  { id: 'x-gif-l', name: 'X GIF 横 1280×720', fmt: 'gif', w: 1280, h: 720, lock: false, fit: 'cover', target: 15, fps: 15, maxFrames: 350 },
  { id: 'x-gif-sq', name: 'X GIF 正方形 720×720', fmt: 'gif', w: 720, h: 720, lock: false, fit: 'cover', target: 15, fps: 15, maxFrames: 350 },
  { id: 'x-mp4-l', name: 'X 動画 横 1280×720', fmt: 'mp4', w: 1280, h: 720, lock: false, fit: 'cover', target: 0, fps: 30 },
  { id: 'x-mp4-p', name: 'X 動画 縦 720×1280', fmt: 'mp4', w: 720, h: 1280, lock: false, fit: 'cover', target: 0, fps: 30 },
  { id: 'x-mp4-sq', name: 'X 動画 正方形 720×720', fmt: 'mp4', w: 720, h: 720, lock: false, fit: 'cover', target: 0, fps: 30 },
  { id: 'ig-34', name: 'Instagram 縦 3:4 1080×1440', fmt: 'mp4', w: 1080, h: 1440, lock: false, fit: 'cover', target: 0, fps: 30 },
  { id: 'ig-45', name: 'Instagram 縦 4:5 1080×1350', fmt: 'mp4', w: 1080, h: 1350, lock: false, fit: 'cover', target: 0, fps: 30 },
  { id: 'ig-sq', name: 'Instagram 正方形 1080×1080', fmt: 'mp4', w: 1080, h: 1080, lock: false, fit: 'cover', target: 0, fps: 30 },
  { id: 'ig-reel', name: 'Instagram リール 1080×1920', fmt: 'mp4', w: 1080, h: 1920, lock: false, fit: 'cover', target: 0, fps: 30 },
];
const KEYS = ['fmt', 'w', 'h', 'lock', 'fit', 'bg', 'fps', 'speed', 'loop', 'target', 'colors', 'q'] as const;
const MAX_BYTES = 1.2e9; // decoded RGBA kept in memory for GIF/WebP
const SPEEDS = ['0.25', '0.5', '0.75', '1', '1.25', '1.5', '2', '3', '4'];
const fmtMB = (b: number) => (b / 1048576).toFixed(b < 1048576 * 10 ? 2 : 1) + ' MB';
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
type Rect = { x: number; y: number; w: number; h: number };

function initState() {
  const g = {
    fmt: 'gif' as Fmt, w: 480, h: 270, lock: true, fit: 'cover' as 'cover' | 'contain', bg: '#000000', fps: 15, speed: 1, loop: 0, target: 0, colors: 256, q: 80, tpl: 'custom',
    v: false, name: '', url: '', dur: 0, sw: 0, sh: 0, start: 0, end: 0, crop: null as Rect | null, result: null as Blob | null, resUrl: '', view: 'src' as 'src' | 'res', busy: false,
  };
  try { Object.assign(g, JSON.parse(localStorage.getItem('gif:settings') || '{}')); } catch {}
  g.crop = null; // per video
  return g;
}
type G = ReturnType<typeof initState>;

export interface GifToolApi { open(f: File): void }
export const isVideo = (f: File) => /^video\//.test(f.type) || /\.(mp4|webm|mov|m4v)$/i.test(f.name);

export function GifTool({ active, ref }: { active: boolean; ref: Ref<GifToolApi> }) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const g = useRef<G>(null as unknown as G); if (!g.current) g.current = initState();
  const s = g.current;
  const vid = useRef<HTMLVideoElement>(null as unknown as HTMLVideoElement);
  if (!vid.current) { const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; vid.current = v; }
  const v = vid.current;
  const pv = useRef<HTMLCanvasElement>(null), stageRef = useRef<HTMLDivElement>(null), thumbs = useRef<HTMLCanvasElement>(null), track = useRef<HTMLDivElement>(null), resV = useRef<HTMLVideoElement>(null), presetRef = useRef<HTMLInputElement>(null);
  const [statusLine, setStatusState] = useState<Status>([]);
  const status = (t: string, c?: 'ok' | 'warn' | 'err') => setStatusState([{ t, c }]);
  const [avail, setAvail] = useState({ w: 0, h: 0 });
  const scrubT = useRef<number | null>(null);

  const outW = () => s.fmt === 'mp4' ? even(s.w) : s.w, outH = () => s.fmt === 'mp4' ? even(s.h) : s.h;
  const effFps = () => s.fmt === 'gif' ? Math.min(s.fps, 50) : s.fps; // GIF delays under 20ms are slowed down by browsers
  const frameCount = () => Math.max(1, Math.round((s.end - s.start) / s.speed * effFps()));
  const alpha = () => s.fmt !== 'mp4' && s.fit === 'contain' && s.bg === 'transparent';
  const persist = () => { try { localStorage.setItem('gif:settings', JSON.stringify(Object.fromEntries(KEYS.map(k => [k, s[k]])))); } catch {} };

  // ---------- crop frame (切り抜き): a rect in source px with the output's aspect ratio, kept inside the video
  const cropOn = () => s.v && (s.fit === 'cover' || s.lock);
  function getCrop(): Rect {
    const r = outW() / outH(), c = s.crop;
    let w = c ? Math.sqrt(c.w * c.h * r) : s.sw, h = w / r;
    const q = Math.min(1, s.sw / w, s.sh / h); w *= q; h *= q;
    const cx = c ? c.x + c.w / 2 : s.sw / 2, cy = c ? c.y + c.h / 2 : s.sh / 2;
    const x = Math.max(0, Math.min(s.sw - w, cx - w / 2)), y = Math.max(0, Math.min(s.sh - h, cy - h / 2));
    return { x, y, w, h };
  }

  // ---------- drawing
  function drawFit(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, W: number, H: number) {
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'high';
    if (cropOn()) { const c = getCrop(); ctx.drawImage(v, c.x, c.y, c.w, c.h, 0, 0, W, H); return; }
    if (!alpha()) { ctx.fillStyle = s.fmt === 'mp4' && s.bg === 'transparent' ? '#000000' : s.bg; ctx.fillRect(0, 0, W, H); }
    const k = Math.min(W / s.sw, H / s.sh), dw = s.sw * k, dh = s.sh * k;
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  function seek(t: number) {
    return new Promise<void>(res => {
      const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); res(); };
      const to = setTimeout(done, 3000);
      v.addEventListener('seeked', done); v.currentTime = Math.min(Math.max(0, t), Math.max(0, s.dur - 0.001));
    });
  }
  function drawPreview() {
    const c = pv.current; if (!s.v || !c) return;
    if (cropOn()) {
      // whole video, outside the frame dimmed
      const k = Math.min(1, 960 / Math.max(s.sw, s.sh)), pw = Math.max(1, Math.round(s.sw * k)), ph = Math.max(1, Math.round(s.sh * k));
      if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
      const ctx = c.getContext('2d')!, r = getCrop();
      ctx.imageSmoothingQuality = 'high'; ctx.drawImage(v, 0, 0, pw, ph);
      ctx.save(); ctx.globalAlpha = 0.7; ctx.fillStyle = getComputedStyle(c).getPropertyValue('--bg').trim() || '#000';
      ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.rect(r.x * k, r.y * k, r.w * k, r.h * k); ctx.fill('evenodd'); ctx.restore();
      return;
    }
    const W = outW(), H = outH(), k = Math.min(1, 960 / Math.max(W, H));
    const pw = Math.max(1, Math.round(W * k)), ph = Math.max(1, Math.round(H * k));
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    drawFit(c.getContext('2d')!, pw, ph);
  }
  const raf = useRef(0);
  function loopPreview() {
    if (v.paused) { raf.current = 0; return; }
    if (v.currentTime >= s.end || v.currentTime < s.start - 0.05) v.currentTime = s.start;
    drawPreview(); bump(); raf.current = requestAnimationFrame(loopPreview);
  }
  function setPlaying(on: boolean) {
    if (!s.v) return;
    if (on) { setView('src'); v.playbackRate = s.speed; if (v.currentTime < s.start || v.currentTime >= s.end) v.currentTime = s.start; v.play().then(() => { if (!raf.current) raf.current = requestAnimationFrame(loopPreview); }).catch(() => {}); }
    else v.pause();
  }
  // handlers read the latest closure through a ref
  const live = useRef({ drawPreview, bump }); live.current = { drawPreview, bump };
  useEffect(() => {
    const onPlay = () => live.current.bump();
    const onSeeked = () => { if (v.paused && !g.current.busy) { live.current.drawPreview(); live.current.bump(); } };
    v.addEventListener('play', onPlay); v.addEventListener('pause', onPlay); v.addEventListener('seeked', onSeeked);
    return () => { v.removeEventListener('play', onPlay); v.removeEventListener('pause', onPlay); v.removeEventListener('seeked', onSeeked); };
  }, [v]);
  useLayoutEffect(() => {
    const st = stageRef.current!;
    const ro = new ResizeObserver(() => { const cs = getComputedStyle(st); setAvail({ w: st.clientWidth - parseFloat(cs.paddingLeft) * 2, h: st.clientHeight - parseFloat(cs.paddingTop) * 2 }); });
    ro.observe(st); return () => ro.disconnect();
  }, []);
  useEffect(() => { if (active && s.v) drawPreview(); }, [active]);
  // Space plays / pauses the preview unless a field has focus
  const playRef = useRef(setPlaying); playRef.current = setPlaying;
  // Ctrl/Cmd+Z, Ctrl+Shift+Z / Ctrl+Y undo/redo the crop frame; arrows move it (Shift = 10px)
  const cropKey = (e: KeyboardEvent) => {
    if (!s.v || s.busy) return false;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'y') { cropUndo(k === 'y' || e.shiftKey); return true; }
      return false;
    }
    const m = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
    if (!m || !cropOn() || e.altKey) return false;
    const before = s.crop, c = getCrop(), q = e.shiftKey ? 10 : 1;
    s.crop = { ...c, x: Math.max(0, Math.min(s.sw - c.w, c.x + m[0] * q)), y: Math.max(0, Math.min(s.sh - c.h, c.y + m[1] * q)) };
    pushHist(before); setCrop(s.crop); return true;
  };
  const cropKeyRef = useRef(cropKey); cropKeyRef.current = cropKey;
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable)) return;
      if (cropKeyRef.current(e)) { e.preventDefault(); return; }
      if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (el instanceof HTMLButtonElement) el.blur(); // keep Space from also pressing the focused button
      if (!e.repeat && !g.current.busy) playRef.current(v.paused);
    };
    addEventListener('keydown', key); return () => removeEventListener('keydown', key);
  }, [active, v]);

  // ---------- crop editing: same gestures as image slices.
  // Drag inside = move, handles = resize, outside = draw a new frame. Alt / a 2nd finger anchors on the center.
  // Touch: drag starts after 8px, 2-finger tap = undo, 3-finger tap = redo.
  const hist = useRef({ u: [] as (Rect | null)[], r: [] as (Rect | null)[] });
  type CDrag = { id: number; type: 'new' | 'move' | 'resize'; h?: string; o: Rect; p: { x: number; y: number }; before: Rect | null };
  const cdrag = useRef<CDrag | null>(null), pend = useRef<{ id: number; target: Element; p: { x: number; y: number } } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>()).current;
  const gest = useRef({ max: 0, t0: 0, moved: false, cancel: false });
  function setCrop(c: Rect | null) { s.crop = c; clearResult(); drawPreview(); bump(); }
  function pushHist(before: Rect | null) {
    const a = before ? JSON.stringify(before) : '', b = s.crop ? JSON.stringify(s.crop) : '';
    if (a !== b) { hist.current.u.push(before); hist.current.r = []; }
  }
  function cropUndo(redo = false) {
    const h = hist.current, from = redo ? h.r : h.u, to = redo ? h.u : h.r;
    if (!from.length || !s.v) return;
    to.push(s.crop); setCrop(from.pop()!);
  }
  const cpt = (e: { clientX: number; clientY: number }) => { const r = pv.current!.getBoundingClientRect(), q = r.width / s.sw; return { x: (e.clientX - r.left) / q, y: (e.clientY - r.top) / q }; };
  function cStart(id: number, target: Element, p: { x: number; y: number }) {
    const hd = target.closest<HTMLElement>('.hd'), o = getCrop(), before = s.crop;
    v.pause();
    if (hd) cdrag.current = { id, type: 'resize', h: hd.dataset.h, o, p, before };
    else if (target.closest('.sr')) cdrag.current = { id, type: 'move', o, p, before };
    else cdrag.current = { id, type: 'new', o: { x: Math.max(0, Math.min(s.sw, p.x)), y: Math.max(0, Math.min(s.sh, p.y)), w: 0, h: 0 }, p, before };
  }
  function cDown(e: RPointerEvent<HTMLDivElement>) {
    if (!cropOn() || s.busy || (s.view === 'res' && s.result)) return;
    const touch = e.pointerType === 'touch';
    if (touch) {
      if (!touches.size) gest.current = { max: 0, t0: performance.now(), moved: false, cancel: false };
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); gest.current.max = Math.max(gest.current.max, touches.size);
      e.currentTarget.setPointerCapture(e.pointerId);
      if (touches.size === 1 && !cdrag.current) pend.current = { id: e.pointerId, target: e.target as Element, p: cpt(e) };
      e.preventDefault(); return;
    }
    if (e.button !== 0) return;
    cStart(e.pointerId, e.target as Element, cpt(e));
    e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault();
  }
  function cMove(e: RPointerEvent<HTMLDivElement>) {
    const t0 = touches.get(e.pointerId);
    if (t0 && Math.hypot(e.clientX - t0.x, e.clientY - t0.y) > 8) {
      gest.current.moved = true;
      const pd = pend.current; if (pd && pd.id === e.pointerId) { pend.current = null; cStart(pd.id, pd.target, pd.p); }
    }
    const g = cdrag.current; if (!g || g.id !== e.pointerId) return;
    const center = e.altKey || touches.size >= 2, r = outW() / outH(), p = cpt(e), o = g.o, SW = s.sw, SH = s.sh;
    if (g.type === 'move') {
      setCrop({ ...o, x: Math.max(0, Math.min(SW - o.w, o.x + p.x - g.p.x)), y: Math.max(0, Math.min(SH - o.h, o.y + p.y - g.p.y)) });
      return;
    }
    // anchor point and the directions the frame grows in from it
    let ax: number, ay: number, sx: number, sy: number, mode: 'xy' | 'x' | 'y';
    if (g.type === 'new') {
      ax = o.x; ay = o.y; sx = p.x < ax ? -1 : 1; sy = p.y < ay ? -1 : 1; mode = 'xy';
      if (center) { sx = sy = 0; }
    } else {
      const h = g.h!;
      sx = h.includes('w') ? -1 : h.includes('e') ? 1 : 0; sy = h.includes('n') ? -1 : h.includes('s') ? 1 : 0;
      mode = sx && sy ? 'xy' : sx ? 'x' : 'y';
      ax = sx < 0 ? o.x + o.w : sx > 0 ? o.x : o.x + o.w / 2; ay = sy < 0 ? o.y + o.h : sy > 0 ? o.y : o.y + o.h / 2;
      if (center) { ax = o.x + o.w / 2; ay = o.y + o.h / 2; sx = sy = 0; }
    }
    // wanted size from the pointer, aspect locked
    const fx = sx ? Math.abs(p.x - ax) : 2 * Math.abs(p.x - ax), fy = sy ? Math.abs(p.y - ay) : 2 * Math.abs(p.y - ay);
    let w = mode === 'x' ? fx : mode === 'y' ? fy * r : Math.max(fx, fy * r);
    // largest size that stays inside the video from this anchor
    const lx = sx < 0 ? ax : sx > 0 ? SW - ax : 2 * Math.min(ax, SW - ax), ly = sy < 0 ? ay : sy > 0 ? SH - ay : 2 * Math.min(ay, SH - ay);
    w = Math.max(Math.min(w, lx, ly * r), 1); const h = w / r;
    if (g.type === 'new' && w < 2 && !s.crop) return;
    setCrop({ x: sx < 0 ? ax - w : sx > 0 ? ax : ax - w / 2, y: sy < 0 ? ay - h : sy > 0 ? ay : ay - h / 2, w, h });
  }
  function cUp(e: RPointerEvent<HTMLDivElement>) {
    if (touches.delete(e.pointerId)) {
      if (e.type === 'pointercancel') gest.current.cancel = true;
      if (pend.current?.id === e.pointerId) pend.current = null;
      const gs = gest.current;
      if (!touches.size && gs.max >= 2 && !gs.moved && !gs.cancel && performance.now() - gs.t0 < 500) cropUndo(gs.max !== 2);
    }
    const g = cdrag.current; if (!g || g.id !== e.pointerId) return;
    cdrag.current = null;
    if (s.crop && s.crop.w < 2) s.crop = g.before;
    pushHist(g.before); setCrop(s.crop);
  }

  // ---------- timeline
  async function makeThumbs() {
    const c = thumbs.current!, tr = track.current!, dpr = devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(tr.clientWidth * dpr)); c.height = Math.max(1, Math.round(tr.clientHeight * dpr));
    const ctx = c.getContext('2d')!, th = c.height, tw = Math.max(1, Math.round(th * s.sw / s.sh)), n = Math.max(1, Math.ceil(c.width / tw));
    const tv = document.createElement('video'); tv.muted = true; tv.preload = 'auto'; tv.src = s.url;
    await new Promise(r => { tv.onloadeddata = r; tv.onerror = r; });
    for (let i = 0; i < n; i++) {
      await new Promise<void>(r => { const to = setTimeout(r, 2000); tv.onseeked = () => { clearTimeout(to); r(); }; tv.currentTime = Math.min(s.dur - 0.01, (i + 0.5) * s.dur / n); });
      try { ctx.drawImage(tv, i * tw, 0, tw, th); } catch {}
    }
    tv.removeAttribute('src'); tv.load();
  }
  // Scrubbing: only one seek in flight; later pointer moves overwrite the target, UI updates once per frame.
  const sk = useRef({ want: null as number | null, seeking: false, uiRaf: 0, drag: null as null | 'start' | 'end' | 'head', rect: null as DOMRect | null });
  async function pumpSeek() {
    const q = sk.current; q.seeking = true;
    while (q.want !== null) { const t = q.want; q.want = null; await seek(t); }
    q.seeking = false;
  }
  function scrub(t: number) { scrubT.current = t; sk.current.want = t; if (!sk.current.seeking) pumpSeek(); }
  function scheduleUi() { const q = sk.current; if (!q.uiRaf) q.uiRaf = requestAnimationFrame(() => { q.uiRaf = 0; bump(); }); }
  const tAt = (e: { clientX: number }) => { const r = sk.current.rect!; return Math.max(0, Math.min(s.dur, (e.clientX - r.left) / r.width * s.dur)); };
  function trackDown(e: RPointerEvent<HTMLDivElement>) {
    if (!s.dur || s.busy) return;
    const q = sk.current; q.rect = e.currentTarget.getBoundingClientRect();
    const t = tAt(e), px = s.dur / q.rect.width * 12;
    q.drag = Math.abs(t - s.start) < px ? 'start' : Math.abs(t - s.end) < px ? 'end' : 'head';
    v.pause(); clearResult();
    e.currentTarget.setPointerCapture(e.pointerId); trackMove(e);
  }
  function trackMove(e: { clientX: number }) {
    const q = sk.current; if (!q.drag) return;
    const t = tAt(e), min = 1 / Math.max(effFps(), 1);
    if (q.drag === 'start') { s.start = Math.min(t, s.end - min); scrub(s.start); }
    else if (q.drag === 'end') { s.end = Math.max(t, s.start + min); scrub(s.end); }
    else scrub(t);
    scheduleUi();
  }
  async function trackUp() {
    const q = sk.current; if (!q.drag) return;
    const d = q.drag; q.drag = null;
    if (d !== 'head') persist();
    while (q.seeking) await new Promise(r => setTimeout(r, 16));
    scrubT.current = null; bump();
  }

  // ---------- inspector
  function lockFromW() { if (s.lock && s.sw) s.h = Math.max(1, Math.round(s.w * s.sh / s.sw)); }
  function changed(custom = true) { if (custom) s.tpl = 'custom'; clearResult(); persist(); drawPreview(); bump(); }
  function applyTemplate(id: string) {
    const t = TEMPLATES.find(x => x.id === id); s.tpl = id; if (!t || id === 'custom') return changed(false);
    for (const k of ['fmt', 'w', 'h', 'lock', 'fit', 'target', 'fps'] as const) if (t[k] !== undefined) (s as any)[k] = t[k];
    if (t.h === undefined) lockFromW();
    if (s.fmt === 'mp4' && s.bg === 'transparent') s.bg = '#000000';
    changed(false);
  }
  const num = (k: 'w' | 'h' | 'fps' | 'target' | 'q' | 'start' | 'end', f: (v: number) => number) => (text: string) => {
    const val = +text; if (text === '' && k !== 'target') return; if (!isFinite(val)) return; s[k] = f(val); changed();
  };

  // ---------- result / compare
  function clearResult() {
    if (s.resUrl) URL.revokeObjectURL(s.resUrl);
    s.result = null; s.resUrl = ''; setKeep(false);
    if (s.view === 'res') setView('src');
  }
  const [keep, setKeep] = useState(false);
  function setView(view: 'src' | 'res') { s.view = view; if (view === 'res') v.pause(); bump(); }
  function showResult(blob: Blob) {
    if (s.resUrl) URL.revokeObjectURL(s.resUrl);
    s.result = blob; s.resUrl = URL.createObjectURL(blob);
    setView('res');
  }
  const outName = () => s.name.replace(/\.[^.]+$/, '') + '.' + s.fmt;
  async function saveResult() {
    if (!s.result) return;
    const r = await saveBlob(outName(), s.result);
    if (r === 'ok') status(`${fmtMB(s.result.size)} を書き出し`, 'ok'); else status(saveFailText(r));
  }
  const showRes = s.view === 'res' && !!s.result;
  useEffect(() => { const rv = resV.current!; if (showRes && s.fmt === 'mp4') rv.play().catch(() => {}); else rv.pause(); });

  // ---------- frame capture
  async function captureFrames(W: number, H: number, onFrame: (i: number, n: number, c: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D) => void | Promise<void>) {
    const n = frameCount(), fps = effFps(), c = new OffscreenCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true })!;
    for (let i = 0; i < n; i++) {
      await seek(s.start + i * s.speed / fps);
      drawFit(ctx, W, H);
      await onFrame(i, n, c, ctx);
    }
  }
  async function grabRGBA(W: number, H: number) {
    const n = frameCount();
    if (n * W * H * 4 > MAX_BYTES) throw new Error('範囲が長すぎるかサイズが大きすぎます。範囲・サイズ・FPSを下げてください');
    const frames: Uint8ClampedArray[] = [];
    await captureFrames(W, H, (i, n, _c, ctx) => { status(`フレーム取得 ${i + 1}/${n}`); frames.push(ctx.getImageData(0, 0, W, H).data); });
    return frames;
  }

  // ---------- export with target size search
  async function doExport() {
    if (!s.v || s.busy) return;
    s.busy = true; v.pause(); clearResult(); bump();
    const W = outW(), H = outH(), target = s.target ? s.target * 1048576 : 0;
    const eo: EncodeOpts = { fps: effFps(), loop: s.loop, useAlpha: alpha() };
    try {
      let best: Blob | null = null;
      if (s.fmt === 'mp4') best = await encodeMp4(W, H, effFps(), frameCount(), s.target, cb => captureFrames(W, H, (i, n, c) => cb(i, n, c)), t => status(t));
      else {
        if (s.fmt === 'webp' && !webpOK) throw new Error('このブラウザはWebP書き出しに対応していません');
        const frames = await grabRGBA(W, H);
        // per spec: keep px, lower colors / quality first, then drop frames
        const levels = s.fmt === 'gif'
          ? [256, 128, 64, 32, 16].filter(c => c <= s.colors)
          : [s.q, 70, 55, 40, 25, 10].filter((q, i) => i === 0 || q < s.q);
        const steps = target ? [1, 2, 3] : [1];
        let tries = 0;
        search: for (const step of steps) for (const lv of target ? levels : levels.slice(0, 1)) {
          if (frames.length / step < 2 && step > 1) break search;
          tries++; status(`${s.fmt === 'gif' ? 'GIF' : 'WebP'}作成 ${tries}回目`);
          const b = s.fmt === 'gif' ? await encodeGif(frames, W, H, lv, step, eo) : await encodeWebp(frames, W, H, lv / 100, step, eo, t => status(t));
          if (!best || b.size < best.size) best = b;
          if (!target || b.size <= target) { best = b; break search; }
        }
      }
      showResult(best!);
      if (target && best!.size > target) { status(`目標 ${s.target} MB に届きません（最小 ${fmtMB(best!.size)}）`, 'warn'); setKeep(true); }
      else await saveResult();
    } catch (e: any) { status(String(e.message || e), 'err'); }
    finally { s.busy = false; drawPreview(); bump(); }
  }

  // ---------- open
  async function open(file: File) {
    v.pause(); clearResult();
    if (s.url) URL.revokeObjectURL(s.url);
    s.url = URL.createObjectURL(file); s.name = file.name; v.src = s.url;
    try {
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('この動画は読み込めません')); });
      if (!isFinite(v.duration)) { v.currentTime = 1e9; await new Promise(r => v.addEventListener('seeked', r, { once: true })); }
      s.v = true; s.dur = v.duration; s.sw = v.videoWidth; s.sh = v.videoHeight; s.start = 0; s.end = Math.min(s.dur, 6); s.crop = null; hist.current = { u: [], r: [] };
      if (s.tpl === 'custom' && s.lock) { s.w = Math.min(s.w, s.sw); lockFromW(); }
      status('');
      bump();
      await seek(0); drawPreview(); bump();
      makeThumbs();
    } catch (e: any) { status(String(e.message || e), 'err'); }
  }
  useImperativeHandle(ref, () => ({ open }));

  // ---------- render
  const W = outW(), H = outH(), k = Math.min(avail.w / W, avail.h / H, 4);
  const box: CSSProperties | undefined = k > 0 ? { width: Math.floor(W * k) + 'px', height: Math.floor(H * k) + 'px' } : undefined;
  const crop = cropOn(), ck = crop ? Math.min(avail.w / s.sw, avail.h / s.sh, 4) : 0;
  const cbox: CSSProperties | undefined = ck > 0 ? { width: Math.floor(s.sw * ck) + 'px', height: Math.floor(s.sh * ck) + 'px' } : undefined;
  const cr = crop ? getCrop() : null, cq = ck > 0 ? Math.floor(s.sw * ck) / s.sw : 0;
  const show = showRes ? (s.fmt === 'mp4' ? 'v' : 'i') : 'pv';
  const p = (t: number) => (t / s.dur * 100) + '%';
  const tpl = TEMPLATES.find(x => x.id === s.tpl), n = frameCount();
  const fitHidden = s.lock && s.v, bgHidden = s.fit !== 'contain' || (s.lock && s.v);
  const sum = s.v ? <>
    {`${outW()}×${outH()} · ${n} フレーム · ${((s.end - s.start) / s.speed).toFixed(2)}秒`}
    {tpl?.maxFrames && n > tpl.maxFrames ? <> · <span className="warn">{`${tpl.maxFrames} フレームを超えています`}</span></> : null}
    {s.fmt === 'gif' && s.fps > 50 ? <> · <span className="warn">GIFは50fpsまで</span></> : null}
  </> : null;
  const playIcon = v.paused
    ? <svg width="10" height="12" viewBox="0 0 10 12"><path d="M1 1v10l8-5z" fill="currentColor" /></svg>
    : <svg width="10" height="12" viewBox="0 0 10 12"><path d="M1 1h3v10H1zM6 1h3v10H6z" fill="currentColor" /></svg>;
  const fieldBlur = () => bump();

  return (
    <section className="gif" id="gif">
      <main className="center" style={{ display: 'flex' }}>
        <div className={'stage' + (cr && show === 'pv' ? ' crop' : '')} id="gStage" ref={stageRef} onPointerDown={cDown} onPointerMove={cMove} onPointerUp={cUp} onPointerCancel={cUp}>
          <div className="cv" hidden={show !== 'pv' || !s.v}>
            <canvas id="gPv" ref={pv} width="1" height="1" style={crop ? cbox : box} />
            {cr && <div className="sl on" id="gCrop">
              <div className="sr sel" style={{ left: cr.x * cq + 'px', top: cr.y * cq + 'px', width: cr.w * cq + 'px', height: cr.h * cq + 'px' }}>
                {HANDLES.map(h => <i key={h} className="hd" data-h={h} style={{ left: (h.includes('w') ? 0 : h.includes('e') ? 100 : 50) + '%', top: (h.includes('n') ? 0 : h.includes('s') ? 100 : 50) + '%', cursor: h + '-resize' }} />)}
              </div>
            </div>}
          </div>
          <img id="gResI" alt="" hidden={show !== 'i' || !s.v} style={box} src={show === 'i' ? s.resUrl : undefined} />
          <video id="gResV" ref={resV} muted loop playsInline hidden={show !== 'v' || !s.v} style={box} src={s.fmt === 'mp4' && s.resUrl ? s.resUrl : undefined} />
          <span className="gempty" id="gEmpty" hidden={s.v}>動画をドロップ</span>
        </div>
        <div className="tl">
          <button className="play" id="gPlay" aria-label={v.paused ? '再生' : '停止'} onClick={() => setPlaying(v.paused)}>{playIcon}</button>
          <div className="track" id="gTrack" ref={track} onPointerDown={trackDown} onPointerMove={trackMove} onPointerUp={trackUp} onPointerCancel={trackUp}>
            <canvas id="gThumbs" ref={thumbs} />
            <div className="dim" id="gDimL" style={s.dur ? { left: '0', width: p(s.start) } : undefined} />
            <div className="dim" id="gDimR" style={s.dur ? { left: p(s.end), right: '0' } : undefined} />
            <div className="rng" id="gRng" style={s.dur ? { left: p(s.start), width: p(s.end - s.start) } : undefined} />
            <div className="ph2" id="gHead" style={s.dur ? { left: p(scrubT.current ?? v.currentTime) } : undefined} />
          </div>
          <span className="num" id="gTime">{s.dur ? `${s.start.toFixed(2)}–${s.end.toFixed(2)} / ${s.dur.toFixed(2)}s` : ''}</span>
        </div>
        <div className="status">
          <span id="gName">{s.v ? `${s.name}  ${s.sw}×${s.sh}` : ''}</span>
          {cr && <span id="gCropInfo" className="num">{`${Math.round(cr.w)}×${Math.round(cr.h)}  x${Math.round(cr.x)} y${Math.round(cr.y)}`}</span>}
          <span id="gOut" className="num" style={{ marginLeft: 'auto' }}>{s.result ? fmtMB(s.result.size) : ''}</span>
          <Seg id="gView" hidden={!s.result} value={s.view} options={[['src', '元'], ['res', '結果']]} onChange={setView} />
          <button className="link" id="gSave" hidden={!s.result} onClick={saveResult}>保存</button>
        </div>
      </main>
      <aside className="panel inspector" aria-label="GIF書き出し設定">
        <div className="insp">
          <div className="sec">
            <label className="prop" htmlFor="gTpl"><span>テンプレート</span><select id="gTpl" value={s.tpl} onChange={e => applyTemplate(e.target.value)}>{TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <div className="prop"><span>形式</span><Seg id="gFmt" value={s.fmt} options={[['gif', 'GIF'], ['webp', 'WebP'], ['mp4', 'MP4']]} onChange={f => { s.fmt = f; if (f === 'mp4' && s.bg === 'transparent') s.bg = '#000000'; changed(); }} /></div>
          </div>
          <div className="sec">
            <div className="prop"><span>幅</span><span className="unit"><DraftInput id="gW" className="n" type="number" min="16" max="4096" value={s.w} onBlur={fieldBlur}
              onDraft={num('w', val => { const w = Math.max(1, Math.min(4096, Math.round(val))); s.w = w; lockFromW(); return w; })} />px</span></div>
            <div className="prop"><span>高さ</span><span className="unit"><DraftInput id="gH" className="n" type="number" min="16" max="4096" value={s.h} onBlur={fieldBlur}
              onDraft={num('h', val => { const h = Math.max(1, Math.min(4096, Math.round(val))); if (s.lock && s.sh) s.w = Math.max(1, Math.round(h * s.sw / s.sh)); return h; })} />px <button className="lock" id="gLock" aria-pressed={s.lock} title="縦横比を固定" onClick={() => { s.lock = !s.lock; lockFromW(); changed(); }}><svg width="12" height="12" viewBox="0 0 12 12"><path d="M5 7 7 5M4.2 5.4 3 6.6a2 2 0 0 0 2.8 2.8L7 8.2M7.8 6.6 9 5.4A2 2 0 0 0 6.2 2.6L5 3.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg></button></span></div>
            <div className="prop" id="gFitRow" hidden={fitHidden}><span>合わせ方</span><Seg id="gFit" value={s.fit} options={[['cover', '切り抜き'], ['contain', '余白']]} onChange={f => { s.fit = f; changed(); }} /></div>
            <div className="prop" id="gBgRow" hidden={bgHidden}><span>背景</span><Seg id="gBg" value={s.bg} options={[['transparent', '透明'], ['#000000', '黒'], ['#ffffff', '白']]} hiddenValues={s.fmt === 'mp4' ? ['transparent'] : []} onChange={b => { s.bg = b; changed(); }} /></div>
          </div>
          <div className="sec">
            <div className="prop"><span>範囲</span><span className="unit">
              <DraftInput id="gStart" className="n" type="number" min="0" step="0.01" aria-label="開始" value={s.start.toFixed(2)} onBlur={() => { fieldBlur(); seek(s.start); }}
                onDraft={num('start', val => Math.max(0, Math.min(val, s.end - 0.01)))} />–<DraftInput id="gEnd" className="n" type="number" min="0" step="0.01" aria-label="終了" value={s.end.toFixed(2)} onBlur={() => { fieldBlur(); seek(s.end); }}
                onDraft={num('end', val => Math.min(s.dur, Math.max(val, s.start + 0.01)))} />秒</span></div>
            <div className="prop"><span>FPS</span><span className="unit"><DraftInput id="gFps" className="n" type="number" min="1" max="60" value={s.fps} onBlur={fieldBlur} onDraft={num('fps', val => Math.max(1, Math.min(60, val)))} /></span></div>
            <label className="prop" htmlFor="gSpeed"><span>速度</span><select id="gSpeed" value={String(s.speed)} onChange={e => { s.speed = +e.target.value; v.playbackRate = s.speed; changed(); }}>{SPEEDS.map(x => <option key={x}>{x}</option>)}</select></label>
            <label className="prop" htmlFor="gLoop" id="gLoopRow" hidden={s.fmt === 'mp4'}><span>ループ</span><select id="gLoop" value={String(s.loop)} onChange={e => { s.loop = +e.target.value; changed(); }}><option value="0">無限</option><option value="1">1回</option><option value="2">2回</option><option value="3">3回</option></select></label>
          </div>
          <div className="sec">
            <div className="prop"><span>目標サイズ</span><span className="unit"><DraftInput id="gTarget" className="n" type="number" min="0" step="0.1" placeholder="なし" value={s.target || ''} onBlur={fieldBlur} onDraft={num('target', val => Math.max(0, val))} />MB</span></div>
            <label className="prop" htmlFor="gColors" id="gColorsRow" hidden={s.fmt !== 'gif'}><span>色数</span><select id="gColors" value={String(s.colors)} onChange={e => { s.colors = +e.target.value; changed(); }}>{['256', '128', '64', '32', '16'].map(x => <option key={x}>{x}</option>)}</select></label>
            <label className="prop" htmlFor="gQ" id="gQRow" hidden={s.fmt !== 'webp'}><span>画質</span><span className="unit"><DraftInput id="gQ" className="n" type="number" min="1" max="100" value={s.q} onBlur={fieldBlur} onDraft={num('q', val => Math.max(1, Math.min(100, Math.round(val))))} /></span></label>
            <div className="prop"><span>設定</span><span className="unit"><button className="link" id="gPLoad" onClick={() => presetRef.current!.click()}>読込</button><button className="link" id="gPSave"
              onClick={() => saveBlob('gif-preset.json', new Blob([JSON.stringify({ type: 'gif-preset', version: 1, ...Object.fromEntries(KEYS.map(k => [k, s[k]])) }, null, 2)], { type: 'application/json' }))}>保存</button>
              <input ref={presetRef} id="gPFile" type="file" accept=".json,application/json" hidden onChange={async e => {
                const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
                try { const j = JSON.parse(await f.text()); for (const k of KEYS) if (j[k] !== undefined) (s as any)[k] = j[k]; changed(); status('設定を読込', 'ok'); }
                catch { status('設定を読み込めません', 'err'); }
              }} /></span></div>
          </div>
        </div>
        <div className="foot">
          <div className="sumrow"><span id="gSum" className="num">{sum}</span><span id="gStatus" className="muted"><StatusText s={statusLine} /></span></div>
          <div className="act"><button className="link" id="gKeep" hidden={!keep} onClick={() => { setKeep(false); saveResult(); }}>このまま保存</button><button className="btn primary" id="gExport" style={{ marginLeft: 'auto' }} disabled={!s.v || s.busy} onClick={doExport}>書き出し</button></div>
        </div>
      </aside>
    </section>
  );
}
