// Source decoding for the 変換 tool: browser formats, small built-in decoders (TGA, PNM, QOI), Photoshop / CLIP STUDIO
// composites and the preview JPEG embedded in camera RAW files. Everything runs on the device.
import { loadPsd } from '../lazy';

const NATIVE = /\.(png|jpe?g|jfif|webp|gif|bmp|avif|ico|cur)$/i;
// formats an <img> shows as-is
export const SHOWN_RE = /\.(png|jpe?g|jfif|webp|gif|bmp|avif|ico|cur|svg)$/i;
export const RAW_RE = /\.(cr2|cr3|crw|nef|nrw|arw|srf|sr2|dng|orf|rw2|raf|pef|srw|x3f|3fr|erf|kdc|mrw|iiq|rwl|mos|mef)$/i;
export const CONV_RE = /\.(png|jpe?g|jfif|webp|gif|bmp|avif|ico|cur|svg|tga|pbm|pgm|ppm|pnm|qoi|tif|tiff|heic|heif|hif|jxl|psd|psb|clip|pdf|cr2|cr3|crw|nef|nrw|arw|srf|sr2|dng|orf|rw2|raf|pef|srw|x3f|3fr|erf|kdc|mrw|iiq|rwl|mos|mef)$/i;
export const CONV_EXTS = ['.png', '.jpg', '.jpeg', '.jfif', '.webp', '.gif', '.bmp', '.avif', '.ico', '.cur', '.svg', '.tga', '.pbm', '.pgm', '.ppm', '.pnm', '.qoi', '.tif', '.tiff', '.heic', '.heif', '.hif', '.jxl', '.psd', '.psb', '.clip', '.pdf',
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng', '.orf', '.rw2', '.raf', '.pef', '.srw', '.x3f', '.3fr', '.erf', '.kdc', '.mrw', '.iiq', '.rwl', '.mos', '.mef'];
export const CONV_FORMATS = 'JPEG · PNG · WebP · GIF · BMP · AVIF · ICO · SVG · TIFF · HEIC · JPEG XL · TGA · PNM · QOI · PSD · CLIP · PDF · RAW';

const ORIENT = { imageOrientation: 'from-image' } as ImageBitmapOptions;
const fromPixels = (data: Uint8ClampedArray, w: number, h: number) => createImageBitmap(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h));

// Decoded source, oriented upright. The caller owns (and closes) the bitmap.
export async function decode(file: Blob, name: string): Promise<ImageBitmap> {
  if (NATIVE.test(name)) return createImageBitmap(file, ORIENT);
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'svg') return svg(file);
  if (RAW_RE.test(name)) return raw(new Uint8Array(await file.arrayBuffer()));
  const buf = await file.arrayBuffer(), u8 = new Uint8Array(buf);
  if (ext === 'tga') { const r = tga(u8); return fromPixels(r.data, r.w, r.h); }
  if (/^p[bgpn]m$/.test(ext)) { const r = pnm(u8); return fromPixels(r.data, r.w, r.h); }
  if (ext === 'qoi') { const r = qoi(u8); return fromPixels(r.data, r.w, r.h); }
  if (ext === 'tif' || ext === 'tiff') return tiff(buf);
  if (ext === 'heic' || ext === 'heif' || ext === 'hif') return heic(u8);
  if (ext === 'jxl') { const { default: dec } = await import('@jsquash/jxl/decode.js'); return createImageBitmap(await dec(buf)); }
  if (ext === 'psd' || ext === 'psb' || ext === 'clip') return layered(name, buf);
  // unknown extension: let the browser try
  return createImageBitmap(file, ORIENT);
}

async function svg(file: Blob) {
  const url = URL.createObjectURL(file.type ? file : new Blob([file], { type: 'image/svg+xml' }));
  try {
    const img = new Image(); img.src = url; await img.decode();
    // vector: drawn at its own size (300×150 when the file gives none)
    const w = img.naturalWidth || 300, h = img.naturalHeight || 150;
    return await createImageBitmap(img, { resizeWidth: w, resizeHeight: h });
  } finally { URL.revokeObjectURL(url); }
}

