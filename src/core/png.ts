// PNG files of straight-alpha 8-bit RGBA, written and read here rather than through a canvas: a canvas keeps
// premultiplied alpha and rounds away the colour of faint edge pixels. Rows are unfiltered (on these drawings that
// compresses about as well as choosing a filter per row); deflate is the browser's.
const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(data.length + 12), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = -1;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 255] ^ (c >>> 8);
  dv.setUint32(8 + data.length, ~c >>> 0);
  return out;
}

// rows(y, out) fills out (zeroed, width × 4 bytes) with row y.
export async function encodePng(width: number, height: number, rows: (y: number, out: Uint8Array) => void): Promise<Blob> {
  const hdr = new Uint8Array(13), dv = new DataView(hdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height); hdr[8] = 8; hdr[9] = 6; // 8 bits, RGBA
  const parts: BlobPart[] = [new Uint8Array(SIG), chunk('IHDR', hdr)];
  const cs = new CompressionStream('deflate'), w = cs.writable.getWriter(), r = cs.readable.getReader();
  const reading = (async () => { for (;;) { const { done, value } = await r.read(); if (done) return; parts.push(chunk('IDAT', value)); } })();
  const stride = width * 4 + 1, band = Math.max(1, Math.floor((1 << 22) / stride));
  try {
    for (let y0 = 0; y0 < height; y0 += band) {
      const k = Math.min(band, height - y0), buf = new Uint8Array(k * stride); // each row: filter 0, then the pixels
      for (let j = 0; j < k; j++) rows(y0 + j, buf.subarray(j * stride + 1, (j + 1) * stride));
      await w.write(buf);
    }
    await w.close();
  } catch (e) { w.abort(e).catch(() => {}); throw e; }
  await reading;
  parts.push(chunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

// Reads back what encodePng writes.
export async function decodePng(blob: Blob): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const b = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(b.buffer);
  const bad = () => new Error('読み込めません');
  if (b.length < 33 || SIG.some((v, i) => b[i] !== v) || b[24] !== 8 || b[25] !== 6 || b[28] !== 0) throw bad();
  const width = dv.getUint32(16), height = dv.getUint32(20), idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= b.length;) {
    const len = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    if (type === 'IEND') break;
    p += len + 12;
  }
  const s = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(s).arrayBuffer());
  const n = width * 4, stride = n + 1, data = new Uint8ClampedArray(n * height);
  if (raw.length < stride * height) throw bad();
  for (let y = 0; y < height; y++) {
    if (raw[y * stride]) throw bad();
    data.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * n);
  }
  return { width, height, data };
}
