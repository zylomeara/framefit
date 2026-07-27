// The bind is observable ONLY through server.address(). A test over the config constant
// (`loadConfig({}).BIND_HOST === '127.0.0.1'`) is satisfied by a schema default with zero wiring
// and cannot tell one wired listen site from two - server.ts has two, 400 lines apart.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { startServer, dialableHost, isLoopbackBind, type ServerHandle } from '../../src/infrastructure/server.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { MultiTenantEnv } from '../../src/multi-tenant/env.js';
import { initJwt } from '../../src/multi-tenant/jwt.js';

const logger = createLogger({ level: 'silent' });
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const captured: ToolDeps[] = [];
vi.mock('../../src/adapters/driving/tools/register-all.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/adapters/driving/tools/register-all.js')>();
  return {
    ...orig,
    registerAllTools: (server: unknown, deps: ToolDeps) => {
      captured.push(deps);
      return orig.registerAllTools(server as Parameters<typeof orig.registerAllTools>[0], deps);
    },
  };
});

const mtEnv: MultiTenantEnv = {
  databaseUrl: 'postgresql://unused',
  encryptionKey: 'a'.repeat(64),
  keycloakJwksUrl: 'https://auth.test/certs',
  oauthAuthorizationServer: 'https://auth.test/realms/mcp',
  mcpHost: 'localhost:3846',
  publicBaseUrl: 'http://localhost:3846',
  expectedAudience: 'http://localhost:3846/mcp',
  expectedAzp: 'figma-portal',
  enforceAudience: false,
};

async function boundAddress(env: Record<string, string>, mt = false): Promise<string> {
  const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test', ...env });
  let handle: ServerHandle;
  if (mt) {
    initJwt(mtEnv.keycloakJwksUrl, mtEnv.oauthAuthorizationServer);
    handle = await startServer(config, logger, {
      env: mtEnv,
      resolvePat: async () => null,
      accountsDb: {
        listTokens: async () => [], addToken: async () => { throw new Error('unused'); },
        removeToken: async () => false, setDefaultToken: async () => false,
        getTokenWithPat: async () => null, updateValidation: async () => {},
      },
      pingDb: async () => {},
    });
  } else {
    handle = await startServer(config, logger);
  }
  try { return handle.address; } finally { await handle.close(); }
}

/**
 * Drive one request through /mcp so registerAllTools actually runs: the single-tenant http server
 * registers its tools PER REQUEST (server.ts app.all('/mcp')), so `captured` stays empty until a
 * request lands. The dial base is written out literally per test rather than derived from
 * dialableHost - deriving it from the function under test would make the assertion circular.
 */
async function pokeMcp(base: string): Promise<void> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  await res.text();
}

describe('BIND_HOST reaches app.listen at BOTH sites', () => {
  // Table row 2 ('') is the empty-assignment hazard: Node treats a falsy host as UNSPECIFIED
  // (net.listen(0, '') binds '::'), and z.string().default() does NOT fire on '', so a copied
  // .env with `BIND_HOST=` would silently restore the wide bind. Same preprocess precedent as
  // FIGMA_TOKEN (config.ts).
  const rows: { name: string; env: Record<string, string>; expected: string }[] = [
    { name: 'unset -> loopback', env: {}, expected: '127.0.0.1' },
    { name: "empty string -> loopback (NOT '::')", env: { BIND_HOST: '' }, expected: '127.0.0.1' },
    { name: 'explicit wildcard is honoured (the image sets this)', env: { BIND_HOST: '0.0.0.0' }, expected: '0.0.0.0' },
  ];

  for (const row of rows) {
    it(`single-tenant: ${row.name}`, async () => {
      expect(await boundAddress(row.env)).toBe(row.expected);
    });
  }

  for (const row of rows) {
    it(`multi-tenant: ${row.name}`, async () => {
      expect(await boundAddress(row.env, true)).toBe(row.expected);
    });
  }
});

describe('BIND_HOST is validated at loadConfig, not at bind time', () => {
  it('rejects a hostname and names the MCP_HOST collision', () => {
    expect(() => loadConfig({ BIND_HOST: 'figma.mcp.example.com' }))
      .toThrow(/BIND_HOST.*MCP_HOST/s);
  });

  it('accepts the shapes a real deployment uses', () => {
    for (const v of ['127.0.0.1', '0.0.0.0', '::', '::1', 'localhost', '192.168.1.20']) {
      expect(loadConfig({ BIND_HOST: v }).BIND_HOST).toBe(v);
    }
  });
});

