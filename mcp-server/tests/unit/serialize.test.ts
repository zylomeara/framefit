import { describe, it, expect, afterEach, vi } from 'vitest';
import { serializeForDelivery } from '../../src/adapters/driving/tools/serialize.js';

describe('serializeForDelivery', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is compact by default (no indentation newlines)', () => {
    const out = serializeForDelivery({ a: 1, b: { c: 2 } });
    expect(out).toBe('{"a":1,"b":{"c":2}}');
    expect(out).not.toContain('\n');
  });

  it('is pretty (2-space) when MCP_PRETTY_JSON=true', () => {
    vi.stubEnv('MCP_PRETTY_JSON', 'true');
    const out = serializeForDelivery({ a: 1, b: { c: 2 } });
    expect(out).toBe(JSON.stringify({ a: 1, b: { c: 2 } }, null, 2));
    expect(out).toContain('\n');
  });

  it('treats any value other than the literal "true" as compact', () => {
    vi.stubEnv('MCP_PRETTY_JSON', 'yes'); // not the literal 'true'
    expect(serializeForDelivery({ a: 1 })).toBe('{"a":1}');
  });
});
