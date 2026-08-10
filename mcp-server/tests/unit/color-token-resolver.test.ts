// The shared color-token resolver factory: the empty-name producers (panel-found — the graph and
// snapshot name columns are NOT NULL DEFAULT '', so `?? libKey` never fired and an EMPTY token
// name leaked into rows, degrading confirm_token grouping which keys on truthy r.token).
import { describe, it, expect } from 'vitest';
import { makeColorTokenResolver } from '../../src/adapters/driving/tools/color-token-resolver.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

const LIBKEY = 'a'.repeat(40);
const boundNode = (aliasId: string): RawSceneNode => ({
  id: '1:1', name: 'n', type: 'FRAME',
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: aliasId } } }],
} as RawSceneNode);
const stacks = { stackFor: () => new Map<string, string>(), graphStackFor: () => new Map<string, string>(), coverageComplete: false };

describe('empty-name producers fall back to the library key', () => {
  it('snapshot tail: name "" (NOT NULL DEFAULT) → token is the libKey, never empty', () => {
    const resolve = makeColorTokenResolver({ ...stacks,
      snapHits: new Map([[LIBKEY, { value: '#123456', name: '' }]]) });
    const t = resolve(boundNode(`VariableID:${LIBKEY}/1:2`), 'fills');
    expect(t?.token).toBe(LIBKEY);
    expect(t?.snapshot_default).toBe(true);
  });
  it('graph tail: token "" → libKey', () => {
    const resolve = makeColorTokenResolver({ ...stacks,
      variableGraph: {
        resolve: () => undefined,
        resolveInMode: () => ({ token: '', value: '#123456', mode_dependent: false, mode_source: 'default' as const, pinned_axis_used: false, unconfirmed_default_used: false }),
      } });
    const t = resolve(boundNode(`VariableID:${LIBKEY}/1:2`), 'fills');
    expect(t?.token).toBe(LIBKEY);
  });
});

// ── merged codeSyntax evidence (graph-css-evidence line) ──
import { buildMergedCssEvidence } from '../../src/adapters/driving/tools/color-token-resolver.js';
import { buildVariableIndex } from '../../src/domain/variables.js';
import { buildGraph, graphCssEvidenceView } from '../../src/domain/variable-graph.js';

const KA = 'a'.repeat(40), KB = 'b'.repeat(40);
const IDX = buildVariableIndex({
  meta: {
    variableCollections: { VC: { id: 'VC', name: 'C', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'M' }] } },
    variables: {
      'V:1': { id: 'V:1', name: 'local/x', resolvedType: 'COLOR', variableCollectionId: 'VC',
        valuesByMode: { m: { r: 1, g: 1, b: 1 } }, codeSyntax: { WEB: '--app-x' } },
      // local semantic tier aliasing the library primitive KA - the BRIDGE population
      'V:2': { id: 'V:2', name: 'local/alias', resolvedType: 'COLOR', variableCollectionId: 'VC',
        valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: `VariableID:${KA}/1:1` } }, codeSyntax: {} },
    },
  },
} as never);
const GRAPH = buildGraph([{
  fileKey: 'LIB',
  vars: [
    { library_key: KA, local_id: 'V:1', collection_id: 'C1', name: 'ds/primary', resolved_type: 'COLOR',
      values_by_mode: { m1: { r: 1, g: 0, b: 0 } }, code_syntax_web: 'var(--ds-primary)' },
    { library_key: KB, local_id: 'V:2', collection_id: 'C1', name: 'ds/other', resolved_type: 'COLOR',
      values_by_mode: { m1: { r: 0, g: 1, b: 0 } }, code_syntax_web: '--ds-other' },
  ],
  colls: [{ collection_id: 'C1', default_mode: 'm1', modes: [{ modeId: 'm1', name: 'Only' }] }],
}]);
const VIEW = graphCssEvidenceView(GRAPH, [KA, KB]);

