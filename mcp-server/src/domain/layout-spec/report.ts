// Deterministic "Verified against Figma" markdown block — the AI drops it into its reply verbatim,
// without reinventing the format (format source: the "Design verification" rule).
import type {
  PairResult, DiffRow, PairSummary, VerificationReceipt, SpacingAuditEntry, SpacingAuditGap, PairSource,
  FixPlanGroup, FixPlanEdit, MatchProfile,
} from './types.js';
import { NOT_COVERED_BY_TOOL, countCoverageHoles } from './diff.js';
import type { SourceHint } from './class-source.js';

const EMOJI: Record<DiffRow['status'], string> = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭', info: 'ℹ️', demoted: '🟰', unchecked: '👁', review: '📝' };

const fmt = (v: string | number | null | undefined): string => (v === null || v === undefined ? '—' : String(v));

function rowLine(r: DiffRow): string {
  const delta = r.delta !== undefined ? ` (Δ${r.delta})` : '';
  const note = r.note ? ` — ${r.note}` : '';
  return `- ${EMOJI[r.status]} ${r.prop}: Figma ${fmt(r.figma)} / DOM ${fmt(r.dom)}${delta}${note}`;
}

// source-hint: render FROM the already-collected PairSource — report.ts does not
// re-parse CSS classes, it only formats addresses along the axes of discrepancy (routing, NOT row
// duplication). The note case (classList non-empty, 0 parses) gets its own honest line instead of
// silence/empty segments. Every channel is strictly optional and renders ONLY on a real hint — a
// style_anchor row can be emitted WITHOUT source.anchor (a carrier with no classes), and the "styles → …"
// render does not look at that (otherwise an empty/broken segment). An anchor that
// duplicates root (same module) adds no segment — it's already named by the root line.
function renderSourceLine(source: PairSource): string | undefined {
  if (source.note) return `code: — (${source.note})`;
  const segments: string[] = [];
  if (source.root) segments.push(`gap/spacing → ${source.root.module ?? source.root.local} (root)`);
  if (source.children?.length) {
    segments.push(source.children.map((c) => `${c.name} → ${c.hint.module ?? c.hint.local}`).join(', '));
  }
  if (source.anchor && source.anchor.module !== source.root?.module) {
    segments.push(`styles → ${source.anchor.module ?? source.anchor.local}`);
  }
  if (source.text?.length) {
    segments.push(`text: ${source.text.map((t) => `${t.label} → ${t.hint.module ?? t.hint.local}`).join(', ')}`);
  }
  if (segments.length === 0) return undefined;
  return `code: ${segments.join('; ')}`;
}

// fix-plan: candidate-address format. The `≈` prefix lives on the bullet line (not here) —
// the target is ITSELF a candidate, never ground truth (module+local isn't unique — N places could be N
// files). Vite builds don't always carry a module (webpack CSS-modules hash) — honest form WITHOUT a
// made-up module.
function fmtTarget(h: SourceHint): string {
  return h.module ? `${h.module} (.${h.local})` : `.${h.local} (local class)`;
}

// prop BASE for the ×N fold = prop up to the first '[' — 'font-weight[plates→"A"]' and
// 'font-weight[plates→"B"]' share the base 'font-weight' (different bracket suffixes = different PLACES of
// the same edit, not different edits).
function propBase(prop: string): string {
  const i = prop.indexOf('[');
  return i === -1 ? prop : prop.slice(0, i);
}

// One edit → one markdown line. prop is passed separately from edit (not edit.prop) — on a folded (×N)
// line we show the BASE (without the bracket suffix of one specific place), on an unfolded line edit.prop
// as-is. A layout kind carries a fixed honest note ("edit the RULE, not px"); the ×N
// annotation is mutually exclusive with layout (fold ONLY for kind='property').
function renderEditLine(target: string, prop: string, e: FixPlanEdit, trailer?: string): string {
  const prefix = e.kind === 'layout' ? 'layout: ' : '';
  const delta = e.delta !== undefined ? ` (Δ${e.delta})` : '';
  const note = trailer ? ` — ${trailer}` : '';
  return `- ≈ ${target}: ${prefix}${prop} ${fmt(e.expected)} ← ${fmt(e.actual)}${delta}${note}`;
}