describe('dialableHost: what a BROWSER can reach', () => {
  it('wildcards are not dialable origins -> loopback', () => {
    expect(dialableHost('0.0.0.0')).toBe('127.0.0.1');
    expect(dialableHost('::')).toBe('127.0.0.1');
  });
  it('a concrete address is used as-is; IPv6 is bracketed', () => {
    expect(dialableHost('192.168.1.20')).toBe('192.168.1.20');
    expect(dialableHost('::1')).toBe('[::1]');
  });
});

describe('single-tenant publicBaseUrl follows the bind, not a hard-coded loopback', () => {
  it('BIND_HOST=127.0.0.1 (default) -> http://127.0.0.1:<port>', async () => {
    captured.length = 0;
    const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test' });
    const handle = await startServer(config, logger);
    try {
      await pokeMcp(`http://127.0.0.1:${handle.port}`);
      expect(captured.at(-1)!.publicBaseUrl).toBe(`http://127.0.0.1:${handle.port}`);
    } finally { await handle.close(); }
  });

  // ::1 rather than a second-loopback IPv4 (127.0.0.2): that alias exists on Linux but NOT on
  // macOS (EADDRNOTAVAIL), so the row would be a platform-dependent red. ::1 is a concrete
  // non-wildcard address everywhere AND it locks the IPv6 bracketing in the live wiring.
  it('a concrete non-wildcard bind is advertised as itself, bracketed (mutation "always 127.0.0.1" -> RED)', async () => {
    captured.length = 0;
    const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test', BIND_HOST: '::1' });
    const handle = await startServer(config, logger);
    try {
      await pokeMcp(`http://[::1]:${handle.port}`);
      expect(captured.at(-1)!.publicBaseUrl).toBe(`http://[::1]:${handle.port}`);
    } finally { await handle.close(); }
  });

  it('a wildcard bind still advertises loopback (0.0.0.0 is not dialable)', async () => {
    captured.length = 0;
    const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test', BIND_HOST: '0.0.0.0' });
    const handle = await startServer(config, logger);
    try {
      await pokeMcp(`http://127.0.0.1:${handle.port}`);
      expect(captured.at(-1)!.publicBaseUrl).toBe(`http://127.0.0.1:${handle.port}`);
    } finally { await handle.close(); }
  });
});

