import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { pnm, qoi, rawPreview, tga, tiffOrientation } from '../src/app/conv/decode';

const f = (n: string) => new Uint8Array(readFileSync(new URL('./fixtures/conv/' + n, import.meta.url)));
const PX = [[255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 255, 255], [10, 20, 30, 255], [255, 255, 255, 0]];
const at = (r: { data: Uint8ClampedArray; w: number }, x: number, y: number) => [...r.data.subarray((y * r.w + x) * 4, (y * r.w + x) * 4 + 4)];

test('TGA: plain and RLE, alpha, top/bottom origin', () => {
  for (const n of ['a.tga', 'a_rle.tga']) {
    const r = tga(f(n)); expect([r.w, r.h]).toEqual([5, 3]);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) { const p = PX[(x + y) % 5]; expect(at(r, x, y)).toEqual(p[3] === 0 ? [p[0], p[1], p[2], 0] : p); }
  }
});
test('QOI', () => {
  const r = qoi(f('a.qoi')); expect([r.w, r.h]).toEqual([5, 3]);
  expect(at(r, 1, 0)).toEqual(PX[1]); expect(at(r, 4, 2)).toEqual(PX[1]);
});
test('PNM: binary PPM / PGM / PBM and ASCII PPM', () => {
  expect(at(pnm(f('a.ppm')), 0, 0)).toEqual([255, 0, 0, 255]);
  expect(at(pnm(f('a.ppm')), 3, 0)).toEqual([10, 20, 30, 255]);
  const g = pnm(f('a.pgm')); expect([g.w, g.h]).toEqual([5, 3]); expect(at(g, 0, 0)[0]).toBe(at(g, 0, 0)[2]);
  const b = pnm(f('a.pbm')); expect(at(b, 4, 0)).toEqual([255, 255, 255, 255]);
  const a = pnm(f('b.ppm')); expect([at(a, 0, 0), at(a, 1, 0)]).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]]);
});
test('RAW: the largest embedded JPEG is picked, lossless data and junk are skipped, TIFF orientation is read', () => {
  const b = f('fake.nef'), j = rawPreview(b)!;
  expect([j.w, j.h]).toEqual([64, 48]);
  expect([b[j.start], b[j.start + 1], b[j.end - 2], b[j.end - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  expect(tiffOrientation(b, 0)).toBe(6);
});
