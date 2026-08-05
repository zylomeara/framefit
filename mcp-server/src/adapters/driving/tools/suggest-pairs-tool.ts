import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeCompoundNodeId, COMPOUND_NODE_ID_RE } from '../../../domain/node-id.js';
import { buildLayoutSpec, FETCH_DEPTH, anyTruncatedSpec } from '../../../domain/layout-spec/projector.js';
import { buildSetNames } from './component-set-names.js';
import { matchPairs, type MatchOpts } from '../../../domain/layout-spec/pair-matcher.js';
import { DomSnapshotSchema, DOM_SNAPSHOT_SCHEMA_VERSION } from './dom-snapshot-schema.js';
import { DomRefSchema, resolveDomRef } from './dom-ref.js';
import type { DomChild } from '../../../domain/layout-spec/types.js';

// #4 — the snapshot honestly carries childrenTruncated (extractor, depth-limit/node-count-cap) anywhere
// in the tree, including the ROOT (dom-extractor.ts:160 sets it at >30 direct visible children). The scan
// recurses over children; the root flag is checked separately by the caller (see below) — otherwise
// a snapshot truncated EXACTLY at the root (a flat >30 list with no further nested truncation) would
// silently pass as an uncovered hole.
const anyTruncated = (kids: DomChild[] | undefined): boolean =>
  (kids ?? []).some((k) => k.childrenTruncated === true || anyTruncated(k.children));

// dom_path ('> :nth-child(3) > :nth-child(1)') is NOT a selector — document.querySelector throws on it.
// We do not GENERATE one either: uniqueness is a property of the document, and the server only ever sees
// the captured subtree (a class that is unique inside a component-rooted capture is typically not unique
// in the page). We concatenate the address we already hold: the capture root selector — which the
// extractor already PROVED unique (>1 match → status 'multiple', it refuses) — plus the nth-child chain,
// which is unique under a unique root by construction. :is() rather than a bare join because the root may
// be a selector LIST ('.a, .b'): '.a, .b > :nth-child(3)' parses as '.a' OR '.b > …' and would silently
// resolve to the wrong element. No root selector in the snapshot → NO field: never synthesize an address.
export const domSelector = (root: string | undefined, path: string): string | undefined =>
  root === undefined || root === '' || path === '' ? undefined : `:is(${root}) ${path}`;

export const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  frame_node_id: z.string().regex(COMPOUND_NODE_ID_RE).describe('Frame/root node to align against the DOM subtree'),
  // Typed object schema — mirror of compare_node_to_dom.dom. z.unknown() advertised an UNTYPED field
  // in the MCP inputSchema, so the connector coerced the object to a string and the server rejected
  // every call. A typed schema advertises type/anyOf → the object passes through. Now OPTIONAL because
  // dom_ref is the alternative; the handler enforces exactly-one (flat-shape input has no per-item
  // z.object to hang a superRefine on, unlike compare's PairSchema).
  dom_snapshot: DomSnapshotSchema.optional().describe(
    'DomSnapshot object from the canonical extractor (get_layout_spec include_extractor:true) - the WHOLE ' +
    'frame-root subtree (root selector), carrying per-node path. Pass the OBJECT (same shape as ' +
    'compare_node_to_dom.dom), not a stringified JSON. Pass exactly one of dom_snapshot | dom_ref.'),
  dom_ref: DomRefSchema.optional().describe(
    'Reference to a browser-uploaded snapshot (get_layout_spec upload_url flow) instead of inlining the ' +
    'whole-frame DOM JSON - moves a large snapshot off the MCP wire onto the direct upload. Only the HTTP ' +
    'servers construct the snapshot store this resolves against; on stdio pass dom_snapshot inline. ref = the ' +
    'snapshot_ref from the extractor POST; selector must match byte-for-byte the root selector passed to the ' +
    'extractor, OR index addresses it by position. Pass exactly one of dom_snapshot | dom_ref.'),
  max_depth: z.number().int().min(1).optional().describe('Bound matching depth (large frames - pair a subtree at a time)' +
    ' (levels 0..max_depth inclusive are processed - effectively about max_depth+1 levels of nesting under the frame root)'),
  figma_token: z.string().min(1).optional(),
};

