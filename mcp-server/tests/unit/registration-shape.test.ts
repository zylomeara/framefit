// The migration is mechanical and typecheck cannot guard it: every fake server in this suite is
// cast `as unknown as McpServer`, which erases arity, so a stub built for the wrong overload fails
// at RUNTIME with a message that points at registration rather than at the stub. This gate is
// therefore over the live registration path, not over the source text alone.
//
// Three independent things are locked here:
//   1. the CALL SHAPE - every tool goes through `registerTool`, never the deprecated positional
//      `tool()` overload (which cannot carry annotations);
//   2. the REGISTERED SURFACE - what a client actually receives from `tools/list` is byte-identical
//      to the recorded baseline. The shape migration must not move a single character of any
//      description or schema, and this is the check that proves it rather than asserting it by eye.
//   3. the SAFETY ANNOTATIONS a client receives, recorded per tool and compared exactly.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../../src/adapters/driving/tools/register-all.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = join(here, '..', '..', 'src', 'adapters', 'driving', 'tools');
const TOOL_COUNT = 26;

// Registration only describes schemas - deps are captured in handler closures and never called -
// so a throwing buildApi both suffices and proves registration stays lazy.
function minimalDeps(): ToolDeps {
  return {
    buildApi: () => { throw new Error('buildApi must not be called during registration'); },
    logger: createLogger({ level: 'silent' }),
  } as unknown as ToolDeps;
}

function drive() {
  const viaTool: string[] = [];
  const viaRegisterTool: { name: string; config: Record<string, unknown> }[] = [];
  const stub = {
    tool: vi.fn((name: string) => { viaTool.push(name); }),
    registerTool: vi.fn((name: string, config: Record<string, unknown>) => {
      viaRegisterTool.push({ name, config });
    }),
  } as unknown as McpServer;
  registerAllTools(stub, minimalDeps());
  return { viaTool, viaRegisterTool };
}

