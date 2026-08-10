// package metadata + .env.example ↔ config-schema sync.
// The sync test SCRAPES both schema sources (config.ts z.object keys + multi-tenant/env.ts
// env.* reads) so ADDING a variable to either schema without documenting it in .env.example
// goes RED, and DELETING a line from .env.example goes RED (mutation "delete a line" → RED).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

  // ---- the blind spot of the sync assertions above, which CONTRIBUTING.md now names ----
  // Both scrapers read a source file, so a variable read straight off `process.env` is in neither
  // and `.env.example` is NOT a complete list of what the server reads. CONTRIBUTING.md points
  // readers at MCP_PRETTY_JSON as the live instance of that gap. Move it into ConfigSchema, into
  // multi-tenant/env.ts, or into .env.example and the prose keeps naming an example that stopped
  // being one — with nothing watching. These pin that it stays the live instance.
  //
  // Its LIVENESS is deliberately not asserted here: tests/unit/serialize.test.ts already proves
  // MCP_PRETTY_JSON=true still changes serializeForDelivery's output, which is the property. A
  // grep of serialize.ts for the string would be the weaker restatement — a commented-out read
  // satisfies containment, so that assertion could not go red for the reason it exists.
  //
  // Not vacuous: `scrapers actually see the schemas` above refuses an empty scrape, so these
  // cannot pass by both key sets rotting to [].
  it('CONTRIBUTING.md still names MCP_PRETTY_JSON and its read site as the uncovered case', () => {
    const contributing = read('../CONTRIBUTING.md');
    expect(contributing).toContain('MCP_PRETTY_JSON');
    expect(contributing).toContain('src/adapters/driving/tools/serialize.ts');
  });

  it('MCP_PRETTY_JSON is in NEITHER scraped source, so no CI gate covers it', () => {
    expect(configSchemaKeys()).not.toContain('MCP_PRETTY_JSON');
    expect(multiTenantEnvKeys()).not.toContain('MCP_PRETTY_JSON');
  });

  it('MCP_PRETTY_JSON is absent from .env.example, by the same predicate the sync tests use', () => {
    expect(mentioned('MCP_PRETTY_JSON')).toBe(false);
  });

  it('FIGMA_TIMEOUT_MS example matches the real default (90000, not the stale 30000)', () => {
    expect(example).toMatch(/^#?\s*FIGMA_TIMEOUT_MS=90000$/m);
  });

  it('no personal or internal hosts in examples (localhost/example.com only)', () => {
    const foreignHosts = [...example.matchAll(/https?:\/\/([\w.-]+)/gi)].map((m) => m[1].toLowerCase()).filter((h) => h !== 'localhost' && h !== '127.0.0.1' && !h.endsWith('example.com'));
    expect(foreignHosts).toEqual([]);
  });
});

