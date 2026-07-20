// mcp-server/src/domain/design-context/color.ts
import type { RawColor, RawPaint } from '../figma-raw.js';

function channel(v: number): string {
  return Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
}

export function rgbaToHex(c: RawColor): string {
  const base = `#${channel(c.r)}${channel(c.g)}${channel(c.b)}`;
  if (c.a === undefined || c.a >= 1) return base;
  return base + channel(c.a);
}

export interface GradientStop { position: number; color: string }
export interface Gradient { type: 'linear' | 'radial' | 'angular'; angle?: number; stops: GradientStop[] }

const GRADIENT_KIND: Record<string, Gradient['type']> = {
  GRADIENT_LINEAR: 'linear',
  GRADIENT_RADIAL: 'radial',
  GRADIENT_ANGULAR: 'angular',
};

function handleAngle(handles: { x: number; y: number }[] | undefined): number | undefined {
  if (!handles || handles.length < 2) return undefined;
  const dx = handles[1].x - handles[0].x;
  const dy = handles[1].y - handles[0].y;
  if (dx === 0 && dy === 0) return undefined;
  const deg = Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

export function parseGradient(paint: RawPaint): Gradient | null {
  const kind = GRADIENT_KIND[paint.type];
  if (!kind || !paint.gradientStops || paint.gradientStops.length === 0) return null;
  const stops: GradientStop[] = paint.gradientStops.map((s) => ({ position: s.position, color: rgbaToHex(s.color) }));
  const angle = kind === 'linear' ? handleAngle(paint.gradientHandlePositions) : undefined;
  return angle !== undefined ? { type: kind, angle, stops } : { type: kind, stops };
}
