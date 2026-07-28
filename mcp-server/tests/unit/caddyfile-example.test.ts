// The example file IS the authentication for a single-tenant VPS: the server has no auth of its
// own and wires FIGMA_TOKEN into every call. So the file gets a machine gate, and the gate asserts
// the exemption set EXACTLY - "contains basic_auth somewhere" would pass on a file that
// authenticates /health and nothing else.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const caddyfile = readFileSync(join(repoRoot, 'Caddyfile.example'), 'utf8');

/**
 * Every line in `src` that DEFINES the named matcher. Caddy ORs repeated `@name` lines into one
 * matcher set, so "is there a line naming the right prefix" is not a question worth asking - the
 * question is what the complete set is, which is why this returns all of them and the assertions
 * below compare token-for-token.
 */
function matcherLines(src: string, name: string): string[] {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(name + ' ') || l === name);
}

/** Split the site block into top-level `handle` blocks, keyed by their matcher (or '' for none). */
function handleBlocks(src: string): { matcher: string; body: string }[] {
  const out: { matcher: string; body: string }[] = [];
  const re = /handle(\s+@[A-Za-z0-9_]+)?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push({ matcher: (m[1] ?? '').trim(), body: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}

describe('Caddyfile.example is authenticated, stream-safe and functional', () => {
  const blocks = handleBlocks(caddyfile);

  it('every proxying handle block is behind basic_auth EXCEPT exactly the dom-snapshot matcher', () => {
    const proxying = blocks.filter((b) => /reverse_proxy/.test(b.body));
    expect(proxying.length, 'no reverse_proxy found - did the file move?').toBeGreaterThan(0);

    const unauthenticated = proxying
      .filter((b) => !/basic_auth/.test(b.body))
      .map((b) => b.matcher);

    // EXACTLY this, nothing else. Adding a second exemption is a hole; removing this one kills the
    // extractor flow (a cross-origin <script src> cannot carry credentials, and a 401 without CORS
    // headers surfaces in the browser as a bare "Failed to fetch").
    expect(unauthenticated).toEqual(['@dom_snapshots']);
  });

  // The exemption is a PATH SET, not a name. A regex that merely finds the right prefix somewhere
  // on the matcher line is green for `@dom_snapshots path /api/dom-snapshots/* /mcp*`, and that
  // config was run: anonymous POST /mcp answers 200 with serverInfo. So assert the whole line,
  // token for token, and assert there is only one such line (Caddy ORs repeats of the same name).
  it('the dom-snapshot matcher is one line, one directive, and exactly one path', () => {
    const lines = matcherLines(caddyfile, '@dom_snapshots');
    expect(lines, 'a second @dom_snapshots line ORs another path into the exemption').toHaveLength(1);
    expect(lines[0].split(/\s+/)).toEqual(['@dom_snapshots', 'path', '/api/dom-snapshots/*']);
  });

  it('/mcp is inside basic_auth (it is reached by the catch-all handle)', () => {
    const authed = blocks.filter((b) => /basic_auth/.test(b.body));
    expect(authed).toHaveLength(1);
    expect(authed[0].matcher, 'the authenticated block must be the catch-all, not a narrow matcher').toBe('');
    expect(authed[0].body).toMatch(/reverse_proxy/);
  });

  it('no compression anywhere - gzip buffers the SSE stream the MCP transport uses', () => {
    expect(caddyfile).not.toMatch(/^\s*encode\b/m);
  });

  it('the access log never records the upload URI, because the capToken travels in the path', () => {
    const snap = blocks.find((b) => b.matcher === '@dom_snapshots');
    expect(snap, 'no @dom_snapshots handle block').toBeDefined();
    expect(snap!.body).toMatch(/log_skip/);
  });

  // The VALUE is asserted, not just the directive. Caddy parses `2MB` as 2,000,000 bytes and
  // express.text({ limit: '2mb' }) means 2,097,152, so the round number puts the edge cap 97,152
  // bytes BELOW the app's - measured: a 2,050,001-byte upload under a live token is 200 direct and
  // 413 at the edge, with no CORS header and no body, i.e. the opaque "Failed to fetch" this
  // carve-out exists to prevent. 2MiB is the same number the app uses.
  it('the exempted route is capped at the same ceiling the app enforces', () => {
    const snap = blocks.find((b) => b.matcher === '@dom_snapshots')!;
    expect(snap.body).toMatch(/request_body/);
    expect(snap.body).toMatch(/max_size\s+2MiB/);
  });

  it('the file tells the reader how to produce the credential', () => {
    expect(caddyfile).toMatch(/caddy hash-password/);
  });

  it('the file states WHY the exemption exists, so it is never read as an oversight', () => {
    expect(caddyfile).toMatch(/capToken/);
  });

  // Measured, not assumed: `caddy list-modules` on the stock 2.11.4 darwin/arm64 binary lists no
  // module matching /rate/ at all - `rate_limit` lives in the third-party caddy-ratelimit plugin.
  // So the size cap above is the ONLY bound this file can put on the one anonymous route, and the
  // file has to say so rather than let the reader assume the carve-out is free.
  it('the exempt block admits it is not rate-limited and names what to do instead', () => {
    const snap = blocks.find((b) => b.matcher === '@dom_snapshots')!;
    expect(snap.body).toMatch(/rate[ -]?limit/i);
    expect(snap.body, 'naming the gap without naming the remedy is a note, not a fix')
      .toMatch(/xcaddy|caddy-ratelimit|firewall/i);
  });

  it('ASCII only', () => {
    // eslint-disable-next-line no-control-regex
    expect(caddyfile).toMatch(/^[\x00-\x7F]*$/);
  });
});

describe('docs/deployment.md agrees with the file it points at', () => {
  const deployment = readFileSync(join(repoRoot, 'docs', 'deployment.md'), 'utf8');

  /** The fenced caddyfile snippets. Prose about basic_auth is not a basic_auth block. */
  function caddyfileFences(md: string): string[] {
    const out: string[] = [];
    const re = /```caddyfile\r?\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) !== null) out.push(m[1]);
    return out;
  }

  // Every snippet that PROXIES gets the same treatment the file gets. Asserting on the whole page
  // instead is vacuous: the sentence "Never skip the `basic_auth` block." satisfies /basic_auth/,
  // so a snippet with its entire basic_auth block deleted kept the suite green.
  const proxyFences = caddyfileFences(deployment).filter((f) => /reverse_proxy/.test(f));

  it('the page ships a proxying caddyfile snippet at all', () => {
    expect(proxyFences.length, 'no proxying caddyfile fence - did Option B move?').toBeGreaterThan(0);
  });

  it('every proxying snippet is authenticated except exactly the dom-snapshot matcher', () => {
    for (const fence of proxyFences) {
      const unauthenticated = handleBlocks(fence)
        .filter((b) => /reverse_proxy/.test(b.body))
        .filter((b) => !/basic_auth/.test(b.body))
        .map((b) => b.matcher);
      expect(unauthenticated).toEqual(['@dom_snapshots']);
    }
  });

  it('every proxying snippet exempts the same single path set, and log_skips it', () => {
    for (const fence of proxyFences) {
      const lines = matcherLines(fence, '@dom_snapshots');
      expect(lines).toHaveLength(1);
      expect(lines[0].split(/\s+/)).toEqual(['@dom_snapshots', 'path', '/api/dom-snapshots/*']);

      const snap = handleBlocks(fence).find((b) => b.matcher === '@dom_snapshots');
      expect(snap, 'the exempt block itself is missing from the snippet').toBeDefined();
      expect(snap!.body).toMatch(/log_skip/);
      expect(snap!.body).toMatch(/max_size\s+2MiB/);
    }
  });

  it('no sentence claims the example "shows the same shape" without naming the carve-out', () => {
    expect(deployment).not.toMatch(/shows the same shape/);
  });

  it('the page tells the operator the anonymous prefix has no rate limit anywhere', () => {
    expect(deployment).toMatch(/rate[ -]?limit/i);
    expect(deployment).toMatch(/xcaddy|caddy-ratelimit|firewall/i);
  });
});
