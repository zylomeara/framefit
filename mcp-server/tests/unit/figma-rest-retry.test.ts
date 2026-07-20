import { describe, it, expect, vi, afterEach } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const silent = createLogger({ level: 'silent' });

const docPayload = {
  document: { id: '0:0', name: 'Doc', type: 'DOCUMENT', children: [
    { id: '0:1', name: 'Page', type: 'CANVAS', children: [] },
  ] },
};

afterEach(() => vi.unstubAllGlobals());

describe('FigmaRestAdapter.getFileStructure retry', () => {
  it('retries once after a network error then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('socket hang up');
      return new Response(JSON.stringify(docPayload), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const adapter = new FigmaRestAdapter('tok', silent);
    const structure = await adapter.getFileStructure('KEY');
    expect(calls).toBe(2);
    expect(structure.nodeById.get('0:1')?.name).toBe('Page');
  });

  it('does NOT retry on a non-network error (404)', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return new Response('not found', { status: 404 });
    }));
    const adapter = new FigmaRestAdapter('tok', silent);
    await expect(adapter.getFileStructure('KEY')).rejects.toMatchObject({ kind: 'not_found' });
    expect(calls).toBe(1);
  });
});
