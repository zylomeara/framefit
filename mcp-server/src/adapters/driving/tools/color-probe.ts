import { Jimp } from 'jimp';

type Rgba = { r: number; g: number; b: number; a: number };

export interface ColorProbeResult {
  status: 'ok';
  source_coordinates: { x: number; y: number; width: number; height: number };
  center_rgba: Rgba;
  sampled_rgba: Rgba;
  radius: number;
  expected?: string;
  tolerance?: number;
  matches_expected?: boolean;
}

export class ColorProbeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ColorProbeValidationError';
  }
}

export async function probePng(
  buffer: Buffer,
  input: { x: number; y: number; space: 'normalized' | 'pixel'; radius: number; expected?: string; tolerance: number },
): Promise<ColorProbeResult> {
  const image = await Jimp.read(buffer);
  const { width, height } = image.bitmap;
  const x = resolveCoordinate(input.x, width, input.space);
  const y = resolveCoordinate(input.y, height, input.space);
  if (x < 0 || x >= width || y < 0 || y >= height) {
    throw new ColorProbeValidationError('probe coordinates are outside the rendered PNG');
  }

  const center = rgba(image.getPixelColor(x, y));
  const samples: Rgba[] = [];
  for (let sampleY = Math.max(0, y - input.radius); sampleY <= Math.min(height - 1, y + input.radius); sampleY += 1) {
    for (let sampleX = Math.max(0, x - input.radius); sampleX <= Math.min(width - 1, x + input.radius); sampleX += 1) {
      samples.push(rgba(image.getPixelColor(sampleX, sampleY)));
    }
  }
  const sampled = {
    r: median(samples.map((sample) => sample.r)),
    g: median(samples.map((sample) => sample.g)),
    b: median(samples.map((sample) => sample.b)),
    a: median(samples.map((sample) => sample.a)),
  };
  const expected = input.expected === undefined ? undefined : parseExpected(input.expected);

  return {
    status: 'ok',
    source_coordinates: { x, y, width, height },
    center_rgba: center,
    sampled_rgba: sampled,
    radius: input.radius,
    ...(input.expected === undefined ? {} : { expected: input.expected, tolerance: input.tolerance, matches_expected: matches(sampled, expected!, input.tolerance) }),
  };
}

function resolveCoordinate(value: number, size: number, space: 'normalized' | 'pixel'): number {
  if (!Number.isFinite(value)) throw new ColorProbeValidationError('probe coordinates must be finite numbers');
  if (space === 'normalized') {
    if (value < 0 || value > 1) throw new ColorProbeValidationError('normalized probe coordinates must be between 0 and 1');
    return Math.round(value * (size - 1));
  }
  return Math.round(value);
}

function rgba(color: number): Rgba {
  return { r: (color >>> 24) & 0xff, g: (color >>> 16) & 0xff, b: (color >>> 8) & 0xff, a: color & 0xff };
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2);
}

function parseExpected(value: string): Rgba {
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)) {
    throw new ColorProbeValidationError('expected color must be a six- or eight-digit hex color');
  }
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
    ...(value.length === 9 ? { a: Number.parseInt(value.slice(7, 9), 16) } : {}),
  } as Rgba;
}

function matches(sampled: Rgba, expected: Rgba, tolerance: number): boolean {
  const channels: (keyof Rgba)[] = expected.a === undefined ? ['r', 'g', 'b'] : ['r', 'g', 'b', 'a'];
  return channels.every((channel) => Math.abs(sampled[channel] - expected[channel]) <= tolerance);
}
