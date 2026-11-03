// Minimal GIF reader for tests: palette, per-frame delays (centiseconds), transparency and decoded indices.
function lzw(data: Uint8Array, minSize: number, n: number) {
  const out = new Uint8Array(n); let o = 0;
  const clear = 1 << minSize, eoi = clear + 1;
  let size = minSize + 1, dict: number[][] = [], prev: number[] | null = null, bits = 0, acc = 0;
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = []; size = minSize + 1; prev = null; };
  reset();
  for (let p = 0; p < data.length; p++) {
    acc |= data[p] << bits; bits += 8;
    while (bits >= size) {
      const code = acc & ((1 << size) - 1); acc >>>= size; bits -= size;
      if (code === clear) { reset(); continue; }
      if (code === eoi) return out;
      let e: number[];
      if (code < dict.length) e = dict[code]; else e = prev!.concat(prev![0]);
      for (const v of e) if (o < n) out[o++] = v;
      if (prev) dict.push(prev.concat(e[0]));
      prev = e;
      if (dict.length === 1 << size && size < 12) size++;
    }
  }
  return out;
}
export function parseGif(b: Uint8Array) {
  let p = 6; const u16 = (o: number) => b[o] | b[o + 1] << 8;
  const W = u16(p), H = u16(p + 2), flags = b[p + 4]; p += 7;
  const gct = flags & 0x80 ? 1 << ((flags & 7) + 1) : 0; p += gct * 3;
  const frames: { delay: number; transparent: boolean; tIdx: number; dispose: number; idx: Uint8Array }[] = [];
  let gce: { delay: number; transparent: boolean; tIdx: number; dispose: number } | null = null;
  const sub = () => { const parts: number[] = []; while (b[p]) { for (let i = 1; i <= b[p]; i++) parts.push(b[p + i]); p += b[p] + 1; } p++; return Uint8Array.from(parts); };
  while (p < b.length) {
    const c = b[p++];
    if (c === 0x3b) break;
    if (c === 0x21) {
      const label = b[p++];
      if (label === 0xf9) { gce = { delay: u16(p + 2), transparent: !!(b[p + 1] & 1), tIdx: b[p + 4], dispose: (b[p + 1] >> 2) & 7 }; p += 6; }
      else sub();
    } else if (c === 0x2c) {
      const w = u16(p + 4), h = u16(p + 6), f = b[p + 8]; p += 9; if (f & 0x80) p += (1 << ((f & 7) + 1)) * 3;
      const min = b[p++];
      frames.push({ ...(gce || { delay: 0, transparent: false, tIdx: 0, dispose: 0 }), idx: lzw(sub(), min, w * h) }); gce = null;
    } else throw new Error('bad block ' + c);
  }
  return { W, H, gct, frames, total: frames.reduce((a, f) => a + f.delay, 0) };
}
