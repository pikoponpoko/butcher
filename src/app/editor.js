// Image tool: PSD / .clip / image open, layer tree, slices, preview and export.
import { readPsd } from 'ag-psd';
import JSZip from 'jszip';
import * as PsdCore from '../core/psdcore';
import { readClip } from '../core/clipreader';
import { GifTool } from './giftool.js';
import { saveBlob } from './save.js';

const SAMPLES = ['01_normal_layers.psd', '02_multiple_folders.psd', '03_nested_folders.psd', '04_masks.psd', '05_clipping.psd', '06_blend_modes.psd'];
const WARN_JA = {
  effects: 'レイヤー効果は描画されません', adjustment: '調整レイヤーは適用されません', blendIf: 'ブレンド条件は適用されません',
  knockout: 'ノックアウトは適用されません', vectorMask: 'ベクトルマスクは適用されません', smartFilter: 'スマートフィルターは保存済みの画像を使用',
  noPixels: 'ピクセルデータがありません', vectorOnly: 'シェイプ・塗りつぶしの画像がありません', passThroughOpacity: '通過グループの不透明度は近似',
  specialFillOpacity: 'この描画モードの塗りは近似', specialOpacity: 'この描画モードの不透明度は近似', blendMode: '未対応の描画モード',
  maskFeather: 'マスクのぼかしは適用されません', artboard: 'アートボードの背景・切り抜きは適用されません',
  clipBlendUnverified: '合成モードは未検証（通常として処理）', clipMaskUnverified: 'CLIP STUDIOのマスクは未検証', clipOffset: 'レイヤーの位置情報は未検証',
  clipLayerType: 'この種類のレイヤーは未検証', clipLayout: 'タイル配置を読み取れません', clipPixelFormat: 'この色形式は未対応',
};
const st = { docs: [], cur: 0, sel: null, mode: 'folder', fmt: 'png', out: 'zip', size: 'orig', pane: 'layer' };
const $ = id => document.getElementById(id);

let sqlReady = null;
function ensureSQL() {
  if (!sqlReady) sqlReady = Promise.all([import('sql.js'), import('sql.js/dist/sql-wasm.wasm?url')])
    .then(([m, w]) => m.default({ locateFile: () => w.default }))
    .catch(e => { sqlReady = null; throw new Error('読み込み用ライブラリを取得できません'); });
  return sqlReady;
}
const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)$/i, SRC_RE = /\.(psd|psb|clip|png|jpe?g|webp|gif|bmp)$/i;
async function openFile(name, buf) {
  if (/\.clip$/i.test(name)) addDoc(name, await readClip(buf, await ensureSQL()));
  else if (IMG_RE.test(name)) {
    const bmp = await createImageBitmap(new Blob([buf])), c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0); const img = ctx.getImageData(0, 0, c.width, c.height);
    addDoc(name, { width: c.width, height: c.height, children: [], imageData: { width: c.width, height: c.height, data: img.data } });
    doc().isImage = true;
  } else addDoc(name, readPsd(buf, { useImageData: true }));
}
const nameOf = n => n._rename ?? n.name ?? '';
const pathOf = n => { const p = []; for (let q = n._parent; q; q = q._parent) p.unshift(nameOf(q)); return p; };
function loadPsd(name, buf) { addDoc(name, readPsd(buf, { useImageData: true })); }
function addDoc(name, psd) {
  let id = 0; const checked = new Set();
  (function tag(ch, par) { for (const n of ch || []) { n._id = ++id; n._parent = par; checked.add(n._id); tag(n.children, n); } })(psd.children, null);
  const doc = { name, psd, checked, warnCache: new Map(), slices: loadSlicesLocal(name, psd), sliceSel: null };
  st.docs.push(doc); st.cur = st.docs.length - 1; st.sel = null;
}
const doc = () => st.docs[st.cur];
const opts = () => ({ includeHidden: $('hidden').checked });

