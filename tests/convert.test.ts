import { expect, test } from 'vitest';
import { CONV_INIT, extFor, outSize, ruleName } from '../src/app/conv/convert';

const o = (p: Partial<typeof CONV_INIT>) => ({ ...CONV_INIT, ...p });
test('size rules apply to the rotated result', () => {
  expect(outSize(o({ size: 'long', px: '1000' }), 4000, 3000)).toEqual({ w: 1000, h: 750 });
  expect(outSize(o({ size: 'long', px: '1000', rot: '90' }), 4000, 3000)).toEqual({ w: 750, h: 1000 });
  expect(outSize(o({ size: 'w', px: '800', rot: '270' }), 4000, 3000)).toEqual({ w: 800, h: 1067 });
  expect(outSize(o({ size: 'h', px: '300' }), 4000, 3000)).toEqual({ w: 400, h: 300 });
  expect(outSize(o({ size: 'pct', pct: '25' }), 4000, 3000)).toEqual({ w: 1000, h: 750 });
  expect(outSize(o({ size: 'orig', rot: '180' }), 40, 30)).toEqual({ w: 40, h: 30 });
});
test('no upscaling keeps small images at full size', () => {
  expect(outSize(o({ size: 'long', px: '1920', noUp: true }), 800, 600)).toEqual({ w: 800, h: 600 });
  expect(outSize(o({ size: 'long', px: '1600', noUp: false }), 800, 600)).toEqual({ w: 1600, h: 1200 });
  expect(outSize(o({ size: 'pct', pct: '200', noUp: true }), 800, 600)).toEqual({ w: 800, h: 600 });
});
test('naming: prefix / suffix or text + zero-padded number', () => {
  expect(ruleName(o({ prefix: 'a_', suffix: '_b' }), 'photo', 4)).toBe('a_photo_b');
  expect(ruleName(o({ naming: 'seq', seqText: 'img_', seqStart: '1', seqDigits: '3' }), 'photo', 0)).toBe('img_001');
  expect(ruleName(o({ naming: 'seq', seqText: 'x', seqStart: '98', seqDigits: '2' }), 'photo', 3)).toBe('x101');
  expect(ruleName(o({ naming: 'seq', seqText: '', seqStart: '', seqDigits: '' }), 'photo', 1)).toBe('002');
});
test('original format keeps JPEG / PNG / WebP, others become PNG', () => {
  expect(['a.JPG', 'b.webp', 'c.gif', 'd.bmp', 'e.png'].map(n => extFor('orig', n))).toEqual(['jpg', 'webp', 'png', 'png', 'png']);
  expect(extFor('jpeg', 'a.png')).toBe('jpg');
});
