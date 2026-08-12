import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, textResult, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeCompoundNodeId, COMPOUND_NODE_ID_RE } from '../../../domain/node-id.js';
import { downloadRaster, downloadText } from './image-download.js';
import { DEFAULT_FOCUS_RADIUS, renderFocusCrop } from './focus-crop.js';
import { FigmaApiError, isTimeoutMessage } from '../../../ports/errors.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_id: z.string().regex(COMPOUND_NODE_ID_RE, 'expected "1:42", "1-42", or a nested-instance id like "I12:340;56:7890"')
    .describe('Node (frame/component/instance) to render'),
  format: z.enum(['png', 'svg', 'jpg']).default('png').describe('Image format'),
  scale: z.number().min(0.25).max(4).default(2).describe('Raster scale (png/jpg); ignored for svg. Lower if the image is huge.'),
  return: z.enum(['url', 'inline', 'preview']).default('url')
    .describe('url (default): signed URL + dimensions + curl hint - token-cheap. inline: embed full PNG/JPG base64 or SVG markup. preview: ONE step - a downscaled inline image plus the full-res signed URL (cheap "what is this", with an escape hatch to full size).'),
  tiles: z.boolean().default(false)
    .describe('For very large frames: also return a children_map (per-direct-child node_id, bounds, and a signed URL) so each part can be rendered legibly. Figma renders whole nodes, not regions, so tiling = per-child.'),
  focus: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }).optional().describe('Point of interest within the node (0..1 each) - e.g. target.atPercent from get_review_board. When set, returns a tight zoomed crop centered on this point (with a reticle marking it) instead of the whole node.'),
  focus_radius: z.number().min(0.02).max(0.5).default(DEFAULT_FOCUS_RADIUS)
    .describe('Focus-crop half-size as a fraction of node width (only used with focus). 0.12 gives a ~24%-wide window around the point.'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' };

const LARGE_SIDE_PX = 4000; // a node side beyond this is likely unreadable as one render

const PREVIEW_MAX_PX = 768; // longest preview side; legible enough for "what is this"

export function registerGetScreenshotTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_screenshot',
    {
      description: 'Render a Figma node to an image. Default return=url gives a short-lived signed URL plus pixel dimensions and a curl hint (token-cheap - strongly preferred; avoids inlining megabytes of base64). return=inline embeds the PNG/JPG as base64 or returns SVG markup directly, only for agents that cannot fetch URLs. Use a lower scale for very large frames. return=preview gives a one-step downscaled inline image plus the full-res URL. Pass focus={x,y} (0..1, e.g. target.atPercent from get_review_board) to get a zoomed crop centered on that point with a reticle marking it - ideal for seeing exactly what a review pin points at; the crop is always PNG.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('get_screenshot', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const id = normalizeCompoundNodeId(args.node_id);
        const api = deps.buildApi(token);
        // A cheap /nodes (depth 1) lookup first: turns a missing node into a fast, clear
        // "not found" (Figma's /images endpoint otherwise blocks for the full ~30s timeout
        // on an unknown id, surfacing a misleading "timed out"), AND gives us the node's
        // bounding box so url mode can report pixel dimensions.
        const raw = await api.getNodesRaw(parsed.value, [id], 1);
        const entry = raw.nodes[id];
        if (!entry) throw new Error(`node ${id} not found in file`);
        if (args.focus) {
          if (args.format === 'svg') throw new Error('focus crop requires a raster format (png or jpg), not svg.');
          if (!entry.document.absoluteBoundingBox) throw new Error(`node ${id} has no bounding box; focus crop needs a sized node.`);
        }
        // batch-2 item 6: a bounded transport ladder for the MAIN render. Step 1 is a
        // same-parameters retry (the getFileStructure precedent - the live incident's
        // n=1 cannot attribute the failure to the scale, and a transient drop usually
        // clears on a re-dial). Step 2 drops to half scale ONCE, only after step 1
        // failed in the same class AND the mode delivers this render as the image
        // (focus/preview/tiles compose their own renders from args.scale - excluded).
        // The trigger is the TRANSIENT slice of kind 'network' only: a timeout would
        // double a 90s hang, and a queued bailout says nothing about the endpoint.
        const transient = (e: unknown): boolean =>
          e instanceof FigmaApiError && e.kind === 'network'
          && !isTimeoutMessage(e.message) && e.queuedBailout !== true;
        const rethrowWith = (e: unknown, sentence: string): never => {
          if (e instanceof Error) e.message = `${e.message} ${sentence}`;
          throw e;
        };
        const scaleDropEligible = args.format !== 'svg' && args.scale > 1
          && !args.focus && args.return !== 'preview' && !args.tiles;
        const fallbackScale = Math.max(1, args.scale / 2);
        let deliveredScale = args.scale;
        let images: Record<string, string | null>;
        try {
          images = (await api.getImages(parsed.value, [id], { format: args.format, scale: args.scale })).images;
        } catch (e1) {
          if (!transient(e1)) throw e1;
          try {
            images = (await api.getImages(parsed.value, [id], { format: args.format, scale: args.scale })).images;
          } catch (e2) {
            // A retry failing in a DIFFERENT class carries its own diagnosis and advice
            // (a 429's retryAfterSec, an upstream 200-body reason, a timeout) - it is the
            // fresher, more actionable error and must never be masked behind e1 with a
            // false 'failed the same way' (wave finding).
            if (!transient(e2)) rethrowWith(e2, '(the first attempt failed on a transport drop)');
            if (!scaleDropEligible) rethrowWith(e1, 'An immediate retry failed the same way.');
            try {
              images = (await api.getImages(parsed.value, [id], { format: args.format, scale: fallbackScale })).images;
              deliveredScale = fallbackScale;
            } catch (e3) {
              if (!transient(e3)) rethrowWith(e3, '(two prior attempts failed on transport drops)');
              rethrowWith(e1, `An immediate retry and a scale-${fallbackScale} fallback both failed the same way.`);
            }
          }
        }
        const scaleDegraded = deliveredScale !== args.scale;
        const scaleNote = scaleDegraded
          ? `the render at scale ${args.scale} failed twice on transport drops; a scale-${deliveredScale} render succeeded - re-request with an explicit scale if you need the detail`
          : undefined;
        const url = images![id];
        if (!url) throw new Error(`Figma did not render node ${id} (it may be empty or invalid for ${args.format}).`);

        if (args.focus) {
          const fbox = entry.document.absoluteBoundingBox!;
          const focusRadius = args.focus_radius ?? DEFAULT_FOCUS_RADIUS;
          const { buffer, region, sourceScale } = await renderFocusCrop(api, parsed.value, id, fbox.width, {
            focusX: args.focus.x, focusY: args.focus.y, focusRadius, requestedScale: args.scale,
          });
          const meta: Record<string, unknown> = {
            file: parsed.value, node_id: id, focus: args.focus, focus_radius: focusRadius,
            region, source_scale: sourceScale, full_res_url: url,
            note: `Focus crop (PNG) around (${args.focus.x}, ${args.focus.y}); reticle marks the exact point. Whole node at full res: curl -o screenshot.${args.format} "${url}".`,
          };
          return {
            content: [
              { type: 'image' as const, data: buffer.toString('base64'), mimeType: 'image/png' },
              { type: 'text' as const, text: JSON.stringify(meta, null, 2) },
            ],
          };
        }

        if (args.return === 'preview') {
          const bbox = entry.document.absoluteBoundingBox;
          // SVG is resolution-independent — preview == inline markup (no downscale).
          if (args.format === 'svg') {
            return textResult(await downloadText(url));
          }
          const bigSide = bbox ? Math.max(bbox.width, bbox.height) : 0;
          let previewScale = args.scale;
          if (bigSide > 0) {
            previewScale = Math.max(0.1, Math.min(args.scale, Math.round((PREVIEW_MAX_PX / bigSide) * 100) / 100));
          }
          const previewUrl = previewScale === args.scale
            ? url
            : (await api.getImages(parsed.value, [id], { format: args.format, scale: previewScale })).images[id];
          if (!previewUrl) throw new Error(`Figma did not render a preview for node ${id}.`);
          const buf = await downloadRaster(previewUrl, previewScale);
          const meta: Record<string, unknown> = {
            file: parsed.value, node_id: id, format: args.format,
            full_res_url: url, preview_scale: previewScale,
            note: `Inline preview at scale ${previewScale}. Full-res: curl -o screenshot.${args.format} "${url}" (short-lived signed URL).`,
          };
          if (bbox) {
            meta.original_width = bbox.width;
            meta.original_height = bbox.height;
            meta.preview_width = Math.round(bbox.width * previewScale);
            meta.preview_height = Math.round(bbox.height * previewScale);
          }
          return {
            content: [
              { type: 'image' as const, data: buf.toString('base64'), mimeType: MIME[args.format] },
              { type: 'text' as const, text: JSON.stringify(meta, null, 2) },
            ],
          };
        }

        if (args.return !== 'inline') {
          const bbox = entry.document.absoluteBoundingBox;
          const out: Record<string, unknown> = {
            file: parsed.value, node_id: id, format: args.format, scale: deliveredScale, url,
            // The degradation is ALWAYS visible: the delivered scale replaces the requested
            // one in every field that names it, and the pair of extra fields says why.
            ...(scaleDegraded ? { requested_scale: args.scale, scale_note: scaleNote } : {}),
            note: `Download with: curl -o screenshot.${args.format} "${url}"  — short-lived signed URL, treat it like a secret.`,
          };
          if (bbox) {
            out.original_width = bbox.width;
            out.original_height = bbox.height;
            // SVG is resolution-independent; scaled raster dimensions only make sense for png/jpg.
            if (args.format !== 'svg') {
              out.width = Math.round(bbox.width * deliveredScale);
              out.height = Math.round(bbox.height * deliveredScale);
            }
          }
          const bigSide = bbox ? Math.max(bbox.width, bbox.height) : 0;
          if (bbox && bigSide > LARGE_SIDE_PX) {
            const suggested = Math.max(0.25, Math.min(args.scale, Math.round((LARGE_SIDE_PX / bigSide) * 100) / 100));
            out.readability_hint = {
              suggested_scale: suggested,
              note: `Frame is ${bbox.width}×${bbox.height}; text is unreadable at one render. Render children individually (tiles:true) or use get_review_board for review boards.`,
            };
          }
          if (args.tiles) {
            const kids = (entry.document.children ?? []).filter((c) => c.absoluteBoundingBox);
            if (kids.length) {
              // The whole-node render above already succeeded and is in `out`. A failure on the
              // per-child renders must not throw it away: before getImages started throwing on a
              // 200 body carrying `err`, this path yielded url:null per child and the main result
              // still came back. Same shape kept, with the reason attached instead of silence.
              let kidImages: Record<string, string | null> = {};
              try {
                kidImages = (await api.getImages(parsed.value, kids.map((c) => c.id), { format: args.format, scale: args.scale })).images;
              } catch (err) {
                // Narrowed to the class that regressed - same catch, same reasoning, as
                // get-review-board-tool.ts. 403/404/5xx/timeout/429 all still fail the call.
                if (!(err instanceof FigmaApiError && err.kind === 'upstream' && err.status === 200)) throw err;
                deps.logger.info({ err: err.message }, 'get_screenshot.tiles_unavailable');
                out.children_map_note = `Per-child renders unavailable: ${err.message}`;
              }
              out.children_map = kids.map((c) => {
                const cb = c.absoluteBoundingBox!;
                return { node_id: c.id, name: c.name, bounds: { x: cb.x, y: cb.y, w: cb.width, h: cb.height }, url: kidImages[c.id] ?? null };
              });
            }
          }
          return jsonResult(out);
        }

        if (args.format === 'svg') {
          return textResult(await downloadText(url));
        }
        const buf = await downloadRaster(url, deliveredScale);
        return {
          content: [
            { type: 'image' as const, data: buf.toString('base64'), mimeType: MIME[args.format] },
            // Inline mode has no meta channel - a degraded delivery gains a SECOND (text)
            // content item; the undegraded shape stays single-item byte-identically.
            ...(scaleDegraded
              ? [{ type: 'text' as const, text: JSON.stringify({ scale: deliveredScale, requested_scale: args.scale, scale_note: scaleNote }, null, 2) }]
              : []),
          ],
        };
      }, deps.noTokenHint),
  );
}
