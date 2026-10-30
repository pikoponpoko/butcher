// PSD layer/folder compositor.
// Input: ag-psd result read with { useImageData: true } (or the same shape from clipreader).
// Buffers are Float32 straight-alpha RGBA in [0,1], document-sized.

export type PixelData = Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array;
export interface PixelImage { width: number; height: number; data: PixelData }
export interface MaskNode {
  left?: number; top?: number; right?: number; bottom?: number;
  disabled?: boolean; defaultColor?: number; fromVectorData?: boolean;
  userMaskDensity?: number; vectorMaskDensity?: number; userMaskFeather?: number; vectorMaskFeather?: number;
  imageData?: PixelImage;
}
// Structural subset of ag-psd's Layer that the compositor reads; `_warn` comes from clipreader.
export interface PsdNode {
  name?: string; hidden?: boolean; opacity?: number; fillOpacity?: number; blendMode?: string; clipping?: boolean;
  left?: number; top?: number; right?: number; bottom?: number;
  children?: PsdNode[]; imageData?: PixelImage | null; mask?: MaskNode;
  effects?: any; adjustment?: { type?: string }; blendingRanges?: any; blendInteriorElements?: boolean;
  vectorFill?: unknown; vectorMask?: { disabled?: boolean }; text?: unknown; artboard?: unknown; knockout?: unknown;
  filterMask?: unknown; placedLayer?: { filter?: unknown };
  _warn?: string[];
}
export interface PsdDoc { width: number; height: number; children?: PsdNode[]; imageData?: PixelImage }
export interface Warning { path: string; type: string; detail?: string; level?: string }
export interface CompositeOptions { includeHidden?: boolean; clipModel?: string; applyNodeOpacity?: boolean }
export interface Composite { buf: Float32Array; W: number; H: number; warnings: Warning[] }
export interface Target { kind: 'folder' | 'layer'; node: PsdNode; path: string[] }
type RGB = number[];
type Sampler = ((x: number, y: number) => number) | null;


export const SUPPORTED = new Set<string>([
  'normal', 'pass through', 'dissolve', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color dodge', 'color burn', 'hard light', 'soft light', 'difference', 'exclusion',
  'linear burn', 'linear dodge', 'vivid light', 'linear light', 'pin light', 'hard mix',
  'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity', 'darker color', 'lighter color',
]);

const clamp = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;
const screen = (b: number, s: number) => b + s - b * s;
const dodge = (b: number, s: number) => b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
const burn = (b: number, s: number) => b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);

const SEP: Record<string, (b: number, s: number) => number> = {
  'normal': (_b, s) => s,
  'multiply': (b, s) => b * s,
  'screen': screen,
  'overlay': (b, s) => b <= 0.5 ? 2 * b * s : screen(s, 2 * b - 1),
  'darken': Math.min,
  'lighten': Math.max,
  'color dodge': dodge,
  'color burn': burn,
  'hard light': (b, s) => s <= 0.5 ? 2 * b * s : screen(b, 2 * s - 1),
  'soft light': (b, s) => s <= 0.5 ? 2 * b * s + b * b * (1 - 2 * s) : 2 * b * (1 - s) + Math.sqrt(b) * (2 * s - 1),
  'difference': (b, s) => Math.abs(b - s),
  'exclusion': (b, s) => b + s - 2 * b * s,
  'linear burn': (b, s) => Math.max(0, b + s - 1),
  'linear dodge': (b, s) => Math.min(1, b + s),
  'vivid light': (b, s) => s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * (s - 0.5)),
  'linear light': (b, s) => clamp(b + 2 * s - 1),
  'pin light': (b, s) => s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1),
  'hard mix': (b, s) => b + s >= 1 ? 1 : 0,
  'subtract': (b, s) => Math.max(0, b - s),
  'divide': (b, s) => s === 0 ? (b === 0 ? 0 : 1) : Math.min(1, b / s),
};

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c: RGB) {
  const l = lum(c[0], c[1], c[2]);
  const n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
  if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * l / (l - n);
  if (x > 1) for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * (1 - l) / (x - l);
  return c;
}
function setLum(c: RGB, l: number) { const d = l - lum(c[0], c[1], c[2]); return clipColor([c[0] + d, c[1] + d, c[2] + d]); }
const sat = (c: RGB) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c: RGB, s: number) {
  const o = [0, 0, 0];
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [mn, md, mx] = idx;
  if (c[mx] > c[mn]) { o[md] = (c[md] - c[mn]) * s / (c[mx] - c[mn]); o[mx] = s; }
  return o;
}
const NONSEP: Record<string, (b: RGB, s: RGB) => RGB> = {
  'hue': (b, s) => setLum(setSat(s, sat(b)), lum(b[0], b[1], b[2])),
  'saturation': (b, s) => setLum(setSat(b, sat(s)), lum(b[0], b[1], b[2])),
  'color': (b, s) => setLum(s.slice(), lum(b[0], b[1], b[2])),
  'luminosity': (b, s) => setLum(b.slice(), lum(s[0], s[1], s[2])),
  'darker color': (b, s) => lum(s[0], s[1], s[2]) < lum(b[0], b[1], b[2]) ? s.slice() : b.slice(),
  'lighter color': (b, s) => lum(s[0], s[1], s[2]) > lum(b[0], b[1], b[2]) ? s.slice() : b.slice(),
};