describe('every tool registers through registerTool', () => {
  it('the deprecated positional overload is not used at all', () => {
    const { viaTool, viaRegisterTool } = drive();
    expect(viaTool, `still on server.tool(): ${viaTool.join(', ')}`).toEqual([]);
    expect(viaRegisterTool).toHaveLength(TOOL_COUNT);
  });

  it('every registration carries a non-empty description and an inputSchema', () => {
    const { viaRegisterTool } = drive();
    const bad = viaRegisterTool.filter(
      (r) => typeof r.config.description !== 'string'
        || (r.config.description as string).trim() === ''
        || r.config.inputSchema === undefined,
    ).map((r) => r.name);
    expect(bad).toEqual([]);
  });

  it('no source file under tools/ still calls server.tool(', () => {
    const offenders = readdirSync(toolsDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /server\.tool\(/.test(readFileSync(join(toolsDir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

// --- surface lock -----------------------------------------------------------------------------
// A recording stub sees what the tool file passed; it does NOT see what a client receives, because
// the SDK converts the Zod shape into JSON Schema on the way out. Only a real McpServer driven by a
// real client over the real protocol shows the delivered surface, so that is what this locks.
// Baseline in tests/fixtures/tool-surface.json was recorded from the pre-migration tree.

type SurfaceEntry = {
  description: string;
  inputSchemaKeys: string[];
  digest: string;
  annotations: Record<string, unknown> | undefined;
};

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonical((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** The tools/list payload as a CLIENT receives it, over the real protocol. */
async function deliveredTools(): Promise<Awaited<ReturnType<Client['listTools']>>['tools']> {
  const server = new McpServer({ name: 'framefit', version: '0.0.0' });
  registerAllTools(server, minimalDeps());
  const client = new Client({ name: 'surface-lock', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

async function liveSurface(): Promise<Record<string, SurfaceEntry>> {
  const tools = await deliveredTools();

  const out: Record<string, SurfaceEntry> = {};
  for (const t of tools) {
    const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    // `annotations` is held OUT of the digest on purpose and locked separately below. Declaring the
    // safety annotations added one top-level key to all 26 delivered entries; digesting the whole
    // entry would have forced a re-record of all 26 baselines, discarding the pre-migration
    // recording of the descriptions and schemas - the one thing this fixture exists to protect.
    // Split this way, every recorded digest stays byte-identical to the pre-annotation tree, which
    // is itself the proof that nothing but the annotations moved, and the annotations still cannot
    // drift unnoticed.
    const withoutAnnotations = { ...(t as Record<string, unknown>) };
    delete withoutAnnotations.annotations;
    out[t.name] = {
      description: t.description ?? '',
      inputSchemaKeys: Object.keys(props).sort(),
      digest: createHash('sha256').update(JSON.stringify(canonical(withoutAnnotations))).digest('hex'),
      annotations: t.annotations as Record<string, unknown> | undefined,
    };
  }
  return out;
}

const baseline: Record<string, SurfaceEntry> = JSON.parse(
  readFileSync(join(here, '..', 'fixtures', 'tool-surface.json'), 'utf8'),
);

describe('the tools/list surface a client receives is unchanged', () => {
  it('registers exactly the baseline tool set', async () => {
    const live = await liveSurface();
    const liveNames = Object.keys(live).sort();
    const baseNames = Object.keys(baseline).sort();
    expect(baseNames).toHaveLength(TOOL_COUNT);
    expect(
      baseNames.filter((n) => !(n in live)),
      'tools present in the baseline but no longer registered - a registration was dropped',
    ).toEqual([]);
    expect(
      liveNames.filter((n) => !(n in baseline)),
      'tools registered but absent from the baseline - update tests/fixtures/tool-surface.json deliberately',
    ).toEqual([]);
  });

  it('delivers every description byte-for-byte as recorded', async () => {
    const live = await liveSurface();
    const drifted = Object.keys(baseline)
      .filter((n) => live[n] && live[n].description !== baseline[n].description)
      .map((n) => ({ tool: n, baseline: baseline[n].description, live: live[n].description }));
    expect(drifted, 'tool descriptions changed').toEqual([]);
  });

  it('delivers every input schema unchanged, field for field', async () => {
    const live = await liveSurface();
    const drifted = Object.keys(baseline)
      .filter((n) => live[n])
      .map((n) => ({
        tool: n,
        missing: baseline[n].inputSchemaKeys.filter((k) => !live[n].inputSchemaKeys.includes(k)),
        added: live[n].inputSchemaKeys.filter((k) => !baseline[n].inputSchemaKeys.includes(k)),
      }))
      .filter((d) => d.missing.length > 0 || d.added.length > 0);
    expect(drifted, 'input schema fields changed').toEqual([]);
  });

  it('matches the full recorded digest of every tool entry', async () => {
    const live = await liveSurface();
    // Catches anything the three checks above do not name explicitly: a changed field description,
    // a widened enum, a lost default, a flipped required flag.
    const drifted = Object.keys(baseline)
      .filter((n) => live[n] && live[n].digest !== baseline[n].digest)
      .map((n) => n);
    expect(
      drifted,
      'tools/list entries differ from tests/fixtures/tool-surface.json beyond name/description/field set',
    ).toEqual([]);
  });

  it('delivers the recorded safety annotations, over the real protocol', async () => {
    const live = await liveSurface();
    // Fail-closed on both sides: a tool that stops sending annotations compares undefined against a
    // recorded object and drifts, and a baseline entry missing the key drifts against every live
    // object. tool-annotations.test.ts decides WHICH class each tool belongs to; this only proves
    // the class the client is handed is the class that was recorded.
    const drifted = Object.keys(baseline)
      .filter((n) => live[n])
      .filter((n) => JSON.stringify(canonical(live[n].annotations)) !== JSON.stringify(canonical(baseline[n].annotations)))
      .map((n) => ({ tool: n, baseline: baseline[n].annotations, live: live[n].annotations }));
    expect(drifted, 'tool annotations differ from tests/fixtures/tool-surface.json').toEqual([]);
  });
});

// --- the delivered English surface --------------------------------------------------------------
// Every string below is handed to an MCP client and read by a model. On 2026-07-28 seventeen of the
// twenty-six TOOL descriptions carried non-ASCII: em dashes, `->`/`<->`/`<=`/`...` written as single
// glyphs, one emoji, and - in find_nodes and get_review_board - Russian example VALUES, the author's
// working language inside an English product surface. That backlog is paid, and these rows keep it
// paid over the DELIVERED surface, because a scan of the source files cannot prove what the SDK
// actually sends.
//
// Character CLASSES, never a list of the strings that happened to be removed: such a list can only
// catch what was already found. The Cyrillic row is deliberately REDUNDANT with the ASCII row - if a
// later change narrows or scopes the ASCII row, the one thing publication cared about most still
// cannot come back silently.
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;
// Cyrillic (U+0400-04FF), Supplement (U+0500-052F), Extended-A (U+2DE0-2DFF) and Extended-B
// (U+A640-A69F): the whole script, not the letters of the two words that were removed. Written as
// escapes so this file stays ASCII itself - a gate that has to contain the thing it forbids in order
// to state it is a gate nobody can grep for.
const CYRILLIC = /[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F]/;

/** Distinct non-ASCII characters in `s`, named by code point, so a failure says WHICH character. */
function nonAsciiPoints(s: string): string {
  return [...new Set([...s].filter((c) => NON_ASCII.test(c)))]
    .map((c) => `${c}(U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')})`)
    .join(' ');
}

// The input SCHEMA is delivered in the same payload and read by the same model: a field description
// reaches a client exactly as a tool description does. Its backlog was paid in the same commit - 38
// field descriptions, including the five that quoted the review-board and find_threads default name
// patterns. Those five now DESCRIBE the default ("recognizes ... in English and Russian") instead of
// quoting it; the regex literals themselves are behaviour, they are correct, and they stay.
//
// The walk below is RECURSIVE over every string in the entry, and that is not tidiness. It has been
// wrong twice, in the same way, one level at a time:
//   - the first version walked only `inputSchema.properties[*].description` and reported a backlog
//     of 36. The real number was 38 - compare_node_to_dom carries two more descriptions under
//     `pairs.items.properties`, where a top-level walk does not look;
//   - the second version walked every VALUE and no KEY. A schema property NAME is delivered in the
//     same payload and is read by a model exactly as its description is (it is also what a caller
//     has to type), so a tool declaring a property named in another script shipped to every client
//     while this file and scripts/stdio-smoke.mjs both reported "every delivered string is ASCII"
//     and exited 0. Measured 2026-07-28, by review.
// A gate that decides for itself where to look will always be a gate that misses somewhere; this one
// now visits every node of the delivered JSON, keys included.
type Str = { path: string; text: string };
function everyString(v: unknown, path: string, out: Str[]): void {
  if (typeof v === 'string') { out.push({ path, text: v }); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => everyString(x, `${path}[${i}]`, out)); return; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out.push({ path: `${path}.${k} <property name>`, text: k });
      everyString(x, `${path}.${k}`, out);
    }
  }
}
function deliveredStrings(tools: Awaited<ReturnType<typeof deliveredTools>>): Str[] {
  const out: Str[] = [];
  for (const t of tools) everyString(t, t.name, out);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

describe('the descriptions a client is handed are English ASCII', () => {
  it('no delivered tool description contains a non-ASCII character', async () => {
    const live = await liveSurface();
    const offenders = Object.entries(live)
      .filter(([, e]) => NON_ASCII.test(e.description))
      .map(([name, e]) => `${name}: ${nonAsciiPoints(e.description)}`);
    expect(
      offenders,
      'a shipped tool description carries non-ASCII - substitute ( - , ->, <->, <=, ... ), do not delete',
    ).toEqual([]);
  });

  it('no delivered tool description contains a Cyrillic character', async () => {
    const live = await liveSurface();
    const offenders = Object.entries(live)
      .filter(([, e]) => CYRILLIC.test(e.description))
      .map(([name, e]) => `${name}: ${nonAsciiPoints(e.description)}`);
    expect(
      offenders,
      "an example value in the author's working language is shipping inside the English tool surface",
    ).toEqual([]);
  });

  it('no string ANYWHERE in a delivered tools/list entry contains a non-ASCII character', async () => {
    const offenders = deliveredStrings(await deliveredTools())
      .filter((s) => NON_ASCII.test(s.text))
      .map((s) => `${s.path}: ${nonAsciiPoints(s.text)}`);
    expect(
      offenders,
      'non-ASCII in the delivered payload - every field description, enum and title is read by a client too',
    ).toEqual([]);
  });

  it('no string ANYWHERE in a delivered tools/list entry contains a Cyrillic character', async () => {
    const offenders = deliveredStrings(await deliveredTools())
      .filter((s) => CYRILLIC.test(s.text))
      .map((s) => `${s.path}: ${nonAsciiPoints(s.text)}`);
    expect(
      offenders,
      "the author's working language is shipping inside the English product surface",
    ).toEqual([]);
  });
});