const ICON = {
  chev: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  eye: '<svg width="14" height="10" viewBox="0 0 14 10"><path d="M1 5c1.6-2.7 3.6-4 6-4s4.4 1.3 6 4c-1.6 2.7-3.6 4-6 4S2.6 7.7 1 5Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="5" r="1.8" fill="currentColor"/></svg>',
  eyeOff: '<svg width="14" height="10" viewBox="0 0 14 10"><path d="M1 5c1.6-2.7 3.6-4 6-4s4.4 1.3 6 4c-1.6 2.7-3.6 4-6 4S2.6 7.7 1 5Z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2 9 12 1" stroke="currentColor" stroke-width="1.2"/></svg>',
  folder: '<svg width="18" height="14" viewBox="0 0 18 14"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h4l1.5 2h7.5A1.5 1.5 0 0 1 17 4.5v7A1.5 1.5 0 0 1 15.5 13h-13A1.5 1.5 0 0 1 1 11.5Z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
};
const collapsed = new Set();
function renderTabs() {
  $('tabs').innerHTML = '';
  st.docs.forEach((d, i) => { const b = document.createElement('button'); b.className = 'tab'; b.role = 'tab'; b.textContent = d.name; b.title = d.name; b.setAttribute('aria-selected', i === st.cur); b.onclick = () => { st.cur = i; st.sel = null; renderAll(); }; $('tabs').append(b); });
}
function thumbOf(n) {
  if (n._thumb !== undefined) return n._thumb;
  n._thumb = null;
  const img = n.imageData; if (!img) return null;
  const s = document.createElement('canvas'); s.width = img.width; s.height = img.height;
  const d = img.data instanceof Uint8ClampedArray ? img.data : Uint8ClampedArray.from(img.data, v => v * 255 / PsdCore.depthMax(img.data));
  s.getContext('2d').putImageData(new ImageData(d, img.width, img.height), 0, 0);
  const c = document.createElement('canvas'); c.width = c.height = 52; const k = Math.min(52 / img.width, 52 / img.height);
  c.getContext('2d').drawImage(s, (52 - img.width * k) / 2, (52 - img.height * k) / 2, img.width * k, img.height * k);
  return (n._thumb = c.toDataURL());
}
function startRename(n, nm) {
  const inp = document.createElement('input'); inp.className = 'rn'; inp.value = nameOf(n); inp.setAttribute('aria-label', '名前');
  let done = false;
  const end = ok => { if (done) return; done = true; if (ok) { const v = inp.value.trim(); n._rename = v && v !== n.name ? v : undefined; } renderTree(); if (st.sel) renderPreview(); };
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') end(true); else if (e.key === 'Escape') end(false); };
  inp.onblur = () => end(true); inp.onclick = e => e.stopPropagation();
  nm.replaceWith(inp); inp.focus(); inp.select();
}
function renderTree() {
  const d = doc(), t = $('tree'); t.innerHTML = '';
  let total = 0;
  (function walk(ch, depth) {
    for (let i = ch.length - 1; i >= 0; i--) {
      const n = ch[i]; total++;
      const r = document.createElement('div'); r.className = 'row' + (n.hidden ? ' hid' : '') + (st.sel === n ? ' sel' : '');
      r.style.paddingLeft = (8 + depth * 14) + 'px';
      const eye = document.createElement('span'); eye.className = 'eye'; eye.innerHTML = n.hidden ? ICON.eyeOff : ICON.eye; eye.title = n.hidden ? '非表示' : '表示';
      const tw = document.createElement('button'); tw.className = 'tw' + (collapsed.has(n) ? ' closed' : ''); tw.setAttribute('aria-label', '開閉');
      if (n.children) { tw.innerHTML = ICON.chev; tw.onclick = e => { e.stopPropagation(); collapsed.has(n) ? collapsed.delete(n) : collapsed.add(n); renderTree(); }; } else tw.style.visibility = 'hidden';
      const th = document.createElement('span');
      if (n.children) { th.className = 'thumb folder'; th.innerHTML = ICON.folder; }
      else { th.className = 'thumb'; const u = thumbOf(n); if (u) { th.style.backgroundImage = `url(${u}), conic-gradient(var(--chk-b) 25%, transparent 0 50%, var(--chk-b) 0 75%, transparent 0)`; th.style.backgroundSize = 'contain, 6px 6px'; th.style.backgroundRepeat = 'no-repeat, repeat'; th.style.backgroundPosition = 'center, 0 0'; } }
      const nm = document.createElement('span'); nm.className = 'name' + (n._rename != null ? ' renamed' : ''); nm.textContent = nameOf(n) || '(名前なし)';
      if (n._rename != null) nm.title = `元の名前：${n.name || ''}`;
      nm.ondblclick = e => { e.stopPropagation(); startRename(n, nm); };
      r.append(eye, tw, th, nm);
      if (n.clipping) { const c = document.createElement('span'); c.className = 'tag'; c.textContent = 'クリップ'; r.append(c); }
      const bm = n.blendMode; if (bm && bm !== 'normal' && bm !== 'pass through') { const c = document.createElement('span'); c.className = 'tag'; c.textContent = bm; r.append(c); }
      const w = PsdCore.collectWarnings(n).filter(x => x !== 'text');
      if (w.length) { const c = document.createElement('span'); c.className = 'tag w'; c.textContent = '警告'; c.title = w.map(x => WARN_JA[x] || x).join('\n'); r.append(c); }
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'ck'; cb.checked = d.checked.has(n._id); cb.setAttribute('aria-label', '書き出し対象');
      cb.onclick = e => { e.stopPropagation(); const set = c => { (cb.checked ? d.checked.add(c._id) : d.checked.delete(c._id)); (c.children || []).forEach(set); }; set(n); renderTree(); renderSummary(); };
      r.append(cb);
      r.onclick = () => { st.sel = st.sel === n ? null : n; t.querySelectorAll('.row.sel').forEach(x => x.classList.remove('sel')); if (st.sel) r.classList.add('sel'); renderPreview(); };
      t.append(r);
      if (n.children && !collapsed.has(n)) walk(n.children, depth + 1);
    }
  })(d.psd.children || [], 0);
}