// Composite one source pixel onto dst[i..i+3]. atop: keep backdrop alpha (clipping).
const cb = [0, 0, 0], cs = [0, 0, 0];
function compPixel(dst: Float32Array, i: number, sr: number, sg: number, sb: number, sa: number, mode: string, atop: boolean) {
  if (sa <= 0) return;
  const ab = dst[i + 3];
  let br = 0, bg = 0, bb = 0;
  if (ab > 0) {
    if (mode === 'normal') { br = sr; bg = sg; bb = sb; }
    else if (SEP[mode]) { const f = SEP[mode]; br = f(dst[i], sr); bg = f(dst[i + 1], sg); bb = f(dst[i + 2], sb); }
    else if (NONSEP[mode]) {
      cb[0] = dst[i]; cb[1] = dst[i + 1]; cb[2] = dst[i + 2]; cs[0] = sr; cs[1] = sg; cs[2] = sb;
      const o = NONSEP[mode](cb, cs); br = o[0]; bg = o[1]; bb = o[2];
    } else { br = sr; bg = sg; bb = sb; }
    // Cs' = (1-ab)Cs + ab*B(Cb,Cs)
    br = (1 - ab) * sr + ab * br; bg = (1 - ab) * sg + ab * bg; bb = (1 - ab) * sb + ab * bb;
  } else { br = sr; bg = sg; bb = sb; }
  if (atop) {
    if (ab <= 0) return;
    dst[i] = sa * br + (1 - sa) * dst[i];
    dst[i + 1] = sa * bg + (1 - sa) * dst[i + 1];
    dst[i + 2] = sa * bb + (1 - sa) * dst[i + 2];
    return;
  }
  const ao = sa + ab * (1 - sa);
  const k = ab * (1 - sa);
  dst[i] = (sa * br + k * dst[i]) / ao;
  dst[i + 1] = (sa * bg + k * dst[i + 1]) / ao;
  dst[i + 2] = (sa * bb + k * dst[i + 2]) / ao;
  dst[i + 3] = ao;
}

export const depthMax = (d: PixelData) => d instanceof Uint16Array ? 65535 : d instanceof Float32Array ? 1 : 255;

function maskSampler(m: MaskNode | undefined): Sampler {
  if (!m || m.disabled || !m.imageData) return null;
  const d = m.imageData.data, w = m.imageData.width, h = m.imageData.height, q = depthMax(d);
  const l = (m.left ?? 0) | 0, t = (m.top ?? 0) | 0;
  const dens = (m.fromVectorData ? m.vectorMaskDensity : m.userMaskDensity) ?? 1;
  const def = 1 - dens * (1 - (m.defaultColor || 0) / 255);
  return (x: number, y: number) => {
    const mx = x - l, my = y - t;
    if (mx < 0 || my < 0 || mx >= w || my >= h) return def;
    return 1 - dens * (1 - d[(my * w + mx) * 4] / q);
  };
}

export function hasEnabledEffects(e: any): boolean {
  if (!e || e.disabled) return false;
  for (const k of Object.keys(e)) {
    if (k === 'disabled' || k === 'scale') continue;
    const v = e[k];
    const list: any[] = Array.isArray(v) ? v : [v];
    if (k === 'solidFill' && list.every(x => !x || !x.enabled || x.blendMode !== 'dissolve')) continue;
    if (list.some(x => x && typeof x === 'object' && x.enabled !== false)) return true;
  }
  return false;
}
function blendIfActive(r: any): boolean {
  if (!r) return false;
  const def = (a: number[] | undefined) => !a || (a[0] === 0 && a[1] === 0 && a[2] === 255 && a[3] === 255);
  if (!def(r.compositeGrayBlendSource) || !def(r.compositeGraphBlendDestinationRange)) return true;
  return (r.ranges || []).some((x: any) => !def(x.sourceRange) || !def(x.destRange));
}

