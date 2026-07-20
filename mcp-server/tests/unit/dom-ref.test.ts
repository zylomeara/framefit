import { describe, it, expect, vi } from 'vitest';
import { DomRefSchema, resolveDomRef } from '../../src/adapters/driving/tools/dom-ref.js';
import type { DomSnapshotStore } from '../../src/infrastructure/dom-snapshot-store.js';

const store = (over: Partial<DomSnapshotStore>) => over as unknown as DomSnapshotStore;

describe('DomRefSchema', () => {
  it('accepts ref+selector OR ref+index; rejects both / neither', () => {
    expect(DomRefSchema.safeParse({ ref: 'r', selector: '.a' }).success).toBe(true);
    expect(DomRefSchema.safeParse({ ref: 'r', index: 0 }).success).toBe(true);
    expect(DomRefSchema.safeParse({ ref: 'r', selector: '.a', index: 0 }).success).toBe(false);
    expect(DomRefSchema.safeParse({ ref: 'r' }).success).toBe(false);
  });
});

describe('resolveDomRef', () => {
  it('resolves by selector', () => {
    const resolve = vi.fn(() => ({ ok: true as const, snapshot: { selector: '.a' } }));
    const r = resolveDomRef({ ref: 'r', selector: '.a' }, store({ resolve }), 'u');
    expect(resolve).toHaveBeenCalledWith('r', '.a', 'u');
    expect(r).toEqual({ ok: true, snapshot: { selector: '.a' } });
  });

  it('resolves by index (never through selector)', () => {
    const resolveByIndex = vi.fn(() => ({ ok: true as const, snapshot: { k: 1 } }));
    const r = resolveDomRef({ ref: 'r', index: 2 }, store({ resolveByIndex }), 'u');
    expect(resolveByIndex).toHaveBeenCalledWith('r', 2, 'u');
    expect(r).toEqual({ ok: true, snapshot: { k: 1 } });
  });

  it('unknown_selector → note listing available selectors', () => {
    const resolve = vi.fn(() => ({ ok: false as const, reason: 'unknown_selector' as const, selectors: ['.a', '.b'] }));
    const r = resolveDomRef({ ref: 'r', selector: '.x' }, store({ resolve }), 'u');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.note).toContain('.a, .b');
  });

  it('unknown_selector via index → range note', () => {
    const resolveByIndex = vi.fn(() => ({ ok: false as const, reason: 'unknown_selector' as const, selectors: ['.a', '.b'] }));
    const r = resolveDomRef({ ref: 'r', index: 9 }, store({ resolveByIndex }), 'u');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.note).toContain('index 9 out of range');
  });

  it('expired/unknown_ref/owner_mismatch → single masked note', () => {
    for (const reason of ['expired', 'unknown_ref', 'owner_mismatch'] as const) {
      const resolve = vi.fn(() => ({ ok: false as const, reason }));
      const r = resolveDomRef({ ref: 'r', selector: '.a' }, store({ resolve }), 'u');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.note).toContain('expired/unknown');
    }
  });
});