function toCanvas(rgba, W, H) { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0); return c; }
function renderNode(d, n) {
  if (!n && !(d.psd.children || []).length && d.psd.imageData) return { rgba: new Uint8ClampedArray(d.psd.imageData.data), W: d.psd.width, H: d.psd.height, warnings: [] };
  const r = n ? PsdCore.compositeNode(d.psd, n, opts()) : PsdCore.compositeDocument(d.psd, opts());
  return { rgba: PsdCore.toRGBA8(r.buf, r.W, r.H), W: r.W, H: r.H, warnings: r.warnings };
}
function renderPreview() {
  const d = doc(), n = st.sel;
  const t0 = performance.now();
  const r = renderNode(d, n);
  const ms = Math.round(performance.now() - t0);
  const src = toCanvas(r.rgba, r.W, r.H), pv = $('pv');
  pv.width = r.W; pv.height = r.H; pv.getContext('2d').drawImage(src, 0, 0); fitPreview();
  $('pvName').textContent = n ? [...pathOf(n), nameOf(n)].join(' / ') : `${d.name}  ${d.psd.width}×${d.psd.height}`;
  const bb = PsdCore.alphaBounds(r.rgba, r.W, r.H);
  $('pvSize').textContent = (bb ? `${bb.w}×${bb.h}  x${bb.x} y${bb.y}` : '空') + `  ${ms}ms`;
  renderSlices();
  const info = $('pvInfo'); info.innerHTML = '';
  const ws = dedupe(r.warnings.filter(w => w.type !== 'text'));
  info.hidden = !ws.length;
  $('pvState').innerHTML = ws.length ? `<span class="warn">警告 ${ws.length}</span>` : '<span class="ok">警告なし</span>';
  ws.forEach(w => { const e = document.createElement('div'); e.textContent = `${w.path}：${WARN_JA[w.type] || w.type}${w.detail ? `（${w.detail}）` : ''}`; info.append(e); });
}
function fitPreview() {
  const pv = $('pv'), s = $('stage'), cs = getComputedStyle(s);
  const aw = s.clientWidth - parseFloat(cs.paddingLeft) * 2, ah = s.clientHeight - parseFloat(cs.paddingTop) * 2;
  if (aw <= 0 || ah <= 0) return;
  // in slice mode, fit the union of the canvas and all slices so out-of-canvas slices stay visible
  let x0 = 0, y0 = 0, x1 = pv.width, y1 = pv.height;
  const d = doc();
  if (st.pane === 'slice' && d) for (const s of d.slices) { x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x + s.w); y1 = Math.max(y1, s.y + s.h); }
  const k = Math.min(aw / (x1 - x0), ah / (y1 - y0), 8);
  pv.style.width = Math.floor(pv.width * k) + 'px'; pv.style.height = Math.floor(pv.height * k) + 'px';
  pv.parentNode.style.transform = `translate(${Math.round(((pv.width - x1) - x0) * k / 2)}px, ${Math.round(((pv.height - y1) - y0) * k / 2)}px)`;
  renderSlices();
}
new ResizeObserver(() => fitPreview()).observe(document.getElementById('stage'));
function dedupe(ws) { const s = new Set(); return ws.filter(w => { const k = w.path + w.type; if (s.has(k)) return false; s.add(k); return true; }); }

function targetsOf(d) {
  const o = opts(), out = [];
  if (st.mode === 'slice') return d.slices.filter(s => s.on).map(s => ({ kind: 'slice', s, path: [] }));
  (function walk(ch, path) {
    for (let i = ch.length - 1; i >= 0; i--) {
      const n = ch[i];
      if (n.hidden && !o.includeHidden) continue;
      const on = d.checked.has(n._id);
      if (n.children) { if (on && st.mode !== 'layer') out.push({ kind: 'folder', n, path }); walk(n.children, path.concat(nameOf(n))); }
      else if (on && st.mode !== 'folder') out.push({ kind: 'layer', n, path });
    }
  })(d.psd.children || [], []);
  return out;
}
function renderSummary() {
  const docs = $('allFiles').checked ? st.docs : [doc()];
  let n = 0, w = 0;
  for (const d of docs) for (const t of targetsOf(d)) { n++; if (PsdCore.collectWarningsDeep(t.n || { children: d.psd.children || [] }, opts()).length) w++; }
  $('sum').innerHTML = `${n} ファイル` + (w ? ` · <span class="warn">警告あり ${w}</span>` : '');
  $('incWarnRow').hidden = !w;
}
function renderAll() { renderTabs(); renderTree(); renderSliceList(); renderPreview(); renderSummary(); }

