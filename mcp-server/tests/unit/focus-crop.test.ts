import { describe, it, expect } from 'vitest';
import { focusSourceScale, CROP_MAX_PX, DEFAULT_FOCUS_RADIUS } from '../../src/adapters/driving/tools/focus-crop.js';

describe('focusSourceScale', () => {
  it('clamps to the requested scale when the window-fit scale is larger', () => {
    // 512 / (2 × 0.12 × 360) = 5.93 → clamped to min(requestedScale=2, 4) = 2
    expect(focusSourceScale(360, 0.12, 2)).toBe(2);
  });
  it('uses the window-fit scale for a wide node (smaller than requested)', () => {
    // 512 / (2 × 0.12 × 2048) = 1.0416 → round to 1.04, below requested 2
    expect(focusSourceScale(2048, 0.12, 2)).toBe(1.04);
  });
  it('never goes below the 0.25 floor', () => {
    // huge node → tiny fit scale → floored at 0.25
    expect(focusSourceScale(100000, 0.12, 2)).toBe(0.25);
  });
  it('exposes the shared constants', () => {
    expect(CROP_MAX_PX).toBe(512);
    expect(DEFAULT_FOCUS_RADIUS).toBe(0.12);
  });
});
