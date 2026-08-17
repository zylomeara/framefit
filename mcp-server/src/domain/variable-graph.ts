// mcp-server/src/domain/variable-graph.ts
// Pure resolver over a per-user library variable graph. Follows alias chains (cross-library
// by published key, within-library by fileKey|localId), reading each collection's default
// mode, and converts literal COLOR to hex. Supports both default-mode resolution
// (resolveKey/resolveNode) and per-mode resolution (resolveKeyModes/resolveNodeInMode).
import { extractLibraryKey } from './variable-snapshot.js';
import { extractCssName } from './variables.js';
import { rgbaToHex } from './design-context/color.js';
import type { RawColor } from './figma-raw.js';
import type { ModeEvidenceStack } from './mode-resolve.js';
import {
  recordApplied, formatEffectiveModes, compositeModeSource,
  type AppliedMode, type ResolvedToken,
} from './design-context/resolved-token.js';

interface Node { name: string; valuesByMode: Record<string, unknown>; collectionId: string; fileKey: string; codeSyntaxWeb: string }
export interface Graph {
  byKey: Map<string, Node>; byLocal: Map<string, Node>;
  // Authored css name (extractCssName over codeSyntaxWeb) -> deduped lower-cased libKeys.
  // Keys are VERBATIM (CSS custom properties are case-sensitive; only the 40-hex identity
  // keys fold) - a folded name would merge --Brand with --brand and mint wrong uniqueness.
  byCssName: Map<string, string[]>;
  collDefaultMode: Map<string, string>;
  collModes: Map<string, { modeId: string; name: string }[]>;   // key = fileKey|collectionId
  collNames: Map<string, string>;                                // key = fileKey|collectionId
  collKeys: Map<string, string>;                                 // key = fileKey|collectionId (only non-empty)
}
export interface Lib {
  fileKey: string;
  vars: { library_key: string; local_id: string; collection_id: string; values_by_mode: Record<string, unknown>; name: string; resolved_type: string; code_syntax_web: string }[];
  colls: { collection_id: string; default_mode: string; modes: unknown; name?: string; key?: string }[];
}

export function buildGraphMaps(
  vars: { library_key: string; local_id: string; collection_id: string; values_by_mode: Record<string, unknown>; name: string; fileKey: string; code_syntax_web: string }[],
  colls: { collection_id: string; default_mode: string; modes?: { modeId: string; name: string }[]; name?: string; key?: string; fileKey: string }[],
): Graph {
  const byKey = new Map<string, Node>(), byLocal = new Map<string, Node>(), collDefaultMode = new Map<string, string>();
  const byCssName = new Map<string, string[]>();
  const collModes = new Map<string, { modeId: string; name: string }[]>();
  const collNames = new Map<string, string>();
  const collKeys = new Map<string, string>();
  for (const c of colls) {
    collDefaultMode.set(c.fileKey + '|' + c.collection_id, c.default_mode);
    if (c.modes) collModes.set(c.fileKey + '|' + c.collection_id, c.modes);
    if (c.name) collNames.set(c.fileKey + '|' + c.collection_id, c.name);
    // Joins against collectionLibKey's output, which is lower-cased — store lower-cased here
    // too so a mixed-case published key still matches (see collectionLibKey's comment).
    if (c.key) collKeys.set(c.fileKey + '|' + c.collection_id, c.key.toLowerCase());
  }
  for (const v of vars) {
    const node: Node = { name: v.name, valuesByMode: v.values_by_mode, collectionId: v.collection_id, fileKey: v.fileKey, codeSyntaxWeb: v.code_syntax_web };
    byLocal.set(v.fileKey + '|' + v.local_id, node);
    // Published keys are lower-hex; lower-case here so cross-library lookups (which
    // also lower-case the consumer's alias key, see extractLibraryKey) always join.
    if (v.library_key) {
      const lk = v.library_key.toLowerCase();
      byKey.set(lk, node);
      const css = extractCssName(v.code_syntax_web);
      if (css !== undefined) {
        const ids = byCssName.get(css) ?? [];
        if (!ids.includes(lk)) ids.push(lk); // dedup: duplicate team ids ingest a library twice
        byCssName.set(css, ids);
      }
    }
  }
  return { byKey, byLocal, byCssName, collDefaultMode, collModes, collNames, collKeys };
}

