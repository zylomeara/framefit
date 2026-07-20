import type { FigmaApi } from '../../../ports/figma-api.js';
import { cropFocus } from './image-crop.js';
import { downloadRaster } from './image-download.js';

export const CROP_MAX_PX = 512; // longest side of a focus crop
export const DEFAULT_FOCUS_RADIUS = 0.12;

// Source render scale sized so the crop window lands near CROP_MAX_PX, never above the requested scale.
export function focusSourceScale(bboxWidth: number, focusRadius: number, requestedScale: number): number {
  return Math.max(0.25, Math.min(requestedScale, 4, Math.round((CROP_MAX_PX / (2 * focusRadius * bboxWidth)) * 100) / 100));
}

export interface FocusCropResult {
  buffer: Buffer;
  region: { x: number; y: number; w: number; h: number };
  sourceScale: number;
}

// Renders the node at a window-sized scale, downloads it, and crops a reticle-marked window
// around the focus point. Caller supplies the node's UNSCALED bbox width.
export async function renderFocusCrop(
  api: FigmaApi, fileKey: string, nodeId: string, bboxWidth: number,
  o: { focusX: number; focusY: number; focusRadius: number; requestedScale: number },
): Promise<FocusCropResult> {
  const sourceScale = focusSourceScale(bboxWidth, o.focusRadius, o.requestedScale);
  const sourceUrl = (await api.getImages(fileKey, [nodeId], { format: 'png', scale: sourceScale })).images[nodeId];
  if (!sourceUrl) throw new Error(`Figma did not render node ${nodeId} at scale ${sourceScale} for the focus crop.`);
  const srcBuf = await downloadRaster(sourceUrl, sourceScale);
  const { buffer, region } = await cropFocus(srcBuf, {
    focusX: o.focusX, focusY: o.focusY, radius: o.focusRadius, maxPx: CROP_MAX_PX, marker: true,
  });
  return { buffer, region, sourceScale };
}
