import { describe, it, expect, afterEach, vi } from 'vitest';
import { validatePat } from '../../src/multi-tenant/validate-pat.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('validatePat', () => {
  it('returns ok with handle for a valid PAT', async () => {
    const fn = stubFetch(200, { id: '1', handle: 'testuser', email: 'a@b.c' });
    const result = await validatePat('figd_valid');
    expect(result).toEqual({ ok: true, handle: 'testuser', email: 'a@b.c' });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.figma.com/v1/me');
    expect((init.headers as Record<string, string>)['X-Figma-Token']).toBe('figd_valid');
  });

  it('returns not-ok for 403 (invalid/expired token)', async () => {
    stubFetch(403, { status: 403, err: 'Invalid token' });
    expect(await validatePat('figd_dead')).toEqual({ ok: false, status: 403 });
  });

  it('returns not-ok for 401', async () => {
    stubFetch(401, { err: 'no' });
    expect(await validatePat('bad')).toEqual({ ok: false, status: 401 });
  });

  it('throws on network error (caller decides, not "invalid")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(validatePat('figd_x')).rejects.toThrow();
  });

  it('propagates AbortError on timeout (no catch may swallow it)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((_, rej) => {
        (init.signal as AbortSignal).addEventListener('abort', () =>
          rej(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
      return new Response('unreachable');
    }));
    await expect(validatePat('figd_x', 1)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
