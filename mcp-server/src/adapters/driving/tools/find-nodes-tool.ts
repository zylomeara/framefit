import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import { findNodes, overridePreview } from '../../../domain/find-nodes.js';
import type { NodeMatch } from '../../../domain/find-nodes.js';
import { clampToBudget } from '../../../application/get-comments.js';
import { FigmaApiError } from '../../../ports/errors.js';
import type { RawSceneNode } from '../../../domain/figma-raw.js';
import { serializeForDelivery } from './serialize.js';

// Cap on the container NAMES surfaced in coverage.skipped (coverage.skippedTotal always reflects
// the true count, even beyond this cap) — keeps a heavily-skipped response from blowing the token
// budget on a list of names instead of the matches the caller actually asked for.
export const COVERAGE_SKIPPED_NAMES_CAP = 20;

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  query: z.string().min(1).optional().describe('Name/text substring(s) to match; space-separated terms are AND-ed, case-insensitive. Omit to search by type alone (requires `type`).'),
  node_id: z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"').optional()
    .describe('Scope the search to this node\'s subtree; omit to search the whole file (slower, heavier).'),
  type: z.string().optional().describe('Filter by node type, e.g. FRAME, TEXT, INSTANCE, COMPONENT.'),
  fuzzy: z.boolean().default(false).describe('Typo-tolerant fuzzy matching instead of substring.'),
  depth: z.number().int().min(1).max(10).default(6).describe('How deep to fetch and search the subtree (keep modest on large files).'),
  limit: z.number().int().min(1).max(50).default(20).describe('Max matches returned.'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerFindNodesTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'find_nodes',
    {
      description: 'Find nodes by name OR text content (substring or fuzzy) inside a Figma file or a subtree, without knowing node ids. Use this when node names are master-component placeholders rather than semantics (e.g. the label "Корзина" lives in a node named "Все жанры") — it also matches the node\'s text (characters). Returns node_id, name, type, breadcrumb path, size, and matched_on (name|text|property). Component-instance text set as a property override (e.g. a DS section header) matches as \'property\'. Feed a node_id into get_design_context or get_text_styles. Scope with node_id to search a single frame; omit it to search the whole file.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('find_nodes', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        if (!args.query && !args.type) throw new Error('provide query or type');

        const TEXT_PREVIEW = 80;
        const buildRow = (m: NodeMatch<RawSceneNode>, path: string): Record<string, unknown> => {
          const row: Record<string, unknown> = {
            node_id: m.node.id,
            name: m.node.name,
            type: m.node.type,
            path,
            matched_on: m.matchedOn,
            ...(m.node.absoluteBoundingBox ? { size: { w: m.node.absoluteBoundingBox.width, h: m.node.absoluteBoundingBox.height } } : {}),
            score: Math.round(m.score * 100) / 100,
          };
          const preview =
            m.matchedOn === 'text' ? m.node.characters
            : m.matchedOn === 'property' ? overridePreview(m.node, args.query)
            : undefined;
          if (preview !== undefined) {
            row.text = preview.length > TEXT_PREVIEW ? preview.slice(0, TEXT_PREVIEW) + '…' : preview;
          }
          return row;
        };

        let root: RawSceneNode | undefined;
        let rows: Record<string, unknown>[] = [];
        let coverage: Record<string, unknown> | undefined;
        if (args.node_id) {
          const api = deps.buildApi(token);
          const id = normalizeNodeId(args.node_id);
          const res = await api.getNodesRaw(parsed.value, [id], args.depth);
          const doc = res.nodes[id]?.document;
          if (!doc) throw new Error(`node ${id} not found in file`);
          root = doc;
        } else {
          // Whole-file search: a single getDocumentRaw(file, args.depth) used to pull the ENTIRE
          // document tree at once — on a ~110 MB worst-case file that is exactly what produced the
          // live 400/timeout(90s) failures this fixes. Instead: a cheap depth-2 SKELETON (page ->
          // top-level container) chunks the work into one bounded getNodesRaw fetch per container,
          // each independently try/caught so one flaky/slow/rate-limited container degrades to a
          // partial, HONEST result instead of failing the whole call.
          const deadlineAt = Date.now() + (deps.toolTimeBudgetMs ?? 90_000);
          const budgetApi = deps.buildApi(token, undefined, deadlineAt);
          const skeleton = await budgetApi.getDocumentRaw(parsed.value, 2);
          const containers = (skeleton.document.children ?? []).flatMap((p) =>
            (p.children ?? []).map((c) => ({ page: p.name, node: c })));

          // Matches keyed by node_id — dedupes the one overlap between the two passes below: a
          // top-level container matched by NAME in the skeleton is matched AGAIN as its chunk's
          // root. A chunk entry overwrites the skeleton one (same node, same score) so the
          // surviving path uses the chunk format ("Page › …") consistent with sibling rows.
          const byId = new Map<string, { m: NodeMatch<RawSceneNode>; path: string }>();
          const skippedNames: string[] = [];
          let skippedTotal = 0;
          let searched = 0;

          const skip = (name: string): void => {
            skippedTotal++;
            if (skippedNames.length < COVERAGE_SKIPPED_NAMES_CAP) skippedNames.push(name);
          };
          const skipFrom = (idx: number): void => { for (const rest of containers.slice(idx)) skip(rest.node.name); };

          // Skeleton-level pass: the chunk loop only searches INSIDE containers, so nodes that
          // exist purely at the skeleton level — the document, PAGES (CANVAS), and the top-level
          // containers themselves — would silently stop matching by name (the old whole-file path
          // matched them), while coverage still claimed completeness. The skeleton is already in
          // hand, so a findNodes pass over it is free. Its paths are m.path as-is (already rooted
          // at the document — no page prefix to add).
          for (const m of findNodes(skeleton.document, { query: args.query, type: args.type, fuzzy: args.fuzzy, limit: args.limit })) {
            byId.set(m.node.id, { m, path: m.path.join(' › ') });
          }

          for (let i = 0; i < containers.length; i++) {
            const c = containers[i];
            // Loop-guard — NOT a guarantee "the first container always runs": a genuinely-expired
            // deadline honestly aborts the adapter's very first fetch too (a real timeout
            // FigmaApiError), failing the whole call as before — acceptable. This only
            // short-circuits containers 2..N once we already KNOW we're past budget, instead of
            // paying for a fetch that would abort anyway.
            if (i > 0 && Date.now() >= deadlineAt) { skipFrom(i); break; }

            try {
              const res = await budgetApi.getNodesRaw(parsed.value, [c.node.id], args.depth);
              // Ids straight from the skeleton API response are already canonical ("1:42") —
              // no normalization needed on either the request or the lookup.
              const doc = res.nodes[c.node.id]?.document;
              if (!doc) { skip(c.node.name); continue; }
              // Per-chunk limit is ALWAYS args.limit — the standard sorted-merge argument: each
              // container can contribute at most `limit` rows to the true global top-K, but never
              // fewer. Shrinking it by matches already banked from other containers loses rows
              // INSIDE a container (e.g. limit=2, container A banks one exact — a shrunk limit=1
              // on container B would drop B's 2nd exact match, which belongs in the real top-2).
              const matches = findNodes(doc, { query: args.query, type: args.type, fuzzy: args.fuzzy, limit: args.limit });
              for (const m of matches) byId.set(m.node.id, { m, path: [c.page, ...m.path].join(' › ') });
              searched++;
            } catch (e) {
              // Token is dead for every remaining chunk too — fail the whole call honestly instead
              // of quietly returning a partial result under a broken token.
              if (e instanceof FigmaApiError && (e.kind === 'auth' || e.kind === 'forbidden')) throw e;
              if (e instanceof FigmaApiError && e.kind === 'rate_limited') {
                // Continuing to hammer the API under rate-limit is an antipattern (discoverAncestorModes
                // rethrows on rate_limited for the same reason) — but we already have a partial result
                // worth returning here, so stop the LOOP (not the whole call) and report the rest honestly.
                skipFrom(i);
                break;
              }
              // timeout/abort/network/unknown_4xx/anything else: this ONE container failed to search —
              // skip it and keep going, instead of the pre-fix behavior of failing the ENTIRE
              // whole-file search on the first flaky/slow chunk.
              skip(c.node.name);
              continue;
            }

            let exactNow = 0;
            for (const { m } of byId.values()) if (m.score === 1) exactNow++;
            if (exactNow >= args.limit) { skipFrom(i + 1); break; } // score===1 can't be improved on
          }

          const rowsSorted = [...byId.values()]
            .sort((a, b) => b.m.score - a.m.score || a.m.node.id.localeCompare(b.m.node.id))
            .slice(0, args.limit);
          rows = rowsSorted.map(({ m, path }) => buildRow(m, path));

          const total = containers.length;
          coverage = {
            searched, total,
            skipped: skippedNames,
            skippedTotal,
            ...(searched < total ? {
              note: `Searched ${searched} of ${total} top-level containers (budget/limit/429) — narrow scope (node_id) or fetch the rest via skipped.`,
            } : {}),
          };
        }

        if (root) {
          const matches = findNodes(root, { query: args.query, type: args.type, fuzzy: args.fuzzy, limit: args.limit });
          rows = matches.map((m) => buildRow(m, m.path.join(' › ')));
        }

        const budget = deps.maxResultChars ?? 40000;
        // Measure == delivery: serializeForDelivery is the same function
        // jsonResult uses; the whole envelope; clamped:true in the measurement is CONSERVATIVELY always set
        // (+~14 chars of fixed headroom — an honest shift upward, not drift).
        const { kept, clamped } = clampToBudget(rows, budget, (xs) =>
          serializeForDelivery({ query: args.query, total: rows.length, returned: xs.length,
            clamped: true, ...(coverage ? { coverage } : {}), matches: xs }));
        return jsonResult({
          query: args.query, total: rows.length, returned: kept.length,
          ...(clamped ? { clamped: true } : {}),
          ...(coverage ? { coverage } : {}),
          matches: kept,
        });
      }, deps.noTokenHint),
  );
}
