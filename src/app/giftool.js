// GIF / animated WebP / MP4 export from a video, GifGun-style. Self-contained: needs only the page's
// saveBlob() and the markup in #gif. Encoders: gifenc (GIF), canvas WebP frames muxed into an
// animated WebP here, WebCodecs + mp4-muxer (MP4).
import { saveBlob } from './save.js';

export const GifTool = (() => {
  const $ = id => document.getElementById(id);
  const TEMPLATES = [
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
  const KEYS = ['fmt', 'w', 'h', 'lock', 'fit', 'bg', 'fps', 'speed', 'loop', 'target', 'colors', 'q'];
  const g = { fmt: 'gif', w: 480, h: 270, lock: true, fit: 'cover', bg: '#000000', fps: 15, speed: 1, loop: 0, target: 0, colors: 256, q: 80, tpl: 'custom',
    v: null, name: '', url: '', dur: 0, sw: 0, sh: 0, start: 0, end: 0, result: null, resUrl: '', view: 'src', busy: false };
  const vid = document.createElement('video'); vid.muted = true; vid.playsInline = true; vid.preload = 'auto';
  const MAX_BYTES = 1.2e9; // decoded RGBA kept in memory for GIF/WebP

  try { Object.assign(g, JSON.parse(localStorage.getItem('gif:settings') || '{}')); } catch {}
  const persist = () => { try { localStorage.setItem('gif:settings', JSON.stringify(Object.fromEntries(KEYS.map(k => [k, g[k]])))); } catch {} };
  const status = (html, cls) => { $('gStatus').innerHTML = cls ? `<span class="${cls}">${html}</span>` : html; };
  const fmtMB = b => (b / 1048576).toFixed(b < 1048576 * 10 ? 2 : 1) + ' MB';
  const even = n => Math.max(2, Math.round(n / 2) * 2);
  const outW = () => g.fmt === 'mp4' ? even(g.w) : g.w, outH = () => g.fmt === 'mp4' ? even(g.h) : g.h;
  const effFps = () => g.fmt === 'gif' ? Math.min(g.fps, 50) : g.fps; // GIF delays under 20ms are slowed down by browsers
  const frameCount = () => Math.max(1, Math.round((g.end - g.start) / g.speed * effFps()));
  const alpha = () => g.fmt !== 'mp4' && g.fit === 'contain' && g.bg === 'transparent';

  // ---------- libraries (loaded on first export)
  let gifLib, muxLib;
  const loadGif = () => gifLib ||= import('gifenc');
  const loadMux = () => muxLib ||= import('mp4-muxer');

  // ---------- drawing
  function drawFit(ctx, src, W, H) {
    ctx.clearRect(0, 0, W, H);
    if (g.fit === 'contain' && !alpha()) { ctx.fillStyle = g.fmt === 'mp4' && g.bg === 'transparent' ? '#000000' : g.bg; ctx.fillRect(0, 0, W, H); }
    const k = g.fit === 'cover' ? Math.max(W / g.sw, H / g.sh) : Math.min(W / g.sw, H / g.sh);
    const dw = g.sw * k, dh = g.sh * k;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  function seek(t) {
    return new Promise(res => {
      const done = () => { clearTimeout(to); vid.removeEventListener('seeked', done); res(); };
      const to = setTimeout(done, 3000);
      vid.addEventListener('seeked', done); vid.currentTime = Math.min(Math.max(0, t), Math.max(0, g.dur - 0.001));
    });
  }

  // ---------- preview
  const pv = $('gPv'), pctx = pv.getContext('2d');
  function fit() {
    const st = $('gStage'), cs = getComputedStyle(st), aw = st.clientWidth - parseFloat(cs.paddingLeft) * 2, ah = st.clientHeight - parseFloat(cs.paddingTop) * 2;
    const show = g.view === 'res' && g.result ? (g.fmt === 'mp4' ? $('gResV') : $('gResI')) : pv;
    const W = outW(), H = outH(), k = Math.min(aw / W, ah / H, 4);
    if (!(k > 0)) return;
    for (const el of [pv, $('gResI'), $('gResV')]) { el.style.width = Math.floor(W * k) + 'px'; el.style.height = Math.floor(H * k) + 'px'; el.hidden = el !== show || !g.v; }
    if (g.view === 'res' && g.result && g.fmt === 'mp4') $('gResV').play().catch(() => {});
    else $('gResV').pause();
  }
  function drawPreview() {
    if (!g.v) return;
    const W = outW(), H = outH(), k = Math.min(1, 960 / Math.max(W, H));
    const pw = Math.max(1, Math.round(W * k)), ph = Math.max(1, Math.round(H * k));
    if (pv.width !== pw || pv.height !== ph) { pv.width = pw; pv.height = ph; fit(); }
    drawFit(pctx, vid, pw, ph);
  }
  let raf = 0;
  function loopPreview() {
    if (vid.paused) { raf = 0; return; }
    if (vid.currentTime >= g.end || vid.currentTime < g.start - 0.05) vid.currentTime = g.start;
    drawPreview(); renderTrack(); raf = requestAnimationFrame(loopPreview);
  }
  function setPlaying(on) {
    if (!g.v) return;
    if (on) { setView('src'); vid.playbackRate = g.speed; if (vid.currentTime < g.start || vid.currentTime >= g.end) vid.currentTime = g.start; vid.play().then(() => { if (!raf) raf = requestAnimationFrame(loopPreview); }).catch(() => {}); }
    else vid.pause();
  }
  vid.addEventListener('play', renderPlay); vid.addEventListener('pause', renderPlay);
  vid.addEventListener('seeked', () => { if (vid.paused && !g.busy) { drawPreview(); renderTrack(); } });
  function renderPlay() {
    $('gPlay').innerHTML = vid.paused
      ? '<svg width="10" height="12" viewBox="0 0 10 12"><path d="M1 1v10l8-5z" fill="currentColor"/></svg>'
      : '<svg width="10" height="12" viewBox="0 0 10 12"><path d="M1 1h3v10H1zM6 1h3v10H6z" fill="currentColor"/></svg>';
    $('gPlay').setAttribute('aria-label', vid.paused ? '再生' : '停止');
  }

  // ---------- timeline
  async function makeThumbs() {
    const c = $('gThumbs'), tr = $('gTrack'), dpr = devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(tr.clientWidth * dpr)); c.height = Math.max(1, Math.round(tr.clientHeight * dpr));
    const ctx = c.getContext('2d'), th = c.height, tw = Math.max(1, Math.round(th * g.sw / g.sh)), n = Math.max(1, Math.ceil(c.width / tw));
    const tv = document.createElement('video'); tv.muted = true; tv.preload = 'auto'; tv.src = g.url;
    await new Promise(r => { tv.onloadeddata = r; tv.onerror = r; });
    for (let i = 0; i < n; i++) {
      await new Promise(r => { const to = setTimeout(r, 2000); tv.onseeked = () => { clearTimeout(to); r(); }; tv.currentTime = Math.min(g.dur - 0.01, (i + 0.5) * g.dur / n); });
      try { ctx.drawImage(tv, i * tw, 0, tw, th); } catch {}
    }
    tv.removeAttribute('src'); tv.load();
  }
  function renderTrack() {
    if (!g.dur) { $('gTime').textContent = ''; return; }
    const p = t => (t / g.dur * 100) + '%';
    $('gDimL').style.left = '0'; $('gDimL').style.width = p(g.start);
    $('gDimR').style.left = p(g.end); $('gDimR').style.right = '0';
    $('gRng').style.left = p(g.start); $('gRng').style.width = p(g.end - g.start);
    $('gHead').style.left = p(scrubT ?? vid.currentTime);
    $('gTime').textContent = `${g.start.toFixed(2)}–${g.end.toFixed(2)} / ${g.dur.toFixed(2)}s`;
  }
  // Scrubbing: only one seek in flight; later pointer moves overwrite the target, UI updates once per frame.
  let scrubT = null, want = null, seeking = false, uiRaf = 0;
  async function pumpSeek() {
    seeking = true;
    while (want !== null) { const t = want; want = null; await seek(t); }
    seeking = false;
  }
  function scrub(t) { scrubT = t; want = t; if (!seeking) pumpSeek(); }
  function scheduleUi() { if (!uiRaf) uiRaf = requestAnimationFrame(() => { uiRaf = 0; renderTrack(); renderInputs(); }); }
  (() => {
    const tr = $('gTrack'); let drag = null, rect = null;
    const tAt = e => Math.max(0, Math.min(g.dur, (e.clientX - rect.left) / rect.width * g.dur));
    tr.addEventListener('pointerdown', e => {
      if (!g.dur || g.busy) return;
      rect = tr.getBoundingClientRect();
      const t = tAt(e), px = g.dur / rect.width * 12;
      drag = Math.abs(t - g.start) < px ? 'start' : Math.abs(t - g.end) < px ? 'end' : 'head';
      vid.pause(); clearResult();
      tr.setPointerCapture(e.pointerId); move(e);
    });
    const move = e => {
      if (!drag) return;
      const t = tAt(e), min = 1 / Math.max(effFps(), 1);
      if (drag === 'start') { g.start = Math.min(t, g.end - min); scrub(g.start); }
      else if (drag === 'end') { g.end = Math.max(t, g.start + min); scrub(g.end); }
      else scrub(t);
      scheduleUi();
    };
    tr.addEventListener('pointermove', move);
    const up = async () => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d !== 'head') persist();
      while (seeking) await new Promise(r => setTimeout(r, 16));
      scrubT = null; renderTrack();
    };
    tr.addEventListener('pointerup', up); tr.addEventListener('pointercancel', up);
  })();

  // ---------- inspector
  function renderInputs() {
    const tpl = $('gTpl'); if (!tpl.options.length) for (const t of TEMPLATES) tpl.append(new Option(t.name, t.id));
    tpl.value = g.tpl;
    for (const [id, k] of [['gFmt', 'fmt'], ['gFit', 'fit'], ['gBg', 'bg']]) $(id).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === String(g[k])));
    const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
    set('gW', g.w); set('gH', g.h); set('gFps', g.fps); set('gStart', g.start.toFixed(2)); set('gEnd', g.end.toFixed(2)); set('gTarget', g.target || ''); set('gQ', g.q);
    $('gSpeed').value = String(g.speed); $('gLoop').value = String(g.loop); $('gColors').value = String(g.colors);
    $('gLock').setAttribute('aria-pressed', g.lock);
    $('gFitRow').hidden = g.lock && !!g.v; $('gBgRow').hidden = g.fit !== 'contain' || (g.lock && !!g.v);
    $('gBgT').hidden = g.fmt === 'mp4';
    $('gLoopRow').hidden = g.fmt === 'mp4'; $('gColorsRow').hidden = g.fmt !== 'gif'; $('gQRow').hidden = g.fmt !== 'webp';
    renderSummary();
  }
  function renderSummary() {
    if (!g.v) { $('gSum').textContent = ''; $('gExport').disabled = true; return; }
    const n = frameCount(), t = TEMPLATES.find(x => x.id === g.tpl);
    let s = `${outW()}×${outH()} · ${n} フレーム · ${((g.end - g.start) / g.speed).toFixed(2)}秒`;
    if (t && t.maxFrames && n > t.maxFrames) s += ` · <span class="warn">${t.maxFrames} フレームを超えています</span>`;
    if (g.fmt === 'gif' && g.fps > 50) s += ' · <span class="warn">GIFは50fpsまで</span>';
    $('gSum').innerHTML = s; $('gExport').disabled = g.busy;
  }
  function lockFromW() { if (g.lock && g.sw) g.h = Math.max(1, Math.round(g.w * g.sh / g.sw)); }
  function changed(custom = true) { if (custom) g.tpl = 'custom'; clearResult(); persist(); renderInputs(); drawPreview(); fit(); }
  function applyTemplate(id) {
    const t = TEMPLATES.find(x => x.id === id); g.tpl = id; if (!t || id === 'custom') return changed(false);
    for (const k of ['fmt', 'w', 'h', 'lock', 'fit', 'target', 'fps']) if (t[k] !== undefined) g[k] = t[k];
    if (t.h === undefined) lockFromW();
    if (g.fmt === 'mp4' && g.bg === 'transparent') g.bg = '#000000';
    changed(false);
  }
  const segs = [['gFmt', 'fmt'], ['gFit', 'fit'], ['gBg', 'bg']];
  for (const [id, k] of segs) $(id).querySelectorAll('button').forEach(b => b.onclick = () => { g[k] = b.dataset.v; if (k === 'fmt' && g.fmt === 'mp4' && g.bg === 'transparent') g.bg = '#000000'; changed(); });
  $('gTpl').onchange = () => applyTemplate($('gTpl').value);
  const num = (id, k, f) => $(id).oninput = () => { const v = +$(id).value; if ($(id).value === '' && k !== 'target') return; if (!isFinite(v)) return; g[k] = f ? f(v) : v; changed(); };
  num('gW', 'w', v => { const w = Math.max(1, Math.min(4096, Math.round(v))); g.w = w; lockFromW(); return w; });
  num('gH', 'h', v => { const h = Math.max(1, Math.min(4096, Math.round(v))); if (g.lock && g.sh) g.w = Math.max(1, Math.round(h * g.sw / g.sh)); return h; });
  num('gFps', 'fps', v => Math.max(1, Math.min(60, v)));
  num('gTarget', 'target', v => Math.max(0, v));
  num('gQ', 'q', v => Math.max(1, Math.min(100, Math.round(v))));
  num('gStart', 'start', v => Math.max(0, Math.min(v, g.end - 0.01)));
  num('gEnd', 'end', v => Math.min(g.dur, Math.max(v, g.start + 0.01)));
  for (const id of ['gW', 'gH', 'gFps', 'gStart', 'gEnd', 'gTarget', 'gQ']) $(id).addEventListener('blur', renderInputs);
  $('gStart').addEventListener('change', () => seek(g.start)); $('gEnd').addEventListener('change', () => seek(g.end));
  $('gSpeed').onchange = () => { g.speed = +$('gSpeed').value; vid.playbackRate = g.speed; changed(); };
  $('gLoop').onchange = () => { g.loop = +$('gLoop').value; changed(); };
  $('gColors').onchange = () => { g.colors = +$('gColors').value; changed(); };
  $('gLock').onclick = () => { g.lock = !g.lock; lockFromW(); changed(); };
  $('gPlay').onclick = () => setPlaying(vid.paused);
  $('gPSave').onclick = () => saveBlob('gif-preset.json', new Blob([JSON.stringify({ type: 'gif-preset', version: 1, ...Object.fromEntries(KEYS.map(k => [k, g[k]])) }, null, 2)], { type: 'application/json' }));
  $('gPLoad').onclick = () => $('gPFile').click();
  $('gPFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const j = JSON.parse(await f.text()); for (const k of KEYS) if (j[k] !== undefined) g[k] = j[k]; changed(); status('設定を読込', 'ok'); }
    catch { status('設定を読み込めません', 'err'); }
  };

  // ---------- result / compare
  function clearResult() {
    if (g.resUrl) URL.revokeObjectURL(g.resUrl);
    g.result = null; g.resUrl = ''; $('gView').hidden = true; $('gSave').hidden = true; $('gKeep').hidden = true; $('gOut').textContent = '';
    if (g.view === 'res') setView('src');
  }
  function setView(v) {
    g.view = v; $('gView').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v));
    if (v === 'res') vid.pause();
    fit();
  }
  $('gView').querySelectorAll('button').forEach(b => b.onclick = () => setView(b.dataset.v));
  function showResult(blob) {
    if (g.resUrl) URL.revokeObjectURL(g.resUrl);
    g.result = blob; g.resUrl = URL.createObjectURL(blob);
    if (g.fmt === 'mp4') { $('gResV').src = g.resUrl; } else { $('gResI').src = g.resUrl; }
    $('gOut').textContent = fmtMB(blob.size); $('gView').hidden = false; $('gSave').hidden = false;
    setView('res');
  }
  const outName = () => g.name.replace(/\.[^.]+$/, '') + '.' + g.fmt;
  async function saveResult() { if (g.result && await saveBlob(outName(), g.result)) status(`${fmtMB(g.result.size)} を書き出し`, 'ok'); }
  $('gSave').onclick = saveResult;
  $('gKeep').onclick = () => { $('gKeep').hidden = true; saveResult(); };

  // ---------- frame capture
  async function captureFrames(W, H, onFrame) {
    const n = frameCount(), fps = effFps(), c = new OffscreenCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true });
    for (let i = 0; i < n; i++) {
      await seek(g.start + i * g.speed / fps);
      drawFit(ctx, vid, W, H);
      await onFrame(i, n, c, ctx);
    }
  }
  async function grabRGBA(W, H) {
    const n = frameCount();
    if (n * W * H * 4 > MAX_BYTES) throw new Error('範囲が長すぎるかサイズが大きすぎます。範囲・サイズ・FPSを下げてください');
    const frames = [];
    await captureFrames(W, H, (i, n, c, ctx) => { status(`フレーム取得 ${i + 1}/${n}`); frames.push(ctx.getImageData(0, 0, W, H).data); });
    return frames;
  }

  // ---------- GIF
  async function encodeGif(frames, W, H, colors, step) {
    const { GIFEncoder, quantize, applyPalette } = await loadGif();
    const useAlpha = alpha(), fps = effFps(), delay = 1000 / fps * step;
    const pick = frames.filter((_, i) => i % step === 0);
    // one global palette from a sample of frames keeps colors stable and the file small
    const sampleN = Math.min(pick.length, 8), per = Math.max(1, Math.floor(W * H / 60000));
    const sample = new Uint8ClampedArray(sampleN * Math.ceil(W * H / per) * 4); let o = 0;
    for (let s = 0; s < sampleN; s++) { const f = pick[Math.floor(s * pick.length / sampleN)]; for (let p = 0; p < W * H; p += per) { sample.set(f.subarray(p * 4, p * 4 + 4), o); o += 4; } }
    const fmt = useAlpha ? 'rgba4444' : 'rgb565';
    const pal = quantize(sample.subarray(0, o), useAlpha ? colors : colors - 1, useAlpha ? { format: fmt, oneBitAlpha: true } : { format: fmt });
    let tIdx;
    if (useAlpha) { tIdx = pal.findIndex(c => c[3] === 0); if (tIdx < 0) { pal.push([0, 0, 0, 0]); tIdx = pal.length - 1; } }
    const full = useAlpha ? pal : pal.concat([[0, 0, 0]]); // extra entry = "unchanged" marker for frame deltas
    const enc = GIFEncoder(); let prev = null;
    for (let i = 0; i < pick.length; i++) {
      const idx = applyPalette(pick[i], pal, fmt);
      const opt = { palette: i === 0 ? full : undefined, delay, repeat: g.loop === 0 ? 0 : g.loop === 1 ? -1 : g.loop - 1 };
      if (useAlpha) Object.assign(opt, { transparent: true, transparentIndex: tIdx, dispose: 2 });
      else {
        const T = full.length - 1;
        if (prev) { const cur = idx.slice(); for (let p = 0; p < idx.length; p++) if (idx[p] === prev[p]) idx[p] = T; prev = cur; } else prev = idx.slice();
        if (i > 0) Object.assign(opt, { transparent: true, transparentIndex: T, dispose: 1 });
      }
      enc.writeFrame(idx, W, H, opt);
      if (i % 8 === 7) await new Promise(r => setTimeout(r));
    }
    enc.finish();
    return new Blob([enc.bytes()], { type: 'image/gif' });
  }

  // ---------- animated WebP (frames encoded by the browser, muxed here)
  const webpOK = (() => { try { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL('image/webp').startsWith('data:image/webp'); } catch { return false; } })();
  function riffChunks(u8) {
    const out = {}; let p = 12;
    while (p + 8 <= u8.length) { const id = String.fromCharCode(...u8.subarray(p, p + 4)), n = u8[p + 4] | u8[p + 5] << 8 | u8[p + 6] << 16 | u8[p + 7] << 24; out[id] = u8.subarray(p, p + 8 + n + (n & 1)); p += 8 + n + (n & 1); }
    return out;
  }
  function chunk(id, payload) {
    const n = payload.length, b = new Uint8Array(8 + n + (n & 1));
    for (let i = 0; i < 4; i++) b[i] = id.charCodeAt(i);
    b[4] = n & 255; b[5] = n >> 8 & 255; b[6] = n >> 16 & 255; b[7] = n >>> 24; b.set(payload, 8); return b;
  }
  const u24 = v => [v & 255, v >> 8 & 255, v >> 16 & 255];
  async function encodeWebp(frames, W, H, q, step) {
    const c = new OffscreenCanvas(W, H), ctx = c.getContext('2d'), fps = effFps(), dur = Math.round(1000 / fps * step);
    const parts = [];
    let i = 0;
    for (let f = 0; f < frames.length; f += step) {
      ctx.putImageData(new ImageData(frames[f], W, H), 0, 0);
      const u8 = new Uint8Array(await (await c.convertToBlob({ type: 'image/webp', quality: q })).arrayBuffer()), ch = riffChunks(u8);
      const data = ch['VP8 '] ? [ch.ALPH, ch['VP8 ']].filter(Boolean) : [ch.VP8L];
      const hdr = new Uint8Array([0, 0, 0, 0, 0, 0, ...u24(W - 1), ...u24(H - 1), ...u24(dur), 0b10]);
      const len = data.reduce((a, d) => a + d.length, hdr.length), pay = new Uint8Array(len); let o = 0;
      pay.set(hdr, o); o += hdr.length; for (const d of data) { pay.set(d, o); o += d.length; }
      parts.push(chunk('ANMF', pay));
      if (++i % 4 === 0) status(`WebP作成 ${f + 1}/${frames.length}`);
    }
    const vp8x = chunk('VP8X', new Uint8Array([0x02 | 0x10, 0, 0, 0, ...u24(W - 1), ...u24(H - 1)]));
    const loops = g.loop === 0 ? 0 : g.loop;
    const anim = chunk('ANIM', new Uint8Array([0, 0, 0, 0, loops & 255, loops >> 8]));
    const body = [vp8x, anim, ...parts], size = body.reduce((a, b) => a + b.length, 4);
    const head = new Uint8Array(12); head.set([82, 73, 70, 70, size & 255, size >> 8 & 255, size >> 16 & 255, size >>> 24, 87, 69, 66, 80]);
    return new Blob([head, ...body], { type: 'image/webp' });
  }

  // ---------- MP4 (H.264 via WebCodecs), streamed so long clips don't sit in memory
  async function encodeMp4(W, H) {
    if (typeof VideoEncoder === 'undefined') throw new Error('このブラウザはMP4書き出しに対応していません');
    const M = await loadMux(), fps = effFps(), n = frameCount(), secs = n / fps;
    const bitrate = g.target ? Math.max(100e3, g.target * 8 * 1048576 / secs * 0.95) : Math.max(1e6, Math.min(20e6, W * H * fps * 0.12));
    let config = null;
    for (const codec of ['avc1.640033', 'avc1.4d0033', 'avc1.42e033', 'avc1.640028', 'avc1.42e01f']) {
      const c = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } };
      try { if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; break; } } catch {}
    }
    if (!config) throw new Error('この解像度のMP4はこのブラウザで書き出せません');
    const muxer = new M.Muxer({ target: new M.ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H, frameRate: fps }, fastStart: 'in-memory' });
    let err = null;
    const enc = new VideoEncoder({ output: (ch, meta) => muxer.addVideoChunk(ch, meta), error: e => { err = e; } });
    enc.configure(config);
    await captureFrames(W, H, async (i, n, c) => {
      if (err) throw err;
      status(`MP4作成 ${i + 1}/${n}`);
      const fr = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(fr, { keyFrame: i % Math.round(fps * 2) === 0 }); fr.close();
      while (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 5));
    });
    await enc.flush(); if (err) throw err; enc.close(); muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }

  // ---------- export with target size search
  async function doExport() {
    if (!g.v || g.busy) return;
    g.busy = true; vid.pause(); clearResult(); renderSummary(); $('gExport').disabled = true;
    const W = outW(), H = outH(), target = g.target ? g.target * 1048576 : 0;
    try {
      let best = null;
      if (g.fmt === 'mp4') best = await encodeMp4(W, H);
      else {
        if (g.fmt === 'webp' && !webpOK) throw new Error('このブラウザはWebP書き出しに対応していません');
        const frames = await grabRGBA(W, H);
        // per spec: keep px, lower colors / quality first, then drop frames
        const levels = g.fmt === 'gif'
          ? [256, 128, 64, 32, 16].filter(c => c <= g.colors)
          : [g.q, 70, 55, 40, 25, 10].filter((q, i) => i === 0 || q < g.q);
        const steps = target ? [1, 2, 3] : [1];
        let tries = 0;
        search: for (const step of steps) for (const lv of target ? levels : levels.slice(0, 1)) {
          if (frames.length / step < 2 && step > 1) break search;
          tries++; status(`${g.fmt === 'gif' ? 'GIF' : 'WebP'}作成 ${tries}回目`);
          const b = g.fmt === 'gif' ? await encodeGif(frames, W, H, lv, step) : await encodeWebp(frames, W, H, lv / 100, step);
          if (!best || b.size < best.size) best = b;
          if (!target || b.size <= target) { best = b; break search; }
        }
      }
      showResult(best);
      if (target && best.size > target) { status(`目標 ${g.target} MB に届きません（最小 ${fmtMB(best.size)}）`, 'warn'); $('gKeep').hidden = false; }
      else await saveResult();
    } catch (e) { status(String(e.message || e), 'err'); }
    finally { g.busy = false; renderSummary(); drawPreview(); }
  }
  $('gExport').onclick = doExport;

  // ---------- open
  async function open(file) {
    vid.pause(); clearResult();
    if (g.url) URL.revokeObjectURL(g.url);
    g.url = URL.createObjectURL(file); g.name = file.name; vid.src = g.url;
    try {
      await new Promise((res, rej) => { vid.onloadeddata = res; vid.onerror = () => rej(new Error('この動画は読み込めません')); });
      if (!isFinite(vid.duration)) { vid.currentTime = 1e9; await new Promise(r => vid.addEventListener('seeked', r, { once: true })); }
      g.v = true; g.dur = vid.duration; g.sw = vid.videoWidth; g.sh = vid.videoHeight; g.start = 0; g.end = Math.min(g.dur, 6);
      if (g.tpl === 'custom' && g.lock) { g.w = Math.min(g.w, g.sw); lockFromW(); }
      $('gEmpty').hidden = true; $('gName').textContent = `${file.name}  ${g.sw}×${g.sh}`;
      status('');
      await seek(0); renderInputs(); drawPreview(); fit(); renderTrack(); renderPlay();
      makeThumbs();
    } catch (e) { status(String(e.message || e), 'err'); }
  }
  $('gFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) open(f); };
  new ResizeObserver(() => { if (document.body.classList.contains('tool-gif')) fit(); }).observe($('gStage'));
  renderInputs(); renderPlay();
  return {
    open, isVideo: f => /^video\//.test(f.type) || /\.(mp4|webm|mov|m4v)$/i.test(f.name),
    shown: () => { fit(); if (g.v) drawPreview(); },
  };
})();
