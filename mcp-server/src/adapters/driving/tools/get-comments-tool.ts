import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FigmaApi } from '../../../ports/figma-api.js';
import type { Logger } from '../../../infrastructure/logger.js';
import { getCommentsUseCase, computeWarnings } from '../../../application/get-comments.js';
import { formatMarkdown } from '../../../domain/format-markdown.js';
import type { Thread } from '../../../domain/types.js';
import { FilterSchema, toCriteria } from './shared-schemas.js';
import { runTool, textResult, type ReadOnlyGate } from './shared-error-handler.js';
import { clampToBudget, responseTooLargeResult } from './response-budget.js';
import { serializeForDelivery } from './serialize.js';

export type ToolDeps = {
  // deadlineAt (epoch ms, optional): an ABSOLUTE per-call deadline plumbed into the adapter so a
  // semaphore-queued heavy fetch clamps its abort window to the remaining budget at DISPATCH — a
  // request dequeued past the deadline exits in ~1ms without touching the network (see FigmaRestAdapter).
  buildApi: (token: string, timeoutMs?: number, deadlineAt?: number) => FigmaApi;
  defaultToken?: string;
  logger: Logger;
  maxResultChars?: number;
  /** Per-call time budget for stage degradation (ms). Default 90s. */
  toolTimeBudgetMs?: number;
  /** Multi-tenant: overrides the "no token" error text (portal link). */
  noTokenHint?: string;
  /** Multi-tenant Code Connect enrichment: resolve the user's mappings by (file_key,node_id). Undefined → no enrichment (single-tenant/stdio). */
  codeConnect?: {
    lookup(refs: { file_key: string; node_id: string }[]): Promise<Map<string, import('../../../domain/code-connect.js').MappingHit>>;
  };
  /** Multi-tenant variable-snapshot resolution: resolve published library keys (the 40-hex key embedded in a cross-library alias id) to their snapshotted values. Undefined → no resolution (single-tenant/stdio). */
  variableSnapshot?: {
    lookup(keys: string[]): Promise<Map<string, import('../../../multi-tenant/variable-snapshot-db.js').SnapshotHit>>;
  };
  /** Multi-tenant headless library-graph resolution: resolve a published library key to its graph-resolved value (preferred over variableSnapshot when present). Undefined → fall back to variableSnapshot. */
  variableGraph?: {
    // Single-tenant env-graph only: build/refresh the library graph before the first resolve of a
    // call (idempotent, concurrency-safe, fail-soft, TTL-refreshed). Absent on the multi-tenant
    // wrappers (their graph is loaded per-request from the DB). Every tool that reads variableGraph
    // MUST `await deps.variableGraph?.ensureReady?.()` above its first read so the lazy env build
    // has run — the optional chaining makes it a no-op when the wrapper does not provide it.
    ensureReady?(): Promise<void>;
    resolve(key: string): {
      value: string; name?: string; sourceLibrary?: string;
      modesByName?: Record<string, string>;
    } | undefined;
    // coverageComplete (optional) tells the resolver whether the node's full ancestor chain was
    // discovered — consumed by the honest-label logic; existing impls may ignore it.
    resolveInMode?(key: string, modeByCollection: Map<string, string>, coverageComplete?: boolean, evidence?: import('../../../domain/mode-resolve.js').ModeEvidenceStack):
      (import('../../../domain/design-context/resolved-token.js').ResolvedToken & { pinned_axis_used: boolean; unconfirmed_default_used: boolean }) | undefined;
    // True iff the key's TOP collection is multi-mode (by mode EXISTENCE, not resolvability) — the
    // exact condition under which resolveInMode emits a mode-dependent object. Lets needsAncestors
    // gate ancestor discovery precisely; when absent, callers fall back to `resolve().modesByName`.
    isMultiMode?(key: string): boolean;
    // Scoped codeSyntax-evidence view for the merged CssTokenEvidence facade (graph-css-evidence
    // line). ONE method on purpose: a wrapper exposing part of the evidence surface would be
    // indistinguishable from an unwired one, and a missing alias walk must never read as "no
    // relation exists". Same ensureReady precondition as every other read.
    cssEvidence?(referencedKeys: string[], excludeFileKey?: string): import('../../../domain/variable-graph.js').GraphCssView | undefined;
  };
  /** Write gate. Multi-tenant resolves the user's read_only flag per request; single-tenant sets a
   * constant gate when FRAMEFIT_READ_ONLY=true (buildToolDeps). Undefined → no read-only mode was
   * configured, so writes are allowed. Carries its own remediation sentence because the two modes
   * have different answers — see ReadOnlyGate. */
  readOnly?: ReadOnlyGate;
  /** Multi-tenant: list the user's registered design-system team ids — the fallback for search_design_system when no team_id is given. Undefined → single-tenant/stdio. */
  registeredTeams?: { list(): Promise<string[]> };
  /** Multi-tenant: is this fileKey a registered variable-library file (library_files)? Drives the
   * mode_context "library_default_modes" vs "default_modes" distinction. Undefined → single-tenant
   * (only "default_modes" can be emitted). */
  libraryFiles?: { has(fileKey: string): Promise<boolean> };
  /** dom-diff-dx browser-direct upload flow: mints capTokens that gate POST /api/dom-snapshots/:capToken.
   * Undefined → get_layout_spec never emits upload_url (e.g. degraded stdio bridge startup). */
  snapshotStore?: import('../../../infrastructure/dom-snapshot-store.js').DomSnapshotStore;
  /** Public base URL the minted upload_url is built against (e.g. 'https://figma.mcp.example.com').
   * Undefined → get_layout_spec never emits upload_url (no public endpoint to point at). */
  publicBaseUrl?: string;
  /** Stdio-only fail-soft receipt. Present when the loopback browser bridge could not start. */
  browserBridgeDegraded?: {
    status: 'unavailable';
    reason: 'loopback bridge could not start; using inline extractor';
  };
  /** Owner id passed to snapshotStore.mint() — scopes uploaded snapshots to this caller. Multi-tenant:
   * the JWT-authenticated userId of the current request. Single-tenant/stdio: 'local'. */
  tenantId?: string;
};

