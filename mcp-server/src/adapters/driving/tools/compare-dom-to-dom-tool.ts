// compare_dom_to_dom (feedback item 16): two DOM states of ONE screen, measured against each
// other - skeleton vs loaded, before vs after an edit, breakpoint vs breakpoint. REFERENCE is
// the state whose geometry should hold; CANDIDATE is the state being checked. The tool makes
// ZERO Figma calls: no file, no figma_token - both sides come from the canonical extractor
// (inline or via the snapshot store), and the diff is the existing engine in its explicit
// dom-dom mode (domain/layout-spec/dom-dom.ts).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTokenlessTool, jsonResult } from './shared-error-handler.js';
import { serializeForDelivery } from './serialize.js';
import { summarize, deriveCoverage } from '../../../domain/layout-spec/diff.js';
import { diffDomPair } from '../../../domain/layout-spec/dom-dom.js';
import { renderReport } from '../../../domain/layout-spec/report.js';
import { DomSnapshotSchema, DOM_SNAPSHOT_SCHEMA_VERSION } from './dom-snapshot-schema.js';
import { clampToBudget } from '../../../application/get-comments.js';
import { DomRefSchema, resolveDomRef } from './dom-ref.js';
import { buildVerification } from '../../../domain/layout-spec/verification.js';
import type { PairResult, PairSummary, DomSnapshot, DomSnapshotOk, DiffRow, VerificationReceipt } from '../../../domain/layout-spec/types.js';

// What this comparison structurally does not see: content correctness (two captures of the SAME
// wrong text agree), anything below the capture depth on BOTH sides, and icons (same as the
// Figma comparator). Named so a green verdict is not read as covering them.
const DOM_DOM_NOT_COVERED = ['content correctness (both captures can agree on a wrong value)', 'per-child paint (child background/radius/shadow - compare the child as its own pair)', 'icons'] as const;