const stem = n => n.replace(/\.(psd|psb|clip|png|jpe?g|webp|gif|bmp)$/i, '');
const safe = s => (s || '_').replace(/[\\/:*?"<>|]/g, '_');
// Cut a canvas-space rect (outside the canvas = transparent). With fill, pixels that aren't fully opaque are
// filled with the most common color along the edge of the transparent area (the background color).
function cropPixels(rgba, W, H, r, fill) {
  const out = new Uint8ClampedArray(r.w * r.h * 4), src = new Uint32Array(rgba.buffer, rgba.byteOffset, W * H), dst = new Uint32Array(out.buffer);
  for (let j = 0; j < r.h; j++) {
    const sy = r.y + j; if (sy < 0 || sy >= H) continue;
    for (let i = 0; i < r.w; i++) { const sx = r.x + i; if (sx >= 0 && sx < W) dst[j * r.w + i] = src[sy * W + sx]; }
  }
  if (fill) fillTransparent(out, r.w, r.h);
  return out;
}
function fillTransparent(px, w, h) {
  const bins = new Map(); let any = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4; if (px[p + 3] !== 255) { any = true; continue; }
    let edge = false;
    for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h && px[(ny * w + nx) * 4 + 3] < 255) { edge = true; break; }
    }
    if (!edge) continue;
    const k = (px[p] >> 4) << 8 | (px[p + 1] >> 4) << 4 | px[p + 2] >> 4, b = bins.get(k) || [0, 0, 0, 0];
    b[0] += px[p]; b[1] += px[p + 1]; b[2] += px[p + 2]; b[3]++; bins.set(k, b);
  }
  if (!any || !bins.size) return;
  let best = null; for (const b of bins.values()) if (!best || b[3] > best[3]) best = b;
  const c = [best[0] / best[3], best[1] / best[3], best[2] / best[3]];
  for (let p = 0; p < px.length; p += 4) {
    const a = px[p + 3]; if (a === 255) continue; const k = a / 255;
    px[p] = px[p] * k + c[0] * (1 - k); px[p + 1] = px[p + 1] * k + c[1] * (1 - k); px[p + 2] = px[p + 2] * k + c[2] * (1 - k); px[p + 3] = 255;
  }
}
async function encode(rgba, W, H, crop) {
  let c = toCanvas(rgba, W, H), x = 0, y = 0, w = W, h = H;
  if (crop) { c = toCanvas(cropPixels(rgba, W, H, crop, $('slFill').checked), crop.w, crop.h); w = crop.w; h = crop.h; }
  else if ($('trim').checked) { const b = PsdCore.alphaBounds(rgba, W, H); if (!b) return null; ({ x, y, w, h } = b); }
  const px = Math.max(1, +$('px').value || 1);
  const s = st.size === 'orig' ? 1 : $('basis').value === 'canvas' ? px / (st.size === 'w' ? W : H) : px / (st.size === 'w' ? w : h);
  const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(w * s)); out.height = Math.max(1, Math.round(h * s));
  const ctx = out.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  if (st.fmt === 'jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height); }
  ctx.drawImage(c, x, y, w, h, 0, 0, out.width, out.height);
  const q = Math.min(100, Math.max(1, +$('quality').value || 90)) / 100;
  return await new Promise(res => out.toBlob(res, 'image/' + st.fmt, q));
}
async function writeTo(dir, path, blob) {
  const parts = path.split('/'), file = parts.pop();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  const w = await (await dir.getFileHandle(file, { create: true })).createWritable(); await w.write(blob); await w.close();
}
async function saveCurrent() {
  const d = doc(), n = st.sel, r = renderNode(d, n), s = st.pane === 'slice' ? curSlice() : null;
  const blob = await encode(r.rgba, r.W, r.H, s);
  if (!blob) { $('status').innerHTML = '<span class="err">空の画像です</span>'; return; }
  const base = s ? s.name : n ? nameOf(n) : stem(d.name);
  if (await saveBlob($('prefix').value + safe(base) + $('suffix').value + '.' + (st.fmt === 'jpeg' ? 'jpg' : st.fmt), blob)) $('status').innerHTML = '<span class="ok">1 ファイルを書き出し</span>';
}
async function doExport() {
  const btn = $('export'); btn.disabled = true;
  const docs = $('allFiles').checked ? st.docs : [doc()];
  const zip = new JSZip(), report = [], ext = st.fmt === 'jpeg' ? 'jpg' : st.fmt;
  let dir = null;
  if (st.out === 'dir') {
    try { dir = await showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e) { btn.disabled = false; if (e.name === 'AbortError') { $('status').textContent = '保存を取り消しました'; return; } $('outDir').hidden = true; $('out').querySelector('[data-v="zip"]').click(); $('status').innerHTML = '<span class="err">この環境ではフォルダに保存できません</span>'; return; }
  }
  let written = 0, skipped = 0;
  try {
    for (const d of docs) {
      const base = docs.length > 1 ? safe(stem(d.name)) + '/' : '';
      const ts = targetsOf(d), used = new Set();
      let full = null;
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        $('status').textContent = `${d.name} ${i + 1}/${ts.length}`;
        await new Promise(r => setTimeout(r));
        const r = t.s ? (full ||= renderNode(d, null)) : renderNode(d, t.n);
        const ws = dedupe(r.warnings.filter(w => w.type !== 'text'));
        let stemName = safe(t.s ? t.s.name : nameOf(t.n));
        if (t.s) { let k = 2, b = stemName; while (used.has(stemName)) stemName = `${b}_${k++}`; used.add(stemName); }
        const fname = $('prefix').value + stemName + $('suffix').value + '.' + ext;
        const rel = st.mode === 'both' ? (t.kind === 'folder' ? 'folders/' : 'layers/') : '';
        const path = base + rel + ($('tree2').checked ? t.path.map(safe).map(p => p + '/').join('') : (t.path.length ? t.path.map(safe).join('_') + '_' : '')) + fname;
        if (ws.length) report.push(`${path}\n` + ws.map(w => `  - ${w.path}: ${WARN_JA[w.type] || w.type}${w.detail ? ` (${w.detail})` : ''}`).join('\n'));
        if (ws.length && !$('incWarn').checked) { skipped++; continue; }
        const blob = await encode(r.rgba, r.W, r.H, t.s);
        if (!blob) { report.push(`${path}\n  - 空の画像のため省略`); continue; }
        if (dir) await writeTo(dir, path, blob);
        else if (st.out === 'each') { if (!(await saveBlob(path.replace(/\//g, '_'), blob))) return; } else zip.file(path, blob);
        written++;
      }
    }
    const done = () => $('status').innerHTML = `<span class="ok">${written} ファイルを書き出し</span>` + (skipped ? ` · <span class="warn">${skipped} 件を省略</span>` : '');
    if (dir && report.length) await writeTo(dir, 'warnings.txt', new Blob([report.join('\n\n') + '\n']));
    if (st.out !== 'zip') { if (!written) $('status').innerHTML = '<span class="err">書き出せる画像がありません</span>'; else done(); return; }
    if (report.length) zip.file('warnings.txt', (skipped ? `警告のため書き出さなかった画像: ${skipped}\n\n` : '') + report.join('\n\n') + '\n');
    if (!written) { $('status').innerHTML = '<span class="err">書き出せる画像がありません</span>'; return; }
    const data = await zip.generateAsync({ type: 'blob' });
    const name = (docs.length > 1 ? 'psd-export' : safe(stem(docs[0].name))) + '.zip';
    if (await saveBlob(name, data)) done();
  } catch (e) { $('status').innerHTML = `<span class="err">エラー: ${String(e.message || e)}</span>`; }
  finally { btn.disabled = false; }
}

// Slices: canvas-space rectangles cut from the document composite
const curSlice = () => { const d = doc(); return d.slices.find(s => s.id === d.sliceSel) || null; };
const slKey = (name, psd) => `slices:${name}:${psd.width}x${psd.height}`;
let slSeq = 0;
function loadSlicesLocal(name, psd) {
  try { const a = JSON.parse(localStorage.getItem(slKey(name, psd)) || '[]'); return a.map(s => ({ ...s, id: ++slSeq, on: s.on !== false })); } catch { return []; }
}
function persistSlices(d = doc()) {
  try { localStorage.setItem(slKey(d.name, d.psd), JSON.stringify(d.slices.map(({ name, x, y, w, h, on }) => ({ name, x, y, w, h, on })))); } catch {}
}
function nextSliceName(d) { let i = d.slices.length + 1; const has = n => d.slices.some(s => s.name === n); while (has(`slice_${String(i).padStart(2, '0')}`)) i++; return `slice_${String(i).padStart(2, '0')}`; }
function clampSlice(s, W, H) {
  // slices may extend up to one canvas beyond each edge (filled on export)
  s.w = Math.max(1, Math.min(Math.round(s.w), 3 * W)); s.h = Math.max(1, Math.min(Math.round(s.h), 3 * H));
  s.x = Math.max(-W, Math.min(Math.round(s.x), 2 * W - s.w)); s.y = Math.max(-H, Math.min(Math.round(s.y), 2 * H - s.h));
}
function setPane(p) {
  st.pane = p;
  $('pane').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === p));
  document.querySelectorAll('.lp').forEach(e => e.hidden = p !== 'layer');
  document.querySelectorAll('.sp:not(#sprops)').forEach(e => e.hidden = p !== 'slice');
  if (p === 'slice') { if (st.mode !== 'slice') st.prevMode = st.mode; st.mode = 'slice'; st.sel = null; renderTree(); }
  else if (st.mode === 'slice') st.mode = st.prevMode || 'folder';
  renderSummary();
  $('sl').classList.toggle('on', p === 'slice'); $('stage').classList.toggle('slicing', p === 'slice');
  renderSliceList(); renderPreview();
}
function sliceChanged(list = true) {
  persistSlices(); if (list) fitPreview(); else renderSlices(); renderSliceProps(); if (list) renderSliceList(); renderSummary();
  const s = curSlice(); if (st.pane === 'slice' && s) $('pvSize').textContent = `${s.w}×${s.h}  x${s.x} y${s.y}`;
}
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function renderSlices() {
  const ov = $('sl'); ov.innerHTML = '';
  const d = doc(); if (!d || st.pane !== 'slice') return;
  const pv = $('pv'), k = pv.clientWidth / pv.width;
  for (const s of d.slices) {
    const e = document.createElement('div'); e.className = 'sr' + (s.id === d.sliceSel ? ' sel' : '') + (s.on ? '' : ' off'); e.dataset.id = s.id;
    Object.assign(e.style, { left: s.x * k + 'px', top: s.y * k + 'px', width: s.w * k + 'px', height: s.h * k + 'px' });
    const b = document.createElement('b'); b.textContent = s.name; e.append(b);
    if (s.id === d.sliceSel) for (const h of HANDLES) {
      const q = document.createElement('i'); q.className = 'hd'; q.dataset.h = h;
      q.style.left = (h.includes('w') ? 0 : h.includes('e') ? 100 : 50) + '%'; q.style.top = (h.includes('n') ? 0 : h.includes('s') ? 100 : 50) + '%';
      q.style.cursor = h + '-resize'; e.append(q);
    }
    ov.append(e);
  }
}
function renderSliceList() {
  const d = doc(), l = $('slist'); if (!d) return; l.innerHTML = '';
  if (!d.slices.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = '画像上をドラッグして作成'; l.append(e); }
  for (const s of d.slices) {
    const r = document.createElement('div'); r.className = 'row' + (s.id === d.sliceSel ? ' sel' : '');
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = s.name;
    nm.ondblclick = e => { e.stopPropagation(); d.sliceSel = s.id; sliceChanged(); $('sName').focus(); $('sName').select(); };
    const sz = document.createElement('span'); sz.className = 'tag num'; sz.textContent = `${s.w}×${s.h}`;
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'ck'; cb.checked = s.on; cb.setAttribute('aria-label', '書き出し対象');
    cb.onclick = e => { e.stopPropagation(); s.on = cb.checked; sliceChanged(); };
    r.append(nm, sz, cb); r.onclick = () => { d.sliceSel = s.id; sliceChanged(); };
    l.append(r);
  }
  renderSliceProps();
}
function renderSliceProps() {
  const s = curSlice(), box = $('sprops');
  box.hidden = st.pane !== 'slice' || !s;
  for (const [id, key] of [['sName', 'name'], ['sX', 'x'], ['sY', 'y'], ['sW', 'w'], ['sH', 'h']]) if (document.activeElement !== $(id)) $(id).value = s ? s[key] : '';
}
for (const [id, key] of [['sX', 'x'], ['sY', 'y'], ['sW', 'w'], ['sH', 'h']]) $(id).oninput = () => {
  const s = curSlice(), v = Math.round(+$(id).value); if (!s || !isFinite(v) || $(id).value === '') return;
  s[key] = v; clampSlice(s, doc().psd.width, doc().psd.height); sliceChanged();
};
[['sX'], ['sY'], ['sW'], ['sH']].forEach(([id]) => $(id).onblur = renderSliceProps);
$('sName').oninput = () => { const s = curSlice(); if (!s) return; s.name = $('sName').value; persistSlices(); renderSlices(); const r = $('slist').querySelector('.row.sel .name'); if (r) r.textContent = s.name; };
$('sName').onblur = () => { const s = curSlice(); if (s && !s.name.trim()) { s.name = nextSliceName(doc()); sliceChanged(); } };
$('sName').onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') $('sName').blur(); };
function deleteSlice() { const d = doc(), i = d.slices.findIndex(s => s.id === d.sliceSel); if (i < 0) return; d.slices.splice(i, 1); d.sliceSel = (d.slices[i] || d.slices[i - 1] || {}).id ?? null; sliceChanged(); }
$('sDel').onclick = deleteSlice;
$('sRound').onclick = () => { const on = $('sRound').getAttribute('aria-pressed') !== 'true'; $('sRound').setAttribute('aria-pressed', on); $('sl').classList.toggle('round', on); };
$('pane').querySelectorAll('button').forEach(b => b.onclick = () => setPane(b.dataset.v));
(() => {
  const ov = $('stage'); let drag = null;
  const pt = e => { const r = $('pv').getBoundingClientRect(), k = r.width / $('pv').width; return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }; };
  ov.addEventListener('pointerdown', e => {
    if (st.pane !== 'slice' || e.button !== 0 || e.target.closest('.warnbox')) return;
    const d = doc(), p = pt(e), W = d.psd.width, H = d.psd.height, X0 = -W, X1 = 2 * W, Y0 = -H, Y1 = 2 * H;
    const hd = e.target.closest('.hd'), sr = e.target.closest('.sr');
    if (hd) { const s = curSlice(); drag = { type: 'resize', h: hd.dataset.h, s, o: { ...s }, p }; }
    else if (sr) { const s = d.slices.find(x => x.id === +sr.dataset.id); d.sliceSel = s.id; drag = { type: 'move', s, o: { ...s }, p }; sliceChanged(); }
    else {
      const x = Math.max(X0, Math.min(X1, Math.round(p.x))), y = Math.max(Y0, Math.min(Y1, Math.round(p.y)));
      const s = { id: ++slSeq, name: nextSliceName(d), x, y, w: 0, h: 0, on: true };
      drag = { type: 'new', s, o: { x, y }, p, d };
    }
    ov.setPointerCapture(e.pointerId); e.preventDefault();
  });
  ov.addEventListener('pointermove', e => {
    if (!drag) return;
    const d = doc(), p = pt(e), W = d.psd.width, H = d.psd.height, X0 = -W, X1 = 2 * W, Y0 = -H, Y1 = 2 * H, dx = p.x - drag.p.x, dy = p.y - drag.p.y, s = drag.s, o = drag.o;
    if (drag.type === 'new') {
      const x2 = Math.max(X0, Math.min(X1, Math.round(p.x))), y2 = Math.max(Y0, Math.min(Y1, Math.round(p.y)));
      let w = Math.abs(x2 - o.x), h = Math.abs(y2 - o.y);
      if (e.shiftKey) { w = h = Math.min(Math.max(w, h), x2 < o.x ? o.x - X0 : X1 - o.x, y2 < o.y ? o.y - Y0 : Y1 - o.y); }
      Object.assign(s, { x: x2 < o.x ? o.x - w : o.x, y: y2 < o.y ? o.y - h : o.y, w, h });
      if (!drag.added && s.w >= 2 && s.h >= 2) { drag.added = true; d.slices.push(s); d.sliceSel = s.id; }
      if (drag.added) sliceChanged(false);
      return;
    }
    if (drag.type === 'move') { s.x = Math.round(o.x + dx); s.y = Math.round(o.y + dy); clampSlice(s, W, H); }
    else {
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h; const h = drag.h;
      if (h.includes('w')) x1 = Math.min(x2 - 1, Math.max(X0, Math.round(o.x + dx)));
      if (h.includes('e')) x2 = Math.max(x1 + 1, Math.min(X1, Math.round(o.x + o.w + dx)));
      if (h.includes('n')) y1 = Math.min(y2 - 1, Math.max(Y0, Math.round(o.y + dy)));
      if (h.includes('s')) y2 = Math.max(y1 + 1, Math.min(Y1, Math.round(o.y + o.h + dy)));
      if (e.shiftKey) {
        // keep the original aspect ratio, anchored on the opposite side/corner
        const r = o.w / o.h, ax = h.includes('w') ? o.x + o.w : h.includes('e') ? o.x : o.x + o.w / 2, ay = h.includes('n') ? o.y + o.h : h.includes('s') ? o.y : o.y + o.h / 2;
        let w = x2 - x1, hh = y2 - y1;
        if (h.length === 2) { if (w / r > hh) hh = w / r; else w = hh * r; } else if (h === 'e' || h === 'w') hh = w / r; else w = hh * r;
        const fx = h.includes('w') ? ax - X0 : h.includes('e') ? X1 - ax : 2 * Math.min(ax - X0, X1 - ax), fy = h.includes('n') ? ay - Y0 : h.includes('s') ? Y1 - ay : 2 * Math.min(ay - Y0, Y1 - ay);
        const k = Math.min(1, fx / w, fy / hh); w = Math.max(1, Math.round(w * k)); hh = Math.max(1, Math.round(hh * k));
        x1 = h.includes('w') ? ax - w : h.includes('e') ? ax : Math.round(ax - w / 2); y1 = h.includes('n') ? ay - hh : h.includes('s') ? ay : Math.round(ay - hh / 2);
        x2 = x1 + w; y2 = y1 + hh;
      }
      Object.assign(s, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
    sliceChanged(false);
  });
  const end = () => { if (!drag) return; const t = drag; drag = null; if (t.type === 'new' && !t.added) { doc().sliceSel = null; } sliceChanged(); };
  ov.addEventListener('pointerup', end); ov.addEventListener('pointercancel', end);
  addEventListener('keydown', e => {
    if (st.pane !== 'slice' || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
    const s = curSlice(); if (!s) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSlice(); e.preventDefault(); return; }
    const m = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]; if (!m) return;
    const k = e.shiftKey ? 10 : 1; s.x += m[0] * k; s.y += m[1] * k; clampSlice(s, doc().psd.width, doc().psd.height); sliceChanged(); e.preventDefault();
  });
})();
$('slSave').onclick = async () => {
  const d = doc(); if (!d.slices.length) { $('status').innerHTML = '<span class="err">スライスがありません</span>'; return; }
  const data = { type: 'slices', version: 1, width: d.psd.width, height: d.psd.height, slices: d.slices.map(({ name, x, y, w, h, on }) => ({ name, x, y, w, h, on })) };
  if (await saveBlob(safe(stem(d.name)) + '_slices.json', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))) $('status').innerHTML = '<span class="ok">スライス設定を保存</span>';
};
$('slLoad').onclick = () => $('slFile').click();
$('slFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text()); if (!Array.isArray(j.slices)) throw new Error();
    const d = doc(), W = d.psd.width, H = d.psd.height;
    d.slices = j.slices.map(s => { const o = { id: ++slSeq, name: String(s.name || '') || nextSliceName(d), x: +s.x || 0, y: +s.y || 0, w: +s.w || 1, h: +s.h || 1, on: s.on !== false }; clampSlice(o, W, H); return o; });
    d.sliceSel = d.slices[0]?.id ?? null; if (st.pane !== 'slice') setPane('slice'); sliceChanged();
    $('status').innerHTML = (j.width && (j.width !== W || j.height !== H)) ? `<span class="warn">キャンバスサイズが異なります（${j.width}×${j.height}）</span>` : `<span class="ok">${d.slices.length} 件のスライスを読込</span>`;
  } catch { $('status').innerHTML = '<span class="err">スライス設定を読み込めません</span>'; }
};

