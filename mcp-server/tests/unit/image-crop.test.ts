import { describe, it, expect } from 'vitest';
import { Jimp } from 'jimp';
import { cropFocus } from '../../src/adapters/driving/tools/image-crop.js';

async function solidPng(w: number, h: number, color = 0x808080ff): Promise<Buffer> {
  return new Jimp({ width: w, height: h, color }).getBuffer('image/png');
}

describe('cropFocus', () => {
  it('crops a centered box sized by radius × width and reports the region', async () => {
    const src = await solidPng(200, 200);
    const { buffer, region } = await cropFocus(src, { focusX: 0.5, focusY: 0.5, radius: 0.1, maxPx: 512, marker: false });
    const out = await Jimp.read(buffer);
    expect(out.bitmap.width).toBe(40);   // 2 × 0.1 × 200
    expect(out.bitmap.height).toBe(40);
    expect(region.x).toBeCloseTo(0.4, 5);
    expect(region.y).toBeCloseTo(0.4, 5);
    expect(region.w).toBeCloseTo(0.2, 5);
    expect(region.h).toBeCloseTo(0.2, 5);
  });

  it('draws a reticle around the focus point but leaves the exact center untouched', async () => {
    const src = await solidPng(200, 200);
    const { buffer } = await cropFocus(src, { focusX: 0.5, focusY: 0.5, radius: 0.1, maxPx: 512, marker: true });
    const out = await Jimp.read(buffer);
    // focus is the center of the 40×40 crop at (20,20); gap keeps it the original gray
    expect(out.getPixelColor(20, 20)).toBe(0x808080ff);
    // a reticle tick MARKER_GAP px out is painted (not gray)
    expect(out.getPixelColor(20 + 4, 20)).not.toBe(0x808080ff);
  });

  it('clamps the box at the image edge without going out of bounds', async () => {
    const src = await solidPng(200, 200);
    const { region, buffer } = await cropFocus(src, { focusX: 0, focusY: 0.5, radius: 0.1, maxPx: 512, marker: false });
    const out = await Jimp.read(buffer);
    expect(out.bitmap.width).toBe(20);   // clamped to [0 .. 20]
    expect(out.bitmap.height).toBe(40);
    expect(region.x).toBe(0);
  });

  it('downscales when the crop exceeds maxPx', async () => {
    const src = await solidPng(200, 200);
    const { buffer } = await cropFocus(src, { focusX: 0.5, focusY: 0.5, radius: 0.5, maxPx: 64, marker: false });
    const out = await Jimp.read(buffer);
    expect(Math.max(out.bitmap.width, out.bitmap.height)).toBeLessThanOrEqual(64);
  });
});
