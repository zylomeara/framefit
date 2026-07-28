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

  // Both rows now pin the REASON as well as the status. The status alone cannot classify a dead
  // token (the same token answers 401 on one endpoint and 403 on another), and `status` printed
  // exactly "Figma refused the token (HTTP 403)" - terminating the diagnosis in the ambiguity it
  // was pointed at to resolve.
  it('returns not-ok for 403, carrying Figma\'s own reason', async () => {
    stubFetch(403, { status: 403, err: 'Invalid token' });
    expect(await validatePat('figd_dead')).toEqual({ ok: false, status: 403, reason: 'Invalid token' });
  });

  it('returns not-ok for 401', async () => {
    stubFetch(401, { err: 'no' });
    expect(await validatePat('bad')).toEqual({ ok: false, status: 401, reason: 'no' });
  });

  it('a body with no readable reason yields no reason field at all', async () => {
    // Same rule as the REST adapter: an HTML interstitial from a proxy or captive portal must
    // contribute nothing rather than arrive as this server's diagnosis in this server's voice.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<HTML>403</HTML>', { status: 403 })));
    expect(await validatePat('figd_dead')).toEqual({ ok: false, status: 403 });
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
