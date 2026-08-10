// mcp-server/src/domain/variables.ts
// Parses GET /variables/local into (a) an index for resolving node boundVariables
// to token names, and (b) a flat token list for the get_variables tool. Values are
// shown for each collection's default mode; one alias hop is resolved.
import type { RawVariablesResponse, RawVariable, RawVariableAlias, RawVariableValue, RawColor, RawSceneNode } from './figma-raw.js';
import { rgbaToHex } from './design-context/color.js';
import type { ModeStack } from './mode-resolve.js';
import { effectiveMode } from './mode-resolve.js';
import { recordApplied, formatModesApplied, type AppliedMode, type ResolvedToken } from './design-context/resolved-token.js';

export interface VariableIndex {
  byId: Map<string, RawVariable>;
  defaultModeByCollection: Map<string, string>;
  collectionName: Map<string, string>;
  collectionModes: Map<string, { modeId: string; name: string }[]>;
}

export interface Token {
  name: string;
  type: RawVariable['resolvedType'];
  value: string | number | boolean | null;
  /** True when the default value is a variable alias we could not resolve — the target is outside this file's local set (typically an external library variable). Figma's REST API does not expose its value; use the token name. */
  alias?: boolean;
  /** The unresolved alias target id (e.g. "VariableID:<hash>/<id>"), present only when alias is true. */
  alias_of?: string;
  /** How the value was resolved: 'local' (defined/aliased within this file), or — for external aliases resolved via an injected resolver — 'graph' (headless library graph) or 'snapshot' (plugin upload). */
  resolved_via?: 'local' | 'snapshot' | 'graph';
  /** Present when resolved cross-library: identifies the source library (graph path: the source node's fileKey). */
  source_library?: string;
  collection: string;
  /** Mode NAME -> resolved value, present only when the owning collection has more than one mode. */
  modes?: Record<string, string | number | boolean>;
  /** True when `modes` is present (i.e. the token's value can differ by mode). */
  mode_dependent?: boolean;
}

function isAlias(v: RawVariableValue): v is RawVariableAlias {
  return typeof v === 'object' && v !== null && (v as RawVariableAlias).type === 'VARIABLE_ALIAS';
}
function isColor(v: RawVariableValue): v is RawColor {
  return typeof v === 'object' && v !== null && 'r' in v && 'g' in v && 'b' in v;
}

export function buildVariableIndex(resp: RawVariablesResponse): VariableIndex {
  const byId = new Map<string, RawVariable>();
  const defaultModeByCollection = new Map<string, string>();
  const collectionName = new Map<string, string>();
  const collectionModes = new Map<string, { modeId: string; name: string }[]>();
  const meta = resp.meta;
  if (meta) {
    for (const v of Object.values(meta.variables)) byId.set(v.id, v);
    for (const c of Object.values(meta.variableCollections)) {
      defaultModeByCollection.set(c.id, c.defaultModeId);
      collectionName.set(c.id, c.name);
      collectionModes.set(c.id, c.modes);
    }
  }
  return { byId, defaultModeByCollection, collectionName, collectionModes };
}

/** The alias id a node binds to a given property key (first entry if it's a list), or null. */
export function boundVariableId(
  boundVariables: Record<string, RawVariableAlias | RawVariableAlias[]> | undefined,
  key: string,
): string | null {
  const binding = boundVariables?.[key];
  if (!binding) return null;
  const alias = Array.isArray(binding) ? binding[0] : binding;
  return alias?.id ?? null;
}

export function resolveBoundVariable(
  boundVariables: Record<string, RawVariableAlias | RawVariableAlias[]> | undefined,
  key: string,
  idx: VariableIndex,
): string | null {
  const id = boundVariableId(boundVariables, key);
  if (id === null) return null;
  const v = idx.byId.get(id);
  return v ? v.name : null;
}

/** Resolve a node's LOCAL bound variable to a ResolvedToken in the node's effective mode.
 * null when the binding's variable is not in the local index (try the cross-library path).
 * `coverageComplete` (whether the node's full ancestor chain was discovered) drives the
 * honest-label logic: a multi-mode collection that took its default because it was ABSENT
 * from the stack genuinely renders that default on screen when coverage is complete, so the
 * composite equals on-screen → mode_source:'node'; under incomplete coverage an unseen ancestor
 * could override it → 'default'. */
