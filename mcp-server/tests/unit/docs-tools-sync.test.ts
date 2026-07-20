// docs-tools-sync: docs/tools/*.md must list EXACTLY the tools the server
// registers — both directions, no drift.
//
// The ONLY sound source of registered names is a RECORDING STUB driven through the real
// registerAllTools: regex over the tool source files is FORBIDDEN here — the tool name sits on
// the line AFTER `server.tool(` in 25 of 26 files, so a source regex catches 1/26 and passes
// vacuously (catastrophic false-green, proven during planning). Registration only describes
// schemas (deps are captured in handler closures, never called), so a minimal deps object is
// enough to run the real registration path.
//
// Doc-side convention this test enforces: in docs/tools/*.md the `### ` heading level is
// reserved for tool names (snake_case). Prose sub-sections must use `## ` or `**bold**`.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAllTools } from '../../src/adapters/driving/tools/register-all.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/docs/tools/*.md and <root>/mcp-server/tests/unit/<this file>.
const DOCS_TOOLS_DIR = path.resolve(__dirname, '..', '..', '..', 'docs', 'tools');

function registeredToolNames(): string[] {
  const seen: string[] = [];
  // Recording stub: both current (`tool`) and modern (`registerTool`) SDK registration entry
  // points record the first argument — the tool name — and swallow the rest.
  const stub = {
    tool: (name: string, ..._rest: unknown[]) => { seen.push(name); },
    registerTool: (name: string, ..._rest: unknown[]) => { seen.push(name); },
  };
  const minimalDeps = {
    // Registration must never touch the API: a throwing buildApi proves it stays lazy.
    buildApi: () => { throw new Error('buildApi must not be called during tool registration'); },
    logger: createLogger({ level: 'silent' }),
  } as unknown as ToolDeps;
  registerAllTools(stub as unknown as Parameters<typeof registerAllTools>[0], minimalDeps);
  return seen;
}

function documentedToolNames(): { all: string[]; byFile: Record<string, string[]> } {
  const files = readdirSync(DOCS_TOOLS_DIR).filter((f) => f.endsWith('.md'));
  expect(files.length, `no .md files found in ${DOCS_TOOLS_DIR}`).toBeGreaterThan(0);
  const byFile: Record<string, string[]> = {};
  const all: string[] = [];
  for (const f of files) {
    const text = readFileSync(path.join(DOCS_TOOLS_DIR, f), 'utf8');
    const names = [...text.matchAll(/^###\s+([a-z0-9_]+)\s*$/gm)].map((m) => m[1]);
    byFile[f] = names;
    all.push(...names);
  }
  return { all, byFile };
}

describe('docs/tools ↔ live tool registration sync', () => {
  it('documents exactly the registered tool set (set equality, both directions)', () => {
    const seen = registeredToolNames();
    expect(seen.length, 'recording stub captured no registrations').toBeGreaterThan(0);
    expect(new Set(seen).size, `duplicate tool names registered: ${seen.join(', ')}`).toBe(seen.length);

    const { all: docNames, byFile } = documentedToolNames();
    expect(new Set(docNames).size,
      `a tool is documented more than once across docs/tools/*.md: ${JSON.stringify(byFile)}`,
    ).toBe(docNames.length);

    const liveSet = new Set(seen);
    const docSet = new Set(docNames);
    const missingFromDocs = seen.filter((n) => !docSet.has(n)).sort();
    const unknownInDocs = docNames.filter((n) => !liveSet.has(n)).sort();

    expect(missingFromDocs,
      'registered tools missing a `### <name>` section in docs/tools/*.md',
    ).toEqual([]);
    expect(unknownInDocs,
      'docs/tools/*.md sections that do not correspond to any registered tool',
    ).toEqual([]);
    // Redundant with the two directional asserts, but locks full set equality in one line.
    expect([...docSet].sort()).toEqual([...liveSet].sort());
  });
});
