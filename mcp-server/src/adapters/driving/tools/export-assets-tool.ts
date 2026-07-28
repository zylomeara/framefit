import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import { collectImageRefs } from '../../../domain/image-fills.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_ids: z.array(z.string().min(1)).min(1).max(100)
    .describe('Node IDs to export (e.g. ["1:42", "1-43"]). Up to 100 per call.'),
  format: z.enum(['png', 'svg', 'jpg']).default('png')
    .describe('Export format. svg omits the scale parameter.'),
  scale: z.number().min(0.01).max(4).optional()
    .describe('Export scale (png/jpg only, default 2). Ignored for svg.'),
  include_raw_images: z.boolean().default(false)
    .describe('Also return the ORIGINAL uploaded source images (JPEG/PNG/GIF/WebP) used as IMAGE fills in the requested node subtrees, attached per node as raw_images:[{imageRef,url}]. Adds up to 2 REST calls (subtree + image-fills); default false.'),
  image_depth: z.number().int().min(1).max(8).default(4)
    .describe('Subtree depth scanned for IMAGE fills when include_raw_images=true (default 4).'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerExportAssetsTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'export_assets',
    {
      description: 'Export Figma nodes as rendered images (PNG/SVG/JPG) and return signed S3 URLs. Use get_metadata first to find node IDs. Returns url:null for nodes Figma could not render. Set include_raw_images:true to also return the ORIGINAL uploaded source images (IMAGE fills) per node as raw_images:[{imageRef,url}].',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('export_assets', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);

        // Validate each node id in the tool body (zod schema is not checked by runTool).
        for (const raw of args.node_ids) {
          if (!NODE_ID_RE.test(raw)) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: `Invalid node id: "${raw}". Expected format "1:42" or "1-42".` }],
            };
          }
        }

        const api = deps.buildApi(token);
        const ids = [...new Set(args.node_ids.map(normalizeNodeId))];
        const result = await api.getImages(parsed.value, ids, {
          format: args.format,
          ...(args.scale !== undefined ? { scale: args.scale } : {}),
        });

        // Optionally extract the original uploaded source images (IMAGE fills) per node.
        let rawByNode: Map<string, { imageRef: string; url: string }[]> | undefined;
        if (args.include_raw_images) {
          const subtree = await api.getNodesRaw(parsed.value, ids, args.image_depth ?? 4);
          const refsByNode = new Map<string, string[]>();
          const allRefs = new Set<string>();
          for (const id of ids) {
            const doc = subtree.nodes[id]?.document;
            const refs = doc ? collectImageRefs(doc) : [];
            refsByNode.set(id, refs);
            refs.forEach((r) => allRefs.add(r));
          }
          // One call returns every image fill in the file; skip it entirely when no IMAGE fills exist.
          const fillUrls = allRefs.size ? (await api.getImageFills(parsed.value)).images : {};
          rawByNode = new Map(ids.map((id) => [id,
            (refsByNode.get(id) ?? [])
              .map((imageRef) => ({ imageRef, url: fillUrls[imageRef] }))
              .filter((r): r is { imageRef: string; url: string } => !!r.url),
          ]));
        }

        const assets = ids.map((id) => ({
          node_id: id,
          url: result.images[id] ?? null,
          ...(rawByNode ? { raw_images: rawByNode.get(id) ?? [] } : {}),
        }));

        return jsonResult({ file: parsed.value, format: args.format, assets });
      }, deps.noTokenHint),
  );
}
