import { describe, expect, test } from 'vitest';
import type { PsdDoc, PsdNode } from '../src/core/psdcore';
import { alphaBounds, compositeDocument, compositeNode, listTargets, toRGBA8 } from '../src/core/psdcore';
import { loadSample, maxDiff, samples, sha } from './helpers';

describe.each(samples())('%s', name => {
  const psd = loadSample(name);

  test('document composite matches the merged image stored in the PSD', () => {
    const r = compositeDocument(psd);
    expect(r.warnings).toEqual([]);
    expect(maxDiff(toRGBA8(r.buf, r.W, r.H), psd.imageData!.data)).toBeLessThanOrEqual(2);
  });

  test('every layer and folder export is unchanged', () => {
    const out = listTargets(psd).map(t => {
      const r = compositeNode(psd, t.node);
      const rgba = toRGBA8(r.buf, r.W, r.H);
      return { kind: t.kind, path: [...t.path, t.node.name].join('/'), bounds: alphaBounds(rgba, r.W, r.H), sha: sha(rgba) };
    });
    expect(out).toMatchSnapshot();
  });
});

// 2x1 document: left pixel covered by both layers, right pixel only by the base.
const px = (left: number, rgba: number[][]): PsdNode => ({
  left, top: 0, right: left + rgba.length, bottom: 1,
  imageData: { width: rgba.length, height: 1, data: Uint8ClampedArray.from(rgba.flat()) },
});
const doc = (children: PsdNode[]): PsdDoc => ({ width: 2, height: 1, children });
const render = (d: PsdDoc) => { const r = compositeDocument(d); return [...toRGBA8(r.buf, r.W, r.H)]; };

describe('blending', () => {
  const base = { name: 'base', ...px(0, [[200, 100, 50, 255], [200, 100, 50, 255]]) };
  test('multiply', () => {
    expect(render(doc([base, { name: 'top', blendMode: 'multiply', ...px(0, [[128, 255, 0, 255]]) }])).slice(0, 4)).toEqual([100, 100, 0, 255]);
  });
  test('screen', () => {
    expect(render(doc([base, { name: 'top', blendMode: 'screen', ...px(0, [[255, 0, 0, 255]]) }])).slice(0, 4)).toEqual([255, 100, 50, 255]);
  });
  test('opacity', () => {
    expect(render(doc([base, { name: 'top', opacity: 0.5, ...px(0, [[0, 0, 0, 255]]) }])).slice(0, 4)).toEqual([100, 50, 25, 255]);
  });
  test('clipping stays inside the base shape', () => {
    const half = { name: 'base', ...px(0, [[255, 255, 255, 255]]) };
    const clip = { name: 'clip', clipping: true, ...px(0, [[255, 0, 0, 255], [255, 0, 0, 255]]) };
    expect(render(doc([half, clip]))).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
  });
  test('hidden layers are skipped unless included', () => {
    const d = doc([{ name: 'h', hidden: true, ...px(0, [[10, 20, 30, 255]]) }]);
    expect(render(d).slice(0, 4)).toEqual([0, 0, 0, 0]);
    const r = compositeDocument(d, { includeHidden: true });
    expect([...toRGBA8(r.buf, 2, 1)].slice(0, 4)).toEqual([10, 20, 30, 255]);
  });
  test('unsupported features are reported', () => {
    const d = doc([{ name: 'fx', effects: { dropShadow: [{ enabled: true }] }, ...px(0, [[0, 0, 0, 255]]) }]);
    expect(compositeDocument(d).warnings.map(w => w.type)).toEqual(['effects']);
  });
});

test('fully transparent pixels export as transparent black', () => {
  const buf = Float32Array.from([1, 0.5, 0.25, 0, 1, 1, 1, 1]);
  expect([...toRGBA8(buf, 2, 1)]).toEqual([0, 0, 0, 0, 255, 255, 255, 255]);
});

test('alphaBounds trims to opaque pixels', () => {
  const rgba = new Uint8ClampedArray(4 * 4 * 4);
  rgba[(1 * 4 + 2) * 4 + 3] = 255; rgba[(2 * 4 + 1) * 4 + 3] = 1;
  expect(alphaBounds(rgba, 4, 4)).toEqual({ x: 1, y: 1, w: 2, h: 2 });
  expect(alphaBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull();
});

// 1x1 layers with a 1x1 mask: the mask is applied once whether or not layers are clipped onto the base
describe('masks under clipping', () => {
  const one = (rgba: number[]): PsdNode => ({ left: 0, top: 0, right: 1, bottom: 1, imageData: { width: 1, height: 1, data: Uint8ClampedArray.from(rgba) } });
  const mask = (v: number) => ({ left: 0, top: 0, right: 1, bottom: 1, defaultColor: 0, imageData: { width: 1, height: 1, data: Uint8ClampedArray.from([v, v, v, 255]) } });
  const one1 = (children: PsdNode[]) => { const r = compositeDocument({ width: 1, height: 1, children }); return [...toRGBA8(r.buf, 1, 1)]; };
  const red = (): PsdNode => ({ name: 'clip', clipping: true, ...one([255, 0, 0, 255]) });
  const white = (extra: Partial<PsdNode> = {}): PsdNode => ({ name: 'base', ...one([255, 255, 255, 255]), mask: mask(128), ...extra });

  test('raster base: alpha stays 128 with a clipped layer', () => {
    expect(one1([white()])).toEqual([255, 255, 255, 128]);
    expect(one1([white(), red()])).toEqual([255, 0, 0, 128]);
  });
  test('raster base with layer opacity', () => {
    expect(one1([white({ opacity: 0.5 })])[3]).toBe(64);
    expect(one1([white({ opacity: 0.5 }), red()])).toEqual([255, 0, 0, 64]);
  });
  test('raster base with fill opacity', () => {
    expect(one1([white({ fillOpacity: 0.5 }), red()])[3]).toBe(one1([white({ fillOpacity: 0.5 })])[3]);
  });
  test('folder base with a mask', () => {
    const f = (o = 1): PsdNode => ({ name: 'f', opacity: o, children: [{ name: 'x', ...one([255, 255, 255, 255]) }], mask: mask(128) });
    expect(one1([f(), red()])).toEqual([255, 0, 0, 128]);
    expect(one1([f(0.5), red()])).toEqual([255, 0, 0, 64]);
  });
  test('over an opaque backdrop the clipped color shows at the mask strength', () => {
    const blue = { name: 'bg', ...one([0, 0, 255, 255]) };
    const ref = one1([blue, { name: 'r', ...one([255, 0, 0, 255]), mask: mask(128) }]);
    expect(one1([blue, white(), red()])).toEqual(ref);
  });
  test('isolated layer export keeps the mask once', () => {
    const d: PsdDoc = { width: 1, height: 1, children: [white(), red()] };
    const r = compositeNode(d, d.children![0]);
    expect([...toRGBA8(r.buf, 1, 1)][3]).toBe(128);
  });
});
