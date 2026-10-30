import { describe, expect, it } from 'vitest';
import { icoFile } from '../src/app/image/exporter';

describe('icoFile', () => {
  it('writes an ICO directory pointing at each PNG entry', async () => {
    const pngs = [new Blob([new Uint8Array(10).fill(1)]), new Blob([new Uint8Array(20).fill(2)]), new Blob([new Uint8Array(30).fill(3)])];
    const b = new Uint8Array(await (await icoFile(pngs, [16, 32, 48])).arrayBuffer()), v = new DataView(b.buffer);
    expect([v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true)]).toEqual([0, 1, 3]);
    let off = 6 + 16 * 3;
    [16, 32, 48].forEach((n, i) => {
      const e = 6 + 16 * i;
      expect([b[e], b[e + 1], v.getUint16(e + 6, true), v.getUint32(e + 8, true), v.getUint32(e + 12, true)]).toEqual([n, n, 32, pngs[i].size, off]);
      expect(b[off]).toBe(i + 1);
      off += pngs[i].size;
    });
    expect(b.length).toBe(off);
  });
});
