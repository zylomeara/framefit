/**
 * FigmaApiError.kind is FROZEN. This file is the freeze, and it is a GATE, not a table.
 *
 * WHY A TABLE WOULD BE DECORATION. `kind` is a routing decision that 41 branch sites in 13 files
 * read and nothing in the protocol carries: an agent sees a message, an operator sees the
 * `error_kind` log field, and neither can tell that a 403 stopped being 'forbidden'. A document
 * listing the eight kinds cannot fail, so it cannot protect them. Three mutations were measured
 * against the tree this file was added to, each moving ONE producer:
 *
 *   403 default          'forbidden' -> 'auth'         5 files red, ONE of them a consumer
 *                                                      (get_variables); find_nodes, node-ancestry,
 *                                                      search_design_system and the negative-cache
 *                                                      whitelist all stayed green
 *   getImages 200 body   'upstream'  -> 'unknown_4xx'  2 rows red (get_review_board, get_screenshot);
 *                                                      get_pin_detail's guard stayed green
 *   readCapped x3        'too_large' -> 'unknown_4xx'  2 rows red, BOTH adapter-level; the depth-1
 *                                                      backoff in caching-figma-api - the only
 *                                                      consumer of that kind - stayed green
 *   5xx                  'upstream'  -> 'network'      1 row red, adapter-level; the negative-cache
 *                                                      whitelist stayed green
 *
 * The pattern behind every gap: the consumer suites build their own `new FigmaApiError('x', ...)`,
 * so they assert what the consumer does with a kind they invented and never observe the kind the
 * adapter produces. This file therefore has ONE rule for every row - the error under test comes
 * from the REAL producer, driven end to end with only `fetch` stubbed. Not one FigmaApiError is
 * constructed here.
 *
 * Four parts:
 *   1. The consumer map, READ OFF src rather than hand-maintained, so the names in a failure
 *      message are the sites that exist today.
 *   2. The production freeze: every path that produces a kind, exercised, with (kind, status)
 *      frozen. A failure NAMES the consumers that stop firing and the ones that start.
 *   3. Consumer rows for the three sites nothing else reaches, each fed from the real producer.
 *   4. Population ratchets, so a NEW producer or a NEW consumer cannot ship without appearing here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { CachingFigmaApiAdapter, type ReadCaches } from '../../src/adapters/driven/caching-figma-api.js';
import { FileStructureCache } from '../../src/infrastructure/file-structure-cache.js';
import { FrameHydrationStore } from '../../src/infrastructure/frame-hydration-store.js';
import { TtlCache } from '../../src/infrastructure/node-cache.js';
import { makeReadCaches } from '../../src/infrastructure/server.js';
import { loadConfig } from '../../src/infrastructure/config.js';
import { runTool } from '../../src/adapters/driving/tools/shared-error-handler.js';
import { FigmaApiError, type FigmaApiErrorKind } from '../../src/ports/errors.js';

const logger = pino({ level: 'silent' });
afterEach(() => vi.unstubAllGlobals());

const KINDS: FigmaApiErrorKind[] = [
  'auth', 'forbidden', 'not_found', 'rate_limited', 'upstream', 'network', 'unknown_4xx', 'too_large',
];

// ---------------------------------------------------------------------------------------------
// 1. The consumer map, read off src
// ---------------------------------------------------------------------------------------------

const SRC = join(fileURLToPath(new URL('../../src/', import.meta.url)));

/**
 * Blank out comments while PRESERVING offsets, so an occurrence found in the original text can be
 * asked "were you code?" by looking at the same index. A state machine rather than a regex pair:
 * `//` inside a string literal (`'http://...'`) is not a comment, and a regex that pretends
 * otherwise silently deletes code - which in a scanner means silently under-reporting, the exact
 * false green this file exists to close.
 */
