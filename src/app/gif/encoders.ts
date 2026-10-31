// GIF / animated WebP / MP4 encoders. Encoders: gifenc (GIF), canvas WebP frames muxed into an
// animated WebP here, WebCodecs + mp4-muxer (MP4). Libraries load on first export.
export interface EncodeOpts { fps: number; loop: number; useAlpha: boolean }

let gifLib: Promise<typeof import('gifenc')> | undefined, muxLib: Promise<typeof import('mp4-muxer')> | undefined;
let gifNow: typeof import('gifenc') | undefined;
export const loadGif = () => gifLib ||= import('gifenc').then(m => (gifNow = m));
export const gifLibNow = () => gifNow; // sync access once loaded, for per-frame previews
const loadMux = () => muxLib ||= import('mp4-muxer');

// ---------- GIF
export async function encodeGif(frames: Uint8ClampedArray[], W: number, H: number, colors: number, step: number, o: EncodeOpts) {
  const { GIFEncoder, quantize, applyPalette } = await loadGif();
  const useAlpha = o.useAlpha, delay = 1000 / o.fps * step;
  const pick = frames.filter((_, i) => i % step === 0);
  // one global palette from a sample of frames keeps colors stable and the file small
  const sampleN = Math.min(pick.length, 8), per = Math.max(1, Math.floor(W * H / 60000));
  const sample = new Uint8ClampedArray(sampleN * Math.ceil(W * H / per) * 4); let off = 0;
  for (let s = 0; s < sampleN; s++) { const f = pick[Math.floor(s * pick.length / sampleN)]; for (let p = 0; p < W * H; p += per) { sample.set(f.subarray(p * 4, p * 4 + 4), off); off += 4; } }
  const fmt = useAlpha ? 'rgba4444' : 'rgb565';
  const pal: number[][] = quantize(sample.subarray(0, off), useAlpha ? colors : colors - 1, useAlpha ? { format: fmt, oneBitAlpha: true } : { format: fmt });
  let tIdx = -1;
  if (useAlpha) { tIdx = pal.findIndex(c => c[3] === 0); if (tIdx < 0) { pal.push([0, 0, 0, 0]); tIdx = pal.length - 1; } }
  const full = useAlpha ? pal : pal.concat([[0, 0, 0]]); // extra entry = "unchanged" marker for frame deltas
  const enc = GIFEncoder(); let prev: Uint8Array | null = null;
  for (let i = 0; i < pick.length; i++) {
    const idx = applyPalette(pick[i], pal, fmt);
    const opt: Record<string, unknown> = { palette: i === 0 ? full : undefined, delay, repeat: o.loop === 0 ? 0 : o.loop === 1 ? -1 : o.loop - 1 };
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
  return new Blob([enc.bytes() as Uint8Array<ArrayBuffer>], { type: 'image/gif' });
}

// ---------- animated WebP (frames encoded by the browser, muxed here)
export const webpOK = (() => { try { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL('image/webp').startsWith('data:image/webp'); } catch { return false; } })();
function riffChunks(u8: Uint8Array) {
  const out: Record<string, Uint8Array> = {}; let p = 12;
  while (p + 8 <= u8.length) { const id = String.fromCharCode(...u8.subarray(p, p + 4)), n = u8[p + 4] | u8[p + 5] << 8 | u8[p + 6] << 16 | u8[p + 7] << 24; out[id] = u8.subarray(p, p + 8 + n + (n & 1)); p += 8 + n + (n & 1); }
  return out;
}
function chunk(id: string, payload: Uint8Array) {
  const n = payload.length, b = new Uint8Array(8 + n + (n & 1));
  for (let i = 0; i < 4; i++) b[i] = id.charCodeAt(i);
  b[4] = n & 255; b[5] = n >> 8 & 255; b[6] = n >> 16 & 255; b[7] = n >>> 24; b.set(payload, 8); return b;
}
const u24 = (v: number) => [v & 255, v >> 8 & 255, v >> 16 & 255];
export async function encodeWebp(frames: Uint8ClampedArray[], W: number, H: number, q: number, step: number, o: EncodeOpts, status: (s: string) => void) {
  const c = new OffscreenCanvas(W, H), ctx = c.getContext('2d')!, dur = Math.round(1000 / o.fps * step);
  const parts: Uint8Array[] = [];
  let i = 0;
  for (let f = 0; f < frames.length; f += step) {
    ctx.putImageData(new ImageData(frames[f] as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0);
    const u8 = new Uint8Array(await (await c.convertToBlob({ type: 'image/webp', quality: q })).arrayBuffer()), ch = riffChunks(u8);
    const data = ch['VP8 '] ? [ch.ALPH, ch['VP8 ']].filter(Boolean) : [ch.VP8L];
    const hdr = new Uint8Array([0, 0, 0, 0, 0, 0, ...u24(W - 1), ...u24(H - 1), ...u24(dur), 0b10]);
    const len = data.reduce((a, d) => a + d.length, hdr.length), pay = new Uint8Array(len); let off = 0;
    pay.set(hdr, off); off += hdr.length; for (const d of data) { pay.set(d, off); off += d.length; }
    parts.push(chunk('ANMF', pay));
    if (++i % 4 === 0) status(`WebP作成 ${f + 1}/${frames.length}`);
  }
  const vp8x = chunk('VP8X', new Uint8Array([0x02 | 0x10, 0, 0, 0, ...u24(W - 1), ...u24(H - 1)]));
  const loops = o.loop === 0 ? 0 : o.loop;
  const anim = chunk('ANIM', new Uint8Array([0, 0, 0, 0, loops & 255, loops >> 8]));
  const body = [vp8x, anim, ...parts], size = body.reduce((a, b) => a + b.length, 4);
  const head = new Uint8Array(12); head.set([82, 73, 70, 70, size & 255, size >> 8 & 255, size >> 16 & 255, size >>> 24, 87, 69, 66, 80]);
  return new Blob([head, ...body] as BlobPart[], { type: 'image/webp' });
}

// ---------- MP4 (H.264 via WebCodecs), streamed so long clips don't sit in memory
export async function encodeMp4(W: number, H: number, fps: number, n: number, targetMB: number,
  capture: (onFrame: (i: number, n: number, c: OffscreenCanvas) => Promise<void>) => Promise<void>, status: (s: string) => void) {
  if (typeof VideoEncoder === 'undefined') throw new Error('このブラウザはMP4書き出しに対応していません');
  const M = await loadMux(), secs = n / fps;
  const bitrate = targetMB ? Math.max(100e3, targetMB * 8 * 1048576 / secs * 0.95) : Math.max(1e6, Math.min(20e6, W * H * fps * 0.12));
  let config: VideoEncoderConfig | null = null;
  for (const codec of ['avc1.640033', 'avc1.4d0033', 'avc1.42e033', 'avc1.640028', 'avc1.42e01f']) {
    const c: VideoEncoderConfig = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; break; } } catch {}
  }
  if (!config) throw new Error('この解像度のMP4はこのブラウザで書き出せません');
  const muxer = new M.Muxer({ target: new M.ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H, frameRate: fps }, fastStart: 'in-memory' });
  let err: unknown = null;
  const enc = new VideoEncoder({ output: (ch, meta) => muxer.addVideoChunk(ch, meta), error: e => { err = e; } });
  enc.configure(config);
  await capture(async (i, n, c) => {
    if (err) throw err;
    status(`MP4作成 ${i + 1}/${n}`);
    const fr = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    enc.encode(fr, { keyFrame: i % Math.round(fps * 2) === 0 }); fr.close();
    while (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 5));
  });
  await enc.flush(); if (err) throw err; enc.close(); muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