export function resolveBoundVariableInMode(
  boundVariables: Record<string, RawVariableAlias | RawVariableAlias[]> | undefined,
  key: string, idx: VariableIndex, stack: ModeStack, coverageComplete?: boolean,
  stats?: { pinnedAxisUsed: boolean; unconfirmedDefaultUsed: boolean },
): ResolvedToken | null {
  const id = boundVariableId(boundVariables, key);
  if (id === null) return null;
  const v = idx.byId.get(id);
  if (!v) return null;
  const modes = idx.collectionModes.get(v.variableCollectionId) ?? [];
  const multi = modes.length > 1;
  const eff = effectiveMode(stack, v.variableCollectionId, idx.defaultModeByCollection.get(v.variableCollectionId));
  const modeId = eff?.modeId ?? idx.defaultModeByCollection.get(v.variableCollectionId) ?? Object.keys(v.valuesByMode)[0];
  // Track whether resolving the value needed an alias hop that fell back to a target's default
  // mode (on a multi-mode target collection). If so, the value shown is a default-mode value and
  // mode_source must be honest ('default') unless coverage is complete (see below). `invalidExplicit`
  // (a DOWNSTREAM hop whose target had a stack entry it could not validly apply) mirrors the graph
  // path's `track.invalidExplicit` and is never rescued to 'node'.
  const track = { fellBack: false, invalidExplicit: false, applied: [] as AppliedMode[] };
  if (multi) recordApplied(track.applied, {
    key: v.variableCollectionId,
    collection: idx.collectionName.get(v.variableCollectionId) ?? '',
    mode: modes.find((m) => m.modeId === modeId)?.name ?? '',
    source: eff?.source === 'node' && modes.some((m) => m.modeId === eff.modeId) ? 'node' : 'default',
  });
  const value = resolveInMode(v, modeId, idx, 0, track, stack);
  if (value === null) return null;
  const modeName = modes.find((m) => m.modeId === modeId)?.name;
  // `usedMultiModeDefault` = a multi-mode collection took its default rather than a
  // stack-confirmed mode (a hop fell back — track.fellBack — OR the TOP collection was absent from
  // the stack — eff.source !== 'node'). No multi-mode default → 'node' regardless of coverage.
  // Some multi-mode default under COMPLETE coverage → the absent collection genuinely defaults on
  // screen → 'node'; under incomplete coverage → 'default'. Residual: an explicit mode that is
  // present but NOT a real mode of the collection means the value fell back to the default — never
  // trust that as 'node', even under complete coverage. This holds for the TOP collection
  // (effectiveMode does not validate) AND for any DOWNSTREAM hop (track.invalidExplicit).
  const invalidExplicit = (eff?.source === 'node' && !modes.some((m) => m.modeId === eff.modeId)) || track.invalidExplicit;
  const usedMultiModeDefault = track.fellBack || (multi && eff?.source !== 'node');
  // mode_context (spec (1)): out-of-band pin-consumption signal — set unconditionally (NOT gated
  // on `multi`: a single-mode top can consume a pin on a downstream hop) and never placed on the
  // returned token (globalVars dedup keys on JSON.stringify).
  if (stats) {
    if (track.applied.some((a) => a.source === 'node')) stats.pinnedAxisUsed = true;
    // mode_context (R1): some multi-mode axis (top OR downstream hop — incl. under a single-mode
    // top) took its default WITHOUT confirmed coverage, or an invalid explicit pin was skipped.
    // "No pins anywhere" is then NOT positive knowledge for this chain — the marker must not fire.
    if (invalidExplicit || (usedMultiModeDefault && !coverageComplete)) stats.unconfirmedDefaultUsed = true;
  }
  const mode_source: 'node' | 'default' =
    !invalidExplicit && (!usedMultiModeDefault || coverageComplete) ? 'node' : 'default';
  const applied = formatModesApplied(track.applied);
  // Emit mode fields when the collection is multi-mode OR a DOWNSTREAM multi-mode hop fell back
  // (`track.fellBack`): a single-mode-top SEMANTIC token that aliases a multi-mode PRIMITIVE is
  // genuinely mode-dependent (the downstream palette repaints it by theme), so the returned token
  // must carry mode_dependent/mode_source — otherwise colorVerdict group B cannot gate it and a
  // legitimate default-mode color false-red's as a group-C hex divergence (Finding-1). mode_source
  // is already computed honestly above (default under incomplete coverage, node when complete).
  return {
    token: v.name, value,
    ...((multi || track.fellBack) ? { mode: modeName, mode_dependent: true, mode_source, ...(applied ? { modes_applied: applied } : {}) } : {}),
  };
}

