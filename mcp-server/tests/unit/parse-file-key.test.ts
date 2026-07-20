import { describe, it, expect } from 'vitest';
import { parseFileKey } from '../../src/domain/parse-file-key.js';

describe('parseFileKey', () => {
  it('extracts key from /design/ URL', () => {
    const r = parseFileKey('https://www.figma.com/design/ABC123def/My-File');
    expect(r).toEqual({ ok: true, value: 'ABC123def' });
  });

  it('extracts key from legacy /file/ URL', () => {
    const r = parseFileKey('https://www.figma.com/file/ABC123def/My-File');
    expect(r).toEqual({ ok: true, value: 'ABC123def' });
  });

  it('handles query string and node-id param', () => {
    const r = parseFileKey('https://figma.com/design/XYZ789/Foo?node-id=1-2&t=abc');
    expect(r).toEqual({ ok: true, value: 'XYZ789' });
  });

  it('extracts key from a /board/ FigJam URL', () => {
    const r = parseFileKey('https://www.figma.com/board/BAZ123/Whiteboard?node-id=1-2');
    expect(r).toEqual({ ok: true, value: 'BAZ123' });
  });

  it('accepts a raw file key', () => {
    const r = parseFileKey('ABC123def');
    expect(r).toEqual({ ok: true, value: 'ABC123def' });
  });

  it('rejects empty input', () => {
    const r = parseFileKey('');
    expect(r.ok).toBe(false);
  });

  it('rejects unsupported /proto/ URL', () => {
    const r = parseFileKey('https://www.figma.com/proto/ABC123/Foo');
    expect(r.ok).toBe(false);
  });
});