const SideSchema = z.object({
  dom: DomSnapshotSchema.optional().describe('DomSnapshot from the canonical extractor (get_layout_spec include_extractor:true). Pass exactly one of dom | dom_ref.'),
  dom_ref: DomRefSchema.optional().describe(
    'Reference to a browser-uploaded snapshot batch instead of inlining raw DOM JSON - same store, '
    + 'TTLs and addressing as compare_node_to_dom\'s dom_ref. Only the HTTP servers construct the '
    + 'snapshot store; on stdio pass dom inline. Pass exactly one of dom | dom_ref.',
  ),
}).superRefine((p, ctx) => {
  if ((p.dom === undefined) === (p.dom_ref === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass exactly one of dom | dom_ref' });
  }
});

export const DomPairSchema = z.object({
  label: z.string().min(1).max(80).describe('REQUIRED pair identity - names this element in rows, receipt and report (e.g. "product-card-list"). There are no Figma ids here; the label IS the address.'),
  reference: SideSchema.describe('The state whose geometry SHOULD hold (e.g. the loaded page for a skeleton check, the default state for a hover check)'),
  candidate: SideSchema.describe('The state being CHECKED against the reference (e.g. the skeleton)'),
});

const InputSchema = {
  pairs: z.array(DomPairSchema).min(1).max(10).describe('reference/candidate snapshot pairs - up to 10 per call; the receipt aggregates ALL pairs (three defects = one complete:false, not three calls)'),
  tolerance_px: z.number().min(0).max(10).optional()
    .describe('A delta below this is a pass (px metrics); omitted -> 1'),
  max_depth: z.number().int().min(1).max(8).optional()
    .describe('The max_depth BOTH captures were made with (default 4). This tool captures nothing itself - the value bounds the nested-text descent and the drill advice in the receipt, so pass the SAME max_depth the extractor ran with for both states.'),
};

type Side = z.infer<typeof SideSchema>;

function resolveSide(side: Side, role: 'reference' | 'candidate', deps: ToolDeps): { snap?: DomSnapshot; note?: string } {
  if (side.dom_ref) {
    if (!deps.snapshotStore) return { note: `${role}: snapshot store unavailable on this server — pass ${role}.dom inline` };
    const r = resolveDomRef(side.dom_ref, deps.snapshotStore, deps.tenantId ?? 'local');
    // The side name prefixes the store's own note: with two refs in one pair, "expired" without
    // a side is a coin-flip for the caller re-capturing exactly one of them.
    return r.ok ? { snap: r.snapshot as DomSnapshot } : { note: `${role}: ${r.note}` };
  }
  return { snap: side.dom as DomSnapshot };
}

// Per-side gates BEFORE the diff, each naming the side (the both-sides staleness lock: a stale
// or failed capture on EITHER side must trip its own named row, not corrupt the numbers).
function sideGateRows(snap: DomSnapshot | undefined, note: string | undefined, role: 'reference' | 'candidate'): DiffRow[] {
  if (note) return [{ prop: 'snapshot_ref', status: 'warn', note }];
  if (snap !== undefined && snap.status !== undefined && snap.status !== 'ok') {
    return [{ prop: 'snapshot', status: 'warn',
      note: `${role}: extractor capture failed (${snap.status}${'matches' in snap && snap.matches !== undefined ? `, ${snap.matches} matches` : ''}) — fix the ${role} selector/state and re-capture` }];
  }
  const ok = snap as DomSnapshotOk | undefined;
  if (ok?.schema !== undefined && ok.schema !== DOM_SNAPSHOT_SCHEMA_VERSION) {
    return [{ prop: 'snapshot_schema', status: 'warn', figma: DOM_SNAPSHOT_SCHEMA_VERSION, dom: ok.schema,
      note: `the ${role.toUpperCase()} snapshot version does not match the server — re-run the current extractor for the ${role} capture` }];
  }
  return [];
}

export function registerCompareDomToDomTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'compare_dom_to_dom',
    {
      description: 'Deterministic metric diff between TWO DOM states of one screen: reference (what geometry '
      + 'should hold - e.g. the loaded page) vs candidate (what is checked - e.g. its skeleton). Same row '
      + 'machinery as the Figma comparator - sizes, inter-child gaps, effective paddings, cross-axis offsets, '
      + 'typography, colors - plus symmetric presence checks (a background or text present on exactly one side '
      + 'is named, never silent) and a fill token-provenance drift row (var()-anchored on one side, literal on '
      + 'the other = review). Makes ZERO Figma calls: no file and no figma_token parameter. Both captures come '
      + 'from the canonical extractor (get_layout_spec include_extractor:true), inline or via dom_ref. The layout '
      + 'axis is INFERRED from the reference children geometry (snapshots do not declare flex direction); when '
      + 'ambiguous the gap/offset rows are honestly skipped with a visible note. verification.complete aggregates '
      + 'ALL pairs and is the done-gate: never claim the states match while it is false or blocking[] is non-empty. '
      + 'Primary uses: skeleton-vs-loaded (content must not jump on swap), before/after an edit, '
      + 'breakpoint-vs-breakpoint (unequal capture widths become one loud viewport row), hover/default.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTokenlessTool('compare_dom_to_dom', deps.logger, async () => {
        const t0 = Date.now();
        const tolerancePx = args.tolerance_px ?? 1;
        const depthLevels = args.max_depth ?? 4;

        const results: PairResult[] = args.pairs.map((p): PairResult => {
          const ref = resolveSide(p.reference, 'reference', deps);
          const cand = resolveSide(p.candidate, 'candidate', deps);
          const selector = p.candidate.dom_ref?.selector ?? (cand.snap as { selector?: string } | undefined)?.selector;
          // Label-based identity: there is no Figma node here - the label IS node_id, so every
          // consumer of PairResult (verification blocking, report, fix-plan-less rows) addresses
          // the pair by the caller's own name.
          const base = { node_id: p.label, label: p.label, ...(selector ? { selector } : {}) };
          const gateRows = [...sideGateRows(ref.snap, ref.note, 'reference'), ...sideGateRows(cand.snap, cand.note, 'candidate')];
          if (gateRows.length > 0) {
            return { ...base, rows: gateRows, summary: summarize(gateRows), coverage: deriveCoverage(gateRows) };
          }
          const rows = diffDomPair(ref.snap as DomSnapshotOk, cand.snap as DomSnapshotOk,
            { tolerancePx, ...(args.max_depth !== undefined ? { maxDepth: args.max_depth } : {}) });
          return { ...base, rows, summary: summarize(rows), coverage: deriveCoverage(rows) };
        });

        // No frame and no frameRequested -> 'pairs' scope: the receipt demands nothing beyond the
        // submitted pairs, and complete:false aggregates every pair's fails/reviews/holes in ONE
        // verdict (the done-gate correction: three defects are one incomplete receipt, not three calls).
        const verification: VerificationReceipt = buildVerification(results, { depthLevels, tolerancePx, mode: 'dom-dom' });

        const budget = deps.maxResultChars ?? 40000;
        const serialize = (kept: PairResult[]): string => serializeForDelivery(buildOutput(tolerancePx, kept, results.length - kept.length, depthLevels, verification));
        let kept = results;
        if (serialize(results).length > budget) {
          ({ kept } = clampToBudget(results, budget, serialize));
        }
        deps.logger.info({ total_ms: Date.now() - t0, pairs: args.pairs.length }, 'compare_dom_to_dom.done');
        return jsonResult(buildOutput(tolerancePx, kept, results.length - kept.length, depthLevels, verification));
      }),
  );
}

function buildOutput(tolerancePx: number, pairs: PairResult[], omitted: number,
  depthLevels: number, verification: VerificationReceipt): Record<string, unknown> {
  const summary: PairSummary = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 };
  for (const p of pairs) (Object.keys(summary) as (keyof PairSummary)[]).forEach((k) => { summary[k] += p.summary[k]; });
  return {
    tolerance_px: tolerancePx, pairs, summary, verification,
    not_covered_by_tool: DOM_DOM_NOT_COVERED,
    report_markdown: renderReport({
      tolerancePx, pairs, depthLevels, verification,
      headerLine: `Verified reference vs candidate (tolerance ${tolerancePx}px)`,
      sideLabels: ['reference', 'candidate'],
      ...(omitted ? { omittedPairs: omitted } : {}),
    }),
    ...(omitted ? { omitted_pairs: omitted } : {}),
  };
}