function blankComments(src: string): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++; }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkTs(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

type Site = { file: string; line: number; kind: FigmaApiErrorKind };
/** A `new FigmaApiError(` call whose first argument is not a kind literal. */
type DynamicProducer = { file: string; line: number; expr: string };

/**
 * Blank the `FigmaApiErrorKind` union declaration, preserving offsets, so the file the type lives
 * in can be SCANNED rather than skipped.
 *
 * Round 2 closed a hole here, and it is the same population-boundary defect this branch has now
 * paid for four times. The scanner used to skip ports/errors.ts by name, on the reasoning that the
 * union's own declaration is not a use of it. True of the declaration; false of the file. A review
 * declared `export const RENDER_MISS_KIND = 'not_found';` in that file and threw
 * `new FigmaApiError(RENDER_MISS_KIND, ...)` from getImages: a new producer, invisible to the
 * literal scan (the producer site holds an identifier) AND invisible to the population ratchet (the
 * literal sat in the one file nothing read). 31/31 green, whole suite green. Blanking the
 * DECLARATION instead of the FILE is the narrowest boundary that still lets a const be seen.
 */
function blankKindUnion(src: string): string {
  const start = src.indexOf('export type FigmaApiErrorKind');
  if (start === -1) return src;
  const end = src.indexOf(';', start);
  if (end === -1) return src;
  return src.slice(0, start) + ' '.repeat(end - start + 1) + src.slice(end + 1);
}

/**
 * Every occurrence of a kind LITERAL in a file that knows about FigmaApiError, classified as a
 * producer (`new FigmaApiError('x'`), a branch (`.kind === 'x'`, `.kind !== 'x'`, `case 'x'`) or
 * neither. "Neither" is a failure, not a silence: an unrecognised form is a site this file cannot
 * name, and naming the sites is what the freeze is for.
 *
 * It also collects every `new FigmaApiError(` whose first argument is NOT a literal. Freezing the
 * literals alone leaves the identifier route open wherever the identifier is declared, so the
 * question this scanner answers is "what does each producer pass", not "where are the literals".
 *
 * Scoped to files mentioning FigmaApiError on purpose. `'not_found'` is also a dom-extractor
 * selector status and `'network'` shows up in unrelated prose; widening the population to all of
 * src would trade a precise scanner for a noisy one.
 */
function scanKindSites(): {
  producers: Site[]; branches: Site[]; dynamic: DynamicProducer[]; unclassified: string[]; files: number;
} {
  const producers: Site[] = [];
  const branches: Site[] = [];
  const dynamic: DynamicProducer[] = [];
  const unclassified: string[] = [];
  const files = walkTs(SRC)
    .filter((p) => readFileSync(p, 'utf8').includes('FigmaApiError'))
    .sort();
  for (const p of files) {
    const rel = relative(SRC, p).split('\\').join('/');
    const text = readFileSync(p, 'utf8');
    const code = blankKindUnion(blankComments(text));
    const lineOf = (idx: number): number => text.slice(0, idx).split('\n').length;
    const re = new RegExp(`'(${KINDS.join('|')})'`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const idx = m.index;
      // The stripper blanks comment bodies and the union declaration, so a literal that is
      // whitespace in `code` at the same offset was prose or the type itself. Neither is a use.
      if (code.slice(idx, idx + m[0].length).trim() === '') continue;
      const kind = m[1] as FigmaApiErrorKind;
      const before = code.slice(Math.max(0, idx - 80), idx);
      if (/new FigmaApiError\(\s*$/.test(before)) producers.push({ file: rel, line: lineOf(idx), kind });
      else if (/\.kind\s*(===|!==)\s*$/.test(before)) branches.push({ file: rel, line: lineOf(idx), kind });
      else if (/\bcase\s+$/.test(before)) branches.push({ file: rel, line: lineOf(idx), kind });
      else unclassified.push(`${rel}:${lineOf(idx)} '${kind}'`);
    }
    // Every construction, by what it PASSES. The `s` flag matters: three call sites in this tree
    // put the kind on the line after the paren.
    const call = /new FigmaApiError\(\s*([^,]*?)\s*,/gs;
    while ((m = call.exec(code)) !== null) {
      const expr = m[1];
      if (!/^'[a-z0-9_]+'$/.test(expr)) dynamic.push({ file: rel, line: lineOf(m.index), expr });
    }
  }
  return { producers, branches, dynamic, unclassified, files: files.length };
}

const SITES = scanKindSites();

/** The sites that would change behaviour if this kind arrived, or stopped arriving. */
function consumersOf(kind: string): string[] {
  return SITES.branches.filter((b) => b.kind === kind).map((b) => `${b.file}:${b.line}`);
}

/**
 * The failure a reader of this file actually needs: not "expected forbidden, got auth", but which
 * code stops running and which code starts. Computed from the scan, so it can never name a site
 * that was deleted or miss one that was added.
 */
function kindMoved(row: string, frozen: string, observed: string): string {
  const stops = consumersOf(frozen);
  const starts = consumersOf(observed);
  return `${row}: FigmaApiError.kind moved '${frozen}' -> '${observed}'.\n`
    + `  Consumers that branch on '${frozen}' and would STOP firing (${stops.length}): `
    + `${stops.join(', ') || '(none)'}\n`
    + `  Consumers that branch on '${observed}' and would START firing (${starts.length}): `
    + `${starts.join(', ') || '(none)'}\n`
    + '  And every kind reaches a reader as the [kind] prefix on the tool result and an operator as\n'
    + '  the error_kind field of the tool.error log line (shared-error-handler.ts).\n'
    + '  If the move is intended: change the frozen kind HERE, in the same commit, and say in the\n'
    + '  message what each site above now does.';
}

// ---------------------------------------------------------------------------------------------
// 2. The production freeze - every producing path, driven for real
// ---------------------------------------------------------------------------------------------

const api = (opts: { maxFetchBytes?: number; deadlineAt?: number } = {}) =>
  new FigmaRestAdapter('figd_test', logger, 4, 5000, undefined, undefined,
    opts.deadlineAt, opts.maxFetchBytes ?? 128 * 1024 * 1024);

function stubStatus(status: number, body: string, headers: Record<string, string> = {}): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers })));
}