// Photoshop: the saved composite when the file has one (fast), otherwise the layers are composited.
async function layered(name: string, buf: ArrayBuffer) {
  if (!/\.clip$/i.test(name)) {
    const { readPsd } = await loadPsd();
    const p = readPsd(buf, { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
    const id = p.imageData;
    if (id && id.width && id.height) return fromPixels(new Uint8ClampedArray(id.data.buffer, id.data.byteOffset, id.data.byteLength), id.width, id.height);
  }
  const { openFile, renderNode } = await import('../image/model');
  const r = renderNode(await openFile(name, buf, true), null, false);
  return fromPixels(r.rgba, r.W, r.H);
}

// ---------- TGA (uncompressed and RLE; color-mapped, true-color, grayscale)
export function tga(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const idLen = b[0], cmType = b[1], type = b[2], cmFirst = v.getUint16(3, true), cmLen = v.getUint16(5, true), cmBits = b[7];
  const w = v.getUint16(12, true), h = v.getUint16(14, true), bpp = b[16], desc = b[17];
  if (!w || !h || ![1, 2, 3, 9, 10, 11].includes(type)) throw new Error('TGA');
  let p = 18 + idLen;
  const cmBytes = Math.ceil(cmBits / 8), cmap = cmType ? b.subarray(p, p + cmLen * cmBytes) : null; p += cmType ? cmLen * cmBytes : 0;
  const px = Math.ceil(bpp / 8), n = w * h, raw = new Uint8Array(n * px);
  if (type >= 9) {
    for (let i = 0; i < raw.length;) {
      const c = b[p++], k = (c & 127) + 1;
      if (c & 128) { const s = b.subarray(p, p + px); p += px; for (let j = 0; j < k && i < raw.length; j++, i += px) raw.set(s, i); }
      else { const m = Math.min(k * px, raw.length - i); raw.set(b.subarray(p, p + m), i); p += k * px; i += m; }
    }
  } else raw.set(b.subarray(p, p + raw.length));
  const out = new Uint8ClampedArray(n * 4), alpha = (desc & 15) > 0;
  const col = (s: Uint8Array, o: number, bits: number, d: number) => {
    if (bits === 8) { out[d] = out[d + 1] = out[d + 2] = s[o]; out[d + 3] = 255; }
    else if (bits === 15 || bits === 16) { const x = s[o] | s[o + 1] << 8; out[d] = (x >> 10 & 31) * 255 / 31; out[d + 1] = (x >> 5 & 31) * 255 / 31; out[d + 2] = (x & 31) * 255 / 31; out[d + 3] = bits === 16 && alpha && !(x & 0x8000) ? 0 : 255; }
    else { out[d] = s[o + 2]; out[d + 1] = s[o + 1]; out[d + 2] = s[o]; out[d + 3] = bits === 32 && alpha ? s[o + 3] : 255; }
  };
  const top = (desc & 32) !== 0, right = (desc & 16) !== 0, gray = type === 3 || type === 11, mapped = type === 1 || type === 9;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * px, d = (((top ? y : h - 1 - y) * w) + (right ? w - 1 - x : x)) * 4;
    if (mapped) { const k = (px === 2 ? raw[i] | raw[i + 1] << 8 : raw[i]) - cmFirst; col(cmap!, k * cmBytes, cmBits === 24 || cmBits === 32 ? cmBits : cmBits, d); }
    else if (gray) { out[d] = out[d + 1] = out[d + 2] = raw[i]; out[d + 3] = bpp === 16 ? raw[i + 1] : 255; }
    else col(raw, i, bpp, d);
  }
  return { data: out, w, h };
}

// ---------- PBM / PGM / PPM (P1–P6)
export function pnm(b: Uint8Array) {
  let p = 0;
  const tok = () => {
    for (;;) {
      while (p < b.length && /\s/.test(String.fromCharCode(b[p]))) p++;
      if (b[p] === 35) { while (p < b.length && b[p] !== 10 && b[p] !== 13) p++; continue; }
      break;
    }
    let s = ''; while (p < b.length && !/\s/.test(String.fromCharCode(b[p]))) s += String.fromCharCode(b[p++]);
    return s;
  };
  const m = tok(); if (!/^P[1-6]$/.test(m)) throw new Error('PNM');
  const k = +m[1], w = +tok(), h = +tok(), max = k === 1 || k === 4 ? 1 : +tok();
  if (!w || !h || !max) throw new Error('PNM');
  p++; // the single whitespace after the header
  const out = new Uint8ClampedArray(w * h * 4), ch = k === 3 || k === 6 ? 3 : 1, wide = max > 255;
  const asc = () => +tok();
  for (let i = 0; i < w * h; i++) {
    const d = i * 4; let c: number[];
    if (k === 1) c = [asc() ? 0 : 255];
    else if (k === 4) { const y = (i / w) | 0, x = i % w, bit = b[p + y * Math.ceil(w / 8) + (x >> 3)] >> (7 - (x & 7)) & 1; c = [bit ? 0 : 255]; }
    else if (k <= 3) c = Array.from({ length: ch }, () => asc() * 255 / max);
    else c = Array.from({ length: ch }, (_, j) => { const o = p + (i * ch + j) * (wide ? 2 : 1); return (wide ? b[o] << 8 | b[o + 1] : b[o]) * 255 / max; });
    out[d] = c[0]; out[d + 1] = c[ch === 3 ? 1 : 0]; out[d + 2] = c[ch === 3 ? 2 : 0]; out[d + 3] = 255;
  }
  return { data: out, w, h };
}

// ---------- QOI
export function qoi(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(0) !== 0x716f6966) throw new Error('QOI');
  const w = v.getUint32(4), h = v.getUint32(8), out = new Uint8ClampedArray(w * h * 4), idx = new Uint8Array(256);
  let r = 0, g = 0, bl = 0, a = 255, p = 14, run = 0;
  for (let d = 0; d < out.length; d += 4) {
    if (run > 0) run--;
    else {
      const c = b[p++];
      if (c === 0xfe) { r = b[p++]; g = b[p++]; bl = b[p++]; }
      else if (c === 0xff) { r = b[p++]; g = b[p++]; bl = b[p++]; a = b[p++]; }
      else if ((c & 0xc0) === 0x00) { const i = (c & 63) * 4; r = idx[i]; g = idx[i + 1]; bl = idx[i + 2]; a = idx[i + 3]; }
      else if ((c & 0xc0) === 0x40) { r = (r + ((c >> 4) & 3) - 2) & 255; g = (g + ((c >> 2) & 3) - 2) & 255; bl = (bl + (c & 3) - 2) & 255; }
      else if ((c & 0xc0) === 0x80) { const c2 = b[p++], dg = (c & 63) - 32; r = (r + dg - 8 + ((c2 >> 4) & 15)) & 255; g = (g + dg) & 255; bl = (bl + dg - 8 + (c2 & 15)) & 255; }
      else run = c & 63;
      const i = ((r * 3 + g * 5 + bl * 7 + a * 11) % 64) * 4; idx[i] = r; idx[i + 1] = g; idx[i + 2] = bl; idx[i + 3] = a;
    }
    out[d] = r; out[d + 1] = g; out[d + 2] = bl; out[d + 3] = a;
  }
  return { data: out, w, h };
}

