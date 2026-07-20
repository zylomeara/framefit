import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import { resolveConsumedLibraries } from '../../../domain/consumed-libraries.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key whose libraries to list'),
  node_id: z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"').optional()
    .describe('Scope the consumed-library scan to this node\'s subtree (bounds REST cost on huge files); omit to scan the whole file'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerGetLibrariesTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'get_libraries',
    'List the design-system libraries a Figma file publishes or consumes. "publishes" = components this file itself exports (GET /files/:key/components). "consumes" = external libraries the file actually uses, detected from remote component references resolved to their source files (grouped by library file key with component_count + sample names). Best-effort: it surfaces libraries with USED components, not merely-subscribed-but-unused ones. Use a library file key with get_design_context; for search_design_system pass the team id from the library file\'s URL.',
    InputSchema,
    async (args) =>
      runTool('get_libraries', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const fk = parsed.value;
        const api = deps.buildApi(token);

        // publishes: GET /files/:key/components only ever returns this file's OWN published
        // components (all carry file_key === fk), so group them into a single library entry.
        const comps = await api.getFileComponents(fk);
        const ownByLib = new Map<string, { file_key: string; component_count: number; sample: string[] }>();
        for (const c of comps) {
          if (c.file_key !== fk) continue;
          let lib = ownByLib.get(c.file_key);
          if (!lib) { lib = { file_key: c.file_key, component_count: 0, sample: [] }; ownByLib.set(c.file_key, lib); }
          lib.component_count++;
          if (lib.sample.length < 8) lib.sample.push(c.name);
        }
        const ownLibs = [...ownByLib.values()].sort((a, b) => b.component_count - a.component_count);
        const publishes = { count: ownLibs.length, libraries: ownLibs };

        // consumes: external libraries detected from remote component references.
        const consumed = await resolveConsumedLibraries(
          api,
          fk,
          args.node_id ? { nodeId: normalizeNodeId(args.node_id) } : {},
        );
        const consumes = { count: consumed.libraries.length, libraries: consumed.libraries };

        return jsonResult({ file: fk, publishes, consumes, ...(consumed.degraded ? { degraded: true } : {}) });
      }, deps.noTokenHint),
  );
}