export function buildGraph(libs: Lib[]): Graph {
  return buildGraphMaps(
    libs.flatMap((lib) => lib.vars.map((v) => ({ ...v, fileKey: lib.fileKey }))),
    libs.flatMap((lib) => lib.colls.map((c) => ({
      collection_id: c.collection_id, default_mode: c.default_mode,
      modes: c.modes as { modeId: string; name: string }[] | undefined, name: c.name, key: c.key, fileKey: lib.fileKey,
    }))),
  );
}

// The 40-hex library key embedded in a collection id of the published/subscribed form
// "VariableCollectionId:<key>/<localId>" — the same library collection can appear under
// DIFFERENT local-id suffixes (the graph's own library-instance copy vs. a node's subscribed-
// instance reference), but the key (everything before the first "/") is always the same. For
// a plain local collection id ("VariableCollectionId:<localId>", no "/") this is just the id
// itself. Pure; used to match a node's explicitVariableModes entry to the graph's collection
// even when the full id strings differ (matched by library key across
// cross-library instances).
//
// Result is lower-cased: mixed-case 40-hex ids are observed live (uppercase `VariableID:` ids
// prompted extractLibraryKey to go case-insensitive; buildGraphMaps lower-cases library_key
// before every byKey insert for the same reason — see its comment). Every scan that joins on
// this key (pickModeForCollection / stackHasEntryForCollection, buildModeByCollection's
// seenLibKeys de-dupe in mode-resolve.ts, and the recordApplied dedup keys below) must compare
// normalized strings on both sides, so normalizing once here is enough as long as the OTHER
// side (collKeys, populated below) is also lower-cased — a case-mismatched pin/collection-key
// pair would otherwise silently fail the join and produce incorrect provenance
// this file exists to prevent (incident 2026-07-02).
const COLLECTION_ID_PREFIX = 'VariableCollectionId:';

