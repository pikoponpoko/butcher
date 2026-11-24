// PNG written and read without a canvas: straight alpha kept exactly.
import { expect, test } from 'vitest';
import { crc32, inflateSync } from 'node:zlib';
import { decodePng, encodePng } from '../src/core/png';

const image = (w: number, h: number) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i++) d[i] = (i * 7919 + (i >> 9) * 31) % 256; return d; };
const encode = (d: Uint8ClampedArray, w: number, h: number) => encodePng(w, h, (y, out) => out.set(d.subarray(y * w * 4, (y + 1) * w * 4)));

test('writes RGBA PNG chunks with valid checksums, the rows unfiltered', async () => {
  const w = 1500, h = 1500, d = image(w, h); // three bands of rows
  const b = Buffer.from(await (await encode(d, w, h)).arrayBuffer());
  expect([...b.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const types: string[] = [], idat: Buffer[] = [];
  for (let p = 8; p < b.length;) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8);
    expect(b.readUInt32BE(p + 8 + len)).toBe(crc32(b.subarray(p + 4, p + 8 + len)));
    types.push(type); if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    p += len + 12;
  }
  expect(types[0]).toBe('IHDR'); expect(types.at(-1)).toBe('IEND');
  expect([b.readUInt32BE(16), b.readUInt32BE(20), ...b.subarray(24, 29)]).toEqual([w, h, 8, 6, 0, 0, 0]);
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    expect(raw[y * (w * 4 + 1)]).toBe(0);
    expect(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)).equals(Buffer.from(d.buffer, y * w * 4, w * 4))).toBe(true);
  }
});

test('reads back exactly what it wrote, faint and semi-transparent pixels included', async () => {
  const w = 37, h = 23, d = image(w, h);
  const r = await decodePng(await encode(d, w, h));
  expect([r.width, r.height]).toEqual([w, h]);
  expect(r.data).toEqual(d);
  await expect(decodePng(new Blob(['not a png']))).rejects.toThrow();
});
