import { describe, it, expect, afterEach, vi } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string) => { status?: number; body: unknown }) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => {
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const api = () => new FigmaRestAdapter('figd_x', logger, 4, 30000);

describe('FigmaRestAdapter read methods', () => {
  it('getDocumentRaw hits /files/:key?depth and returns version+document', async () => {
    const fn = stub((url) => {
      expect(url).toContain('/files/abc?depth=2');
      return { body: { name: 'F', lastModified: '2026-01-01T00:00:00Z', version: '99', document: { id: '0:0', name: 'Doc', type: 'DOCUMENT' } } };
    });
    const res = await api().getDocumentRaw('abc', 2);
    expect(res.version).toBe('99');
    expect(res.document.id).toBe('0:0');
    expect((fn.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'X-Figma-Token': 'figd_x' });
  });

  it('getNodesRaw encodes ids+depth and returns nodes map', async () => {
    stub((url) => {
      expect(url).toContain('/files/abc/nodes?ids=1%3A2%2C3%3A4&depth=4');
      return { body: { nodes: { '1:2': { document: { id: '1:2', name: 'A', type: 'FRAME' } }, '3:4': null } } };
    });
    const res = await api().getNodesRaw('abc', ['1:2', '3:4'], 4);
    expect(res.nodes['1:2']?.document.name).toBe('A');
    expect(res.nodes['3:4']).toBeNull();
  });

  it('getNodesRaw returns empty map for empty ids without calling fetch', async () => {
    const fn = stub(() => ({ body: {} }));
    const res = await api().getNodesRaw('abc', [], 4);
    expect(res.nodes).toEqual({});
    expect(fn).not.toHaveBeenCalled();
  });

  it('getImages hits /images and returns node→url map', async () => {
    stub((url) => {
      expect(url).toContain('/images/abc?ids=1%3A2&format=png&scale=2');
      return { body: { err: null, images: { '1:2': 'https://s3/img.png' } } };
    });
    const res = await api().getImages('abc', ['1:2'], { format: 'png', scale: 2 });
    expect(res.images['1:2']).toBe('https://s3/img.png');
  });

  it('getImages with svg format omits scale param and returns images map', async () => {
    stub((url) => {
      expect(url).toContain('/images/abc?ids=1%3A2%2C3%3A4&format=svg');
      expect(url).not.toContain('scale=');
      return { body: { err: null, images: { '1:2': 'https://s3/a.svg', '3:4': 'https://s3/b.svg' } } };
    });
    const res = await api().getImages('abc', ['1:2', '3:4'], { format: 'svg' });
    expect(res.images['1:2']).toBe('https://s3/a.svg');
    expect(res.images['3:4']).toBe('https://s3/b.svg');
  });

  it('getVariablesLocal hits /variables/local and returns meta', async () => {
    stub((url) => {
      expect(url).toContain('/files/abc/variables/local');
      return { body: { status: 200, meta: { variables: { 'VariableID:1:2': { id: 'VariableID:1:2', name: 'color/brand', resolvedType: 'COLOR', valuesByMode: {}, variableCollectionId: 'c' } }, variableCollections: {} } } };
    });
    const res = await api().getVariablesLocal('abc');
    expect(res.meta?.variables['VariableID:1:2'].name).toBe('color/brand');
  });

  it('getVariablesLocal maps 403 to a forbidden FigmaApiError (non-Enterprise)', async () => {
    stub(() => ({ status: 403, body: { status: 403, err: 'Not allowed' } }));
    await expect(api().getVariablesLocal('abc')).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('getFileVersion fetches depth=1 and returns version meta', async () => {
    stub((url) => {
      expect(url).toContain('/files/abc?depth=1');
      return { body: { name: 'F', lastModified: 'X', version: '77', document: { id: '0:0', name: 'D', type: 'DOCUMENT' } } };
    });
    const res = await api().getFileVersion('abc');
    expect(res.version).toBe('77');
  });
});