type Resolved = { value: string | number | boolean } | { aliasOf: string };

// Resolve a variable's default-mode value, following aliases WITHIN this file.
// Returns { aliasOf } (honest "unresolved") when the target isn't in the local set
// (external library variable — Figma REST doesn't expose it) or the chain is too deep.
function resolveDefault(v: RawVariable, idx: VariableIndex, hops = 0): Resolved {
  const mode = idx.defaultModeByCollection.get(v.variableCollectionId);
  const raw = (mode && v.valuesByMode[mode]) ?? Object.values(v.valuesByMode)[0];
  if (isAlias(raw)) {
    if (hops > 4) return { aliasOf: raw.id };
    const target = idx.byId.get(raw.id);
    return target ? resolveDefault(target, idx, hops + 1) : { aliasOf: raw.id };
  }
  if (isColor(raw)) return { value: rgbaToHex(raw) };
  return { value: raw as string | number | boolean };
}

// Pick the mode to resolve a hop TARGET in, mirroring the graph path's `pickTargetMode` but over
// the LOCAL VariableIndex — in-file collection ids are exact/consistent, so a plain exact-id stack
// lookup suffices (no library-key fallback). Priority:
//   (1) a VALID stack-confirmed mode for the target's OWN collection — this is what pins a
//       downstream multi-mode collection to its true on-screen mode (fixes the C1 value regression);
//   (2) the inherited mode id — trusted within the SAME collection (mode ids are shared there), and,
//       in the legacy NO-STACK best-effort path (resolveAllModes), for any target that defines it
//       (preserves prior default-on-miss behavior; the stack-driven path stays graph-symmetric);
//   (3) the target's default mode. `fellBack` is true in case (3) for a MULTI-mode target (an
//       unconfirmed cross-collection default — a downstream 'node' label would be dishonest).
//       `invalidExplicit` is the SUBSET of (3) where the stack DID carry an entry for the target
//       collection but its mode was invalid/unmappable — never rescued to 'node'.
function pickTargetModeLocal(
  source: RawVariable, target: RawVariable, inheritedModeId: string, idx: VariableIndex, stack?: ModeStack,
): { modeId: string; fellBack: boolean; invalidExplicit: boolean; source: 'node' | 'inherited' | 'default' } {
  const modes = idx.collectionModes.get(target.variableCollectionId) ?? [];
  const stackMode = stack?.get(target.variableCollectionId);
  if (stackMode !== undefined && modes.some((m) => m.modeId === stackMode)) {
    return { modeId: stackMode, fellBack: false, invalidExplicit: false, source: 'node' };
  }
  const sameCollection = target.variableCollectionId === source.variableCollectionId;
  if ((sameCollection || stack === undefined) && target.valuesByMode[inheritedModeId] !== undefined) {
    return { modeId: inheritedModeId, fellBack: false, invalidExplicit: false, source: 'inherited' };
  }
  const dm = idx.defaultModeByCollection.get(target.variableCollectionId);
  const multi = modes.length > 1;
  const invalidExplicit = multi && stackMode !== undefined; // present in the stack but not a real mode
  return { modeId: dm ?? Object.keys(target.valuesByMode)[0], fellBack: multi, invalidExplicit, source: 'default' };
}

/** Resolve a single mode's value to a scalar/hex, following within-file aliases. At each
 * cross-collection alias hop the target's mode is RE-PICKED for its own collection from `stack`
 * (when provided) — symmetric with the graph path's `resolveNodeInMode` — so a downstream
 * collection validly pinned to a non-default mode resolves to its on-screen value rather than the
 * target default. `stack`/`track` are optional so best-effort callers (resolveAllModes, no stack)
 * keep their prior default-on-miss behavior; `track.fellBack`/`track.invalidExplicit` let the caller
 * keep mode_source honest. */