export function collectionLibKey(collectionId: string): string {
  const rest = collectionId.startsWith(COLLECTION_ID_PREFIX) ? collectionId.slice(COLLECTION_ID_PREFIX.length) : collectionId;
  const slash = rest.indexOf('/');
  return (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
}

// Look up the mode picked for `collectionId` in `modeByCollection`, validated against `modes`
// (the collection's REAL modes — safety: never trust an unvalidated/unknown mode id).
// Tries an exact-string match first (works for both plain local ids and full published ids).
// If that misses (or is invalid), fall back to a linear scan for ANY stack entry whose library
// key matches — this is what lets a node's subscribed-instance collection id join the graph's
// library-instance copy of the same collection. For a published/subscribed id (has a "/") the
// scan key is embedded in the id itself. A plain (origin-file) id embeds no key of its own, so
// it only gets a scan when the caller supplies `publishedKey` (defensive fix: the
// collection's REST-published key, stored alongside it — see collKeys) — this is what lets a
// consumer's subscribed-form pin join an ORIGIN-file collection whose id is plain. Without a
// `publishedKey` a plain id gets no scan at all, exactly as before (avoids false positives: an
// unrelated stack entry could otherwise coincidentally collide with the id used as its own key).
function pickModeForCollection(
  collectionId: string, modes: { modeId: string; name: string }[], modeByCollection?: Map<string, string>,
  publishedKey?: string,
): string | undefined {
  if (!modeByCollection) return undefined;
  const exact = modeByCollection.get(collectionId);
  if (exact !== undefined) {
    // A present exact pin is TERMINAL: valid -> apply; invalid -> present-but-invalid —
    // never rescued by the published-key scan below (a farther same-key entry must not override
    // the nearest exact pin: on screen Figma already applied the unmappable pin -> default).
    return modes.some((m) => m.modeId === exact) ? exact : undefined;
  }
  // Scan key: '/'-form ids embed their collection's published key; a plain (origin-file) id
  // carries none, so use the key stored from REST variableCollections[].key (incident fix) —
  // same mode-membership validation either way.
  const scanKey = collectionId.includes('/') ? collectionLibKey(collectionId) : (publishedKey || undefined);
  if (scanKey === undefined) return undefined;
  for (const [entryId, modeId] of modeByCollection) {
    if (collectionLibKey(entryId) !== scanKey) continue;
    if (modes.some((m) => m.modeId === modeId)) return modeId;
  }
  return undefined;
}

// Whether the stack carries ANY entry for `collectionId` (exact id, or — for the published/
// subscribed "<key>/<localId>" form, or a plain id with a known `publishedKey` — any entry
// with the same library key), REGARDLESS of whether its mode id is valid. Used to distinguish
// the two reasons a multi-mode collection takes its default: ABSENT-from-stack
// (benign — its default genuinely renders on screen, so 'node' is honest under complete
// coverage) vs. PRESENT-but-invalid (an explicit mode we could not apply — on screen it uses
// that unmappable mode, so the default value may differ → never 'node', even under complete
// coverage). Mirrors pickModeForCollection's matching but skips mode validation.
function stackHasEntryForCollection(collectionId: string, modeByCollection?: Map<string, string>, publishedKey?: string): boolean {
  if (!modeByCollection) return false;
  if (modeByCollection.has(collectionId)) return true;
  const scanKey = collectionId.includes('/') ? collectionLibKey(collectionId) : (publishedKey || undefined);
  if (scanKey === undefined) return false;
  for (const entryId of modeByCollection.keys()) if (collectionLibKey(entryId) === scanKey) return true;
  return false;
}

function graphEvidenceForCollection(
  collectionId: string,
  evidence?: ModeEvidenceStack,
  publishedKey?: string,
) {
  if (!evidence) return undefined;
  const exact = evidence.get(collectionId);
  if (exact !== undefined) return exact;
  const scanKey = collectionId.includes('/') ? collectionLibKey(collectionId) : (publishedKey || undefined);
  if (scanKey === undefined) return undefined;
  for (const [entryId, item] of evidence) {
    if (collectionLibKey(entryId) === scanKey) return item;
  }
  return undefined;
}

function graphAxisEvidence(
  collectionId: string,
  modeId: string,
  modes: { modeId: string; name: string }[],
  modeByCollection: Map<string, string>,
  coverageComplete: boolean | undefined,
  evidence: ModeEvidenceStack | undefined,
  publishedKey?: string,
): Pick<AppliedMode, 'source' | 'nodeId'> {
  const hasStackEntry = stackHasEntryForCollection(collectionId, modeByCollection, publishedKey);
  const item = graphEvidenceForCollection(collectionId, evidence, publishedKey);
  if (hasStackEntry) {
    if (!modes.some((mode) => mode.modeId === modeId) || !item || item.modeId !== modeId) {
      return { source: 'unverifiable' };
    }
    return { source: item.source, nodeId: item.nodeId };
  }
  if (item !== undefined) return { source: 'unverifiable' };
  return { source: coverageComplete ? 'confirmed_default' : 'unverifiable' };
}

export interface Resolved { value?: string; name?: string; missingKey?: string }

export function resolveKey(g: Graph, key: string, hops = 0): Resolved {
  if (hops > 14) return {};
  const node = g.byKey.get(key.toLowerCase());
  if (!node) return { missingKey: key };
  return resolveNode(g, node, hops);
}

function resolveNode(g: Graph, node: Node, hops: number): Resolved {
  const mode = g.collDefaultMode.get(node.fileKey + '|' + node.collectionId);
  const val = (mode !== undefined && node.valuesByMode[mode] !== undefined) ? node.valuesByMode[mode] : Object.values(node.valuesByMode)[0];
  if (val && typeof val === 'object' && (val as { type?: string }).type === 'VARIABLE_ALIAS') {
    const id = (val as { id: string }).id;
    const k = extractLibraryKey(id);
    if (k) return resolveKey(g, k, hops + 1);                  // cross-library hop
    const local = g.byLocal.get(node.fileKey + '|' + id);      // within-library hop
    return local ? resolveNode(g, local, hops + 1) : {};
  }
  if (val && typeof val === 'object' && 'r' in (val as object)) return { value: rgbaToHex(val as RawColor), name: node.name };
  return { value: val === undefined || val === null ? undefined : String(val), name: node.name };
}

// Pick the mode to resolve a HOP TARGET in, given the mode inherited from the aliasing `source`.
// Priority: (1) a stack-confirmed mode for the target's OWN collection (via pickModeForCollection:
// exact id, else library-key match across subscribed-vs-library id instances — resolving the mode-validation
// risk — always validated against its real modes); (2) the inherited mode id ONLY when the
// target is in the SAME collection as the aliasing node (mode ids are shared there — within-
// collection alias, and the per-mode listing path); (3) the target's default mode. `fellBack` is
// true in case (3) for a MULTI-mode collection — i.e. an unconfirmed cross-collection hop, so a
// downstream 'node' label would be dishonest. A cross-collection hop with no confirmed stack
// entry NEVER trusts a coincidentally-equal mode id (two libraries can number modes identically),
// making the graph path exactly as conservative as the local path.
function pickTargetMode(
  g: Graph, source: Node, target: Node, inheritedModeId: string, modeByCollection?: Map<string, string>,
): { modeId: string; fellBack: boolean; invalidExplicit: boolean; source: 'node' | 'inherited' | 'default' } {
  const collKey = target.fileKey + '|' + target.collectionId;
  const modes = g.collModes.get(collKey) ?? [];
  const picked = pickModeForCollection(target.collectionId, modes, modeByCollection, g.collKeys.get(collKey));
  if (picked !== undefined) return { modeId: picked, fellBack: false, invalidExplicit: false, source: 'node' };
  const sameCollection = target.fileKey === source.fileKey && target.collectionId === source.collectionId;
  if (sameCollection && target.valuesByMode[inheritedModeId] !== undefined) return { modeId: inheritedModeId, fellBack: false, invalidExplicit: false, source: 'inherited' };
  const dm = g.collDefaultMode.get(collKey);
  const multi = modes.length > 1;
  // A multi-mode target that had a stack entry we could not validly apply defaulted for the UNSAFE
  // reason — the label must never be rescued to 'node' by complete coverage.
  const invalidExplicit = multi && stackHasEntryForCollection(target.collectionId, modeByCollection, g.collKeys.get(collKey));
  return { modeId: dm ?? Object.keys(target.valuesByMode)[0], fellBack: multi, invalidExplicit, source: 'default' };
}

// Resolve `node`'s value in `modeId`, following alias hops. At each cross-collection hop the
// target's mode is RE-PICKED for its own collection from `modeByCollection` (when provided),
// so a value taken from a target's default mode is never silently presented as the requested
// mode. `track.fellBack` records whether any hop had to fall back to a default (multi-mode)
// mode; `track.invalidExplicit` records the SUBSET of those fallbacks where the collection had an
// explicit (but unmappable) stack entry — never rescued to 'node' by coverage. The caller uses
// both to keep rendered-value evidence honest. `modeByCollection`/`track` are optional so best-effort callers
// (resolveKeyModes, which has no node stack) keep their prior behavior.
function resolveNodeInMode(
  g: Graph, node: Node, modeId: string, hops: number,
  modeByCollection?: Map<string, string>, track?: GraphModeTrack,
): string | undefined {
  if (hops > 14) return undefined;
  // Prefer the requested mode; if the (possibly alias-hopped) node's collection doesn't
  // define it, fall back to that node's OWN default mode before the last-resort first value.
  const dm = g.collDefaultMode.get(node.fileKey + '|' + node.collectionId);
  const val = node.valuesByMode[modeId]
    ?? (dm !== undefined ? node.valuesByMode[dm] : undefined)
    ?? Object.values(node.valuesByMode)[0];
  if (val && typeof val === 'object' && (val as { type?: string }).type === 'VARIABLE_ALIAS') {
    const id = (val as { id: string }).id;
    const k = extractLibraryKey(id);
    const target = k ? g.byKey.get(k.toLowerCase()) : g.byLocal.get(node.fileKey + '|' + id);
    if (!target) return undefined;
    const pick = pickTargetMode(g, node, target, modeId, modeByCollection);
    if (track) {
      if (pick.fellBack) track.fellBack = true;
      if (pick.invalidExplicit) track.invalidExplicit = true;
      if (pick.source === 'node') track.pinnedAxisUsed = true;
      if (track.applied && pick.source !== 'inherited') {
        const collKey = target.fileKey + '|' + target.collectionId;
        const tModes = g.collModes.get(collKey) ?? [];
        if (tModes.length > 1) recordApplied(track.applied, {
          key: target.fileKey + '|' + collectionLibKey(target.collectionId),
          collection: g.collNames.get(collKey) ?? target.collectionId,
          mode: tModes.find((m) => m.modeId === pick.modeId)?.name ?? pick.modeId,
          ...graphAxisEvidence(
            target.collectionId, pick.modeId, tModes, modeByCollection ?? new Map(),
            track.coverageComplete, track.evidence, g.collKeys.get(collKey),
          ),
        });
      }
    }
    return resolveNodeInMode(g, target, pick.modeId, hops + 1, modeByCollection, track);
  }
  if (val && typeof val === 'object' && 'r' in (val as object)) return rgbaToHex(val as RawColor);
  return val === undefined || val === null ? undefined : String(val);
}

type GraphModeTrack = {
  fellBack: boolean;
  invalidExplicit?: boolean;
  applied?: AppliedMode[];
  pinnedAxisUsed?: boolean;
  coverageComplete?: boolean;
  evidence?: ModeEvidenceStack;
};

export function resolveKeyInMode(
  g: Graph, key: string, modeByCollection: Map<string, string>, coverageComplete?: boolean,
  evidence?: ModeEvidenceStack,
): (ResolvedToken & { pinned_axis_used: boolean; unconfirmed_default_used: boolean }) | undefined {
  const node = g.byKey.get(key.toLowerCase());
  if (!node) return undefined;
  const modes = g.collModes.get(node.fileKey + '|' + node.collectionId) ?? [];
  const multi = modes.length > 1;
  const defaultMode = g.collDefaultMode.get(node.fileKey + '|' + node.collectionId);
  // The node's explicit mode for THIS variable's collection (by id) — matched by exact id first,
  // then by library key when the id is of the published/subscribed "<key>/<localId>"
  // form, so a node's subscribed-instance collection id still joins the graph's library-instance
  // copy of the same collection; also (defensive fix) by the collection's stored published
  // key when the id is plain, so a subscribed-form pin can join a plain-id ORIGIN collection.
  // Always validated against `modes`.
  const validPicked = pickModeForCollection(node.collectionId, modes, modeByCollection, g.collKeys.get(node.fileKey + '|' + node.collectionId));
  const modeId = validPicked ?? defaultMode ?? Object.keys(node.valuesByMode)[0];
  // Thread the node's per-collection mode map through the alias chain so a cross-collection hop
  // that cannot confirm its target's mode is recorded (track.fellBack / track.invalidExplicit).
  const track: GraphModeTrack = {
    fellBack: false, invalidExplicit: false, applied: [], pinnedAxisUsed: false,
    coverageComplete, evidence,
  };
  if (validPicked !== undefined) track.pinnedAxisUsed = true;
  if (multi) recordApplied(track.applied, {
    key: node.fileKey + '|' + collectionLibKey(node.collectionId),
    collection: g.collNames.get(node.fileKey + '|' + node.collectionId) ?? node.collectionId,
    mode: modes.find((m) => m.modeId === modeId)?.name ?? modeId,
    ...graphAxisEvidence(
      node.collectionId, modeId, modes, modeByCollection, coverageComplete, evidence,
      g.collKeys.get(node.fileKey + '|' + node.collectionId),
    ),
  });
  const value = resolveNodeInMode(g, node, modeId, 0, modeByCollection, track);
  if (value === undefined) return undefined;
  // Port-only accounting stays separate from the serialized evidence. Any axis sourced from an
  // explicit node or ancestor consumes a pin; any unverifiable axis records an unconfirmed default.
  // mode_context (spec (1)): unconditional port-level signal — present on BOTH branches (a
  // single-mode top can still consume a pin downstream); the tool must read it before its
  // mode_dependent-gated discard and never copy it onto the interned ResolvedToken.
  const pinned_axis_used = track.pinnedAxisUsed === true
    || track.applied?.some((a) => a.source === 'explicit_node' || a.source === 'ancestor_chain') === true;
  // mode_context (R1): mirrors resolveBoundVariableInMode's stats block — for a single-mode top,
  // usedMultiModeDefault === track.fellBack (a downstream multi-mode hop defaulted).
  const unconfirmed_default_used = track.applied?.some((a) => a.source === 'unverifiable') === true;
  // Emit the mode-aware object whenever the top or a downstream alias hop reached a multi-mode
  // collection. The default composite is resolved independently and remains diagnostic when the
  // effective evidence is unverifiable.
  const effectiveModes = formatEffectiveModes(track.applied);
  if (!effectiveModes) return { token: node.name, value, pinned_axis_used, unconfirmed_default_used };
  const defaultValue = resolveKey(g, key).value;
  if (defaultValue === undefined) return undefined;
  const effectiveModeSource = compositeModeSource(effectiveModes);
  const effectiveRenderedValue = effectiveModeSource === 'unverifiable' ? null : value;
  return {
    token: node.name,
    default_value: defaultValue,
    effective_rendered_value: effectiveRenderedValue,
    value: effectiveRenderedValue,
    effective_modes: effectiveModes,
    effective_mode_source: effectiveModeSource,
    mode_dependent: true,
    pinned_axis_used,
    unconfirmed_default_used,
  };
}

export function resolveKeyModes(
  g: Graph, key: string,
): { modesByName: Record<string, string>; modesById: Record<string, string>; collectionId: string; fileKey: string } | undefined {
  const node = g.byKey.get(key.toLowerCase());
  if (!node) return undefined;
  const modes = g.collModes.get(node.fileKey + '|' + node.collectionId);
  const modesByName: Record<string, string> = {}, modesById: Record<string, string> = {};
  for (const m of modes ?? []) {
    const hex = resolveNodeInMode(g, node, m.modeId, 0);
    if (hex !== undefined) { modesByName[m.name] = hex; modesById[m.modeId] = hex; }
  }
  return { modesByName, modesById, collectionId: node.collectionId, fileKey: node.fileKey };
}

// True when the variable's OWN (top) collection has >1 mode — mirrors resolveKeyInMode's `multi`,
// the exact condition under which a mode-dependent object is emitted. Counts modes by EXISTENCE,
// so (unlike resolveKeyModes, which drops a mode whose hex can't resolve) the needsAncestors gate
// stays precise even for a partial-sync collection with an unresolvable mode.
export function keyIsMultiMode(g: Graph, key: string): boolean {
  const node = g.byKey.get(key.toLowerCase());
  if (!node) return false;
  return (g.collModes.get(node.fileKey + '|' + node.collectionId)?.length ?? 0) > 1;
}


// ── codeSyntax evidence over the graph (graph-css-evidence line) ─────────────────────────────
// The gate rule (diff.ts D-branch) does not move; these primitives only widen what the merged
// CssTokenEvidence facade can answer for cross-library bindings.

/** The bound variable's own authored css name, by lower-cased published key. '' or an
 * unanchored authored string is NO evidence (extractCssName). */
export function graphAuthoredName(g: Graph, libKey: string): string | undefined {
  const node = g.byKey.get(libKey.toLowerCase());
  if (!node) return undefined;
  return extractCssName(node.codeSyntaxWeb);
}

/** Every library variable minting `cssName` (VERBATIM key), as lower-cased libKeys. */
export function graphIdsByCssName(g: Graph, cssName: string): string[] {
  return g.byCssName.get(cssName) ?? [];
}

export type GraphRef = { kind: 'key'; key: string } | { kind: 'local'; fileKey: string; id: string };
const refId = (r: GraphRef): string => (r.kind === 'key' ? 'k:' + r.key.toLowerCase() : 'l:' + r.fileKey + '|' + r.id);
const refNode = (g: Graph, r: GraphRef): Node | undefined =>
  r.kind === 'key' ? g.byKey.get(r.key.toLowerCase()) : g.byLocal.get(r.fileKey + '|' + r.id);

/**
 * TRI-STATE alias reachability (panel-locked): 'unknown' - a hop target absent from the
 * published-only projection (sync drops keyless variables, so holes are ROUTINE, not exotic)
 * or the budget exhausted - is NOT 'unrelated'. The caller may treat only a fully-walked
 * chain as evidence of non-relation; the positive-collision gate must never fire on an
 * incompletely-walked chain. Edges are scanned across ALL modes (a non-default-mode alias is
 * a real tier - resolveKey's default-mode pick must never be copied here). One budget, one
 * composite-ref visited set - no reset at any boundary.
 */
export function graphAliasWalk(g: Graph, from: GraphRef, to: GraphRef, budget = 24): 'related' | 'unrelated' | 'unknown' {
  const target = refId(to);
  if (refId(from) === target) return 'related';
  const seen = new Set<string>();
  let frontier: GraphRef[] = [from];
  let sawHole = false;
  for (let depth = 0; depth < budget && frontier.length; depth++) {
    const next: GraphRef[] = [];
    for (const ref of frontier) {
      const id = refId(ref);
      if (seen.has(id)) continue;
      seen.add(id);
      const node = refNode(g, ref);
      if (!node) { sawHole = true; continue; } // hole in the projection - cannot exclude relation
      for (const val of Object.values(node.valuesByMode)) {
        const alias = val as { type?: string; id?: string };
        if (alias?.type !== 'VARIABLE_ALIAS' || typeof alias.id !== 'string') continue;
        const k = extractLibraryKey(alias.id);
        const edgeRef: GraphRef = k !== null ? { kind: 'key', key: k } : { kind: 'local', fileKey: node.fileKey, id: alias.id };
        // The EDGE's identity counts even when its node is absent - an alias pointing AT the
        // target is a relation regardless of whether the target row itself was synced.
        if (refId(edgeRef) === target) return 'related';
        next.push(edgeRef);
      }
    }
    frontier = next;
  }
  if (frontier.length) sawHole = true; // budget exhausted with unexplored refs
  return sawHole ? 'unknown' : 'unrelated';
}

/** Scoped evidence view for the merged facade. The MINTER population is limited to the
 * libraries the compared subtree actually references (referencedKeys -> their fileKeys) -
 * tenant-wide uniqueness would collide the commonest DS names across unrelated brands - and
 * EXCLUDES the compared file itself (excludeFileKey): when the compared file is a registered
 * library, the local index IS that file, fresher and complete; keeping its graph copy would
 * mint twin identities for every variable (evidence lost or a self-collision gate). The alias
 * WALK stays unscoped - relatedness is a property of the wiring, not of the minter set. */
export interface GraphCssView {
  authoredNameOf(libKey: string): string | undefined;
  idsByCssName(cssName: string): string[];
  aliasWalk(fromKey: string, toKey: string, budget?: number): 'related' | 'unrelated' | 'unknown';
}
export function graphCssEvidenceView(g: Graph, referencedKeys: string[], excludeFileKey?: string): GraphCssView {
  // Transitive scope (v2 addendum #4, the 'plus files reached during alias walks' clause): a
  // referenced variable's alias chain legitimately pulls its TARGET libraries into play - a
  // minter living in a transitively-reached file must be able to collide. Bounded BFS over the
  // same all-modes edges the walk uses; the compared file stays excluded throughout.
  const allowedFiles = new Set<string>();
  const seenRefs = new Set<string>();
  let frontier: GraphRef[] = referencedKeys.map((k) => ({ kind: 'key', key: k }));
  for (let depth = 0; depth < 24 && frontier.length; depth++) {
    const next: GraphRef[] = [];
    for (const ref of frontier) {
      const rid = refId(ref);
      if (seenRefs.has(rid)) continue;
      seenRefs.add(rid);
      const node = refNode(g, ref);
      if (!node) continue;
      if (node.fileKey !== excludeFileKey) allowedFiles.add(node.fileKey);
      for (const val of Object.values(node.valuesByMode)) {
        const alias = val as { type?: string; id?: string };
        if (alias?.type !== 'VARIABLE_ALIAS' || typeof alias.id !== 'string') continue;
        const k = extractLibraryKey(alias.id);
        next.push(k !== null ? { kind: 'key', key: k } : { kind: 'local', fileKey: node.fileKey, id: alias.id });
      }
    }
    frontier = next;
  }
  const admits = (libKey: string): boolean => {
    const node = g.byKey.get(libKey.toLowerCase());
    return node !== undefined && node.fileKey !== excludeFileKey && allowedFiles.has(node.fileKey);
  };
  return {
    authoredNameOf: (libKey) => (admits(libKey) ? graphAuthoredName(g, libKey) : undefined),
    idsByCssName: (cssName) => graphIdsByCssName(g, cssName).filter(admits),
    aliasWalk: (fromKey, toKey, budget) => graphAliasWalk(g, { kind: 'key', key: fromKey }, { kind: 'key', key: toKey }, budget),
  };
}