// Warnings for things this compositor cannot reproduce faithfully.
function layerWarnings(layer: PsdNode, path: string[], warn: Warning[]) {
  const p = path.concat(layer.name || '').join('/');
  if (layer.blendMode === 'dissolve' && ((layer.opacity ?? 1) < 1 || (layer.fillOpacity ?? 1) < 1)) warn.push({ path: p, type: 'blendMode', detail: 'dissolve' });
  if (layer.blendMode && layer.blendMode !== 'dissolve' && !SUPPORTED.has(layer.blendMode)) warn.push({ path: p, type: 'blendMode', detail: layer.blendMode });
  if (hasEnabledEffects(layer.effects)) warn.push({ path: p, type: 'effects', detail: Object.keys(layer.effects).filter(k => k !== 'disabled' && k !== 'scale').join(',') });
  if (layer.adjustment) warn.push({ path: p, type: 'adjustment', detail: layer.adjustment.type });
  if (blendIfActive(layer.blendingRanges)) warn.push({ path: p, type: 'blendIf' });
  if (layer.mask && !layer.mask.disabled && (layer.mask.userMaskFeather || layer.mask.vectorMaskFeather)) warn.push({ path: p, type: 'maskFeather' });
  if (!layer.children && !layer.imageData && layer.vectorFill) warn.push({ path: p, type: 'vectorOnly' });
  if (layer.text) warn.push({ path: p, type: 'text', level: 'info' });
  if (layer.artboard) warn.push({ path: p, type: 'artboard' });
  if (layer.knockout) warn.push({ path: p, type: 'knockout' });
  if (layer.vectorMask && !layer.vectorMask.disabled && !layer.vectorFill && !layer.text) warn.push({ path: p, type: 'vectorMask' });
  if (layer.filterMask || (layer.placedLayer && layer.placedLayer.filter)) warn.push({ path: p, type: 'smartFilter' });
  (layer._warn || []).forEach(t => warn.push({ path: p, type: t }));
  if (!layer._warn && !layer.children && !layer.imageData && !layer.adjustment && ((layer.right ?? 0) - (layer.left ?? 0)) > 0) warn.push({ path: p, type: 'noPixels' });
  if (layer.children && layer.blendMode === 'pass through' && (layer.opacity ?? 1) < 1) warn.push({ path: p, type: 'passThroughOpacity' });
  if ((layer.opacity ?? 1) < 1 && ['vivid light', 'hard mix'].includes(layer.blendMode ?? '')) warn.push({ path: p, type: 'specialOpacity', detail: layer.blendMode });
  if (layer.fillOpacity !== undefined && layer.fillOpacity < 1 && !['normal', 'pass through', 'multiply', 'screen'].includes(layer.blendMode || 'normal')) warn.push({ path: p, type: 'specialFillOpacity', detail: layer.blendMode });
}

function newBuf(W: number, H: number) { return new Float32Array(W * H * 4); }

const px = new Float32Array(4);
// Color Overlay effects (solid fill) applied onto the layer's own pixels.
function solidFills(layer: PsdNode) {
  const e = layer.effects; if (!e || e.disabled || !e.solidFill) return null;
  const list: any[] = (Array.isArray(e.solidFill) ? e.solidFill : [e.solidFill]).filter((f: any) => f && f.enabled);
  if (!list.length) return null;
  return list.map(f => ({ r: f.color.r / 255, g: f.color.g / 255, b: f.color.b / 255, a: f.opacity ?? 1, mode: f.blendMode || 'normal' }));
}

// Draw a raster layer onto dst.
function drawLayer(dst: Float32Array, W: number, H: number, layer: PsdNode, alphaMul: number, mode: string, atop: boolean) {
  const img = layer.imageData; if (!img) return;
  const ms = maskSampler(layer.mask);
  const lw = img.width, lh = img.height, lx = (layer.left ?? 0) | 0, ly = (layer.top ?? 0) | 0, d = img.data, q = depthMax(d);
  const fills = solidFills(layer);
  const x0 = Math.max(0, lx), y0 = Math.max(0, ly), x1 = Math.min(W, lx + lw), y1 = Math.min(H, ly + lh);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const si = ((y - ly) * lw + (x - lx)) * 4;
      let a = d[si + 3] / q * alphaMul;
      let r = d[si] / q, g = d[si + 1] / q, b = d[si + 2] / q;
      if (fills && layer.blendInteriorElements) for (const f of fills) { px[0] = r; px[1] = g; px[2] = b; px[3] = 1; compPixel(px, 0, f.r, f.g, f.b, f.a, f.mode, true); r = px[0]; g = px[1]; b = px[2]; }
      if (ms) a *= ms(x, y);
      if (a <= 0) continue;
      const di = (y * W + x) * 4;
      compPixel(dst, di, r, g, b, a, mode, atop);
      // Interior effects not blended as group: composite onto the result inside the layer shape.
      if (fills && !layer.blendInteriorElements) for (const f of fills) compPixel(dst, di, f.r, f.g, f.b, a * f.a, f.mode, atop);
    }
  }
}