describe('the container image re-opens the bind, and the healthcheck reads the SERVER not the env', () => {
  const dockerfile = readFileSync(join(repoRoot, 'docker', 'Dockerfile'), 'utf8');

  it('sets the wide bind', () => {
    expect(dockerfile).toMatch(/^ENV BIND_HOST=0\.0\.0\.0$/m);
  });

  // Gate 3b in the spec ("a container whose published port is dead fails its healthcheck") has no
  // runner: .github/workflows/ci.yml has no job that starts a container, and `docker build` never
  // executes HEALTHCHECK. So the healthcheck line is lifted out of the Dockerfile and EXECUTED here
  // against a stub `wget` - the same decision the container makes, made in CI, including the
  // fail-closed path that no string assertion can reach.
  const healthcheckCmd = dockerfile
    .slice(dockerfile.indexOf('HEALTHCHECK'))
    .split('\n')
    .find((l) => l.trimStart().startsWith('CMD'))!;
  const script = healthcheckCmd.replace(/^\s*CMD\s+/, '');

  const OK = '{"status":"ok","bind":{"address":"0.0.0.0","loopback":false}}';
  const LOOPBACK = '{"status":"ok","bind":{"address":"127.0.0.1","loopback":true}}';
  const NO_FIELD = '{"status":"ok"}';

  const stubBin = mkdtempSync(join(tmpdir(), 'ff-healthcheck-'));
  writeFileSync(
    join(stubBin, 'wget'),
    ['#!/bin/sh',
      'for a in "$@"; do case "$a" in http*) printf %s "$a" > "$STUB_URL_FILE" ;; esac; done',
      'if [ -n "$STUB_WGET_FAIL" ]; then exit 1; fi',
      'printf %s "$STUB_PAYLOAD"',
      ''].join('\n'),
  );
  chmodSync(join(stubBin, 'wget'), 0o755);
  const urlFile = join(stubBin, 'dialed-url');

  function runHealthcheck(
    BIND_HOST: string,
    STUB_PAYLOAD = OK,
    opts: { unreachable?: boolean } = {},
  ): { code: number | null; url: string } {
    writeFileSync(urlFile, '');
    const r = spawnSync('/bin/sh', ['-c', script], {
      env: {
        PATH: `${stubBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        BIND_HOST, PORT: '3846', STUB_PAYLOAD, STUB_URL_FILE: urlFile,
        ...(opts.unreachable ? { STUB_WGET_FAIL: '1' } : {}),
      },
      encoding: 'utf8',
    });
    return { code: r.status, url: readFileSync(urlFile, 'utf8') };
  }

  it('healthy only when the server itself reports a non-loopback bind', () => {
    expect(runHealthcheck('0.0.0.0', OK).code).toBe(0);
  });

  it('unhealthy when the server reports a loopback bind, whatever BIND_HOST says', () => {
    // BIND_HOST here claims a wide bind; the SERVER says loopback. The server wins - that is the
    // entire point of moving the verdict out of the environment.
    expect(runHealthcheck('0.0.0.0', LOOPBACK).code).toBe(1);
  });

  it('FAIL-CLOSED: a payload without the bind field is unhealthy, not healthy', () => {
    // The mutation this kills: `case "$R" in *\'"loopback":true\'*) exit 1 ;; esac` - which passes
    // anything that merely fails to say true, including a server that stopped reporting the field.
    expect(runHealthcheck('0.0.0.0', NO_FIELD).code).toBe(1);
  });

  it('unhealthy when the server cannot be reached at all', () => {
    expect(runHealthcheck('0.0.0.0', OK, { unreachable: true }).code).toBe(1);
  });

  it('the shell does NOT classify the bind address (that is what kept breaking)', () => {
    // The only loopback literal allowed on this line is the wildcard dial fallback. Any other
    // 127./::1 occurrence means address classification crept back into shell patterns.
    expect(script.replace('H=127.0.0.1', '')).not.toMatch(/127\.|::1/);
    expect(script).toContain('"loopback":false');
  });

  // BIND_HOST is still read to build the URL to dial. A misread here costs a FALSE ALARM (the probe
  // fails), never a false green, because the verdict comes from the payload - which is why every
  // spelling below only has to produce a dialable authority, not a correct classification.
  it.each([
    ['0.0.0.0', 'http://127.0.0.1:3846/health'],
    ['::', 'http://127.0.0.1:3846/health'],
    ['', 'http://127.0.0.1:3846/health'],
    ['172.28.0.5', 'http://172.28.0.5:3846/health'],
    ['192.168.1.20', 'http://192.168.1.20:3846/health'],
    ['fd00::5', 'http://[fd00::5]:3846/health'],
    ['::1', 'http://[::1]:3846/health'],
    ['0:0:0:0:0:0:0:1', 'http://[0:0:0:0:0:0:0:1]:3846/health'],
    ['::ffff:7f00:1', 'http://[::ffff:7f00:1]:3846/health'],
    ['2001:db8::ffff:127.0.0.1', 'http://[2001:db8::ffff:127.0.0.1]:3846/health'],
  ])('BIND_HOST=%s dials %s', (bind, url) => {
    expect(runHealthcheck(bind).url).toBe(url);
  });
});

// The address classification that used to live in shell patterns, where three review rounds found
// three separate false greens. Over KERNEL-canonical values (what server.address() returns) the
// loopback space is finite and provable: 127.0.0.0/8, ::1, and that block mapped into IPv6. The
// function normalises first (WHATWG URL parser), so it is total over every spelling as well.
describe('isLoopbackBind: the verdict, in application code', () => {
  it.each([
    '127.0.0.1', '127.0.0.2', '127.255.255.254', '127.1',
    'localhost',
    '::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '0::1', '::0:1', '::0.0.0.1',
    '::ffff:127.0.0.1', '::FFFF:127.0.0.1', '::Ffff:127.0.0.1',
    '0:0:0:0:0:ffff:127.0.0.1', '0::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:7f00:0002',
    '::ffff:127.0.0.2', '::ffff:7fff:ffff',
  ])('%s is loopback - a published port bound to it is dead', (address) => {
    expect(isLoopbackBind(address)).toBe(true);
  });

  it.each([
    '0.0.0.0', '::',
    '172.28.0.5', '192.168.1.20', '10.0.0.7', '8.8.8.8', '128.0.0.1', '126.255.255.255',
    'fd00::5', 'fe80::1', '::11', '::1:1', '1::', '2001:db8::1',
    // The collateral an UNANCHORED hex pattern would take - addresses that merely CONTAIN the
    // loopback bytes. Anchoring on the mapped prefix keeps all of them allowed.
    '2001:7fab::5', '2001:db8::ffff:127.0.0.1', '7f00::1', '::ffff:126.0.0.1', '::ffff:128.0.0.1',
    '7f00:1::', '2001:db8::ffff:7f00:1',
  ])('%s is NOT loopback - a published port bound to it works', (address) => {
    expect(isLoopbackBind(address)).toBe(false);
  });

  it('unparseable input degrades to loopback (a visible alarm), never to a silent pass', () => {
    expect(isLoopbackBind('')).toBe(true);
    expect(isLoopbackBind('not an address')).toBe(true);
  });
});

// The claim the whole redesign rests on: the KERNEL canonicalises the operator's spelling, so the
// value that reaches isLoopbackBind is one of a handful of forms no matter what was configured.
// Proven end-to-end here - bind each spelling for real, read it back through the live /health
// payload - rather than asserted from documentation.
describe('every spelling collapses to a canonical bind, and /health reports it', () => {
  const loopbackSpellings = [
    '127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001', '0::1', '::0:1', '::0.0.0.1',
    '::ffff:127.0.0.1', '::FFFF:127.0.0.1', '::Ffff:127.0.0.1',
    '0:0:0:0:0:ffff:127.0.0.1', '0::ffff:127.0.0.1', '::ffff:7f00:1',
  ];

  it.each(loopbackSpellings)('BIND_HOST=%s -> /health says loopback:true', async (bind) => {
    const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test', BIND_HOST: bind });
    const handle = await startServer(config, logger);
    try {
      const res = await fetch(`http://${dialableHost(bind)}:${handle.port}/health`);
      const body = await res.json() as { status: string; bind: { address: string; loopback: boolean } };
      expect(body.status).toBe('ok');
      expect(body.bind.address).toBe(handle.address);      // the payload reports what the socket bound
      expect(['127.0.0.1', '::1', '::ffff:127.0.0.1']).toContain(handle.address); // canonicalised
      expect(body.bind.loopback).toBe(true);
    } finally { await handle.close(); }
  });

  it.each(['0.0.0.0', '::'])('BIND_HOST=%s -> /health says loopback:false', async (bind) => {
    const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test', BIND_HOST: bind });
    const handle = await startServer(config, logger);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
      const body = await res.json() as { bind: { address: string; loopback: boolean } };
      expect(body.bind.address).toBe(handle.address);
      expect(body.bind.loopback).toBe(false);
    } finally { await handle.close(); }
  });

  // The production server is the multi-tenant one; its /health is a different handler, so the field
  // is wired twice and must be locked twice (the same shape of miss as the two listen sites).
  it('multi-tenant /health carries the same bind block', async () => {
    initJwt(mtEnv.keycloakJwksUrl, mtEnv.oauthAuthorizationServer);
    const config = loadConfig({ MCP_TRANSPORT: 'http', PORT: '0', NODE_ENV: 'test', BIND_HOST: '127.0.0.1' });
    const handle = await startServer(config, logger, {
      env: mtEnv,
      resolvePat: async () => null,
      accountsDb: {
        listTokens: async () => [], addToken: async () => { throw new Error('unused'); },
        removeToken: async () => false, setDefaultToken: async () => false,
        getTokenWithPat: async () => null, updateValidation: async () => {},
      },
      pingDb: async () => {},
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
      const body = await res.json() as { status: string; bind: { address: string; loopback: boolean } };
      expect(body.status).toBe('ok');
      expect(body.bind).toEqual({ address: '127.0.0.1', loopback: true });
    } finally { await handle.close(); }
  });
});

// Finding 1 of review round 1, proven live: mcp-server/.env.example is fed to the full-profile
// container through docker compose `env_file`, and `env_file` beats the image's own ENV. An ACTIVE
// `BIND_HOST=127.0.0.1` line in the shipped example therefore shadows `ENV BIND_HOST=0.0.0.0`: the
// container binds loopback inside its own namespace, the published port answers nothing and the
// container goes unhealthy - on a FRESH production deploy, whose documented bring-up step
// (docker/README.md) copies this very file into place.
describe('the shipped .env.example cannot shadow the image bind', () => {
  const example = readFileSync(join(repoRoot, 'mcp-server', '.env.example'), 'utf8');
  const compose = readFileSync(join(repoRoot, 'docker', 'docker-compose.yml'), 'utf8');

  it('the shadowing path still exists: compose feeds that file to the container', () => {
    expect(compose).toMatch(/env_file:\s*\n\s*-\s*\.\.\/mcp-server\/\.env\s*$/m);
  });

  it('BIND_HOST is documented but NOT an active assignment (same rule as FIGMA_TOKEN)', () => {
    expect(example).toMatch(/^#\s*BIND_HOST=127\.0\.0\.1$/m);
    expect(example).not.toMatch(/^\s*BIND_HOST=/m);
  });
});