async function caught(run: () => Promise<unknown>): Promise<FigmaApiError> {
  const e = await run().then(() => undefined).catch((x: unknown) => x);
  expect(e, 'the call under test did not fail at all').toBeInstanceOf(FigmaApiError);
  return e as FigmaApiError;
}

type Row = {
  name: string;
  /** Which producing path this row reaches - the thing that must not silently re-classify. */
  producer: string;
  kind: FigmaApiErrorKind;
  status: number;
  run: () => Promise<FigmaApiError>;
};

const rows: Row[] = [
  {
    name: '401 with no parseable reason',
    producer: 'figma-rest.ts mapStatus 401 dead-token branch',
    kind: 'auth', status: 401,
    run: () => { stubStatus(401, ''); return caught(() => api().getComments('abc123')); },
  },
  {
    name: '401 naming the Authorization-header rule (live-captured body)',
    producer: 'figma-rest.ts mapStatus 401 named-reason branch',
    kind: 'auth', status: 401,
    run: () => {
      stubStatus(401, '{"status":401,"err":"figd_ tokens must be passed via X-Figma-Token header, not Authorization"}');
      return caught(() => api().getComments('abc123'));
    },
  },
  {
    name: '403 Invalid token (live-captured body)',
    producer: 'figma-rest.ts mapStatus 403 dead_token family',
    kind: 'forbidden', status: 403,
    run: () => { stubStatus(403, '{"status":403,"err":"Invalid token"}'); return caught(() => api().getComments('abc123')); },
  },
  {
    name: '403 Invalid token under the `message` field (/variables/local body shape)',
    producer: 'figma-rest.ts mapStatus 403 dead_token family, message spelling',
    kind: 'forbidden', status: 403,
    run: () => {
      stubStatus(403, '{"status":403,"error":true,"message":"Invalid token"}');
      return caught(() => api().getVariablesLocal('abc123'));
    },
  },
  {
    name: '403 Invalid scope',
    producer: 'figma-rest.ts mapStatus 403 scope family - the ONE branch that answers auth at 403',
    kind: 'auth', status: 403,
    run: () => { stubStatus(403, '{"status":403,"err":"Invalid scope"}'); return caught(() => api().getComments('abc123')); },
  },
  {
    name: '403 Limited by Figma plan',
    producer: 'figma-rest.ts mapStatus 403 plan_limit family',
    kind: 'forbidden', status: 403,
    run: () => { stubStatus(403, '{"status":403,"err":"Limited by Figma plan"}'); return caught(() => api().getComments('abc123')); },
  },
  {
    // THE CLASS THAT MOVED DURING THIS LINE, and the reason this file exists rather than a table:
    // before task 11 the scope test ran first and this body answered 'auth'. It is frozen at the
    // 403 default now, which is the point - the kind stops being something an intermediary can
    // choose by writing "scope" into a body.
    name: '403 naming BOTH an account type and a scope (the class that moved in this line)',
    producer: 'figma-rest.ts mapStatus 403 plan_limit outranking the scope test',
    kind: 'forbidden', status: 403,
    run: () => {
      stubStatus(403, '{"status":403,"err":"Incorrect account type, missing scope"}');
      return caught(() => api().getComments('abc123'));
    },
  },
  {
    name: '403 whose body is an HTML interstitial (nothing parseable)',
    producer: 'figma-rest.ts mapStatus 403 frozen default',
    kind: 'forbidden', status: 403,
    run: () => {
      stubStatus(403, '<HTML><HEAD><TITLE>ERROR 403: request out of scope</TITLE></HEAD></HTML>');
      return caught(() => api().getComments('abc123'));
    },
  },
  {
    name: '403 on a comment delete (the write path carries its own message, not its own kind)',
    producer: 'figma-rest.ts mapStatus 403 frozen default, writeOp comment_delete',
    kind: 'forbidden', status: 403,
    run: () => { stubStatus(403, 'Forbidden'); return caught(() => api().deleteComment('abc123', '1')); },
  },
  {
    name: '404',
    producer: 'figma-rest.ts mapStatus 404',
    kind: 'not_found', status: 404,
    run: () => { stubStatus(404, '{"status":404,"err":"Not found"}'); return caught(() => api().getComments('abc123')); },
  },
  {
    name: '429 with a Retry-After header',
    producer: 'figma-rest.ts mapStatus 429',
    kind: 'rate_limited', status: 429,
    run: () => { stubStatus(429, '', { 'retry-after': '30' }); return caught(() => api().getComments('abc123')); },
  },
  {
    name: '429 with no Retry-After header',
    producer: 'figma-rest.ts mapStatus 429, header-less',
    kind: 'rate_limited', status: 429,
    run: () => { stubStatus(429, ''); return caught(() => api().getComments('abc123')); },
  },
  {
    name: '500',
    producer: 'figma-rest.ts mapStatus 5xx',
    kind: 'upstream', status: 500,
    run: () => { stubStatus(500, ''); return caught(() => api().getComments('abc123')); },
  },
  {
    name: '503',
    producer: 'figma-rest.ts mapStatus 5xx',
    kind: 'upstream', status: 503,
    run: () => { stubStatus(503, ''); return caught(() => api().getComments('abc123')); },
  },
  {
    name: '400',
    producer: 'figma-rest.ts mapStatus 4xx fallthrough',
    kind: 'unknown_4xx', status: 400,
    run: () => { stubStatus(400, '{"status":400,"err":"Invalid parameter: node_id"}'); return caught(() => api().getComments('abc123')); },
  },
  {
    name: '409 (a 4xx with no branch of its own)',
    producer: 'figma-rest.ts mapStatus 4xx fallthrough',
    kind: 'unknown_4xx', status: 409,
    run: () => { stubStatus(409, ''); return caught(() => api().getComments('abc123')); },
  },
  {
    // NOT a mapStatus path: GET /v1/images reports a render failure INSIDE a 200 body, so this kind
    // is chosen at a direct construction site. It is guarded at three consumers by
    // (kind === 'upstream' && status === 200) - both halves, so both are frozen here.
    name: 'a render failure reported inside a 200 body (GET /v1/images)',
    producer: 'figma-rest.ts getImages payload.err',
    kind: 'upstream', status: 200,
    run: () => {
      stubStatus(200, '{"err":"Node not found","images":{}}');
      return caught(() => api().getImages('abc123', ['1:2'], { format: 'png', scale: 1 }));
    },
  },
  {
    name: 'a component whose meta carries no library location',
    producer: 'figma-rest.ts getComponent missing file_key/node_id',
    kind: 'not_found', status: 200,
    run: () => { stubStatus(200, '{"meta":{"name":"C"}}'); return caught(() => api().getComponent('ckey')); },
  },
  {
    name: 'a declared content-length over the fetch cap (fast reject)',
    producer: 'figma-rest.ts readCapped declared-length branch',
    kind: 'too_large', status: 0,
    run: () => {
      stubStatus(200, '{}', { 'content-length': '999999999', 'content-type': 'application/json' });
      return caught(() => api({ maxFetchBytes: 20 }).getDocumentRaw('abc123'));
    },
  },
  {
    name: 'a streamed body over the fetch cap (no content-length)',
    producer: 'figma-rest.ts readCapped streaming branch',
    kind: 'too_large', status: 0,
    run: () => {
      stubStatus(200, JSON.stringify({ blob: 'x'.repeat(500) }), { 'content-type': 'application/json' });
      return caught(() => api({ maxFetchBytes: 20 }).getDocumentRaw('abc123'));
    },
  },
  {
    name: 'a request dequeued past its absolute deadline (no fetch issued)',
    producer: 'figma-rest.ts request() deadline pre-check',
    kind: 'network', status: 0,
    run: () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the deadline branch must not reach the network'); }));
      return caught(() => api({ deadlineAt: Date.now() - 1000 }).getComments('abc123'));
    },
  },
  {
    name: 'the transport itself failing (ECONNRESET-shaped)',
    producer: 'figma-rest.ts request() catch-all',
    kind: 'network', status: 0,
    run: () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
      return caught(() => api().getComments('abc123'));
    },
  },
  {
    name: 'an aborted request (the per-request timeout firing)',
    producer: 'figma-rest.ts request() AbortError branch',
    kind: 'network', status: 0,
    run: () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        const e = new Error('This operation was aborted');
        e.name = 'AbortError';
        throw e;
      }));
      return caught(() => api().getComments('abc123'));
    },
  },
];