// ---------- camera RAW: the largest baseline / progressive JPEG stored inside (the camera's own full-size or large preview)
export function rawPreview(b: Uint8Array): { start: number; end: number; w: number; h: number; exifOrient: number } | null {
  let best: ReturnType<typeof rawPreview> = null;
  for (let s = 0; (s = b.indexOf(0xff, s)) >= 0 && s < b.length - 4; s++) {
    if (b[s + 1] !== 0xd8 || b[s + 2] !== 0xff) continue;
    const j = jpegSpan(b, s); if (!j) continue;
    if (!best || j.w * j.h > best.w * best.h) best = j;
    s = j.end - 1;
  }
  return best;
}
function jpegSpan(b: Uint8Array, s: number) {
  let p = s + 2, w = 0, h = 0, ok = false, exifOrient = 0;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd9) return null;
    const len = b[p + 2] << 8 | b[p + 3]; if (len < 2) return null;
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) { h = b[p + 5] << 8 | b[p + 6]; w = b[p + 7] << 8 | b[p + 8]; ok = true; }
    else if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return null; // lossless (raw sensor data) and others the browser can't show
    else if (m === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) exifOrient = tiffOrientation(b, p + 10, p + 2 + len) || 0;
    if (m === 0xda) {
      // entropy-coded data runs to the first marker that isn't a stuffed byte or a restart marker
      let q = p + 2 + len;
      for (;;) {
        q = b.indexOf(0xff, q); if (q < 0 || q + 1 >= b.length) return null;
        const n = b[q + 1];
        if (n === 0 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) { q++; continue; }
        if (n === 0xd9) return ok && w > 0 && h > 0 ? { start: s, end: q + 2, w, h, exifOrient } : null;
        if (n === 0xc4 || n === 0xda || n === 0xdd || (n >= 0xe0 && n <= 0xef) || n === 0xfe || n === 0xdb) { p = q; break; } // progressive: more scans follow
        return null;
      }
      continue;
    }
    p += 2 + len;
  }
  return null;
}
// EXIF / TIFF orientation tag (0x0112) in IFD0 of the TIFF structure starting at `t`.
export function tiffOrientation(b: Uint8Array, t: number, end = b.length) {
  if (t + 8 > end) return 0;
  const le = b[t] === 0x49 && b[t + 1] === 0x49, be = b[t] === 0x4d && b[t + 1] === 0x4d; if (!le && !be) return 0;
  const u16 = (o: number) => le ? b[o] | b[o + 1] << 8 : b[o] << 8 | b[o + 1];
  const u32 = (o: number) => (le ? b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24 : b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
  if (u16(t + 2) !== 42) return 0;
  const ifd = t + u32(t + 4); if (ifd + 2 > end) return 0;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (e + 12 > end) return 0; if (u16(e) === 0x112) return u16(e + 8); }
  return 0;
}
async function raw(b: Uint8Array) {
  const j = rawPreview(b); if (!j) throw new Error('RAW');
  const jpg = new Blob([b.subarray(j.start, j.end) as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
  if (j.exifOrient > 1) return createImageBitmap(jpg, ORIENT);
  // the RAW's own orientation (TIFF-based RAWs, and the TIFF block inside CR3)
  let o = 0;
  for (let s = 0; s < Math.min(b.length, 1 << 20) && !o; s++) if ((b[s] === 0x49 && b[s + 1] === 0x49 && b[s + 2] === 42 && b[s + 3] === 0) || (b[s] === 0x4d && b[s + 1] === 0x4d && b[s + 2] === 0 && b[s + 3] === 42)) o = tiffOrientation(b, s) || -1;
  return orient(await createImageBitmap(jpg, { imageOrientation: 'none' } as ImageBitmapOptions), o);
}

// EXIF orientation 2–8 applied to a bitmap decoded as stored.
async function orient(bmp: ImageBitmap, o: number) {
  if (o < 2 || o > 8) return bmp;
  const sw = o >= 5, W = bmp.width, H = bmp.height, c = document.createElement('canvas'); c.width = sw ? H : W; c.height = sw ? W : H;
  const ctx = c.getContext('2d')!;
  // [a, b, c, d, e, f] maps stored pixels to upright ones
  const m: Record<number, number[]> = { 2: [-1, 0, 0, 1, W, 0], 3: [-1, 0, 0, -1, W, H], 4: [1, 0, 0, -1, 0, H], 5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, H, 0], 7: [0, -1, -1, 0, H, W], 8: [0, -1, 1, 0, 0, W] };
  ctx.setTransform(...(m[o] as [number, number, number, number, number, number])); ctx.drawImage(bmp, 0, 0); bmp.close();
  const out = await createImageBitmap(c); c.width = c.height = 0; return out;
}

// TIFF: the largest page (others are usually thumbnails), with its orientation tag
async function tiff(buf: ArrayBuffer) {
  const UTIF = (await import('utif')).default;
  const ifds = UTIF.decode(buf); if (!ifds.length) throw new Error('TIFF');
  const size = (d: any) => (d.t256?.[0] || 0) * (d.t257?.[0] || 0);
  const d = ifds.reduce((a: any, b: any) => size(b) > size(a) ? b : a);
  UTIF.decodeImage(buf, d, ifds);
  const rgba = UTIF.toRGBA8(d), w = d.width, h = d.height;
  return orient(await fromPixels(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), d.t274?.[0] || 1);
}

// HEIC / HEIF (iPhone photos): libheif, loaded only when one is opened. Rotation stored in the file is applied by libheif.
async function heic(u8: Uint8Array) {
  const lib = (await import('libheif-js/libheif-wasm/libheif-bundle.mjs')).default();
  if (lib.ready) await lib.ready;
  const dec = new lib.HeifDecoder(), imgs = dec.decode(u8);
  if (!imgs?.length) throw new Error('HEIC');
  const img = imgs[0], w = img.get_width(), h = img.get_height();
  try {
    const data = await new Promise<ImageData>((res, rej) => img.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (d: ImageData | null) => d ? res(d) : rej(new Error('HEIC'))));
    return await createImageBitmap(new ImageData(data.data as Uint8ClampedArray<ArrayBuffer>, w, h));
  } finally { for (const i of imgs) i.free?.(); }
}
