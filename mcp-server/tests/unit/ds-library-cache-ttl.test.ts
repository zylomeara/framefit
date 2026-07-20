import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../../src/infrastructure/config.js';
import { makeReadCaches } from '../../src/infrastructure/server.js';
import type { AppConfig } from '../../src/infrastructure/config.js';

describe('DS library cache TTL', () => {
  it('DS_LIBRARY_TTL_SEC defaults to 86400 (24h)', () => {
    expect(loadConfig({}).DS_LIBRARY_TTL_SEC).toBe(86400);
  });

  it('DS_LIBRARY_TTL_SEC is overridable via env', () => {
    expect(loadConfig({ DS_LIBRARY_TTL_SEC: '3600' } as NodeJS.ProcessEnv).DS_LIBRARY_TTL_SEC).toBe(3600);
  });

  it('librariesCache outlives the file-structure TTL while nodeCache expires with it', () => {
    vi.useFakeTimers();
    try {
      const config = { FILE_STRUCTURE_TTL_SEC: 300, DS_LIBRARY_TTL_SEC: 21600 } as AppConfig;
      const caches = makeReadCaches(config);
      caches.nodeCache.set('k', { nodes: {} } as never);
      caches.librariesCache.set('k', {} as never);

      // Advance past the 300s file-structure TTL but within the 21600s DS TTL.
      vi.advanceTimersByTime(301_000);

      expect(caches.nodeCache.get('k')).toBeNull();        // file-structure TTL expired
      expect(caches.librariesCache.get('k')).not.toBeNull(); // DS TTL still valid
    } finally {
      vi.useRealTimers();
    }
  });
});