describe('the kind every producing path answers with is frozen', () => {
  for (const row of rows) {
    it(`${row.name} -> ${row.kind} (${row.status})`, async () => {
      const e = await row.run();
      expect(e.kind, kindMoved(`${row.name} [${row.producer}]`, row.kind, e.kind)).toBe(row.kind);
      expect(e.status, `${row.name}: status moved ${row.status} -> ${e.status}. Three consumers `
        + 'guard on (kind, status) together - get_review_board, get_screenshot and get_pin_detail '
        + "all require status 200 beside kind 'upstream' - so the pair is frozen, not the kind alone.")
        .toBe(row.status);
    });
  }

  it('every kind in the union has a row, so a NINTH kind cannot ship unexercised', () => {
    const covered = new Set(rows.map((r) => r.kind));
    expect([...KINDS].filter((k) => !covered.has(k)),
      'a kind with no row here is a kind this freeze does not hold').toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Consumer rows - the sites nothing else reaches, each fed from the real producer
// ---------------------------------------------------------------------------------------------

function freshCaches(): ReadCaches {
  return {
    nodeCache: new TtlCache(300_000),
    variablesCache: new TtlCache(300_000),
    variablesErrorCache: new TtlCache<string>(600_000),
    versionCache: new TtlCache(60_000),
    librariesCache: new TtlCache(300_000),
    componentCache: new TtlCache(300_000),
    docCache: new TtlCache(300_000),
    componentSetsCache: new TtlCache(300_000),
    imageFillsCache: new TtlCache(300_000),
  } as unknown as ReadCaches;
}

/**
 * Route by URL so the version probe succeeds and only the endpoint under test fails. The caching
 * adapter calls getFileVersion before getVariablesLocal; a blanket stub would fail the wrong call
 * and the row would pass for the wrong reason.
 */
function stubRoutes(routes: { match: string; status: number; body: string }[]): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: string) => {
    const u = String(url);
    const hit = routes.find((r) => u.includes(r.match));
    if (!hit) throw new Error(`no route for ${u}`);
    return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const VERSION_BODY = '{"version":"v1","name":"F","lastModified":"x"}';

describe("the negative-variables cache reads the producer's kind, not a hand-built one", () => {
  // caching-figma-api.ts:305 is one of the five sites the reviews named, and it was gated by
  // nothing: its own suite constructs FigmaApiError('upstream', 500) directly, so moving the 5xx
  // kind at the adapter left it green. Here the kind comes from mapStatus.
  it("a 5xx IS remembered, because 'upstream' is on the whitelist", async () => {
    const spy = stubRoutes([
      { match: '/variables/local', status: 500, body: '' },
      { match: '?depth=1', status: 200, body: VERSION_BODY },
    ]);
    const a = new CachingFigmaApiAdapter(api(), new FileStructureCache(300_000), logger, freshCaches(), { timeoutMs: 90_000 });
    const first = await caught(() => a.getVariablesLocal('abc123'));
    expect(first.kind).toBe('upstream');
    const calls = spy.mock.calls.length;
    const second = await caught(() => a.getVariablesLocal('abc123'));
    expect(second.message, 'the second call must be answered from the marker').toMatch(/^cached: /);
    expect(spy.mock.calls.length,
      kindMoved('the 5xx negative-cache whitelist [caching-figma-api.ts:305]', 'upstream', first.kind)
      + '\n  Symptom if this row is the only red one: a broken variables endpoint is re-dialled on '
      + 'every call instead of failing fast from the marker.').toBe(calls);
    // The replayed error keeps the kind: the marker serialises it and the replay reconstructs it,
    // which is a SECOND place a kind can move (caching-figma-api.ts:237, the one producer whose
    // kind argument is not a literal).
    expect(second.kind, kindMoved('the replayed marker [caching-figma-api.ts:237]', 'upstream', second.kind))
      .toBe('upstream');
    expect(second.status).toBe(500);
  });

  it("a 403 is NEVER remembered, because 'forbidden' is a verdict about the token that asked", async () => {
    const spy = stubRoutes([
      { match: '/variables/local', status: 403, body: '{"status":403,"error":true,"message":"Invalid token"}' },
      { match: '?depth=1', status: 200, body: VERSION_BODY },
    ]);
    const a = new CachingFigmaApiAdapter(api(), new FileStructureCache(300_000), logger, freshCaches(), { timeoutMs: 90_000 });
    const first = await caught(() => a.getVariablesLocal('abc123'));
    expect(first.kind).toBe('forbidden');
    const calls = spy.mock.calls.length;
    const second = await caught(() => a.getVariablesLocal('abc123'));
    expect(second.message, 'a token verdict must not be replayed from a shared marker').not.toMatch(/^cached: /);
    expect(spy.mock.calls.length,
      kindMoved('the 403 negative-cache exclusion [caching-figma-api.ts:305]', 'forbidden', first.kind)
      + "\n  Symptom if this row is the only red one: one weak token's 403 denies a stronger token "
      + 'asking for the same file for the next ten minutes.').toBeGreaterThan(calls);
  });
});

describe("the frame depth backoff reads the producer's kind, not a hand-built one", () => {
  // caching-figma-api.ts:178. Its own suite throws FigmaApiError('too_large', 0, 'boom') by hand,
  // so moving every too_large producer at the adapter left the backoff green while it had silently
  // stopped firing.
  it('an over-cap deep fetch falls back to the shallower held frame', async () => {
    const config = loadConfig({});
    const store = new FrameHydrationStore(1e9, 1e9, 1e6, () => 0);
    const read = makeReadCaches(config, logger, undefined, store, 'u1');
    // A held depth-1 frame under the key getFrameRaw will compute for ('fk', ['a']).
    store.setIfDeeper('u1', 'fk|v1|frame:a', { nodes: { a: { document: { id: 'a', name: 'a', type: 'FRAME' } } } } as never, 1, 100);
    stubRoutes([
      // The nodes fetch is far over the cap set below; the version probe is not.
      { match: '/nodes', status: 200, body: JSON.stringify({ nodes: { a: { blob: 'x'.repeat(5000) } } }) },
      { match: '?depth=1', status: 200, body: VERSION_BODY },
    ]);
    const a = new CachingFigmaApiAdapter(api({ maxFetchBytes: 1000 }), new FileStructureCache(300_000), logger, read, {
      frameMaxParseBytes: config.FRAME_MAX_PARSE_BYTES,
      frameParseMultiplier: config.FRAME_PARSE_MULTIPLIER,
    });
    // Proof the producer really answers too_large on this exact fetch, before the consumer reads it.
    const direct = await caught(() => api({ maxFetchBytes: 1000 }).getNodesRaw('fk', ['a'], 5));
    expect(direct.kind, kindMoved('the frame backoff feed [figma-rest.ts readCapped]', 'too_large', direct.kind))
      .toBe('too_large');

    const res = await a.getFrameRaw('fk', ['a'], 4);
    expect(res.heldDepth,
      kindMoved('the frame depth backoff [caching-figma-api.ts:178]', 'too_large', direct.kind)
      + '\n  Symptom if this row is the only red one: an over-cap deep fetch throws instead of '
      + 'serving the shallower frame it already holds.').toBe(1);
    expect(res.hydrated).toBe(true);
  });
});

describe('the kind is delivered to a reader and to an operator, so a move is visible in both', () => {
  // shared-error-handler.ts renders the kind twice: as the [kind] prefix of the tool result an
  // agent reads, and as the error_kind field of the tool.error log line an operator greps. Neither
  // is covered by a (kind, status) assertion anywhere, and both change the moment a kind moves.
  it('the tool result carries [kind] and the log line carries error_kind, both from the real producer', async () => {
    stubStatus(403, '{"status":403,"err":"Invalid token"}');
    const seen: { tool?: string; error_kind?: string }[] = [];
    const capture = {
      warn: (obj: Record<string, unknown>) => seen.push(obj as { tool?: string; error_kind?: string }),
      info: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
    } as never;
    const res = await runTool('get_comments', capture, 'figd_test', async () => {
      await api().getComments('abc123');
      return { content: [{ type: 'text' as const, text: 'unreachable' }] };
    });
    const text = res.content[0].type === 'text' ? res.content[0].text : '';
    const kind = text.slice(1, text.indexOf(']'));
    expect(kind, kindMoved('the [kind] prefix an agent reads [shared-error-handler.ts formatError]',
      'forbidden', kind)).toBe('forbidden');
    expect(seen[0]?.error_kind, kindMoved('the error_kind log field an operator greps '
      + '[shared-error-handler.ts kindOf]', 'forbidden', String(seen[0]?.error_kind))).toBe('forbidden');
    expect(seen[0]?.tool).toBe('get_comments');
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Population ratchets
// ---------------------------------------------------------------------------------------------

/** The kinds a file uses, in source order. Position without line numbers. */
function sequences(sites: Site[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of [...sites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    (out[s.file] ??= []).push(s.kind);
  }
  return out;
}

describe('the populations this freeze is written against', () => {
  it('every kind literal in a FigmaApiError-aware file is a producer or a branch', () => {
    // An unrecognised form is not harmless: it is a site the failure messages above cannot name,
    // which is the difference between a gate and a table. ports/errors.ts is IN this population -
    // only its union declaration is blanked - so a kind constant parked beside the type is an
    // unclassified site and fails here.
    expect(SITES.unclassified, 'unrecognised kind-literal sites - classify them or the map lies').toEqual([]);
    expect(SITES.files, 'files mentioning FigmaApiError').toBe(18); // 17 -> 18: find-breakpoint-variant-tool joined the budgeted-walk consumers (feedback item 10)
  });

  it('the producer population is frozen: a NEW producer has to be added to the table above', () => {
    // ORDERED per file, not counted per file and kind. Round 2 measured what a tally cannot see:
    // swapping two kinds inside one file leaves every count identical. A sequence in source order
    // moves when they swap and does NOT move when unrelated edits shift line numbers, which is why
    // this is a list of kinds rather than a list of `file:line`.
    expect(sequences(SITES.producers)).toEqual({
      'adapters/driven/figma-rest.ts': [
        'upstream',                            // getImages: a render failure inside a 200 body
        'not_found',                           // getComponent: meta with no library location
        'too_large', 'too_large', 'too_large', // readCapped: declared, streamed, post-read
        'network',                             // request(): past the absolute deadline
        'network', 'network',                  // request(): abort, transport failure
        'auth', 'auth',                        // mapStatus 401: dead token, named reason
        'forbidden',                           // mapStatus 403: dead_token family
        'auth',                                // mapStatus 403: scope family
        'forbidden',                           // mapStatus 403: plan_limit family
        'forbidden',                           // mapStatus 403: frozen default
        'not_found',                           // mapStatus 404
        'rate_limited',                        // mapStatus 429
        'upstream',                            // mapStatus 5xx
        'unknown_4xx',                         // mapStatus 4xx fallthrough
      ],
    });
  });

  it('every construction is frozen by WHAT IT PASSES, so an identifier cannot smuggle a kind', () => {
    // The literal scan above answers "where are the literals". This one answers "what does each
    // producer pass", and only the second question is closed against an identifier.
    //
    // Round 2: a review declared `export const RENDER_MISS_KIND = 'not_found'` in ports/errors.ts
    // and threw `new FigmaApiError(RENDER_MISS_KIND, 200, ...)` from getImages. Every literal row
    // above stayed green - there is no literal at that call - and the whole 2796-test suite stayed
    // green with a new producer shipped. Freezing the ARGUMENT is what closes it, wherever the
    // identifier is declared.
    const nonLiteral = SITES.dynamic.map((d) => `${d.file}: ${d.expr}`).sort();
    expect(nonLiteral, 'a FigmaApiError built from something other than a frozen kind literal')
      .toEqual([
        // The ONE legitimate case: the negative-cache replay rebuilds the kind it stored. It cannot
        // be frozen by reading source, so it is frozen behaviourally by the round-trip row in
        // part 3, which requires the replayed error to carry the kind the producer gave it.
        'adapters/driven/caching-figma-api.ts: parsed.kind',
      ]);
  });

  it('the consumer population is frozen, and every frozen kind still has the consumers it names', () => {
    // ORDERED, for the reason given on the producer row. Round 2 measured the count-only version
    // passing a swap of `unknown_4xx` and `network` inside get-variables-tool.ts - the 400 branch
    // firing on a timeout and the timeout branch on a 400, with this file 31/31 green. The wider
    // suite caught that particular swap only because get_variables happens to have behavioural
    // rows; the gap bit exactly the consumers that do not have them.
    expect(sequences(SITES.branches)).toEqual({
      'adapters/driven/caching-figma-api.ts': [
        'too_large',                  // :178 frame depth backoff
        'network',                    // :292 is this failure a timeout
        'upstream', 'unknown_4xx',    // :305 negative-cache whitelist
        'unknown_4xx',                // soft-expiry gate: too-large 400 markers carry softExpiresAt
      ],
      'adapters/driven/figma-rest.ts': ['network'],
      'adapters/driving/tools/compare-node-to-dom-tool.ts':
        // batch-2 item 5 remainder: the variables catch gained the escalation class gate
        // (too-large unknown_4xx is one of the two classes the negative cache caches
        // cap-aware) - it sits INSIDE the first rate_limited catch, hence position 2.
        ['rate_limited', 'unknown_4xx', 'rate_limited', 'rate_limited', 'rate_limited', 'rate_limited'],
      // feedback item 10: the container walk mirrors find_nodes' contract (auth/forbidden
      // rethrow, rate_limited stops the loop keeping the partial), and the content fetch
      // degrades on everything except the dead-token pair.
      'adapters/driving/tools/find-breakpoint-variant-tool.ts': ['auth', 'forbidden', 'rate_limited', 'auth', 'forbidden', 'rate_limited'], // wave fix: content-stage 429 rethrows (back-off), never a buried note
      'adapters/driving/tools/find-nodes-tool.ts': ['auth', 'forbidden', 'rate_limited'],
      // token-parity line: the variables fetch + snapshot prefetch mirror compare's contract —
      // rate_limited rethrows (agent backs off), anything else degrades to degraded_stages.
      'adapters/driving/tools/get-layout-spec-tool.ts': ['rate_limited', 'rate_limited'],
      'adapters/driving/tools/get-code-connect-map-tool.ts': ['rate_limited'],
      'adapters/driving/tools/get-design-context-tool.ts': [
        'network', 'rate_limited', 'network', 'rate_limited', 'rate_limited', 'rate_limited',
        'rate_limited', 'rate_limited', 'rate_limited', 'rate_limited', 'rate_limited',
      ],
      'adapters/driving/tools/get-pin-detail-tool.ts': ['upstream'],
      'adapters/driving/tools/get-review-board-tool.ts': ['upstream'],
      'adapters/driving/tools/get-screenshot-tool.ts': ['network', 'upstream'], // batch-2 item 6: the transport-ladder guard sits ABOVE the tiles catch
      'adapters/driving/tools/get-variables-tool.ts': [
        'rate_limited',            // :83 do not swallow a 429
        'forbidden', 'auth',       // :147 the 403 pair
        'auth',                    // :195 scope family
        'unknown_4xx',             // :254 the 400 branch
        'network',                 // :279 the timeout branch
      ],
      'adapters/driving/tools/search-design-system-tool.ts': ['auth', 'rate_limited', 'forbidden', 'auth'],
      'application/node-ancestry.ts': ['auth', 'forbidden'],
      'domain/consumed-libraries.ts': ['rate_limited'],
    });
    expect(SITES.branches.length, '52 branch sites across 15 files').toBe(52); // 51 -> 52: the variables escalation class gate (batch-2 item 5 remainder); earlier 50 -> 51: get_screenshot's transport-ladder trigger (batch-2 item 6)
    // The one kind nothing branches on today. Stated rather than left implicit: a reader comparing
    // the two tables above would otherwise read the gap as a scanner bug.
    expect(consumersOf('not_found'), "nothing branches on 'not_found' - it reaches the reader as "
      + 'text and the operator as error_kind only').toEqual([]);
    for (const kind of KINDS.filter((k) => k !== 'not_found')) {
      expect(consumersOf(kind).length,
        `no consumer branches on '${kind}' any more - the failure messages above would name nobody`)
        .toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Consumer-through-producer integration (this file's own rule): the get_screenshot
// transport ladder must fire on the kind the REAL adapter produces for a socket close -
// every unit arm in screenshot-retry-ladder.test.ts hand-builds its FigmaApiError, so all
// of them stay green if figma-rest ever stops classifying a socket close as 'network'.
// Only fetch is stubbed here; the error under test comes from the real producer.
// ---------------------------------------------------------------------------------------------

describe('the get_screenshot ladder fires on the ADAPTER-produced transient network kind', () => {
  it('socket-close from the real request() catch-all -> one same-scale retry, delivered', async () => {
    const { registerGetScreenshotTool } = await import('../../src/adapters/driving/tools/get-screenshot-tool.js');
    const { makeFakeMcpServer } = await import('../helpers/fake-mcp-server.js');
    let imagesCalls = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/images/')) {
        imagesCalls += 1;
        if (imagesCalls === 1) throw new TypeError('The socket connection was closed unexpectedly');
        return new Response(JSON.stringify({ images: { '1:1': 'https://img.example/real' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ nodes: { '1:1': { document: {
        id: '1:1', name: 'n', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 } } } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { server, call } = makeFakeMcpServer();
    registerGetScreenshotTool(server, {
      buildApi: () => api(), defaultToken: 'figd_test', logger: pino({ level: 'silent' }),
    } as never);
    const res = await call('get_screenshot', { file: 'abc123', node_id: '1:1', scale: 2 });
    expect(res.isError).not.toBe(true);
    const out = JSON.parse((res.content[0] as { text: string }).text);
    expect(out.url).toBe('https://img.example/real');
    expect(out.scale).toBe(2);                 // step 1 recovered - no degradation fields
    expect(out.requested_scale).toBeUndefined();
    expect(imagesCalls).toBe(2);
  });
});
