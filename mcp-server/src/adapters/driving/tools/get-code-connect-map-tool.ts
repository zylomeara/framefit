// mcp-server/src/adapters/driving/tools/get-code-connect-map-tool.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { COMPOUND_NODE_ID_RE, normalizeCompoundNodeId } from '../../../domain/node-id.js';
import { collectInstanceKeys, indexSnippetsByNodeId } from '../../../domain/code-connect-enrich.js';
import { FigmaApiError } from '../../../ports/errors.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_ids: z.array(z.string().regex(COMPOUND_NODE_ID_RE, 'expected "1:42", "1-42", or a nested-instance id like "I12:340;56:7890"')).min(1).max(50)
    .describe('Instance node ids — top-level ("1:42") or nested ("I12:340;56:7890", copied from get_metadata/get_review_board). Resolved shallowly (depth 1); for a whole frame use get_design_context.'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerGetCodeConnectMapTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_code_connect_map',
    {
      description: 'Map Figma instance nodes to their Code Connect code snippets (component, imports, source) from mappings your CI uploaded (Figma exposes no Code Connect REST endpoint, so this reads CI-ingested mappings, not Figma directly). When the map is empty the response carries a `reason` (no_instances | components_unresolved | no_mappings | not_configured) and a `note` explaining why and how to populate mappings.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('get_code_connect_map', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const ids = args.node_ids.map(normalizeCompoundNodeId);
        const api = deps.buildApi(token);
        if (!deps.codeConnect) {
          return jsonResult({ file: parsed.value, count: 0, map: {}, reason: 'not_configured', note: 'Code Connect requires the multi-tenant deployment with CI-uploaded mappings. In multi-tenant mode, get_design_context also inlines code snippets.' });
        }

        const nodes = await api.getNodesRaw(parsed.value, ids, 1);
        const allPairs: { nodeId: string; componentKey: string }[] = [];
        for (const id of ids) {
          // Figma keys the /nodes response by the requested id; for a nested-instance
          // compound id the exact key shape is unverified (no test-file access), so fall
          // back to matching the returned document.id. Only fires when the exact key misses.
          const entry = nodes.nodes[id] ?? Object.values(nodes.nodes).find((e) => e?.document?.id === id) ?? null;
          if (entry) allPairs.push(...collectInstanceKeys(entry.document, entry.components));
        }
        const keyToRef = new Map<string, { file_key: string; node_id: string }>();
        await Promise.all([...new Set(allPairs.map((p) => p.componentKey))].map(async (key) => {
          try {
            const c = await api.getComponent(key);
            keyToRef.set(key, { file_key: c.file_key, node_id: c.node_id });
          } catch (e) {
            // Surface rate limiting so the agent backs off; skip any other per-key failure.
            if (e instanceof FigmaApiError && e.kind === 'rate_limited') throw e;
          }
        }));
        const refs = [...keyToRef.values()];
        const mappingByRef = refs.length ? await deps.codeConnect.lookup(refs) : new Map();
        const map = indexSnippetsByNodeId(allPairs, keyToRef, mappingByRef);
        // Counters let the agent (and the empty-result diagnostics below) see WHERE the pipeline stopped:
        // instances found → components resolved to a library → mappings matched.
        const instances = allPairs.length;
        const resolvedComponents = keyToRef.size;
        const count = Object.keys(map).length;
        if (count === 0) {
          let reason: 'no_instances' | 'components_unresolved' | 'no_mappings';
          let note: string;
          if (instances === 0) {
            reason = 'no_instances';
            note = 'None of the requested node_ids resolved to a component INSTANCE (Code Connect only maps instances). For a nested instance, pass its compound id ("I…;…") directly, or call get_design_context on the ancestor frame to auto-resolve and inline its instances.';
          } else if (resolvedComponents === 0) {
            reason = 'components_unresolved';
            note = `Found ${instances} instance(s) but could not resolve their components to a source library (likely a PAT/library-access limit or transient error). Check the token has access to the component libraries.`;
          } else {
            reason = 'no_mappings';
            note = 'No Code Connect mappings matched these components. Mappings come from your design-system CI: run `npx figma connect parse -o mappings.json`, then POST it to /api/code-connect/mappings with your X-CI-Key (see README "Code Connect"). If CI already ran, these specific components may not have .figma.ts Code Connect docs yet.';
          }
          return jsonResult({ file: parsed.value, requested: ids.length, instances, resolvedComponents, count: 0, map: {}, reason, note });
        }
        // requested lets the agent see partial misses (requested > count → some nodes had no mapping).
        return jsonResult({ file: parsed.value, requested: ids.length, instances, resolvedComponents, count, map });
      }, deps.noTokenHint),
  );
}
