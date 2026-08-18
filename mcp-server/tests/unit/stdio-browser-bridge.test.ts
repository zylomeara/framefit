import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/infrastructure/logger.js';
import {
  startStdioBrowserBridge,
  type StdioBrowserBridge,
} from '../../src/infrastructure/stdio-browser-bridge.js';

async function startBridge(): Promise<StdioBrowserBridge> {
  return startStdioBrowserBridge(createLogger({ level: 'silent' }));
}

function validSnapshot(selector = '.title') {
  return {
    schema: 7,
    selector,
    innerWidth: 375,
    rect: { x: 0, y: 0, w: 100, h: 50 },
    borders: { top: 0, right: 0, bottom: 0, left: 0 },
    scroll: { top: 0, left: 0 },
    children: [],
  };
}

describe('stdio browser bridge', () => {
  it('binds an ephemeral loopback port and exposes only the DOM snapshot routes', async () => {
    const bridge = await startBridge();
    try {
      expect(bridge.address).toBe('127.0.0.1');
      expect(bridge.port).toBeGreaterThan(0);

      const health = await fetch(`${bridge.publicBaseUrl}/health`);
      expect(health.status).toBe(404);
      const mcp = await fetch(`${bridge.publicBaseUrl}/mcp`, { method: 'POST' });
      expect(mcp.status).toBe(404);
    } finally {
      await bridge.close();
    }
  });

  it('serves the current canonical extractor from the existing route', async () => {
    const bridge = await startBridge();
    try {
      const response = await fetch(`${bridge.publicBaseUrl}/api/dom-snapshots/extractor.js`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('schema v7');
    } finally {
      await bridge.close();
    }
  });

  it('uploads into the same store while preserving owner isolation', async () => {
    const bridge = await startBridge();
    try {
      const capToken = bridge.store.mint('owner-a');
      const response = await fetch(`${bridge.publicBaseUrl}/api/dom-snapshots/${capToken}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ snapshots: [validSnapshot()] }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { snapshot_ref: string };

      expect(bridge.store.resolve(body.snapshot_ref, '.title', 'owner-a')).toMatchObject({ ok: true });
      expect(bridge.store.resolve(body.snapshot_ref, '.title', 'owner-b')).toEqual({
        ok: false,
        reason: 'owner_mismatch',
      });
    } finally {
      await bridge.close();
    }
  });

  it('stops accepting connections after close', async () => {
    const bridge = await startBridge();
    const url = `${bridge.publicBaseUrl}/api/dom-snapshots/extractor.js`;
    await bridge.close();

    await expect(fetch(url)).rejects.toThrow();
  });
});
