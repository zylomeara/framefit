// The migration is mechanical and typecheck cannot guard it: every fake server in this suite is
// cast `as unknown as McpServer`, which erases arity, so a stub built for the wrong overload fails
// at RUNTIME with a message that points at registration rather than at the stub. This gate is
// therefore over the live registration path, not over the source text alone.
//
// Two independent things are locked here:
//   1. the CALL SHAPE - every tool goes through `registerTool`, never the deprecated positional
//      `tool()` overload (which cannot carry annotations);
//   2. the REGISTERED SURFACE - what a client actually receives from `tools/list` is byte-identical
//      to the recorded baseline. The shape migration must not move a single character of any
//      description or schema, and this is the check that proves it rather than asserting it by eye.
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

type SurfaceEntry = { description: string; inputSchemaKeys: string[]; digest: string };

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

async function liveSurface(): Promise<Record<string, SurfaceEntry>> {
  const server = new McpServer({ name: 'framefit', version: '0.0.0' });
  registerAllTools(server, minimalDeps());
  const client = new Client({ name: 'surface-lock', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  const { tools } = await client.listTools();
  await client.close();

  const out: Record<string, SurfaceEntry> = {};
  for (const t of tools) {
    const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    out[t.name] = {
      description: t.description ?? '',
      inputSchemaKeys: Object.keys(props).sort(),
      digest: createHash('sha256').update(JSON.stringify(canonical(t))).digest('hex'),
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
});
