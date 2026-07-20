import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { FigmaApiError } from '../../src/ports/errors.js';

const logger = pino({ level: 'silent' });
afterEach(() => vi.unstubAllGlobals());

// Stub fetch → real Response (has a .body ReadableStream). new Response(str) leaves content-length null,
// so a string body exercises the STREAMING counter path; an explicit header exercises the fast-reject.
function stubBody(bodyStr: string, headers: Record<string, string> = {}) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(bodyStr, { status: 200, headers: { 'content-type': 'application/json', ...headers } })));
}

describe('figma-rest stream cap', () => {
  it('under cap → parsed result identical (byte-for-byte regression lock)', async () => {
    const payload = { name: 'file', document: { id: '0:0', children: [{ id: '1:1' }] } };
    stubBody(JSON.stringify(payload));
    const api = new FigmaRestAdapter('t', logger, 4, 90000, undefined, undefined, undefined, 1_000_000);
    const res = await api.getDocumentRaw('FILEKEY');
    expect(res).toEqual(payload);
  });

  it('streamed body over cap → too_large (no content-length header)', async () => {
    stubBody(JSON.stringify({ blob: 'x'.repeat(500) })); // >20 bytes, no content-length
    const api = new FigmaRestAdapter('t', logger, 4, 90000, undefined, undefined, undefined, 20);
    await expect(api.getDocumentRaw('FILEKEY')).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('declared content-length over cap → too_large fast-reject', async () => {
    stubBody('{}', { 'content-length': '999999999' });
    const api = new FigmaRestAdapter('t', logger, 4, 90000, undefined, undefined, undefined, 20);
    await expect(api.getDocumentRaw('FILEKEY')).rejects.toBeInstanceOf(FigmaApiError);
    await expect(api.getDocumentRaw('FILEKEY')).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('too_large message is actionable (names the cap + narrowing)', async () => {
    stubBody('x'.repeat(500));
    const api = new FigmaRestAdapter('t', logger, 4, 90000, undefined, undefined, undefined, 20);
    await expect(api.getDocumentRaw('FILEKEY')).rejects.toThrow(/node_id|node ids|Narrow/i);
  });

  it('BOM-prefixed body parses (byte-identical to res.text() — BOM stripped, not kept)', async () => {
    // Regression lock for the streaming decode: .toString('utf8') would keep the BOM → JSON.parse throws
    // → spurious network error. TextDecoder strips it exactly as res.text() did.
    const payload = { name: 'file', document: { id: '0:0' } };
    stubBody('\uFEFF' + JSON.stringify(payload));
    const api = new FigmaRestAdapter('t', logger, 4, 90000, undefined, undefined, undefined, 1_000_000);
    await expect(api.getDocumentRaw('FILEKEY')).resolves.toEqual(payload);
  });

  it('request() tags the parsed result with its wire byte size (M3a)', async () => {
    const { sizeOf } = await import('../../src/infrastructure/response-size.js');
    const payload = { name: 'file', document: { id: '0:0' } };
    const body = JSON.stringify(payload);
    stubBody(body);
    const api = new FigmaRestAdapter('t', logger, 4, 90000, undefined, undefined, undefined, 1_000_000);
    const res = await api.getDocumentRaw('FILEKEY');
    expect(sizeOf(res)).toBe(Buffer.byteLength(body));
  });

  it('bare-object stub (no .body/.headers) falls back to text() under cap', async () => {
    // Locks the reorder fix: readCapped must not touch res.headers/res.body on a hand-rolled stub.
    const payload = { document: { id: '0:0', name: 'r', type: 'DOCUMENT' }, nodes: {} };
    vi.stubGlobal('fetch', vi.fn(async () =>
      ({ ok: true, status: 200, text: async () => JSON.stringify(payload) } as unknown as Response)));
    const api = new FigmaRestAdapter('t', logger, 4, 90000, undefined, undefined, undefined, 1_000_000);
    await expect(api.getDocumentRaw('FILEKEY')).resolves.toEqual(payload);
  });
});
