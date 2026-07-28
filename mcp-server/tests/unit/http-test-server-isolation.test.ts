// The suite went red in files nobody had touched - 3 of 25 full-suite runs, measured 2026-07-28 -
// and every symptom was the same one wearing different clothes: the response did not come from the
// app under test. The cause was in the harness, not the product. `app.listen(0, cb)` binds the
// UNSPECIFIED address while the harness dials `http://127.0.0.1:<port>`, and those are not the same
// endpoint. The OS hands an unspecified-address listener port numbers that another process already
// holds on 127.0.0.1, and the loopback-specific bind then wins every request sent there.
//
// The rule these rows enforce is about the address the SOCKET reports, never about the shape of the
// listen() call. An earlier draft asked only "is a host argument present", and
// `.listen(0, '0.0.0.0', cb)`, `.listen(0, '::', cb)` and `.listen(0, '', cb)` all satisfied that
// while reintroducing the defect in full. The first row is the correction: it binds each of those
// spellings for real and reads back what the kernel actually did with it.
//
// Every row is deterministic - none of them waits for the race, because none is about timing.
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, bindsBaseUrlHost, BASE_URL_HOST } from '../helpers/http-test-server.js';

const testsDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A server that answers every path with a marker naming who it is. */
function marker(who: string): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(who);
  });
}

type BindOutcome = { bound: true; server: Server } | { bound: false; code: string };

/** Try to take a port. `host === null` is the host-less idiom: Node binds the unspecified address. */
function tryBind(server: Server, port: number, host: string | null): Promise<BindOutcome> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => resolve({ bound: false, code: err.code ?? err.message });
    server.once('error', onError);
    const listening = (): void => { server.off('error', onError); resolve({ bound: true, server }); };
    if (host === null) server.listen(port, listening);
    else server.listen(port, host, listening);
  });
}

const shutdown = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

// The spellings a reviewer reaches for, and what the kernel does with each. `''` is here because
// Node treats a falsy host as UNSPECIFIED, so an empty host is a wildcard wearing the costume of a
// host argument - the same trap bind-host.test.ts records for the product's BIND_HOST.
const spellings: { name: string; host: string | null; pinned: boolean }[] = [
  { name: "'127.0.0.1'", host: '127.0.0.1', pinned: true },
  { name: "'0.0.0.0'", host: '0.0.0.0', pinned: false },
  { name: "'::'", host: '::', pinned: false },
  { name: "'' - Node reads a falsy host as unspecified", host: '', pinned: false },
  { name: 'no host argument at all', host: null, pinned: false },
];

