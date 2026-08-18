import { describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { ColorProbeValidationError, probePng } from '../../src/adapters/driving/tools/color-probe.js';

async function fixture(): Promise<Buffer> {
  const image = new Jimp({ width: 3, height: 3, color: 0x00000000 });
  const pixels = [
    [0x00ff0000, 0x0a00ff0a, 0x14f00a14],
    [0x1e1ee61e, 0x6496c850, 0x28282828],
    [0x32323232, 0x3c3c3c3c, 0xff4646ff],
  ];
  for (let y = 0; y < pixels.length; y += 1) {
    for (let x = 0; x < pixels[y].length; x += 1) image.setPixelColor(pixels[y][x], x, y);
  }
  return image.getBuffer('image/png');
}

describe('probePng', () => {
  it('maps normalized and pixel coordinates to the same integer source pixel', async () => {
    const buffer = await fixture();
    const normalized = await probePng(buffer, { x: 0.5, y: 0.5, space: 'normalized', radius: 0, tolerance: 2 });
    const pixel = await probePng(buffer, { x: 1, y: 1, space: 'pixel', radius: 0, tolerance: 2 });

    expect(normalized.source_coordinates).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    expect(pixel.source_coordinates).toEqual(normalized.source_coordinates);
    expect(normalized.center_rgba).toEqual({ r: 100, g: 150, b: 200, a: 80 });
  });

  it('uses per-channel medians for a clipped square sample, including alpha', async () => {
    const result = await probePng(await fixture(), {
      x: 1, y: 1, space: 'pixel', radius: 1, tolerance: 2,
    });
    const edge = await probePng(await fixture(), {
      x: 0, y: 0, space: 'pixel', radius: 1, tolerance: 2,
    });

    expect(result.sampled_rgba).toEqual({ r: 40, g: 60, b: 60, a: 40 });
    expect(edge.sampled_rgba).toEqual({ r: 20, g: 90, b: 215, a: 20 });
  });

  it('compares six-digit RGB and eight-digit RGBA expected colors with inclusive tolerance', async () => {
    const buffer = await fixture();
    const rgb = await probePng(buffer, {
      x: 1, y: 1, space: 'pixel', radius: 0, expected: '#6496c8', tolerance: 0,
    });
    const rgba = await probePng(buffer, {
      x: 1, y: 1, space: 'pixel', radius: 0, expected: '#6496c850', tolerance: 0,
    });
    const inclusive = await probePng(buffer, {
      x: 1, y: 1, space: 'pixel', radius: 0, expected: '#6395c7', tolerance: 1,
    });

    expect(rgb.matches_expected).toBe(true);
    expect(rgba.matches_expected).toBe(true);
    expect(inclusive.matches_expected).toBe(true);
  });

  it('rejects source coordinates outside the full-node raster with a validation error', async () => {
    await expect(probePng(await fixture(), {
      x: 3, y: 0, space: 'pixel', radius: 0, tolerance: 2,
    })).rejects.toBeInstanceOf(ColorProbeValidationError);
    await expect(probePng(await fixture(), {
      x: 1.01, y: 0, space: 'normalized', radius: 0, tolerance: 2,
    })).rejects.toBeInstanceOf(ColorProbeValidationError);
  });
});