export function registerSuggestPairsTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'suggest_pairs',
    {
      description: 'Propose Figma-node <-> DOM-element pairs (by text/size/order/role) with confidence + ambiguous flags + honest ' +
      'unmatched, so you review proposed pairs instead of hand-building them (compound I...;... ids come dug out of the ' +
      'frame). Two-step: capture the frame-root DOM subtree with the extractor, pass it here, feed confirmed pairs to ' +
      'compare_node_to_dom. Every proposal ships its receipt - score, margin over the runner-up, both rects, the DOM tag, ' +
      'and dom_selector (the capture-root selector + the nth-child path, pasteable as-is; absent if the snapshot carries no ' +
      'root selector, then use dom_path relative to your own root) - so you confirm or reject by eye instead of re-measuring ' +
      'in the browser. Read the receipt, not the word: an exact text match is worth +100 of a ~145 scale, so on a ' +
      'container-only frame every proposal reads low - that says "no text on either side here", not "bad geometry", and such ' +
      'pairs are yours to confirm by hand. children_skipped means the margin over the runner-up was inside the ambiguity ' +
      'band: the identity is unresolved, so its children were NOT guessed - confirm/retarget the pair, then re-run rooted on ' +
      'the confirmed element. Under an unpaired parent (or once one side of a pair is a leaf), its descendants are not ' +
      'inspected - the top is reported honestly in unmatched_figma/unmatched_dom (with rect + tag, so a mis-pair is ' +
      'retargeted straight from that list) instead, and you drill in by hand.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => runTool('suggest_pairs', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
      const parsed = parseFileKey(args.file);
      if (!parsed.ok) throw new Error(parsed.error);
      // XOR: exactly one of dom_snapshot | dom_ref (flat-shape input → handler guard, not a
      // per-item z.object superRefine like compare's PairSchema).
      if ((args.dom_snapshot === undefined) === (args.dom_ref === undefined)) {
        throw new Error('pass exactly one of dom_snapshot | dom_ref');
      }
      let rawSnapshot: unknown;
      if (args.dom_ref) {
        if (!deps.snapshotStore) throw new Error('snapshot store unavailable on this server — pass dom_snapshot inline');
        const r = resolveDomRef(args.dom_ref, deps.snapshotStore, deps.tenantId ?? 'local');
        if (!r.ok) throw new Error(r.note);
        rawSnapshot = r.snapshot;
      } else {
        rawSnapshot = args.dom_snapshot;
      }
      const dom = DomSnapshotSchema.parse(rawSnapshot);
      if (!('children' in dom)) throw new Error(`dom_snapshot: ${dom.status} — first capture the frame-root subtree with the extractor (the selector must match a single visible element)`); // I5
      // snippet-cap: suggest_pairs is the SECOND matcher input; without a version gate
      // an old extractor (truncates text at 40 WITHOUT a flag) at the server's SNIPPET_CAP=120 threshold
      // is indistinguishable from full text → the canonical mis-anchor (the hidden tail may carry S).
      // The Zod schema field accepts any int — the gate must be explicit. Same INTENT as compare
      // :338, but a DIFFERENT surface: throw/isError (suggest_pairs has no rows structure for a warn string;
      // don't try to emulate a snapshot_schema row).
      if (dom.schema !== undefined && dom.schema !== DOM_SNAPSHOT_SCHEMA_VERSION) {
        throw new Error(`dom_snapshot: schema v${dom.schema} is out of date (server expects v${DOM_SNAPSHOT_SCHEMA_VERSION}) — re-call get_layout_spec {include_extractor:true} and re-capture the snapshot with the updated script`);
      }
      const id = normalizeCompoundNodeId(args.frame_node_id);
      const api = deps.buildApi(token);
      const res = await api.getNodesRaw(parsed.value, [id], FETCH_DEPTH);
      const entry = res.nodes[id];
      if (!entry?.document) throw new Error(`frame ${id} not found in file`);
      const setNames = await buildSetNames(api, entry, deps.logger);
      const spec = buildLayoutSpec(entry.document, { components: entry.components, setNames });
      // rootDom — the real rect of the DOM container (dom.rect is required); rootFig — the real rect
      // of the frame, IF known (spec.rect is optional — absent when absoluteBoundingBox was null,
      // in which case matchPairs falls back to the prior max-child proxy for the fig side).
      // the root dom.childrenTruncated (already checked above for summary.snapshot_truncated) —
      // if true, the root doms list is incomplete (the extractor cut >30 direct children), a true
      // top-level competitor may have been dropped entirely → matchPairs won't anchor through it.
      const matchOpts: MatchOpts = { rootDom: { w: dom.rect.w, h: dom.rect.h }, rootDomTruncated: dom.childrenTruncated === true };
      if (args.max_depth !== undefined) matchOpts.maxDepth = args.max_depth;
      if (spec.rect) matchOpts.rootFig = { w: spec.rect.w, h: spec.rect.h };
      const r = matchPairs(spec.children, dom.children, matchOpts);
      const withSel = <T extends { dom_path: string }>(o: T): T & { dom_selector?: string } => {
        const s = domSelector(dom.selector, o.dom_path);
        return s === undefined ? o : { ...o, dom_selector: s };
      };
      return jsonResult({ file: parsed.value, frame: spec.node,
        pairs: r.pairs.map((p) => withSel(p.candidates ? { ...p, candidates: p.candidates.map(withSel) } : p)),
        unmatched_figma: r.unmatched_figma, unmatched_dom: r.unmatched_dom.map(withSel),
        summary: { paired: r.pairs.length, ambiguous: r.pairs.filter((p) => (p as { ambiguous?: boolean }).ambiguous).length,
          unmatched_figma: r.unmatched_figma.length, unmatched_dom: r.unmatched_dom.length, depth_truncated: r.depth_truncated,
          // I1: includes the ROOT dom.childrenTruncated too (not only nested) — additive, the field
          // is absent when there's no truncation anywhere (like depth_truncated). It also folds in the Figma side
          // (spec.childrenTruncated / anyTruncatedSpec) — the same honest signal, mirroring dom.
          ...((dom.childrenTruncated === true || anyTruncated(dom.children)
              || spec.childrenTruncated === true || anyTruncatedSpec({ children: spec.children }))
            ? { snapshot_truncated: true } : {}) } });
    }, deps.noTokenHint));
}