// One FixPlanGroup → its markdown lines. A null target (address not resolved) — ONE honest line with the
// edit count (the origin channel does not split a null group). An addressed group — line per edit,
// COLLAPSING property edits with an equal prop BASE+expected+actual; layout never
// collapses (even with matching values — different layout rules, not "the same thing").
function renderFixGroup(g: FixPlanGroup): string[] {
  if (g.target === null) {
    const n = g.edits.length;
    return [`- address not resolved: ${n} edit${n === 1 ? '' : 's'} — navigate by structure/text`];
  }
  const target = fmtTarget(g.target);
  // property edits grouped by (prop base, expected, actual) — NUL separator guards 'a'+'bc' vs 'ab'+'c'.
  const clusterKey = (e: FixPlanEdit): string => `${propBase(e.prop)}\x00${String(e.expected)}\x00${String(e.actual)}`;
  const clusterSize = new Map<string, number>();
  for (const e of g.edits) if (e.kind === 'property') {
    const k = clusterKey(e);
    clusterSize.set(k, (clusterSize.get(k) ?? 0) + 1);
  }
  const emitted = new Set<string>();
  const lines: string[] = [];
  for (const e of g.edits) {
    if (e.kind === 'layout') { lines.push(renderEditLine(target, e.prop, e, 'edit the layout rule, not px')); continue; }
    const k = clusterKey(e);
    const n = clusterSize.get(k)!;
    if (n > 1) {
      if (emitted.has(k)) continue; // already rendered by the summary line — the other places are folded into it
      emitted.add(k);
      lines.push(renderEditLine(target, propBase(e.prop), e, `×${n} places (check: one class?)`));
    } else {
      lines.push(renderEditLine(target, e.prop, e));
    }
  }
  return lines;
}

// fix-plan: the "Edits:" markdown block — rendered STRICTLY from fix_plan (does not re-parse rows
// again, does not duplicate or recompute addresses/resolves — buildFixPlan already did that in the tool).
// An empty/absent fix_plan (a pair with no matching fail) → no block at all.
function renderFixPlan(fixPlan: FixPlanGroup[] | undefined): string[] {
  if (!fixPlan || fixPlan.length === 0) return [];
  const lines = ['Edits (target = class candidate, confirm by resolving):'];
  for (const g of fixPlan) lines.push(...renderFixGroup(g));
  return lines;
}

// profiles: profileScoped coverage skips (applyLayoutProfileScope — an axis outside the layout
// profile's scope, folded per-dim) get their OWN summary line, not a rowLine. Source — p.coverage.skipped
// (the canonical channel, deriveCoverage), NOT a second pass over rows. Distinguishing it from an
// environment ⏭ skip (rowLine below, per-row, with its own env-specific note like "scroll container") —
// TWO things: a summary line instead of a per-row one, and the explicit phrase "outside profile scope"
// without "Figma — / DOM —" (nothing to show: the axis wasn't measured at all, it didn't just "return skip").
function renderProfileSkips(p: PairResult): string[] {
  const skips = (p.coverage?.skipped ?? []).filter((s) => s.profileScoped === true);
  if (skips.length === 0) return [];
  const dims = skips.map((s) => s.dim).join(', ');
  return [`⏭ outside profile scope: ${dims} — verify with the token-aware/strict profile`];
}

