import { describe, expect, it } from 'vitest';
import { detectPanels } from '../src/app/image/panels';

// tiny raster: white page, black strokes
function page(W: number, H: number, bg = [255, 255, 255, 255]) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) px.set(bg, i * 4);
  const fill = (x: number, y: number, w: number, h: number, c = [0, 0, 0, 255]) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px.set(c, (j * W + i) * 4);
  };
  const frame = (x: number, y: number, w: number, h: number, t = 3) => {
    fill(x, y, w, t); fill(x, y + h - t, w, t); fill(x, y, t, h); fill(x + w - t, y, t, h);
    fill(x + w / 3, y + h / 3, w / 4, 4); fill(x + w / 2, y + h / 4, 3, h / 3); // drawing inside
  };
  return { px, fill, frame };
}

describe('detectPanels', () => {
  it('finds a vertical 4-koma strip with a title above', () => {
    const { px, fill, frame } = page(300, 900);
    fill(100, 10, 100, 12); // title text
    for (let i = 0; i < 4; i++) frame(20, 40 + i * 210, 260, 200);
    expect(detectPanels(px, 300, 900)).toEqual([0, 1, 2, 3].map(i => ({ x: 20, y: 40 + i * 210, w: 260, h: 200 })));
  });

  it('reads two 4-koma columns right column first', () => {
    const { px, frame } = page(600, 900);
    for (const x of [320, 20]) for (let i = 0; i < 4; i++) frame(x, 40 + i * 210, 260, 200);
    const r = detectPanels(px, 600, 900);
    expect(r.map(p => [p.x, p.y])).toEqual([[320, 40], [320, 250], [320, 460], [320, 670], [20, 40], [20, 250], [20, 460], [20, 670]]);
  });

  it('splits panels that share a border line', () => {
    const { px, fill, frame } = page(500, 500);
    frame(10, 10, 480, 480);
    fill(10, 248, 480, 3); fill(248, 10, 3, 480);
    const r = detectPanels(px, 500, 500);
    expect(r).toEqual([
      { x: 248, y: 10, w: 242, h: 241 }, { x: 10, y: 10, w: 241, h: 241 },
      { x: 248, y: 248, w: 242, h: 242 }, { x: 10, y: 248, w: 241, h: 242 },
    ]);
  });

  it('keeps a solid black panel whole and finds panels cropped tight to the frame', () => {
    const { px, fill, frame } = page(260, 830);
    frame(0, 0, 260, 200); frame(0, 210, 260, 200); fill(0, 420, 260, 200); frame(0, 630, 260, 200);
    expect(detectPanels(px, 260, 830)).toEqual([0, 210, 420, 630].map(y => ({ x: 0, y, w: 260, h: 200 })));
  });

  it('separates panels when drawing breaks out across the gutter', () => {
    const { px, fill, frame } = page(300, 450);
    frame(20, 20, 260, 200); frame(20, 230, 260, 200);
    fill(120, 150, 30, 150); // hair sticking out of panel 1 into panel 2
    expect(detectPanels(px, 300, 450)).toEqual([{ x: 20, y: 20, w: 260, h: 200 }, { x: 20, y: 230, w: 260, h: 200 }]);
  });

  it('works on a transparent background', () => {
    const { px, frame } = page(300, 450, [0, 0, 0, 0]);
    frame(20, 20, 260, 200); frame(20, 230, 260, 200);
    expect(detectPanels(px, 300, 450)).toHaveLength(2);
  });

  it('ignores unframed drawings and speech balloons inside panels', () => {
    const { px, fill, frame } = page(400, 400);
    fill(30, 30, 120, 2); fill(30, 30, 2, 120); // stroke, no frame
    frame(180, 180, 200, 200); frame(200, 200, 60, 60); // inner box inside a panel
    expect(detectPanels(px, 400, 400)).toEqual([{ x: 180, y: 180, w: 200, h: 200 }]);
  });
});