const InputSchema = {
  ...FilterSchema,
  as_markdown: z.boolean().default(true).describe('Return markdown (default) vs structured JSON'),
  node_depth: z.number().int().min(0).max(10).default(0).describe('Figma /nodes depth for fallback name resolution - 0 = name only (fast)'),
  limit: z.number().int().min(1).max(200).default(50).describe('Max threads returned'),
  offset: z.number().int().min(0).default(0).describe('Skip first N matching threads (pagination)'),
  timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Per-call Figma request timeout in ms (default 90000). Raise toward the 120000 max for very large files if you still hit timeouts.'),
};

export function registerGetCommentsTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_comments',
    {
      description: 'Fetch review comments from a Figma file as threads, with rich filtering (author, message, dates, node, mentions) and pagination. Anchors resolve to node names/pages. Use summarize_comments first on large files.',
      inputSchema: InputSchema,
      // Advisory metadata only. MCP clients are instructed to treat annotations as untrusted, and
      // nothing in this server reads them - the only writability enforcement here is
      // assertWritable (shared-error-handler.ts). This is a disclosure, not a gate.
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('get_comments', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const r = await getCommentsUseCase(deps.buildApi(token, args.timeout_ms), deps.logger, {
          file: args.file,
          criteria: toCriteria(args),
          as_markdown: args.as_markdown,
          node_depth: args.node_depth,
          limit: args.limit,
          offset: args.offset,
        });
        const budget = deps.maxResultChars ?? 40000;
        // Keep the established near-limit warning threshold, which was based on the conservative
        // clamp envelope, while measuring the exact final delivery below.
        const conservativeWarnings = computeWarnings({
          total_matching: r.total_matching,
          next_offset: r.total_matching,
          payload_size: 0,
          budget,
          clamped: true,
        });
        const conservativeSize = (threads: Thread[]): number => (args.as_markdown
          ? [
              `(${r.page.length} of ${r.total_matching} matching threads, next_offset=${r.total_matching})`,
              ...conservativeWarnings.map((w) => `⚠ [${w.code}] ${w.message}`),
            ].join('\n') + '\n\n' + formatMarkdown(threads)
          : serializeForDelivery({
              total_matching: r.total_matching,
              returned: threads.length,
              next_offset: r.total_matching,
              warnings: conservativeWarnings,
              threads,
            })).length;
        const serialize = (threads: Thread[]): string => {
          const next_offset = r.offset + threads.length < r.total_matching ? r.offset + threads.length : null;
          const clamped = threads.length < r.page.length;
          const warnings = computeWarnings({
            total_matching: r.total_matching,
            next_offset,
            payload_size: conservativeSize(threads),
            budget,
            clamped,
          });
          return args.as_markdown
            ? [
                `(${threads.length} of ${r.total_matching} matching threads${next_offset !== null ? `, next_offset=${next_offset}` : ''})`,
                ...warnings.map((w) => `⚠ [${w.code}] ${w.message}`),
              ].join('\n') + '\n\n' + formatMarkdown(threads)
            : serializeForDelivery({
                total_matching: r.total_matching,
                returned: threads.length,
                next_offset,
                warnings,
                threads,
              });
        };
        const result = clampToBudget(r.page, budget, serialize);
        if (result.kind === 'first_item_oversize' || result.kind === 'envelope_oversize') {
          return responseTooLargeResult(result.kind);
        }
        return textResult(result.serialized);
      }, deps.noTokenHint),
  );
}