// Composite a full-size source buffer onto dst.
function drawBuf(dst: Float32Array, src: Float32Array, W: number, H: number, alphaMul: number, mode: string, ms: Sampler, atop: boolean) {
  for (let p = 0, n = W * H; p < n; p++) {
    const i = p * 4;
    let a = src[i + 3] * alphaMul;
    if (a <= 0) continue;
    if (ms) { a *= ms(p % W, (p / W) | 0); if (a <= 0) continue; }
    compPixel(dst, i, src[i], src[i + 1], src[i + 2], a, mode, atop);
  }
}

// dst = lerp(before, dst, t(p)) in premultiplied space.
function lerpInto(dst: Float32Array, before: Float32Array, W: number, H: number, tf: (p: number) => number) {
  for (let p = 0, n = W * H; p < n; p++) {
    const t = tf(p);
    if (t >= 1) continue;
    const k = p * 4;
    const a0 = before[k + 3], a1 = dst[k + 3], a = a0 + (a1 - a0) * t;
    for (let c = 0; c < 3; c++) dst[k + c] = a > 0 ? (before[k + c] * a0 + (dst[k + c] * a1 - before[k + c] * a0) * t) / a : 0;
    dst[k + 3] = a;
  }
}

const visible = (l: PsdNode, o: CompositeOptions) => o.includeHidden || !l.hidden;

// Render the content of a node (layer or group) isolated into a fresh buffer.
function renderIsolated(node: PsdNode, W: number, H: number, o: CompositeOptions, path: string[], warn: Warning[]) {
  const buf = newBuf(W, H);
  if (node.children) renderChildren(buf, node.children, W, H, o, path.concat(node.name || ''), warn);
  else drawLayer(buf, W, H, node, node.fillOpacity ?? 1, 'normal', false);
  return buf;
}

function renderChildren(dst: Float32Array, children: PsdNode[], W: number, H: number, o: CompositeOptions, path: string[], warn: Warning[]) {
  for (let i = 0; i < children.length; i++) {
    const L = children[i];
    if (L.clipping) continue; // handled with its base
    const clipped = [];
    for (let j = i + 1; j < children.length && children[j].clipping; j++) clipped.push(children[j]);
    if (!visible(L, o)) continue;
    layerWarnings(L, path, warn);
    const opacity = L.opacity ?? 1;
    const mode = L.blendMode || 'normal';
    const visClipped = clipped.filter(c => visible(c, o));

    if (L.children && mode === 'pass through' && !visClipped.length) {
      // Pass-through: children blend straight into the backdrop; group opacity/mask lerp the result.
      const ms = maskSampler(L.mask);
      if (opacity >= 1 && !ms) { renderChildren(dst, L.children, W, H, o, path.concat(L.name || ''), warn); continue; }
      const before = dst.slice();
      renderChildren(dst, L.children, W, H, o, path.concat(L.name || ''), warn);
      lerpInto(dst, before, W, H, p => opacity * (ms ? ms(p % W, (p / W) | 0) : 1));
      continue;
    }

    if (!visClipped.length) {
      if (L.children) {
        const g = renderIsolated(L, W, H, o, path, warn);
        drawBuf(dst, g, W, H, opacity, mode === 'pass through' ? 'normal' : mode, maskSampler(L.mask), false);
      } else if (!L.adjustment) {
        drawLayer(dst, W, H, L, opacity * (L.fillOpacity ?? 1), mode, false);
      }
      continue;
    }

    if (o.clipModel !== 'A') {
      // Clipping: base drawn normally, clipped layers composite onto that result,
      // then the change is limited to the base coverage (lerp from the pre-base backdrop).
      const before = dst.slice();
      renderChildren(dst, [L], W, H, o, path, []);
      const iso = renderIsolated(L, W, H, o, path, []);
      const ms = maskSampler(L.mask);
      const cov = new Float32Array(W * H);
      for (let p = 0; p < W * H; p++) cov[p] = iso[p * 4 + 3] * (ms ? ms(p % W, (p / W) | 0) : 1) * opacity;
      // Extrapolate the base to full coverage so the final lerp does not apply coverage twice.
      for (let p = 0; p < W * H; p++) {
        const t = cov[p]; if (t <= 0 || t >= 1) continue;
        const k = p * 4, a0 = before[k + 3], a1 = dst[k + 3];
        const a = Math.min(1, a0 + (a1 - a0) / t);
        for (let c = 0; c < 3; c++) {
          const pm = before[k + c] * a0 + (dst[k + c] * a1 - before[k + c] * a0) / t;
          dst[k + c] = a > 0 ? clamp(pm / a) : 0;
        }
        dst[k + 3] = Math.max(0, a);
      }
      for (const C of visClipped) {
        layerWarnings(C, path, warn);
        const cm = C.blendMode || 'normal';
        if (C.children) {
          const g = renderIsolated(C, W, H, o, path, warn);
          drawBuf(dst, g, W, H, C.opacity ?? 1, cm === 'pass through' ? 'normal' : cm, maskSampler(C.mask), false);
        } else if (!C.adjustment) drawLayer(dst, W, H, C, (C.opacity ?? 1) * (C.fillOpacity ?? 1), cm, false);
      }
      lerpInto(dst, before, W, H, p => cov[p]);
      continue;
    }

    // Clipping group: base content isolated, clipped layers atop it, then base mode/opacity.
    const base = newBuf(W, H);
    if (L.children) {
      const g = renderIsolated(L, W, H, o, path, warn);
      drawBuf(base, g, W, H, 1, 'normal', maskSampler(L.mask), false);
    } else drawLayer(base, W, H, L, L.fillOpacity ?? 1, 'normal', false);
    for (const C of visClipped) {
      layerWarnings(C, path, warn);
      const cm = C.blendMode || 'normal';
      if (C.children) {
        const g = renderIsolated(C, W, H, o, path, warn);
        drawBuf(base, g, W, H, C.opacity ?? 1, cm === 'pass through' ? 'normal' : cm, maskSampler(C.mask), true);
      } else if (!C.adjustment) drawLayer(base, W, H, C, (C.opacity ?? 1) * (C.fillOpacity ?? 1), cm, true);
    }
    drawBuf(dst, base, W, H, opacity, mode === 'pass through' ? 'normal' : mode, null, false);
  }
}

