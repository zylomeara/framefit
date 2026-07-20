import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/infrastructure/config.js';

describe('config CACHE_MAX_BYTES >= CACHE_MAX_ENTRY_BYTES floor (M3b)', () => {
  it('defaults pass (256MB >= 64MB)', () => {
    expect(() => loadConfig({})).not.toThrow();
  });
  it('aggregate below per-entry cap is rejected (footgun)', () => {
    expect(() => loadConfig({ CACHE_MAX_BYTES: '20000000', CACHE_MAX_ENTRY_BYTES: '64000000' }))
      .toThrow(/CACHE_MAX_BYTES/);
  });
  it('consistent small caps pass', () => {
    expect(() => loadConfig({ CACHE_MAX_BYTES: '64000000', CACHE_MAX_ENTRY_BYTES: '32000000' }))
      .not.toThrow();
  });
});

describe('config FIGMA_TOKEN empty-string coercion (stranger path)', () => {
  // Fresh clone: `cp .env.example .env` used to leave `FIGMA_TOKEN=` → docker env_file
  // injects '' → min(1) rejected it → container crash-loop. Empty assignment of an
  // OPTIONAL credential must equal absence.
  it('empty string is valid config and coerces to undefined', () => {
    const c = loadConfig({ FIGMA_TOKEN: '' });
    expect(c.FIGMA_TOKEN).toBeUndefined();
  });
  it('a real token passes through unchanged', () => {
    expect(loadConfig({ FIGMA_TOKEN: 'figd_abc' }).FIGMA_TOKEN).toBe('figd_abc');
  });
  it('absent stays undefined', () => {
    expect(loadConfig({}).FIGMA_TOKEN).toBeUndefined();
  });
});

describe('config FRAME_* hydration knobs', () => {
  it('defaults pass and expose the six frame knobs', () => {
    const c = loadConfig({});
    expect(c.FRAME_MAX_PARSE_BYTES).toBe(3 * 1024 * 1024);
    expect(c.FRAME_RAM_GLOBAL_BYTES).toBe(48 * 1024 * 1024);
    expect(c.FRAME_RAM_PER_TENANT_BYTES).toBe(16 * 1024 * 1024);
    expect(c.FRAME_PARSE_MULTIPLIER).toBe(5);
    expect(c.HYDRATION_MAX_MATERIALIZE).toBe(1);
    expect(c.FRAME_CACHE_TTL_SEC).toBe(300);
  });
  it('rejects global below per-tenant', () => {
    expect(() => loadConfig({ FRAME_RAM_GLOBAL_BYTES: '8000000', FRAME_RAM_PER_TENANT_BYTES: '16000000' }))
      .toThrow(/FRAME_RAM_GLOBAL_BYTES/);
  });
  it('rejects per-tenant below one held frame (parse-cap × multiplier)', () => {
    // 4MB wire × 5 = 20MB resident > 16MB per-tenant → first hold self-evicts → footgun, reject.
    expect(() => loadConfig({
      FRAME_MAX_PARSE_BYTES: '4000000', FRAME_PARSE_MULTIPLIER: '5',
      FRAME_RAM_PER_TENANT_BYTES: '16000000', FRAME_RAM_GLOBAL_BYTES: '48000000',
    })).toThrow(/FRAME_RAM_PER_TENANT_BYTES/);
  });
});
