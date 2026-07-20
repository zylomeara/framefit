// package metadata + .env.example ↔ config-schema sync.
// The sync test SCRAPES both schema sources (config.ts z.object keys + multi-tenant/env.ts
// env.* reads) so ADDING a variable to either schema without documenting it in .env.example
// goes RED, and DELETING a line from .env.example goes RED (mutation "delete a line" → RED).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

function configSchemaKeys(): string[] {
  // Every `  NAME: z.…` line inside the ConfigSchema object literal.
  const src = read('src/infrastructure/config.ts');
  return [...src.matchAll(/^ {2}([A-Z][A-Z0-9_]*):\s*z[\s\S]?/gm)].map((m) => m[1]);
}

function multiTenantEnvKeys(): string[] {
  // Every `env.NAME` read + every 'NAME' literal in the required-vars list.
  const src = read('src/multi-tenant/env.ts');
  const dotted = [...src.matchAll(/env\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]);
  const quoted = [...src.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
  return [...new Set([...dotted, ...quoted])];
}

describe('.env.example sync with BOTH env schemas', () => {
  const example = read('.env.example');
  const mentioned = (name: string): boolean => new RegExp(`^#?\\s*${name}=`, 'm').test(example);

  it('scrapers actually see the schemas (guards against silent regex rot)', () => {
    const cfg = configSchemaKeys();
    const mt = multiTenantEnvKeys();
    expect(cfg.length).toBeGreaterThanOrEqual(22);
    expect(cfg).toContain('PUBLIC_BASE_URL');
    expect(cfg).toContain('FIGMA_TIMEOUT_MS');
    expect(mt).toContain('ENFORCE_AUDIENCE');
    expect(mt).toContain('PUBLIC_BASE_URL');
    expect(mt).toContain('MULTI_TENANT');
  });

  it('every config.ts schema variable is documented in .env.example', () => {
    const missing = configSchemaKeys().filter((k) => !mentioned(k));
    expect(missing).toEqual([]);
  });

  it('every multi-tenant/env.ts variable is documented in .env.example', () => {
    const missing = multiTenantEnvKeys().filter((k) => !mentioned(k));
    expect(missing).toEqual([]);
  });

  it('no stale variables: every VAR= line in .env.example exists in a schema (e2e vars allowlisted)', () => {
    const allow = new Set(['FIGMA_TOKEN_E2E', 'E2E_FILE_URL', 'FIGMA_E2E_TOKEN', 'FIGMA_E2E_FILE', 'FIGMA_E2E_NODE', 'FIGMA_E2E_SOURCE_LIB']);
    const known = new Set([...configSchemaKeys(), ...multiTenantEnvKeys()]);
    const listed = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    const stale = listed.filter((k) => !known.has(k) && !allow.has(k));
    expect(stale).toEqual([]);
  });

  it('FIGMA_TIMEOUT_MS example matches the real default (90000, not the stale 30000)', () => {
    expect(example).toMatch(/^#?\s*FIGMA_TIMEOUT_MS=90000$/m);
  });

  it('no personal or internal hosts in examples (localhost/example.com only)', () => {
    const foreignHosts = [...example.matchAll(/https?:\/\/([\w.-]+)/gi)].map((m) => m[1].toLowerCase()).filter((h) => h !== 'localhost' && h !== '127.0.0.1' && !h.endsWith('example.com'));
    expect(foreignHosts).toEqual([]);
  });
});

describe('package.json publication metadata', () => {
  const pkg = JSON.parse(read('package.json'));

  it('bin maps framefit → dist/index.js', () => {
    expect(pkg.bin).toEqual({ 'framefit': 'dist/index.js' });
  });

  it('npm pack ships only dist (files field pins the tarball surface)', () => {
    expect(pkg.files).toEqual(['dist']);
  });

  it('license is MIT and the LICENSE file ships with the repo', () => {
    expect(read('../LICENSE')).toContain('MIT License');
    expect(pkg.license).toBe('MIT');
  });

  it('repository/author present', () => {
    expect(pkg.repository).toMatchObject({ type: 'git', url: expect.stringContaining('github.com/zylomeara/framefit') });
    expect(pkg.author).toBe('Artem Babak');
  });

  it('prepublishOnly builds', () => {
    expect(pkg.scripts.prepublishOnly).toBe('pnpm build');
  });
});

describe('bin entrypoint shebang', () => {
  it('src/index.ts starts with #!/usr/bin/env node as its FIRST line (tsc preserves it into dist)', () => {
    expect(read('src/index.ts').split('\n')[0]).toBe('#!/usr/bin/env node');
  });
});