export function resolveInMode(
  v: RawVariable, modeId: string, idx: VariableIndex, hops = 0,
  track?: { fellBack: boolean; invalidExplicit?: boolean; applied?: AppliedMode[] }, stack?: ModeStack,
): string | number | boolean | null {
  const raw = v.valuesByMode[modeId] ?? v.valuesByMode[idx.defaultModeByCollection.get(v.variableCollectionId) ?? ''];
  if (raw === undefined) return null;
  if (isAlias(raw)) {
    if (hops > 4) return null;
    const target = idx.byId.get(raw.id);
    if (!target) return null;
    const pick = pickTargetModeLocal(v, target, modeId, idx, stack);
    if (track) {
      if (pick.fellBack) track.fellBack = true;
      if (pick.invalidExplicit) track.invalidExplicit = true;
      if (track.applied && pick.source !== 'inherited') {
        const tModes = idx.collectionModes.get(target.variableCollectionId) ?? [];
        if (tModes.length > 1) recordApplied(track.applied, {
          key: target.variableCollectionId,
          collection: idx.collectionName.get(target.variableCollectionId) ?? '',
          mode: tModes.find((m) => m.modeId === pick.modeId)?.name ?? '',
          source: pick.source,
        });
      }
    }
    return resolveInMode(target, pick.modeId, idx, hops + 1, track, stack);
  }
  if (isColor(raw)) return rgbaToHex(raw);
  return raw as string | number | boolean;
}

/** Per-mode value map (mode NAME -> value) for a multi-mode collection; null when single-mode. */
export function resolveAllModes(
  v: RawVariable, idx: VariableIndex,
): { modes: Record<string, string | number | boolean>; mode_dependent: boolean } | null {
  const modes = idx.collectionModes.get(v.variableCollectionId);
  if (!modes || modes.length <= 1) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const m of modes) {
    const val = resolveInMode(v, m.modeId, idx);
    if (val !== null) out[m.name] = val;
  }
  return Object.keys(out).length ? { modes: out, mode_dependent: true } : null;
}

export type ResolveHit = {
  value: string | number | boolean;
  resolved_via?: 'snapshot' | 'graph';
  source_library?: string;
  modes?: Record<string, string | number | boolean>;
};

function emitToken(
  v: RawVariable,
  idx: VariableIndex,
  resolve?: (subscribedId: string) => ResolveHit | string | undefined,
): Token {
  const base = { name: v.name, type: v.resolvedType, collection: idx.collectionName.get(v.variableCollectionId) ?? '' };
  const r = resolveDefault(v, idx);
  if ('aliasOf' in r) {
    const hit = resolve?.(r.aliasOf);
    if (hit !== undefined) {
      // Back-compat: a resolver may return a bare value or a structured hit.
      const h: ResolveHit = typeof hit === 'object' ? hit : { value: hit };
      // The graph/snapshot transport stringifies numbers/booleans; coerce back using the
      // consuming variable's known resolvedType so a FLOAT is 18 (number), not "18" (string).
      let value: string | number | boolean = h.value;
      if (v.resolvedType === 'FLOAT' && typeof value === 'string') {
        const n = Number(value);
        if (!Number.isNaN(n)) value = n;
      } else if (v.resolvedType === 'BOOLEAN' && typeof value === 'string') {
        value = value === 'true';
      }
      return {
        ...base,
        value,
        resolved_via: h.resolved_via ?? 'snapshot',
        source_library: h.source_library,
        ...(h.modes ? { modes: h.modes, mode_dependent: true } : {}),
      };
    }
    return { ...base, value: null, alias: true, alias_of: r.aliasOf };
  }
  // Resolved within this file (direct value or local alias hop).
  const localModes = resolveAllModes(v, idx);
  return { ...base, value: r.value, resolved_via: 'local', ...(localModes ?? {}) };
}

