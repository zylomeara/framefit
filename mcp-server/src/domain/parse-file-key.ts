import type { Result } from './types.js';

const URL_RE = /figma\.com\/(design|file|board)\/([A-Za-z0-9]+)(?:\/|$|\?)/;
const RAW_KEY_RE = /^[A-Za-z0-9]+$/;

export function parseFileKey(input: string): Result<string> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: 'file is required' };
  }

  const match = trimmed.match(URL_RE);
  if (match) {
    return { ok: true, value: match[2] };
  }

  if (trimmed.includes('figma.com/')) {
    return {
      ok: false,
      error: 'unsupported Figma URL — expected /design/<key>, /file/<key>, or /board/<key>',
    };
  }

  if (RAW_KEY_RE.test(trimmed)) {
    return { ok: true, value: trimmed };
  }

  return { ok: false, error: 'could not extract Figma file key from input' };
}