export function renderReport(input: {
  file: string; tolerancePx: number; pairs: PairResult[];
  frame?: { node_id: string; width?: number }; omittedPairs?: number;
  preflight?: string;
  // max_depth drill-down: the depth-ceiling footer note used to hardcode a fixed
  // capture depth (4). Capture depth is now a per-call parameter (compare_node_to_dom's max_depth) —
  // the caller passes the ACTUAL depth used for this report instead of renderReport importing a
  // module constant, or a deep drill-down's footer would keep lying about a stale ceiling of 4.
  // Default 4 = byte-for-byte the prior behavior.
  depthLevels?: number;
  // A1: machine-gated receipt. The verdict accounts for frame coverage (else "no discrepancies" with
  // uncovered regions = a frame-level false green), and the "Check" block + blocking are rendered.
  verification?: VerificationReceipt;
}): string {
  const lines: string[] = [];
  const frameNote = input.frame ? `, frame ${input.frame.node_id}${input.frame.width ? ` (${input.frame.width}px)` : ''}` : '';
  // Profile provenance: match_profile is forwarded FROM verification.match_profile (the single
  // source — buildVerification/the tool already carry it), NOT a new parallel renderReport parameter.
  // Absence of verification/the field (legacy calls, unit tests without it) → honest default 'token-aware'
  // (deliberate explicitness — the profile is ALWAYS in the header, not only when explicitly passed).
  const profile: MatchProfile = input.verification?.match_profile ?? 'token-aware';
  lines.push(`Verified against Figma (file ${input.file}${frameNote}, tolerance ${input.tolerancePx}px, profile ${profile}):`, '');

  // layout — a scope narrowing, not a final check (the machine gate keeps complete:false separately,
  // verification.ts sentinel scope_incomplete); this line is a human-readable echo of THE SAME fact,
  // not an alternative source of truth. Text is fixed (a provenance note).
  if (profile === 'layout') {
    lines.push('⚠️ layout profile — typography/colors/styles OUT OF scope', '');
  }

  if (input.preflight) {
    lines.push(`⚠️ ${input.preflight}`, '');
  }

  const total: PairSummary = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 };
  for (const p of input.pairs) {
    (Object.keys(total) as (keyof PairSummary)[]).forEach((k) => { total[k] += p.summary[k]; });
    const demHead = p.summary.demoted > 0 ? ` 🟰${p.summary.demoted}` : '';
    const unchHead = p.summary.unchecked > 0 ? ` 👁${p.summary.unchecked}` : '';
    const revHead = p.summary.review > 0 ? ` 📝${p.summary.review}` : '';
    const head = `**${p.label ?? p.node_id}** (node ${p.node_id}${p.selector ? ` ↔ ${p.selector}` : ''}): ` +
      `✅${p.summary.pass} ❌${p.summary.fail}${demHead}${unchHead}${revHead} ⚠️${p.summary.warn} ⏭${p.summary.skip} ℹ️${p.summary.info}`;
    lines.push(head);
    // profiles: profileScoped rows are excluded from the rowLine loop — they carry ONLY a bare dim
    // with no figma/dom (nothing to show but placeholder dashes); renderProfileSkips below gives them an
    // honest summary form from p.coverage.skipped instead of a noisy "Figma — / DOM —".
    for (const r of p.rows) if ((r.status !== 'pass' || r.prop === 'unwrapped') && r.profileScoped !== true) lines.push(rowLine(r));
    lines.push(...renderProfileSkips(p));
    if (p.source) {
      const srcLine = renderSourceLine(p.source);
      if (srcLine) lines.push(srcLine);
    }
    lines.push(...renderFixPlan(p.fix_plan));
    lines.push('');
  }
  if (input.omittedPairs) {
    lines.push(`⚠️ ${input.omittedPairs} pairs didn't fit the response budget — call compare again for them`, '');
  }
  const demTotal = total.demoted > 0 ? ` 🟰${total.demoted}` : '';
  const unchTotal = total.unchecked > 0 ? ` 👁${total.unchecked}` : '';
  const revTotal = total.review > 0 ? ` 📝${total.review}` : '';
  // Coverage holes (structure_mismatch / children truncation / axis skip / a pair refusing to compare) —
  // warn/skip statuses the verdict USED to ignore → a pair with silently skipped children collapsed into
  // "no discrepancies" (a live false green). We count them and do NOT let a terminal green be emitted while
  // even one exists. Informational warns (component/fill/frame) are NOT included here — don't cry wolf.
  const holes = input.pairs.reduce((n, p) => n + countCoverageHoles(p.rows), 0);
  const notVerified: string[] = [];
  if (total.demoted > 0) notVerified.push(`${total.demoted} not verified (demoted)`);
  if (total.unchecked > 0) notVerified.push(`${total.unchecked} not verified (out of reach)`);
  if (total.review > 0) notVerified.push(`${total.review} awaiting token confirmation`);
  if (holes > 0) notVerified.push(`${holes} not verified (structure/truncation/environment)`);
  // A1: frame coverage also lowers the verdict — else "no discrepancies" with uncovered regions = a
  // frame-level false green (the AI paired 2 of 8 regions). Verdict ⟺ verification.complete.
  const fc = input.verification?.scope === 'frame' ? input.verification.frame_coverage : undefined;
  if (fc) {
    // Final hardening: .length reads the CAPPED list (≤60, capList in
    // verification.ts) — a frame with 70 uncovered regions rendered "60 region(s)", silently
    // understating the true count. uncovered_capped/partial_capped carry the overflow; adding it back
    // gives the honest total (the JSON list itself stays capped for response-budget reasons — only the
    // PROSE was lying about the count).
    const uncoveredTotal = fc.uncovered.length + (fc.uncovered_capped ?? 0);
    const partialTotal = fc.partial.length + (fc.partial_capped ?? 0);
    // Final hardening: a partial container whose spacing_audit came back
    // fully_clean HAD its between-children gaps verified (and they passed) — counting it under "unpaired
    // (spacing between children)" mis-attributes an insets-only remainder as an unverified spacing
    // question. Subtract fully_clean containers from that line and give them their own honest line.
    const fullyCleanCount = (input.verification?.spacing_audit ?? []).filter((e) => e.fully_clean).length;
    const partialUnverified = partialTotal - fullyCleanCount;
    if (uncoveredTotal > 0) notVerified.push(`${uncoveredTotal} frame region(s) unpaired`);
    if (partialUnverified > 0) notVerified.push(`${partialUnverified} container(s) unpaired (spacing between children)`);
    if (fullyCleanCount > 0) notVerified.push(`insets of ${fullyCleanCount} container(s) not verified (between-children gaps clean per audit)`);
    if (fc.enumeration_truncated) notVerified.push('frame children enumeration truncated');
  }
  // total here — only over kept (shown) pairs, whereas verification is built over ALL results (before the
  // budget clamp). A dropped failing pair → total.fail=0 over kept, BUT verification.complete=false →
  // receiptIncomplete lowers the verdict (closes a class of false-green prose). We gate on that, NOT on
  // omittedPairs itself: a dropped-but-CLEAN pair was verified (it's in the receipt) — degrading for it =
  // crying wolf. omittedPairs stays a separate ⚠️ line below (re-request the display). Verdict ⟺ complete.
  const receiptIncomplete = input.verification !== undefined && !input.verification.complete;
  // a spacing_audit fail — a discrepancy found WITHOUT a pair on the
  // container (auditContainer), which total.fail (per-pair rows) does NOT see (the audit is not a pair, it's
  // a separate channel). Mutation lock: a fixture with total.fail===0 across all pairs must still yield
  // "discrepancies found" EXACTLY through this branch — else an audit fail silently sinks into "no defects found".
  const auditFail = (input.verification?.spacing_audit ?? []).some((e) => e.gaps.some((g) => g.status === 'fail'));
  const verdict =
    total.fail > 0 || auditFail
      ? 'discrepancies found'
      : notVerified.length > 0 || receiptIncomplete
        ? `no defects found, but CHECK INCOMPLETE: ${notVerified.join(', ') || 'see verification.blocking'} — do NOT treat as green, verify visually`
        : 'no discrepancies above tolerance';
  lines.push(`Total: ✅${total.pass} ❌${total.fail}${demTotal}${unchTotal}${revTotal} ⚠️${total.warn} ⏭${total.skip} ℹ️${total.info} — ${verdict}`);
  const vBlock = renderVerification(input.verification);
  if (vBlock.length) lines.push('', ...vBlock);
  lines.push('', `⚠️ NOT covered by this tool (verify visually): ${NOT_COVERED_BY_TOOL.join(', ')}`);
  lines.push('ℹ️ icons: size/position are measured geometrically, the diff does not check glyph/shape — verify visually or get_screenshot focus-crop');
  lines.push(`ℹ️ typography checked to ${input.depthLevels ?? 4} nesting levels — TEXT deeper: raise max_depth (up to 8) and rerun, or add a separate pair on the TEXT node`);
  return lines.join('\n');
}