export function compositeDocument(psd: PsdDoc, o: CompositeOptions = {}): Composite {
  const W = psd.width, H = psd.height, warn: Warning[] = [];
  const buf = newBuf(W, H);
  renderChildren(buf, psd.children || [], W, H, o, [], warn);
  return { buf, W, H, warnings: warn };
}

// Folder export: the folder rendered alone on transparency (its own opacity/mask applied).
export function compositeNode(psd: PsdDoc, node: PsdNode, o: CompositeOptions = {}): Composite {
  const W = psd.width, H = psd.height, warn: Warning[] = [];
  const buf = newBuf(W, H);
  const wrapper: PsdNode = { ...node, hidden: false, clipping: false, blendMode: 'normal' };
  if (!o.applyNodeOpacity) wrapper.opacity = 1;
  renderChildren(buf, [wrapper], W, H, o, [], warn);
  return { buf, W, H, warnings: warn };
}

export function toRGBA8(buf: Float32Array, W: number, H: number) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(buf[i] * 255);
  for (let i = 3; i < out.length; i += 4) if (out[i] === 0) out[i - 1] = out[i - 2] = out[i - 3] = 0;
  return out;
}

export function alphaBounds(rgba: ArrayLike<number>, W: number, H: number) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rgba[(y * W + x) * 4 + 3]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Walk the tree and list export targets with their folder path.
export function listTargets(psd: PsdDoc, o: CompositeOptions = {}): Target[] {
  const out: Target[] = [];
  (function walk(children: PsdNode[], path: string[]) {
    for (let i = children.length - 1; i >= 0; i--) {
      const L = children[i];
      if (!visible(L, o) && !o.includeHidden) continue;
      if (L.children) { out.push({ kind: 'folder', node: L, path }); walk(L.children, path.concat(L.name || '')); }
      else out.push({ kind: 'layer', node: L, path });
    }
  })(psd.children || [], []);
  return out;
}

export function collectWarnings(layer: PsdNode) { const w: Warning[] = []; layerWarnings(layer, [], w); return w.map(x => x.type); }
export function collectWarningsDeep(node: PsdNode, o: CompositeOptions = {}) {
  const w: Warning[] = [];
  (function walk(n: PsdNode, top: boolean) { if (!top && n.hidden && !o.includeHidden) return; layerWarnings(n, [], w); (n.children || []).forEach(c => walk(c, false)); })(node, true);
  return w.filter(x => x.type !== 'text');
}