function segInit(id, key, after) {
  $(id).querySelectorAll('button').forEach(b => b.onclick = () => { $(id).querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); st[key] = b.dataset.v; after && after(); });
}
segInit('out', 'out'); $('outDir').hidden = !('showDirectoryPicker' in window); segInit('size', 'size', () => { $('sizeRow').hidden = st.size === 'orig'; }); segInit('mode', 'mode', renderSummary); segInit('fmt', 'fmt', () => { $('qualityRow').hidden = st.fmt === 'png'; });
$('hidden').onchange = () => { doc().warnCache.clear(); renderAll(); };
$('allFiles').onchange = renderSummary;
$('selAll').onclick = () => { const d = doc(); (function a(ch) { for (const n of ch || []) { d.checked.add(n._id); a(n.children); } })(d.psd.children); renderTree(); renderSummary(); };
$('selNone').onclick = () => { doc().checked.clear(); renderTree(); renderSummary(); };
$('export').onclick = doExport; $('saveOne').onclick = saveCurrent;
async function openFiles(files) {
  for (const f of files) {
    try { $('status').textContent = f.name; await openFile(f.name, await f.arrayBuffer()); $('status').textContent = ''; }
    catch (err) { $('status').innerHTML = `<span class="err">${f.name}: 読み込めません（${String(err.message || err)}）</span>`; }
  }
  if (doc() && doc().isImage && st.pane !== 'slice') setPane('slice');
  renderAll();
}
function setTool(t) {
  document.body.classList.toggle('tool-gif', t === 'gif');
  $('tool').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === t));
  if (t === 'gif') GifTool.shown(); else fitPreview();
}
$('tool').querySelectorAll('button').forEach(b => b.onclick = () => setTool(b.dataset.v));
$('file').onchange = async e => { await openFiles([...e.target.files]); e.target.value = ''; };
let dragDepth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dragDepth++; $('drop').hidden = false; } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('drop').hidden = true; const vid = [...(e.dataTransfer?.files || [])].find(f => GifTool.isVideo(f)); if (vid) { setTool('gif'); GifTool.open(vid); return; } const fs = [...(e.dataTransfer?.files || [])].filter(f => SRC_RE.test(f.name)); if (fs.length) openFiles(fs); });
for (const k of SAMPLES) { const o = document.createElement('option'); o.value = k; o.textContent = k; $('sample').append(o); }
$('sample').onchange = async () => { const k = $('sample').value; const i = st.docs.findIndex(d => d.name === k); if (i >= 0) st.cur = i; else loadPsd(k, await (await fetch(`${import.meta.env.BASE_URL}samples/${k}`)).arrayBuffer()); st.sel = null; renderAll(); };
$('sample').value = '02_multiple_folders.psd'; $('sample').onchange();