// one between-children gap of a partial container — pass/fail carry numbers
// (figma/dom/Δ), unchecked carries ONLY a note (dom/delta are inherently undefined on unchecked, types.ts —
// fabricating a "0" here would mean lying with a number where no comparison was made).
function renderGap(g: SpacingAuditGap): string {
  const label = `gap ${g.between[0]}↔${g.between[1]}`;
  if (g.status === 'pass') return `${label} ${g.figma}/${g.dom} ✅`;
  if (g.status === 'fail') return `${label} ${g.figma}/${g.dom} ❌ Δ${g.delta}`;
  return `${label} 👁${g.note ? ` (${g.note})` : ''}`;
}
// One ⚖ line per container (all its gaps via ' · ') + ONE shared final note about insets — we don't
// duplicate it per container (boilerplate noise), it's equally true for all entries at once (auditContainer
// fundamentally does not measure the container's padding — insets_unverified:true on EVERY entry).
function renderSpacingAudit(entries: SpacingAuditEntry[] | undefined): string[] {
  if (!entries || entries.length === 0) return [];
  const lines = entries.map((e) => `⚖ spacing-audit ${e.container_id}: ${e.gaps.map(renderGap).join(' · ')}`);
  lines.push('the container insets are not verified by the audit — for a fully green result add a container pair');
  return lines;
}