export function listTokens(
  resp: RawVariablesResponse,
  resolve?: (subscribedId: string) => ResolveHit | string | undefined,
): Token[] {
  const idx = buildVariableIndex(resp);
  return [...idx.byId.values()].map((v) => emitToken(v, idx, resolve)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Like listTokens, but only emits tokens whose underlying variable id is in `ids` — the
 * node-scoped analogue of Figma's get_variable_defs (see collectNodeVariableIds). */
export function listTokensForIds(
  resp: RawVariablesResponse,
  ids: Set<string>,
  resolve?: (subscribedId: string) => ResolveHit | string | undefined,
): Token[] {
  const idx = buildVariableIndex(resp);
  const tokens: Token[] = [];
  for (const v of idx.byId.values()) if (ids.has(v.id)) tokens.push(emitToken(v, idx, resolve));
  return tokens.sort((a, b) => a.name.localeCompare(b.name));
}

/** Collect every variable id a node subtree binds — node-level boundVariables (all property
 * keys, single or array), fill/stroke paint bindings, and gradient-stop color bindings. */
export function collectNodeVariableIds(root: RawSceneNode): Set<string> {
  const ids = new Set<string>();
  const add = (bv?: Record<string, RawVariableAlias | RawVariableAlias[]>) => {
    if (!bv) return;
    for (const binding of Object.values(bv)) {
      for (const a of Array.isArray(binding) ? binding : [binding]) {
        if (a?.id) ids.add(a.id);
      }
    }
  };
  const walk = (n: RawSceneNode) => {
    add(n.boundVariables);
    for (const p of [...(n.fills ?? []), ...(n.strokes ?? [])]) {
      add(p.boundVariables);
      for (const stop of p.gradientStops ?? []) {
        if (stop.boundVariables?.color?.id) ids.add(stop.boundVariables.color.id);
      }
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return ids;
}

// ── codeSyntax evidence (semantic-confirm v3) ────────────────────────────────────────────────
// The authored Figma-name -> CSS-custom-property mapping, per variable. codeSyntax.WEB is free
// text with no validation; extraction is ANCHORED to the whole string (bare `--x` or a single
// `var(--x)` / `var(--x, fallback)`) — an unanchored substring scan minted phantom evidence out
// of BEM/SCSS/JS-path strings (`$btn--primary` -> `--primary`), and every phantom fed an
// always-gating branch. Anything else, including multi-var strings, is NO evidence.
const CSS_NAME_BARE = /^\s*(--[A-Za-z0-9_-]+)\s*$/;
// Fallback allows ONE level of balanced parens (`var(--x, rgb(0,0,0))` is an ordinary authored
// value) but still rejects a second var()/any deeper nesting — multi-var strings stay no-evidence.
const CSS_NAME_VAR = /^\s*var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,(?:[^()]|\((?:[^()]*)\))*)?\)\s*$/;
export function extractCssName(web: string | undefined): string | undefined {
  if (!web) return undefined;
  const m = CSS_NAME_BARE.exec(web) ?? CSS_NAME_VAR.exec(web);
  return m?.[1];
}

/**
 * Evidence lookups for the diff's D-branch (positive-collision gating). All three answers come
 * from the local variable index:
 * - nameOf: the BOUND variable's own authored css name (undefined = no evidence);
 * - idsByName: every variable minting that css name (length!==1 = ambiguous = no evidence);
 * - aliasRelation: TRI-STATE reachability through valuesByMode alias chains (any mode, both
 *   directions, depth-capped). 'unknown' — a hop target missing from the population or an
 *   exhausted budget — is NEITHER related NOR unrelated: the PASS quantifier demands PROVEN
 *   'related' for every co-minter, the gate demands PROVEN 'unrelated' for every minter, and
 *   unknown always falls to the legacy rule. A boolean here once turned an unwalkable
 *   co-minter into a green pass (release-verification catch).
 */
export type AliasRelation = 'related' | 'unrelated' | 'unknown';
export interface CssTokenEvidence {
  nameOf(variableId: string): string | undefined;
  idsByName(cssName: string): string[];
  aliasRelation(a: string, b: string): AliasRelation;
}

const ALIAS_WALK_CAP = 8;
export function buildCssEvidence(idx: VariableIndex): CssTokenEvidence {
  const nameOf = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const v of idx.byId.values()) {
    const n = extractCssName(v.codeSyntax?.WEB);
    if (n === undefined) continue;
    nameOf.set(v.id, n);
    byName.set(n, [...(byName.get(n) ?? []), v.id]);
  }
  const reaches = (from: string, to: string): AliasRelation => {
    const seen = new Set<string>();
    let frontier = [from];
    let sawHole = false;
    for (let depth = 0; depth < ALIAS_WALK_CAP && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const v = idx.byId.get(id);
        if (!v) { sawHole = true; continue; } // target outside the index (a published id) - cannot exclude
        for (const val of Object.values(v.valuesByMode)) {
          const alias = (val as { type?: string; id?: string });
          if (alias?.type === 'VARIABLE_ALIAS' && typeof alias.id === 'string') {
            if (alias.id === to) return 'related';
            next.push(alias.id);
          }
        }
      }
      frontier = next;
    }
    if (frontier.length) sawHole = true;
    return sawHole ? 'unknown' : 'unrelated';
  };
  return {
    nameOf: (id) => nameOf.get(id),
    idsByName: (n) => byName.get(n) ?? [],
    aliasRelation: (a, b) => {
      if (a === b) return 'related';
      const fwd = reaches(a, b);
      if (fwd === 'related') return 'related';
      const back = reaches(b, a);
      if (back === 'related') return 'related';
      return fwd === 'unknown' || back === 'unknown' ? 'unknown' : 'unrelated';
    },
  };
}