describe('a test server owns its base URL, and no neighbour can answer for it', () => {
  it.each(spellings)('listen(0, $name): bound address is the base URL host = $pinned', async ({ host, pinned }) => {
    const server = marker('under-test');
    const outcome = await tryBind(server, 0, host);
    expect(outcome.bound).toBe(true);
    try {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no AddressInfo after listen');

      // THE property, read off the socket, so no spelling can talk its way past it. This is the
      // same predicate startTestServer applies before it hands out a base URL.
      expect(bindsBaseUrlHost(addr.address)).toBe(pinned);
      if (pinned) expect(addr.address).toBe(BASE_URL_HOST);
      else expect(addr.address).not.toBe(BASE_URL_HOST);
    } finally {
      await shutdown(server);
    }
  });

  it('the origin is exclusive: nothing else can bind 127.0.0.1:<port> while we hold it', async () => {
    const app = await startTestServer((_req, res) => { res.writeHead(200); res.end('mine'); });
    const impostor = marker('impostor');
    try {
      const outcome = await tryBind(impostor, app.port, '127.0.0.1');

      // The consequence of the property, and it is the OS's to keep rather than a timing window's.
      // Point the helper at any non-pinned spelling and this bind SUCCEEDS, and the request below is
      // answered by the impostor - which is exactly what a parallel worker, or any local tool
      // holding a fixed loopback port, did to this suite.
      if (outcome.bound) {
        const answered = await fetch(`${app.base}/`).then((r) => r.text());
        await shutdown(outcome.server);
        throw new Error(
          `another socket took 127.0.0.1:${app.port}, and a request to the base URL was answered by "${answered}"`,
        );
      }
      expect(outcome.code).toBe('EADDRINUSE');
      expect(await fetch(`${app.base}/`).then((r) => r.text())).toBe('mine');
    } finally {
      await app.close();
    }
  });

  it('a neighbour on the unspecified address cannot take requests sent to that origin', async () => {
    const app = await startTestServer((_req, res) => { res.writeHead(200); res.end('mine'); });
    // Precisely what every other harness used to do, on precisely our port. The row above is the one
    // that fails on the mutation; this one states the other half of why pinning works - a wildcard
    // bind may coexist, but it never out-ranks a specific one.
    const neighbour = marker('neighbour');
    const outcome = await tryBind(neighbour, app.port, null);
    try {
      if (outcome.bound) {
        expect(await fetch(`${app.base}/`).then((r) => r.text())).toBe('mine');
      } else {
        expect(outcome.code).toBe('EADDRINUSE');
      }
    } finally {
      if (outcome.bound) await shutdown(outcome.server);
      await app.close();
    }
  });

  it('a base kept past its server refuses to dial, instead of reaching whoever inherited the port', async () => {
    const app = await startTestServer((_req, res) => { res.writeHead(200); res.end('mine'); });
    await app.close();
    // The other half of the same defect: the port number outlives the socket, so a base held past
    // close() is a base pointing at a stranger. Reading it has to be an error, not a request.
    expect(() => app.base).toThrow(/closed/);
  });

  // A source scan cannot read a socket, so this one does not try to judge a host argument at all -
  // that is the mistake the first row exists to correct. It enforces routing instead: no test starts
  // a server of its own, so every listener passes the live check inside the helper.
  it('no test file starts a server of its own; every listener comes through the helper', () => {
    const exempt = [join('helpers', 'http-test-server.ts'), join('unit', 'http-test-server-isolation.test.ts')];
    const offenders: string[] = [];
    const scanned: string[] = [];

    for (const entry of readdirSync(testsDir, { recursive: true }) as string[]) {
      if (!entry.endsWith('.ts')) continue;
      const posix = entry.split(sep).join('/');
      scanned.push(posix);
      if (exempt.some((e) => entry.endsWith(e))) continue;
      for (const call of listenCalls(stripComments(readFileSync(join(testsDir, entry), 'utf8')))) {
        offenders.push(`${posix}: ${call}`);
      }
    }

    // Co-lock on the scan itself: an empty offender list is evidence only if the walk and the
    // matcher both did their job. A traversal that silently returned nothing, or a matcher that
    // recognises one call spelling out of five, would otherwise report a clean tree.
    expect(scanned.length).toBeGreaterThan(150);
    expect(scanned).toContain('unit/bind-host.test.ts');
    expect(listenCalls(stripComments(MATCHER_SAMPLE))).toEqual([
      '.listen(0, () => r())',
      '.listen(0, cb)',
      ".listen(0, '0.0.0.0', cb)",
      ".listen(0, '::', cb)",
      ".listen(0, '', cb)",
      '.listen(port)',
    ]);

    expect(offenders).toEqual([]);
  });
});

/** Fed to the matcher above, so "no offenders" can never mean "found nothing, ever". */
const MATCHER_SAMPLE = [
  'a.listen(0, () => r());',
  'b.listen(0, cb);',
  "c.listen(0, '0.0.0.0', cb);",
  "d.listen(0, '::', cb);",
  "e.listen(0, '', cb);",
  "// f.listen(0, 'commented out');",
  'g.listen(port);',
].join('\n');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // line comments, without eating the `//` in a `http://` literal
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every `.listen(...)` call, matched by balancing parentheses rather than by a pattern over the
 * argument list - `.listen(0, cb)`, `.listen(0, () => r())` and `.listen(0, '::', cb)` are the same
 * call in three costumes, and a matcher that recognises only some of them is a gate with a hole.
 */
function listenCalls(source: string): string[] {
  const out: string[] = [];
  const opener = /\.listen\(/g;
  let m: RegExpExecArray | null;

  while ((m = opener.exec(source)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
    }
    if (depth !== 0) continue;                       // unbalanced: not a call we can read
    out.push(source.slice(m.index, i).replace(/\s+/g, ' '));
  }
  return out;
}