// CONTRIBUTING.md's integration-tier bullet QUOTES code out of tests/integration/, and the form it
// carried until 59d7ffd was in 0 of the 9 files: `describe.skipIf(!process.env.TEST_DATABASE_URL)`,
// a plausible composite nobody had ever grepped for. The behaviour claim wrapped around it was
// TRUE, which is why nothing noticed for so long -- only the copy-paste was dead. Four quoted forms
// on this branch had rotted the same way, which is the base rate that makes this worth gating.
//
// The literals are READ OUT OF THE PAGE rather than restated here. A list in this file would be a
// second home for the quote, and the next invented form would simply be added to both -- the gate
// would then be checking that this file agrees with itself. Whatever the bullet quotes is what
// every integration file must contain, so the page is the only home.
//
// Ceiling: only the spans mentioning `skipIf` or `TEST_DATABASE_URL` are checked, so a rotted quote
// in any OTHER span of this bullet passes green -- the same failure that made this gate necessary,
// one span over. The filter is what makes the assertion true rather than absurd: the bullet also
// quotes a directory, a service image and a command, and measured across the nine files
// `tests/integration/` is in 0, `postgres:16` in 0 and `pnpm test` in 1. Widening to every span
// would go red on quotes that were never meant to be greppable inside a test file. Widening to a
// named list of the two skip forms is what the paragraph above refuses. Anything better needs the
// gate to know which spans are claims ABOUT the files, which is per-span work, not a filter.
describe('CONTRIBUTING.md quotes the integration tier as it actually is', () => {
  const bullet = /^- \*\*Integration\*\*[\s\S]*?(?=\n- \*\*)/m.exec(read('../CONTRIBUTING.md'))?.[0] ?? '';
  const quoted = [...bullet.matchAll(/`([^`]+)`/g)].map((m) => m[1])
    .filter((s) => s.includes('skipIf') || s.includes('TEST_DATABASE_URL'));
  const files = readdirSync(join(root, 'tests', 'integration')).filter((f) => f.endsWith('.test.ts'));

  it('has a bullet, code spans inside it, and files to check them against', () => {
    // The assertion below quantifies over `quoted` x `files`. Either one empty -- a renamed bullet,
    // a filter that stops matching, a moved directory -- and it passes over nothing, which is this
    // branch's most common false green. These three floors are what stop that.
    expect(bullet, 'no `- **Integration**` bullet in CONTRIBUTING.md; the reader is broken, and a '
      + 'broken reader passes everything').not.toBe('');
    expect(quoted.length, 'the Integration bullet quotes no skip/DB code spans')
      .toBeGreaterThanOrEqual(2);
    expect(files.length, 'no *.test.ts under tests/integration/').toBeGreaterThanOrEqual(9);
  });

  it('every form it quotes is in every integration file, so a reader who greps finds it', () => {
    const missing = quoted.flatMap((lit) => files
      .filter((f) => !read(`tests/integration/${f}`).includes(lit))
      .map((f) => `${f} lacks \`${lit}\``));
    expect(missing, 'CONTRIBUTING.md quotes a form these files do not contain -- either the page '
      + 'invented it, or the files moved on without it').toEqual([]);
  });
});

describe('package.json publication metadata', () => {
  const pkg = JSON.parse(read('package.json'));

  it('bin maps framefit → dist/index.js', () => {
    expect(pkg.bin).toEqual({ 'framefit': 'dist/index.js' });
  });

  it('the tarball carries dist AND the front page AND the licence', () => {
    // `files` pins what npm takes out of the package tree, and dist is all of it. README.md and
    // LICENSE are absent from that list and do not belong in it: npm adds them on its own, but
    // only from the PACKAGE root -- this directory -- while both files live one level up, at the
    // repo root. So the pin alone published a blank npm page and shipped MIT code with no licence
    // text. prepack copies them in, postpack takes them back out; the pin and the copy are one
    // mechanism, and asserting either half by itself is what kept the hole open.
    expect(pkg.files).toEqual(['dist']);
    expect(pkg.scripts.prepack, 'prepack must put the front page in the package root').toContain('README.md');
    expect(pkg.scripts.prepack, 'prepack must put the licence in the package root').toContain('LICENSE');
    expect(pkg.scripts.postpack, 'postpack must remove the copies so they cannot be committed').toContain('rmSync');
  });

  it('the two files prepack reads are where it looks for them', () => {
    // prepack reads ../README.md and ../LICENSE. Rename either at the repo root and publish dies
    // -- loudly, but only in the hands of whoever runs publish, once, irreversibly. This row is
    // where that rename is supposed to be caught instead.
    expect(read('../LICENSE')).toContain('MIT License');
    expect(read('../README.md')).toContain('framefit');
    expect(pkg.license).toBe('MIT');
  });

  it('repository/author present', () => {
    expect(pkg.repository).toMatchObject({ type: 'git', url: expect.stringContaining('github.com/zylomeara/framefit') });
    expect(pkg.author).toBe('Artem Babak');
  });

  it('prepublishOnly builds', () => {
    expect(pkg.scripts.prepublishOnly).toBe('rm -rf dist && pnpm build');
  });
});

describe('bin entrypoint shebang', () => {
  it('src/index.ts starts with #!/usr/bin/env node as its FIRST line (tsc preserves it into dist)', () => {
    expect(read('src/index.ts').split('\n')[0]).toBe('#!/usr/bin/env node');
  });
});
