import { describe, it, expect } from 'vitest';
import { registerGetDesignContextTool } from '../../src/adapters/driving/tools/get-design-context-tool.js';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import { buildGraph, resolveKey, resolveKeyModes, resolveKeyInMode, type Lib } from '../../src/domain/variable-graph.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

// Guarded live integration test — hits the real Figma REST API. Only runs when
// FIGMA_E2E_TOKEN is set (mirrors smoke.test.ts's describe.skipIf convention),
// so CI without a PAT skips it cleanly instead of failing on network access.
//
// To actually PASS (not just skip) this needs your own fixture file plus env vars:
//   FIGMA_E2E_TOKEN      — a Figma PAT with read access to the e2e fixture file and to the
//                           source library that publishes the aliased collection.
//   FIGMA_E2E_FILE       — file key of a consuming file whose target node's stroke is bound to
//                           a variable ALIASED from another library (mode-dependent color).
//   FIGMA_E2E_NODE       — node id of that target node inside the consuming file.
//   FIGMA_E2E_SOURCE_LIB — comma-separated file key(s) of the source library, so buildGraph's
//                           in-memory graph actually contains the alias chain (the consuming
//                           file alone only has the locally-published leg; without the source
//                           library the cross-library hop can't be resolved).
// It is excluded from `npm test` (unit suite) — run via `npm run test:e2e` with the vars set.
const TOKEN = process.env.FIGMA_E2E_TOKEN;
const E2E_FILE = process.env.FIGMA_E2E_FILE ?? '';
const E2E_NODE = process.env.FIGMA_E2E_NODE ?? '';
const enabled = Boolean(TOKEN && E2E_FILE && E2E_NODE);
// The target node's stroke is bound to a variable published from ANOTHER library. To make this test
// DISCRIMINATING (not just reading the stored paint hex), we wire a real variableGraph built
// from the source library. Provide the source library file key(s) via FIGMA_E2E_SOURCE_LIB
// (comma-separated); the consuming file is always included so a locally-published var resolves.
const LIB_KEYS = [E2E_FILE, ...(process.env.FIGMA_E2E_SOURCE_LIB?.split(',') ?? [])]
  .map((s) => s.trim()).filter(Boolean);

// Map a raw /variables/local response to the graph's Lib shape (same projection as library-sync).
async function libFromFile(api: FigmaApi, fileKey: string): Promise<Lib> {
  const raw = (await api.getVariablesLocal(fileKey)) as any;
  const meta = raw?.meta ?? {};
  const vars = Object.values(meta.variables ?? {}).filter((v: any) => v.key).map((v: any) => ({
    library_key: v.key, local_id: v.id, collection_id: v.variableCollectionId,
    values_by_mode: v.valuesByMode, name: v.name, resolved_type: v.resolvedType, code_syntax_web: v.codeSyntax?.WEB ?? '',
  }));
  const colls = Object.values(meta.variableCollections ?? {}).map((c: any) => ({
    collection_id: c.id, default_mode: c.defaultModeId, modes: c.modes,
  }));
  return { fileKey, vars, colls };
}

// Risk-retiring test for the cross-library collectionId<->modeId linkage:
// this node's stroke is bound to a variable published from another library, and its
// resolved value depends on correctly matching the node's explicit variable mode to
// that library's mode (not just falling back to the library's default mode).
describe.skipIf(!enabled)('nested-menu case — cross-library mode resolution', () => {
  it('resolves 24/Stroke/menu stroke to a #8b6afb OBJECT with mode_source:node (not default #a73afd)', async () => {
    const logger = createLogger({ level: 'silent' });
    const { server, call } = makeFakeMcpServer();

    // Build the cross-library graph live, then wire resolve/resolveInMode exactly like server.ts.
    const graphApi = new FigmaRestAdapter(TOKEN!, logger);
    const libs: Lib[] = [];
    for (const k of LIB_KEYS) {
      try { libs.push(await libFromFile(graphApi, k)); } catch { /* skip unreadable libs */ }
    }
    const g = buildGraph(libs);

    const deps: ToolDeps = {
      buildApi: (t) => new FigmaRestAdapter(t, logger),
      defaultToken: TOKEN!,
      logger,
      maxResultChars: 200000,
      variableGraph: {
        resolve: (key: string) => {
          const r = resolveKey(g, key);
          if (r.value === undefined) return undefined;
          const m = resolveKeyModes(g, key);
          const multi = m && Object.keys(m.modesByName).length > 1;
          return { value: r.value, name: r.name, sourceLibrary: g.byKey.get(key.toLowerCase())?.fileKey,
            ...(multi ? { modesByName: m!.modesByName } : {}) };
        },
        // Mirrors the production wiring in src/infrastructure/server.ts: coverageComplete must
        // reach the resolver so a benign collection-default under complete ancestor coverage is
        // honestly labeled 'node' rather than dropped to an unconfirmed 'default'.
        resolveInMode: (key: string, modeByCollection: Map<string, string>, coverageComplete?: boolean) =>
          resolveKeyInMode(g, key, modeByCollection, coverageComplete),
      },
    };
    registerGetDesignContextTool(server, deps);

    const res = await call('get_design_context', {
      file: E2E_FILE,
      node_id: E2E_NODE,
      include_component_docs: false,
    });
    const body = JSON.parse(textOf(res.content[0]));
    const entries = Object.values(body.globalVars ?? {}) as any[];

    // Strengthened: assert the FULL A+B+C outcome, not just that #8b6afb appears somewhere (which
    // the raw stored paint hex would also satisfy). This proves:
    //  - B: the page's explicitly pinned mode (set under a DIFFERENT subscribed-instance collection-id
    //    suffix than the graph's library-instance copy) was matched by library key and actually applied;
    //  - A: the ancestor chain was reached even though the target node is deeper than a depth-4
    //    whole-file fetch;
    //  - C: the resulting mode_source is honestly 'node' (confirmed), not 'default'.
    const confirmed = entries.find(
      (e) =>
        e && typeof e === 'object' &&
        e.value === '#8b6afb' &&
        e.mode_source === 'node' &&
        e.mode_dependent === true &&
        typeof e.token === 'string',
    );
    expect(confirmed).toBeDefined();

    // The library's DEFAULT mode resolves to #a73afd, so it must NOT appear anywhere as a value —
    // neither as this fill's value nor smuggled in under a false 'node'/'default' label.
    expect(JSON.stringify(body.globalVars)).not.toContain('#a73afd');
  }, 60_000);
});