describe('buildMergedCssEvidence', () => {
  it('canon at every edge: a RAW slash-form boundVarId resolves its authored name via the graph', () => {
    const ev = buildMergedCssEvidence(IDX, VIEW);
    expect(ev.nameOf(`VariableID:${KA}/1:1`)).toBe('--ds-primary');
    expect(ev.nameOf('V:1')).toBe('--app-x');
  });
  it('idsByName spans both populations with canonical ids', () => {
    const ev = buildMergedCssEvidence(IDX, VIEW);
    expect(ev.idsByName('--ds-other')).toEqual(['key:' + KB]);
    expect(ev.idsByName('--app-x')).toEqual(['V:1']);
  });
  it('THE BRIDGE: a local variable aliasing a published primitive is related to it across the boundary', () => {
    const ev = buildMergedCssEvidence(IDX, VIEW);
    expect(ev.aliasRelation('V:2', `VariableID:${KA}/1:1`)).toBe('related');
    expect(ev.aliasRelation(`VariableID:${KA}/1:1`, 'V:2')).toBe('related'); // either argument order
  });
  it('fully-visible unrelated pair stays unrelated (the gate may fire)', () => {
    const ev = buildMergedCssEvidence(IDX, VIEW);
    expect(ev.aliasRelation('V:1', `VariableID:${KB}/2:2`)).toBe('unrelated');
  });
  it('a cross-boundary edge with NO graph half wired is "cannot exclude", never unrelated', () => {
    const ev = buildMergedCssEvidence(IDX, undefined);
    expect(ev.aliasRelation('V:2', `VariableID:${KA}/1:1`)).toBe('related');
  });
  it('scoping: a minter from a NON-referenced library is invisible to idsByName', () => {
    const scoped = graphCssEvidenceView(GRAPH, [KA]); // KB's file referenced only via KA... same file here
    const other = buildGraph([{ fileKey: 'OTHERLIB', vars: [
      { library_key: 'c'.repeat(40), local_id: 'V:9', collection_id: 'CX', name: 'other/x', resolved_type: 'COLOR',
        values_by_mode: { m: { r: 0, g: 0, b: 0 } }, code_syntax_web: '--ds-primary' }],
      colls: [{ collection_id: 'CX', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] }]);
    const unreferenced = graphCssEvidenceView(other, [KA]); // KA not in this graph -> no allowed files
    expect(unreferenced.idsByCssName('--ds-primary')).toEqual([]);
    expect(scoped.idsByCssName('--ds-primary')).toEqual([KA]);
  });
  it('self-file exclusion: the compared file\'s own graph copy mints nothing', () => {
    const view = graphCssEvidenceView(GRAPH, [KA, KB], 'LIB');
    expect(view.idsByCssName('--ds-primary')).toEqual([]);
    expect(view.authoredNameOf(KA)).toBeUndefined();
  });
});

// ── alias-minter collapse (live-measured on the flagship DS: 561 names minted by TWO
// libraries at once, 523 of the twins being ALIASES of the same logical token — without the
// collapse, uniqueness silences the evidence on exactly the highest-traffic names). Minters
// PROVEN pairwise alias-related (tri-state 'related' only) count as ONE logical minter;
// an 'unknown' relation never merges — ambiguity stays honest silence.
describe('buildMergedCssEvidence — alias-related minters collapse to one', () => {
  const KC = 'c'.repeat(40), KD = 'd'.repeat(40), KE = 'e'.repeat(40);
  const twoLibGraph = buildGraph([
    { fileKey: 'COLOR', vars: [
      { library_key: KC, local_id: 'V:1', collection_id: 'CC', name: 'bg/x', resolved_type: 'COLOR',
        values_by_mode: { m: { r: 1, g: 1, b: 1 } }, code_syntax_web: '--ds-x' }],
      colls: [{ collection_id: 'CC', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] },
    { fileKey: 'UIKIT', vars: [
      // the twin: same authored name, ALIASES the COLOR variable
      { library_key: KD, local_id: 'V:2', collection_id: 'CU', name: 'bg/x', resolved_type: 'COLOR',
        values_by_mode: { m: { type: 'VARIABLE_ALIAS', id: `VariableID:${KC}/1:1` } }, code_syntax_web: '--ds-x' },
      // an UNRELATED variable minting a different name (control)
      { library_key: KE, local_id: 'V:3', collection_id: 'CU', name: 'bg/y', resolved_type: 'COLOR',
        values_by_mode: { m: { r: 0, g: 0, b: 0 } }, code_syntax_web: '--ds-y' }],
      colls: [{ collection_id: 'CU', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] },
  ]);
  const emptyIdx = buildVariableIndex({ meta: { variables: {}, variableCollections: {} } } as never);
  const view2 = graphCssEvidenceView(twoLibGraph, [KC, KD, KE]);

  it('twin minters stay RAW in idsByName (no collapse, no representative — order independence), and both are alias-related to the origin', () => {
    const ev = buildMergedCssEvidence(emptyIdx, view2);
    expect(ev.idsByName('--ds-x')).toHaveLength(2);
    const [m1, m2] = ev.idsByName('--ds-x');
    expect(ev.aliasRelation(m1, 'key:' + KC)).toBe('related');
    expect(ev.aliasRelation(m2, 'key:' + KC)).toBe('related');
  });
  it('a PROVEN-unrelated second minter does NOT collapse (real ambiguity stays silent)', () => {
    const g = buildGraph([
      { fileKey: 'COLOR', vars: [
        { library_key: KC, local_id: 'V:1', collection_id: 'CC', name: 'bg/x', resolved_type: 'COLOR',
          values_by_mode: { m: { r: 1, g: 1, b: 1 } }, code_syntax_web: '--ds-x' }],
        colls: [{ collection_id: 'CC', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] },
      { fileKey: 'UIKIT', vars: [
        { library_key: KD, local_id: 'V:2', collection_id: 'CU', name: 'other/x', resolved_type: 'COLOR',
          values_by_mode: { m: { r: 0, g: 0, b: 0 } }, code_syntax_web: '--ds-x' }],
        colls: [{ collection_id: 'CU', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] },
    ]);
    const ev = buildMergedCssEvidence(emptyIdx, graphCssEvidenceView(g, [KC, KD]));
    expect(ev.idsByName('--ds-x')).toHaveLength(2);
  });
  it("an 'unknown' relation between minters never merges them (holes stay honest)", () => {
    const g = buildGraph([
      { fileKey: 'COLOR', vars: [
        { library_key: KC, local_id: 'V:1', collection_id: 'CC', name: 'bg/x', resolved_type: 'COLOR',
          values_by_mode: { m: { r: 1, g: 1, b: 1 } }, code_syntax_web: '--ds-x' }],
        colls: [{ collection_id: 'CC', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] },
      { fileKey: 'UIKIT', vars: [
        // aliases a KEYLESS (unsynced) intermediate - the walk cannot see through it
        { library_key: KD, local_id: 'V:2', collection_id: 'CU', name: 'bg/x', resolved_type: 'COLOR',
          values_by_mode: { m: { type: 'VARIABLE_ALIAS', id: 'VariableID:99:99' } }, code_syntax_web: '--ds-x' }],
        colls: [{ collection_id: 'CU', default_mode: 'm', modes: [{ modeId: 'm', name: 'M' }] }] },
    ]);
    const ev = buildMergedCssEvidence(emptyIdx, graphCssEvidenceView(g, [KC, KD]));
    expect(ev.idsByName('--ds-x')).toHaveLength(2);
  });
});
