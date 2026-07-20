import { Jimp } from 'jimp';

export interface CropFocusOpts {
  focusX: number;   // 0..1, horizontal focus within the source image
  focusY: number;   // 0..1, vertical focus within the source image
  radius: number;   // 0..0.5, half-box size as a fraction of source WIDTH
  maxPx: number;    // longest side of the returned crop; downscale ceiling
  marker: boolean;  // draw a center-gap reticle at the focus point
}

export interface CropFocusResult {
  buffer: Buffer;   // PNG bytes of the crop
  region: { x: number; y: number; w: number; h: number }; // cropped box as fractions of the source
}

type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

const MARKER_GAP = 4;
const MARKER_LEN = 10;

// Four short ticks around the point, NOT crossing it (gap), alternating
// black/white so the marker is visible on any background and never hides the target.
function drawReticle(img: JimpImage, mx: number, my: number): void {
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const put = (x: number, y: number, i: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    img.setPixelColor(i % 2 === 0 ? 0x000000ff : 0xffffffff, x, y);
  };
  for (let d = MARKER_GAP; d < MARKER_GAP + MARKER_LEN; d++) {
    const i = d - MARKER_GAP;
    put(mx + d, my, i);
    put(mx - d, my, i);
    put(mx, my + d, i);
    put(mx, my - d, i);
  }
}

export async function cropFocus(input: Buffer, opts: CropFocusOpts): Promise<CropFocusResult> {
  const img = await Jimp.read(input);
  const W = img.bitmap.width;
  const H = img.bitmap.height;
  const cx = opts.focusX * W;
  const cy = opts.focusY * H;
  const half = opts.radius * W;
  const x0 = Math.max(0, Math.round(cx - half));
  const y0 = Math.max(0, Math.round(cy - half));
  const x1 = Math.min(W, Math.round(cx + half));
  const y1 = Math.min(H, Math.round(cy + half));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  img.crop({ x: x0, y: y0, w, h });

  let scale = 1;
  const longest = Math.max(w, h);
  if (longest > opts.maxPx) {
    scale = opts.maxPx / longest;
    img.resize({ w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) });
  }

  if (opts.marker) {
    // focus position inside the (possibly resized) crop
    drawReticle(img, Math.round((cx - x0) * scale), Math.round((cy - y0) * scale));
  }

  const buffer = await img.getBuffer('image/png');
  return { buffer, region: { x: x0 / W, y: y0 / H, w: w / W, h: h / H } };
}
