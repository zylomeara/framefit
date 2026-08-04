import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeCompoundNodeId, COMPOUND_NODE_ID_RE } from '../../../domain/node-id.js';
import { buildLayoutSpec, budgetFor, collectLeafTexts } from '../../../domain/layout-spec/projector.js';
import { buildHydrationReceipt, type HydrationReceipt } from '../../../domain/layout-spec/frame-receipt.js';
import { DOM_SNAPSHOT_SCHEMA_VERSION } from './dom-snapshot-schema.js';
import { EXTRACTOR_JS, buildExtractorLoader } from './dom-extractor.js';
import { buildSetNames } from './component-set-names.js';
import { clampSpecsToBudget, RESULT_BUDGET_BYTES } from './clamp-specs.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_ids: z.array(z.string().regex(COMPOUND_NODE_ID_RE, 'expected "1:42", "1-42" or nested "I…;…"')).min(1).max(20)
    .describe('Node ids to project into diff-ready layout specs, up to 20 per call (batched in one REST call).'),
  include_extractor: z.boolean().default(false)
    .describe('Include the canonical DOM extractor script (paste it VERBATIM into chrome-devtools evaluate_script).'),
  extractor_mode: z.enum(['loader', 'inline']).default('loader')
    // No size digits here on purpose: a tools/list description is cached by the client, cannot be
    // corrected in the field, and nothing the caller DOES depends on the exact count - "the whole
    // script" already carries the only decision it informs (loader small, inline large). A digit
    // here would have to be gated forever; see extractor-size-lock.test.ts for where the real
    // numbers are stated and checked.
    .describe('loader (default): a short thunk that fetches the versioned extractor from the server ' +
      '(GET /api/dom-snapshots/extractor.js) instead of inlining the whole script ' +
      'every call - falls back to inline automatically if the server has no public base URL configured, ' +
      'which is every stdio deployment. inline: always return the full extractor script (e.g. if the ' +
      'loader\'s script-tag injection is CSP-blocked).'),
  max_depth: z.number().int().min(1).max(8).optional()
    .describe('Capture depth for BOTH sides (Figma projection + emitted extractor); default 4. Drill into a ' +
      'childrenTruncated branch by re-fetching it deeper (e.g. max_depth:6) - pass the SAME max_depth to ' +
      'compare_node_to_dom for that pair, or the Figma/DOM sides desync.'),
  text_leaves: z.boolean().default(false)
    .describe('Instead of the full spec tree, return a flat list of leaf TEXT nodes ' +
      '(id/name/path/text_snippet/typography) under each node_id - one call to enumerate typography ' +
      'for pair-building/inspection, no manual frame->children->text drill. Respects max_depth; ' +
      'text_leaves_truncated flags leaves beyond the depth cut (raise max_depth to reach them).'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerGetLayoutSpecTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_layout_spec',
    {
      description: 'Diff-ready layout spec of nodes: rect, auto-layout axis/gap/padding, in-flow children geometry, ' +
      'typography, fill hex, component identity. Lightweight (shallow fetch) - use it to pick the target frame width ' +
      'and build node<->selector pairs before compare_node_to_dom. include_extractor:true returns the DOM extractor ' +
      '(schema-versioned with the server) as extractor_js: the loader thunk that fetches the canonical script ' +
      '(extractor_mode:"loader", the default) is returned only when the server has a public base URL to point the ' +
      'browser at - otherwise, and whenever extractor_mode:"inline" is passed, the full script comes back inline, ' +
      'with extractor_note saying so when the loader was asked for and was unavailable. That same public base URL, ' +
      'plus the snapshot store only the HTTP servers construct, is what also returns an upload_url the extractor can ' +
      'POST snapshots to directly from the browser, yielding a dom_ref to pass to compare_node_to_dom; the stdio ' +
      'server has neither, so pass the snapshot inline as compare_node_to_dom\'s dom.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('get_layout_spec', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        const ids = args.node_ids.map(normalizeCompoundNodeId);
        const api = deps.buildApi(token);

        const maxDepth = args.max_depth;
        const reqDepth = maxDepth ?? 4;
        // Frame hydration: hold the deepest raw per id-set, re-slice ≤ heldDepth for free (bypasses
        // nodeCache). effectiveMaxDepth == reqDepth unless a deep-fetch abort clamped it (backoff).
        const frameRes = await api.getFrameRaw(parsed.value, ids, reqDepth);
        const res = frameRes.raw;
        const effDepth = frameRes.effectiveMaxDepth;
        const hydration: HydrationReceipt[] = [];
        const specs = await Promise.all(ids.map(async (id) => {
          const entry = res.nodes[id];
          if (!entry?.document) return { node_id: id, error: 'not found' };
          const setNames = await buildSetNames(api, entry, deps.logger);
          const built = buildLayoutSpec(entry.document, { components: entry.components, setNames, styleNames: (sid: string) => entry.styles?.[sid]?.name }, { maxDepth: effDepth });
          if (args.text_leaves) {
            const { leaves, truncated } = collectLeafTexts(built);
            return { node_id: id, text_leaves: leaves, ...(truncated ? { text_leaves_truncated: true } : {}) };
          }
          hydration.push(buildHydrationReceipt(id, built, frameRes));
          return { node_id: id, spec: built };
        }));

        const { kept, omitted } = clampSpecsToBudget(specs, RESULT_BUDGET_BYTES);

        // (a') mint-meta: every successful node's rect.w (rounded, deduped)
        // — the widths a browser upload against this capToken is EXPECTED to match. Drives the
        // upload route's honest viewport_warning (dom-snapshot-routes.ts handleUpload) when the
        // browser's innerWidth is a guaranteed reflow vs all of them. Error/text_leaves entries carry
        // no `.spec` and don't contribute; an all-error batch yields widths:[] → meta stays undefined
        // (no hint to give, not an empty-array hint).
        const widths = [...new Set(specs.flatMap((r) => r.spec?.rect ? [Math.round(r.spec.rect.w)] : []))];

        // Multi-use upload_url: minted only when the caller asked for the extractor AND the
        // server is wired for the browser-direct upload flow (snapshotStore + a public base URL
        // to point the browser at). Absent either, the tool falls back to its prior output
        // unchanged — no field, no mint() call (a stdio/local-dev server with no public HTTP
        // endpoint is a correct, silent no-op here, not an error).
        const uploadUrl = args.include_extractor && deps.snapshotStore && deps.publicBaseUrl
          ? `${deps.publicBaseUrl}/api/dom-snapshots/${deps.snapshotStore.mint(deps.tenantId ?? 'local', widths.length ? { expectedWidths: widths } : undefined)}`
          : undefined;

        // extractor_mode: 'loader' (default; ?? here mirrors the zod .default('loader') for direct
        // handler invocations that bypass MCP SDK schema parsing, e.g. unit tests) only actually
        // loads when the server has a public base URL to point the browser at (GET
        // /api/dom-snapshots/extractor.js, see dom-snapshot-routes.ts) — without one there's nothing
        // to fetch, so it silently falls back to the full inline script and says so via extractor_note
        // (honest-degrade, not a silent behavior change the caller has to notice on their own).
        // extractor_mode:'inline' always gets the full script, no note (that's what the caller
        // explicitly asked for, not a fallback).
        const extractorMode = args.extractor_mode ?? 'loader';
        const useLoader = extractorMode === 'loader' && !!deps.publicBaseUrl;
        const extractorFields = args.include_extractor
          ? useLoader
            ? { extractor_js: buildExtractorLoader(deps.publicBaseUrl!) }
            : {
                extractor_js: EXTRACTOR_JS,
                ...(extractorMode === 'loader'
                  ? { extractor_note: 'loader unavailable without public base URL — inline returned' }
                  : {}),
              }
          : {};

        // When max_depth was explicitly given, show the 4-arg extractor call (depthLeft, budget)
        // so the pasted-VERBATIM upload_hint actually drills as deep as the caller asked — without
        // this the extractor would silently run at its 2-arg defaults (depthLeft=3, budget=90) even
        // though get_layout_spec's OWN projection just went deeper. Absent max_depth, the hint stays
        // the prior 2-arg call, byte-for-byte (backward-compat).
        const depthArgsSuffix = maxDepth !== undefined ? `, ${effDepth - 1}, ${budgetFor(effDepth)}` : '';
        // Same depth/budget arguments for the no-upload_url call form, which has no uploadUrl to pass:
        // depthLeft/budget are positional args 3 and 4, so slot 2 needs an explicit `undefined`.
        const stdioDepthArgs = depthArgsSuffix && `, undefined${depthArgsSuffix}`;
        return jsonResult({
          file: parsed.value,
          snapshot_schema: DOM_SNAPSHOT_SCHEMA_VERSION,
          specs: kept,
          ...(omitted.length ? { result_truncated: true, omitted_node_ids: omitted,
            result_truncated_note: 'result exceeded the budget — re-request the omitted node_ids in a separate get_layout_spec call (fewer node_ids at a time) or lower max_depth' } : {}),
          ...(hydration.length ? { hydration: hydration.filter((h) => kept.some((k: { node_id: string }) => k.node_id === h.node_id)) } : {}),
          ...extractorFields,
          // The call form for the branch with NO upload_url — this fires on `!uploadUrl`, which is
          // every stdio server (no snapshot store, no public base URL) and equally any server that
          // has a public base URL but no snapshot store: uploadUrl needs BOTH, the loader needs only
          // the base URL, so that server would hand back a loader thunk AND this hint. No shipped
          // wiring builds one — but the guard is `!uploadUrl`, and the hint is true of any branch it
          // fires on: without an upload_url the snapshots come back to the caller either way.
          // The guidance used to live only in upload_hint, i.e. in the one branch stdio never
          // reaches, so a stdio caller got the full inline extractor and no instructions at all; the
          // usual guess is then to re-paste it per capture and re-request it per call, which costs a
          // cycle roughly 3x what it needs to.
          //
          // THE PASTE-ONCE FORM IS A THUNK, NOT AN ASSIGNMENT. chrome-devtools evaluate_script
          // evaluates `(<what you sent>)` and then CALLS it with no arguments, so a bare
          // `window.__extract = <script>;` does not even parse (the trailing `;` closes nothing) and
          // the same text without the `;` parses as a function expression that is then invoked with
          // no selectors — a TypeError inside the extractor. Wrapping the assignment in a thunk that
          // returns is the only shape that survives both steps.
          ...(args.include_extractor && !uploadUrl ? { extractor_hint:
            'no upload_url on this server: the extractor hands the snapshots back to you. Paste ' +
            'extractor_js ONCE inside a thunk: `() => { window.__extract = <extractor_js VERBATIM>; ' +
            "return 'ok'; }` (evaluate_script CALLS what you send with no arguments, so a bare " +
            'assignment throws) — then every capture is ' +
            `\`async () => await window.__extract(["<sel>", …]${stdioDepthArgs})\` (a reload drops the ` +
            'handle — paste again). Pass include_extractor:false on every later get_layout_spec call. ' +
            'Hand each snapshot inline to the matching compare_node_to_dom pairs[i].dom.' } : {}),
          ...(uploadUrl ? { upload_url: uploadUrl, upload_hint:
            `call the extractor as: async () => { const extract = <extractor_js VERBATIM>; return await extract(["<sel>", …], "<upload_url>"${depthArgsSuffix}); } ` +
            '— extractor_js decides for itself whether to load the canonical script from the server (loader) or is already the full script (inline); ' +
            'it returns {snapshot_ref, summaries}; pass pairs to compare_node_to_dom as dom_ref:{ref, index} (selector position, 0-based, disambiguates duplicates) or {ref, selector}' +
            '; a batch >2MB — split it into several POSTs under the same upload_url (the limit is per-POST, not per-session)' } : {}),
        });
      }, deps.noTokenHint),
  );
}