// A1: human-readable "Check" block (R3 hybrid — structured verification.blocking in JSON, prose here).
// complete=false with an empty blocking = only inherent caveats remain (demoted) → verify visually, no auto
// actions (anti-cry-wolf: we don't push the AI to "fix" the unfixable).
function renderVerification(v?: VerificationReceipt): string[] {
  if (!v) return [];
  const cov = v.frame_coverage;
  const scopeNote = v.scope === 'frame'
    ? `scope frame${cov ? `, coverage ${cov.covered}/${cov.worthy}` : ''}`
    : 'scope pairs — ONLY the submitted pairs were checked, NOT the whole screen';
  // Enumeration provenance (source@depth) + honest advice/caveat (enumeration_note, matrix in
  // buildVerification) — rendered ALSO in the COMPLETE branch (early return below), OTHERWISE a green deep
  // frame loses its provenance (the AI won't learn the projection depth if the
  // check came back green).
  const prov = cov ? ` · enumeration: ${cov.enumeration_source}@${cov.enumeration_depth}${cov.enumeration_note ? ` ⚠ ${cov.enumeration_note}` : ''}` : '';
  const auditBlock = renderSpacingAudit(v.spacing_audit);
  if (v.complete) {
    return [`Check: COMPLETE ✅ — everything verified (${scopeNote}, pairs ${v.pairs.clean}/${v.pairs.checked} clean).${prov}`, ...auditBlock];
  }
  // Final hardening: same total-vs-capped and fully_clean-exclusion
  // treatment as renderReport's notVerified above — this is the SECOND prose point reading the same
  // capped .length / same partial list, and it must stay honest in lockstep with the first.
  const fullyCleanCount = (v.spacing_audit ?? []).filter((e) => e.fully_clean).length;
  const bits: string[] = [`pairs ${v.pairs.clean}/${v.pairs.checked} clean`];
  if (cov) {
    const uncoveredTotal = cov.uncovered.length + (cov.uncovered_capped ?? 0);
    const partialTotal = cov.partial.length + (cov.partial_capped ?? 0);
    const partialUnverified = partialTotal - fullyCleanCount;
    if (uncoveredTotal) bits.push(`regions unpaired ${uncoveredTotal}`);
    if (partialUnverified) bits.push(`containers unpaired (spacing) ${partialUnverified}`);
    if (fullyCleanCount) bits.push(`insets of ${fullyCleanCount} container(s) not verified (between-children gaps clean per audit)`);
    if (cov.enumeration_truncated) bits.push('enumeration truncated');
  }
  const out = [`Check: INCOMPLETE (${scopeNote}): ${bits.join('; ')} — do NOT say "done" until this is closed.${prov}`, ...auditBlock];
  if (v.blocking.length === 0) {
    // Final hardening: the generic caveat used to say only "demoted/out of
    // reach", mis-labeling an audit-clean container's insets-only remainder as one of those two — a
    // fully_clean spacing_audit entry names a THIRD honest reason nothing is actionable here.
    out.push(fullyCleanCount > 0
      ? 'Only inherent items remain (demoted/out of reach/container insets with a clean audit) — verify visually, no auto-actions.'
      : 'Only inherent items remain (demoted/out of reach) — verify visually, no auto-actions.');
    return out;
  }
  const totalBlocking = v.blocking.length + (v.blocking_capped ?? 0);
  out.push(`Remaining (blocking, ${totalBlocking}):`);
  const CAP = 15;
  for (const b of v.blocking.slice(0, CAP)) {
    const addr = b.node_id ? ` node ${b.node_id}` : b.selector ? ` ${b.selector}` : '';
    out.push(`- [${b.action}]${addr} — ${b.detail}`);
  }
  const hidden = totalBlocking - Math.min(CAP, v.blocking.length);
  if (hidden > 0) out.push(`- … ${hidden} more (full list in verification.blocking)`);
  return out;
}
