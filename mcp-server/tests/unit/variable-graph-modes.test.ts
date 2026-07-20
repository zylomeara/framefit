import { describe, it, expect } from 'vitest';
import { buildGraph, resolveKeyModes, resolveKeyInMode, collectionLibKey, keyIsMultiMode } from '../../src/domain/variable-graph.js';

const K = (h: string) => h.padEnd(40, '0');
const colls = [{ collection_id: 'C', default_mode: 'm1',
  modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'MonogramDark' }] }];
const libs = [
  { fileKey: 'L1', colls, vars: [{ library_key: K('aaa'), local_id: 'VariableID:1:1', collection_id: 'C',
    values_by_mode: { m1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, m2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } },
    name: 'text icon/accent', resolved_type: 'COLOR' }] },
];

describe('keyIsMultiMode', () => {
  it('true for a multi-mode top collection', () => {
    expect(keyIsMultiMode(buildGraph(libs), K('aaa'))).toBe(true);
  });

  it('false for a single-mode top collection', () => {
    const single = [{ fileKey: 'L1', colls: [{ collection_id: 'S', default_mode: 's1', modes: [{ modeId: 's1', name: 'Only' }] }],
      vars: [{ library_key: K('ccc'), local_id: 'VariableID:2:2', collection_id: 'S',
        values_by_mode: { s1: { r: 0, g: 0, b: 0, a: 1 } }, name: 'mono', resolved_type: 'COLOR' }] }];
    expect(keyIsMultiMode(buildGraph(single), K('ccc'))).toBe(false);
  });

  it('false for an unknown key', () => {
    expect(keyIsMultiMode(buildGraph(libs), K('zzz'))).toBe(false);
  });

  it('true for a multi-mode top even when a mode is UNRESOLVABLE (partial sync) — unlike resolveKeyModes', () => {
    // Collection P has 2 modes; mode p2 aliases into an UNSYNCED lib var absent from the graph, so
    // its hex cannot resolve. resolveKeyModes drops p2 (→ 1 entry), but the collection still HAS 2
    // modes — keyIsMultiMode counts by existence, so the needsAncestors gate stays exact.
    const partial = [{ fileKey: 'L1', colls: [{ collection_id: 'P', default_mode: 'p1',
      modes: [{ modeId: 'p1', name: 'Default' }, { modeId: 'p2', name: 'Alt' }] }],
      vars: [{ library_key: K('ddd'), local_id: 'VariableID:3:3', collection_id: 'P',
        values_by_mode: { p1: { r: 0.5, g: 0.4, b: 0.9, a: 1 },
          p2: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('eee') + '/9:9' } },  // cross-lib, not in graph
        name: 'partial/accent', resolved_type: 'COLOR' }] }];
    const g = buildGraph(partial);
    expect(Object.keys(resolveKeyModes(g, K('ddd'))!.modesByName).length).toBe(1);   // p2 dropped (unresolvable)
    expect(keyIsMultiMode(g, K('ddd'))).toBe(true);                                   // but 2 modes EXIST
  });
});

describe('resolveKeyModes', () => {
  it('returns per-mode hex by name and by id for a cross-library variable', () => {
    const g = buildGraph(libs);
    const r = resolveKeyModes(g, K('aaa'))!;
    expect(r.modesByName).toEqual({ Default: '#a73afd', MonogramDark: '#8b6afb' });
    expect(r.modesById).toEqual({ m1: '#a73afd', m2: '#8b6afb' });
    expect(r.collectionId).toBe('C');
  });

  it('alias hop into a collection lacking the requested mode falls back to the TARGET default mode', () => {
    // Source collection C_src has modes m1/m2 and aliases both to a target that lives in a
    // DIFFERENT collection C_tgt, whose only real mode is its default t1. The target var's
    // valuesByMode lists a decoy mode (tDecoy) FIRST in insertion order, so an arbitrary
    // "first value" fallback would return the decoy — the fix must return the target default.
    const collsSrc = [{ collection_id: 'C_src', default_mode: 'm1',
      modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dark' }] }];
    const collsTgt = [{ collection_id: 'C_tgt', default_mode: 't1',
      modes: [{ modeId: 't1', name: 'Base' }] }];
    const aliasId = 'VariableID:' + K('b22') + '/9:9';
    const g = buildGraph([
      { fileKey: 'L1', colls: collsSrc, vars: [{ library_key: K('a11'), local_id: 'VariableID:1:1', collection_id: 'C_src',
        values_by_mode: { m1: { type: 'VARIABLE_ALIAS', id: aliasId }, m2: { type: 'VARIABLE_ALIAS', id: aliasId } },
        name: 'src/accent', resolved_type: 'COLOR' }] },
      { fileKey: 'L2', colls: collsTgt, vars: [{ library_key: K('b22'), local_id: 'VariableID:9:9', collection_id: 'C_tgt',
        // Decoy (black) is inserted first; the real default t1 (white) is second.
        values_by_mode: { tDecoy: { r: 0, g: 0, b: 0, a: 1 }, t1: { r: 1, g: 1, b: 1, a: 1 } },
        name: 'tgt/base', resolved_type: 'COLOR' }] },
    ]);
    const r = resolveKeyModes(g, K('a11'))!;
    // Both source modes hop to the target, which lacks m1/m2 -> resolve to target default t1 (#ffffff),
    // NOT the arbitrary first value tDecoy (#000000).
    expect(r.modesByName).toEqual({ Default: '#ffffff', Dark: '#ffffff' });
    expect(r.modesById.m2).toBe('#ffffff');
  });
});

describe('resolveKeyInMode', () => {
  it('resolves the node mode for the source collection (node source)', () => {
    const g = buildGraph(libs);            // libs[0] variable is in collection 'C'
    const r = resolveKeyInMode(g, K('aaa'), new Map([['C', 'm2']]))!;
    expect(r).toMatchObject({ token: 'text icon/accent', value: '#8b6afb', mode: 'MonogramDark', mode_dependent: true, mode_source: 'node' });
  });
  it('falls back to default mode when the stack has no entry for the collection', () => {
    const g = buildGraph(libs);
    const r = resolveKeyInMode(g, K('aaa'), new Map())!;
    expect(r.value).toBe('#a73afd');
    expect(r.mode_source).toBe('default');
  });
  it('discards a present-but-invalid mode id and honestly falls back to default', () => {
    // The stack HAS an entry for collection 'C', but the mode id is a stale/foreign id that is
    // NOT a real mode of that collection (the subscribed-vs-library mode-id risk). The
    // modes.some(...) validation must reject it -> honest default, NOT the node-mode value.
    const g = buildGraph(libs);
    const r = resolveKeyInMode(g, K('aaa'), new Map([['C', 'bogus-mode-id']]))!;
    expect(r.value).toBe('#a73afd');           // default-mode (m1) value, not m2's #8b6afb
    expect(r.mode_source).toBe('default');
  });

  // FR-1: a cross-collection alias hop must not be labeled mode_source:'node' when the target
  // collection's mode could NOT be confirmed from the stack. Source coll C_src (multi) confirms
  // mode m2; its m2 value aliases a MULTI-mode target in a DIFFERENT collection C_tgt. The stack
  // has NO entry for C_tgt, so the target resolves in its default mode — the value shown is the
  // target's DEFAULT, which must be labeled honestly as 'default', never 'node'.
  const fr1Graph = () => buildGraph([
    { fileKey: 'L1', colls: [{ collection_id: 'C_src', default_mode: 'm1',
      modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dark' }] }],
      vars: [{ library_key: K('a11'), local_id: 'VariableID:1:1', collection_id: 'C_src',
        values_by_mode: {
          m1: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('b22') + '/9:9' },
          m2: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('b22') + '/9:9' },
        }, name: 'src/accent', resolved_type: 'COLOR' }] },
    { fileKey: 'L2', colls: [{ collection_id: 'C_tgt', default_mode: 'tA',
      modes: [{ modeId: 'tA', name: 'Light' }, { modeId: 'tB', name: 'Night' }] }],
      vars: [{ library_key: K('b22'), local_id: 'VariableID:9:9', collection_id: 'C_tgt',
        values_by_mode: { tA: { r: 1, g: 1, b: 1, a: 1 }, tB: { r: 0, g: 0, b: 0, a: 1 } },
        name: 'tgt/base', resolved_type: 'COLOR' }] },
  ]);

  it('downgrades to default when a cross-collection hop falls back (target mode unconfirmed)', () => {
    const g = fr1Graph();
    // Stack confirms only the SOURCE collection's mode; C_tgt is unconfirmed.
    const r = resolveKeyInMode(g, K('a11'), new Map([['C_src', 'm2']]))!;
    expect(r.value).toBe('#ffffff');           // target's DEFAULT-mode (tA) value, best-effort
    expect(r.mode_source).toBe('default');     // honest: the hop fell back — NOT 'node'
    expect(r.mode_dependent).toBe(true);
  });

  it('keeps node source and picks the target mode when the stack confirms it too', () => {
    const g = fr1Graph();
    // Stack confirms BOTH the source and the target collection modes → fully confirmed chain.
    const r = resolveKeyInMode(g, K('a11'), new Map([['C_src', 'm2'], ['C_tgt', 'tB']]))!;
    expect(r.value).toBe('#000000');           // target's CONFIRMED mode tB (Night), not default tA
    expect(r.mode_source).toBe('node');
  });

  it('downgrades on a cross-collection hop whose target mode id COLLIDES with the source mode id', () => {
    // In a merged multi-library graph two collections can independently number a mode with the
    // SAME id (e.g. '1:0'). Here the source's confirmed mode id '1:0' also EXISTS in the target's
    // DIFFERENT collection but is NOT the target's default and is NOT confirmed by the stack.
    // The hop must NOT trust the coincident id: resolve in the target's default and label 'default'.
    const g = buildGraph([
      { fileKey: 'L1', colls: [{ collection_id: 'C_src', default_mode: 'c_def',
        modes: [{ modeId: 'c_def', name: 'Default' }, { modeId: '1:0', name: 'Dark' }] }],
        vars: [{ library_key: K('a11'), local_id: 'VariableID:1:1', collection_id: 'C_src',
          values_by_mode: {
            c_def: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('b22') + '/9:9' },
            '1:0': { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('b22') + '/9:9' },
          }, name: 'src/accent', resolved_type: 'COLOR' }] },
      { fileKey: 'L2', colls: [{ collection_id: 'C_tgt', default_mode: 't_def',
        modes: [{ modeId: 't_def', name: 'Base' }, { modeId: '1:0', name: 'Collide' }] }],
        vars: [{ library_key: K('b22'), local_id: 'VariableID:9:9', collection_id: 'C_tgt',
          // Colliding-id mode '1:0' (black) differs from the default t_def (white).
          values_by_mode: { t_def: { r: 1, g: 1, b: 1, a: 1 }, '1:0': { r: 0, g: 0, b: 0, a: 1 } },
          name: 'tgt/base', resolved_type: 'COLOR' }] },
    ]);
    // Stack confirms only the SOURCE collection ('1:0'); NO entry for the target collection.
    const r = resolveKeyInMode(g, K('a11'), new Map([['C_src', '1:0']]))!;
    expect(r.value).toBe('#ffffff');           // target DEFAULT (t_def), NOT the colliding-id black
    expect(r.mode_source).toBe('default');     // honest: target collection was never confirmed
  });
});

// fu1 (post-whole-branch, Finding-1 GRAPH MIRROR): a SINGLE-mode-top cross-library variable aliasing a
// MULTI-mode downstream primitive that FELLS BACK must emit mode_dependent:true and an honest mode_source,
// exactly like the resolveBoundVariableInMode `(multi || track.fellBack)` fix. Before the mirror fix the
// non-multi branch hardcoded mode_dependent:false / mode_source:'default' → the downstream theme-dependence
// was hidden on the cross-library path (local emits it, graph didn't = mirror desync → false confidence).
describe('resolveKeyInMode single-mode-top + downstream multi-mode fellback (graph mirror of variables.ts fix)', () => {
  // C_sem: SINGLE-mode semantic top (surface/card) --alias--> C_pal: MULTI-mode palette (Lunar default
  // / Solar). With C_pal ABSENT from the stack the hop takes the palette DEFAULT (Lunar #a73afd) →
  // track.fellBack=true even though the TOP is single-mode. coverageComplete then decides mode_source.
  const singleTopGraph = () => buildGraph([
    { fileKey: 'L1', colls: [{ collection_id: 'C_sem', default_mode: 's1',
      modes: [{ modeId: 's1', name: 'Only' }] }],
      vars: [{ library_key: K('a11'), local_id: 'VariableID:1:1', collection_id: 'C_sem',
        values_by_mode: { s1: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('b22') + '/9:9' } },
        name: 'surface/card', resolved_type: 'COLOR' }] },
    { fileKey: 'L2', colls: [{ collection_id: 'C_pal', default_mode: 'pA',
      modes: [{ modeId: 'pA', name: 'Lunar' }, { modeId: 'pB', name: 'Solar' }] }],
      vars: [{ library_key: K('b22'), local_id: 'VariableID:9:9', collection_id: 'C_pal',
        values_by_mode: { pA: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, pB: { r: 0.545, g: 0.416, b: 0.984, a: 1 } },
        name: 'palette/accent', resolved_type: 'COLOR' }] },
  ]);
  it('incomplete coverage (downstream palette unconfirmed) → mode_dependent:true, mode_source:default (NOT hardcoded false)', () => {
    const g = singleTopGraph();
    const r = resolveKeyInMode(g, K('a11'), new Map([['C_sem', 's1']]), false)!;
    expect(r.value).toBe('#a73afd');              // palette DEFAULT (Lunar), best-effort
    expect(r.mode_dependent).toBe(true);          // BEFORE fix: false (single-mode top → non-multi branch)
    expect(r.mode_source).toBe('default');        // honest: downstream palette defaulted, unconfirmed
    expect(r.unconfirmed_default_used).toBe(true);
  });
  it('complete coverage (benign downstream default genuinely on-screen) → mode_dependent:true, mode_source:node', () => {
    const g = singleTopGraph();
    const r = resolveKeyInMode(g, K('a11'), new Map([['C_sem', 's1']]), true)!;
    expect(r.value).toBe('#a73afd');
    expect(r.mode_dependent).toBe(true);          // BEFORE fix: false — the mirror emits the signal now
    expect(r.mode_source).toBe('node');           // complete coverage: absent default genuinely renders
    expect(r.unconfirmed_default_used).toBe(false);
  });
});

// Honest mode_source under COMPLETE ancestor coverage. The cross-library chain is:
// text icon/accent (Theme, multi-mode Light/Dark, DEFAULT Light) --alias--> brand/600 (sub-brand
// collection 511f94…, multi-mode Lunar(default)/Solar) --alias--> purple/600 (single-mode).
// When the stack confirms the sub-brand Solar mode but has NO Theme entry, the TOP (Theme)
// collection takes its default. Under COMPLETE coverage that default genuinely renders on screen,
// so the composite (#8b6afb, Solar) equals on-screen → mode_source:'node'. Under INCOMPLETE
// coverage an unseen ancestor might override Theme → uncertain → mode_source:'default'.
describe('resolveKeyInMode: honest mode_source under complete coverage', () => {
  const accentKey = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
  const brandKey = K('b6006000');
  const purpleMarketKey = K('9600aa00');
  const purpleSolarKey = K('9600bb00');
  const themeCollId = 'VariableCollectionId:c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3/12228:2318';
  const subBrandCollId = 'VariableCollectionId:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/15515:117';
  // The stack names the SAME sub-brand library collection under a DIFFERENT subscribed-instance
  // suffix (7856:948) than the graph's library-instance (15515:117) — same 40-hex library key.
  const subBrandSubscribedId = 'VariableCollectionId:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/7856:948';

  function crossLibGraph() {
    return buildGraph([
      { fileKey: 'FTheme',
        colls: [{ collection_id: themeCollId, default_mode: 'ThemeLight',
          modes: [{ modeId: 'ThemeLight', name: 'Light' }, { modeId: 'ThemeDark', name: 'Dark' }] }],
        vars: [{ library_key: accentKey, local_id: 'VariableID:1:1', collection_id: themeCollId,
          values_by_mode: {
            ThemeLight: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + brandKey + '/9:9' },
            ThemeDark: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + brandKey + '/9:9' },
          }, name: 'text icon/accent', resolved_type: 'COLOR' }] },
      { fileKey: 'FSubBrand',
        colls: [{ collection_id: subBrandCollId, default_mode: '15436:0',
          modes: [{ modeId: '15436:0', name: 'Lunar' }, { modeId: '12398:0', name: 'Solar' }] }],
        vars: [{ library_key: brandKey, local_id: 'VariableID:9:9', collection_id: subBrandCollId,
          values_by_mode: {
            '15436:0': { type: 'VARIABLE_ALIAS', id: 'VariableID:' + purpleMarketKey + '/1:1' },
            '12398:0': { type: 'VARIABLE_ALIAS', id: 'VariableID:' + purpleSolarKey + '/1:1' },
          }, name: 'brand/600', resolved_type: 'COLOR' }] },
      { fileKey: 'FPurpleMarket',
        colls: [{ collection_id: 'C', default_mode: 'p', modes: [{ modeId: 'p', name: 'Default' }] }],
        vars: [{ library_key: purpleMarketKey, local_id: 'VariableID:1:1', collection_id: 'C',
          values_by_mode: { p: { r: 0.655, g: 0.227, b: 0.992, a: 1 } }, name: 'purple/600', resolved_type: 'COLOR' }] },
      { fileKey: 'FPurpleSolar',
        colls: [{ collection_id: 'C', default_mode: 'p', modes: [{ modeId: 'p', name: 'Default' }] }],
        vars: [{ library_key: purpleSolarKey, local_id: 'VariableID:1:1', collection_id: 'C',
          values_by_mode: { p: { r: 0.545, g: 0.416, b: 0.984, a: 1 } }, name: 'purple/600', resolved_type: 'COLOR' }] },
    ]);
  }

  it('#1 complete coverage: Solar confirmed downstream, Theme absent → #8b6afb, mode_source:node (headline)', () => {
    const g = crossLibGraph();
    const r = resolveKeyInMode(g, accentKey, new Map([[subBrandSubscribedId, '12398:0']]), true)!;
    expect(r.value).toBe('#8b6afb');
    expect(r.mode_dependent).toBe(true);
    expect(r.mode_source).toBe('node');
  });

  it('#1 same stack but coverage INCOMPLETE → mode_source:default (value still #8b6afb)', () => {
    const g = crossLibGraph();
    const r = resolveKeyInMode(g, accentKey, new Map([[subBrandSubscribedId, '12398:0']]), false)!;
    expect(r.value).toBe('#8b6afb');
    expect(r.mode_source).toBe('default');
  });

  it('#2 all modes explicit (no multi-mode default anywhere) → node regardless of coverage', () => {
    const g = crossLibGraph();
    const stack = new Map([[themeCollId, 'ThemeLight'], [subBrandSubscribedId, '12398:0']]);
    expect(resolveKeyInMode(g, accentKey, stack, false)!.mode_source).toBe('node');
    expect(resolveKeyInMode(g, accentKey, stack, true)!.mode_source).toBe('node');
  });

  it('#3 incomplete coverage + a multi-mode default in the chain → default', () => {
    const g = crossLibGraph();
    const r = resolveKeyInMode(g, accentKey, new Map(), false)!;
    expect(r.value).toBe('#a73afd');
    expect(r.mode_source).toBe('default');
  });

  it('never-wrong: an invalid explicit mode stays default even under complete coverage', () => {
    const g = buildGraph(libs);   // simple text icon/accent in collection 'C' (m1/m2)
    const r = resolveKeyInMode(g, K('aaa'), new Map([['C', 'bogus-mode-id']]), true)!;
    expect(r.value).toBe('#a73afd');
    expect(r.mode_source).toBe('default');
  });

  it('#4 downstream: an invalid explicit mode on a DEEPER collection stays default under complete coverage', () => {
    const g = crossLibGraph();
    // Sub-brand collection has a stack entry, but the mode id is not a real mode of that collection.
    const r = resolveKeyInMode(g, accentKey, new Map([[subBrandSubscribedId, '99:99']]), true)!;
    expect(r.value).toBe('#a73afd');           // sub-brand Lunar default — honest fallback
    expect(r.mode_source).toBe('default');     // invalid explicit mode is never rescued by coverage
  });
});

describe('collectionLibKey', () => {
  it('strips the prefix and returns the substring before the first "/"', () => {
    expect(collectionLibKey('VariableCollectionId:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/7856:948'))
      .toBe('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1');
  });
  it('returns the whole id (minus prefix) when there is no "/"', () => {
    expect(collectionLibKey('VariableCollectionId:abc123')).toBe('abc123');
  });
});

// Cross-library collection matching by library key. Fixture mirrors the
// ground-truth cross-library chain: text icon/accent (Theme, multi-mode Light/Dark) --alias--> brand/600
// (sub-brand collection VariableCollectionId:511f94.../15515:117, modes Lunar 15436:0
// (default) / Solar 12398:0) --alias--> purple/600 (single-mode, literal color, one variant per
// sub-brand mode). The page's explicitVariableModes names the SAME library collection by a
// DIFFERENT (subscribed-instance) suffix: .../7856:948 — same 40-hex library key, 511f94....
describe('resolveKeyInMode: cross-library collection matching by library key (Task B)', () => {
  const K40 = (h: string) => h.padEnd(40, '0');
  const accentKey = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
  const brandKey = K40('b6006000');
  const purpleMarketKey = K40('9600aa00');
  const purpleSolarKey = K40('9600bb00');
  const themeCollId = 'VariableCollectionId:c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3/12228:2318';
  const subBrandCollId = 'VariableCollectionId:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/15515:117';
  // The page's explicitVariableModes uses this SUBSCRIBED-instance suffix (7856:948), never
  // the graph's own library-instance suffix (15515:117) — same library key, different string.
  const subBrandSubscribedId = 'VariableCollectionId:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/7856:948';

  function crossLibGraph() {
    return buildGraph([
      { fileKey: 'FTheme',
        colls: [{ collection_id: themeCollId, default_mode: 'ThemeLight',
          modes: [{ modeId: 'ThemeLight', name: 'Light' }, { modeId: 'ThemeDark', name: 'Dark' }] }],
        vars: [{ library_key: accentKey, local_id: 'VariableID:1:1', collection_id: themeCollId,
          values_by_mode: {
            ThemeLight: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + brandKey + '/9:9' },
            ThemeDark: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + brandKey + '/9:9' },
          }, name: 'text icon/accent', resolved_type: 'COLOR' }] },
      { fileKey: 'FSubBrand',
        colls: [{ collection_id: subBrandCollId, default_mode: '15436:0',
          modes: [{ modeId: '15436:0', name: 'Lunar' }, { modeId: '12398:0', name: 'Solar' }] }],
        vars: [{ library_key: brandKey, local_id: 'VariableID:9:9', collection_id: subBrandCollId,
          values_by_mode: {
            '15436:0': { type: 'VARIABLE_ALIAS', id: 'VariableID:' + purpleMarketKey + '/1:1' },
            '12398:0': { type: 'VARIABLE_ALIAS', id: 'VariableID:' + purpleSolarKey + '/1:1' },
          }, name: 'brand/600', resolved_type: 'COLOR' }] },
      { fileKey: 'FPurpleMarket',
        colls: [{ collection_id: 'C', default_mode: 'p', modes: [{ modeId: 'p', name: 'Default' }] }],
        vars: [{ library_key: purpleMarketKey, local_id: 'VariableID:1:1', collection_id: 'C',
          values_by_mode: { p: { r: 0.655, g: 0.227, b: 0.992, a: 1 } }, name: 'purple/600', resolved_type: 'COLOR' }] },
      { fileKey: 'FPurpleSolar',
        colls: [{ collection_id: 'C', default_mode: 'p', modes: [{ modeId: 'p', name: 'Default' }] }],
        vars: [{ library_key: purpleSolarKey, local_id: 'VariableID:1:1', collection_id: 'C',
          values_by_mode: { p: { r: 0.545, g: 0.416, b: 0.984, a: 1 } }, name: 'purple/600', resolved_type: 'COLOR' }] },
    ]);
  }

  it('matches the sub-brand collection by library key despite the differing subscribed-instance suffix (RED before B: #a73afd, GREEN after: #8b6afb)', () => {
    const g = crossLibGraph();
    const r = resolveKeyInMode(g, accentKey, new Map([[subBrandSubscribedId, '12398:0']]))!;
    expect(r.value).toBe('#8b6afb'); // Solar, via library-key match
  });

  it('an invalid mode id (not a real mode of the matched collection) falls back to the collection default, never a wrong color', () => {
    const g = crossLibGraph();
    const r = resolveKeyInMode(g, accentKey, new Map([[subBrandSubscribedId, '99:99']]))!;
    expect(r.value).toBe('#a73afd'); // Lunar default — honest fallback, not a guess
  });

  it('does not apply a stack entry for a DIFFERENT library key', () => {
    const g = crossLibGraph();
    const otherLibId = 'VariableCollectionId:' + 'deadbeef'.repeat(5) + '/1:1';
    const r = resolveKeyInMode(g, accentKey, new Map([[otherLibId, '12398:0']]))!;
    expect(r.value).toBe('#a73afd'); // untouched — falls back to the sub-brand's own default
  });

  it('local id without "/": exact match still works; a differing local id does not match', () => {
    const g = buildGraph(libs); // simple fixture: 'text icon/accent' in collection 'C' (no '/'), modes m1/m2
    const exact = resolveKeyInMode(g, K('aaa'), new Map([['C', 'm2']]))!;
    expect(exact.value).toBe('#8b6afb');
    const differing = resolveKeyInMode(g, K('aaa'), new Map([['D', 'm2']]))!;
    expect(differing.value).toBe('#a73afd'); // 'D' !== 'C' and neither contains '/' — no fallback applies
  });
});

// modes_applied: the applied {collection -> mode} stack for cross-collection chains.
// Fixture mirrors the cross-library case: top var in multi-mode 'Theme' (L1); its every mode aliases
// cross-lib into multi-mode 'sub-brand' (L2). The node stack pins sub-brand=Solar; Theme is
// absent from the stack (defaults to Light).
const crossLibs = () => [
  { fileKey: 'L1', colls: [{ collection_id: 'CT', default_mode: 't1', name: 'Theme',
    modes: [{ modeId: 't1', name: 'Light' }, { modeId: 't2', name: 'Dark' }] }],
    vars: [{ library_key: K('acc'), local_id: 'VariableID:1:1', collection_id: 'CT',
      values_by_mode: {
        t1: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('cab') + '/9:9' },
        t2: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('cab') + '/9:9' },
      }, name: 'text icon/accent', resolved_type: 'COLOR' }] },
  { fileKey: 'L2', colls: [{ collection_id: 'CS', default_mode: 's1', name: 'sub-brand',
    modes: [{ modeId: 's1', name: 'default' }, { modeId: 's2', name: 'Solar' }] }],
    vars: [{ library_key: K('cab'), local_id: 'VariableID:9:9', collection_id: 'CS',
      values_by_mode: { s1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, s2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } },
      name: 'brand/accent', resolved_type: 'COLOR' }] },
];

describe('resolveKeyInMode modes_applied', () => {
  it('emits both axes with per-axis source for a cross-collection chain (cross-library shape)', () => {
    const g = buildGraph(crossLibs());
    const r = resolveKeyInMode(g, K('acc'), new Map([['CS', 's2']]), true)!;
    expect(r.value).toBe('#8b6afb');                       // Solar hex, not the default
    expect(r.mode).toBe('Light');                          // own-collection mode label, unchanged
    expect(r.mode_source).toBe('node');                    // complete coverage, benign default
    expect(r.modes_applied).toEqual({ Theme: 'Light (default)', 'sub-brand': 'Solar (node)' });
  });

  it('mode_source:"default" (incomplete coverage) still carries the honest computation stack', () => {
    const g = buildGraph(crossLibs());
    const r = resolveKeyInMode(g, K('acc'), new Map([['CS', 's2']]), false)!;
    expect(r.mode_source).toBe('default');
    expect(r.modes_applied).toEqual({ Theme: 'Light (default)', 'sub-brand': 'Solar (node)' });
  });

  it('single multi-mode axis -> no modes_applied (gate)', () => {
    const g = buildGraph(libs);                            // top-of-file fixture: one collection C
    const r = resolveKeyInMode(g, K('aaa'), new Map([['C', 'm2']]))!;
    expect(r.modes_applied).toBeUndefined();
  });

  it('omits the whole field when a participating collection has no name (pre-resync rows)', () => {
    const noName = crossLibs();
    delete (noName[1].colls[0] as { name?: string }).name; // sub-brand row predates the column
    const r = resolveKeyInMode(buildGraph(noName), K('acc'), new Map([['CS', 's2']]), true)!;
    expect(r.value).toBe('#8b6afb');                       // resolution itself unaffected
    expect(r.modes_applied).toBeUndefined();
  });

  it('re-visiting an already-recorded collection dedupes (first pick, nearest the token, wins)', () => {
    // Chain: vA (Theme, L1) -> vB (sub-brand, L2) -> vC (Theme, L1). Theme is recorded once (top).
    const cyc = [
      { fileKey: 'L1', colls: [{ collection_id: 'CT', default_mode: 't1', name: 'Theme',
        modes: [{ modeId: 't1', name: 'Light' }, { modeId: 't2', name: 'Dark' }] }],
        vars: [
          { library_key: K('acc'), local_id: 'VariableID:1:1', collection_id: 'CT',
            values_by_mode: { t1: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('cab') + '/9:9' },
                              t2: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('cab') + '/9:9' } },
            name: 'text icon/accent', resolved_type: 'COLOR' },
          { library_key: K('ccc'), local_id: 'VariableID:2:2', collection_id: 'CT',
            values_by_mode: { t1: { r: 1, g: 1, b: 1, a: 1 }, t2: { r: 0, g: 0, b: 0, a: 1 } },
            name: 'core/base', resolved_type: 'COLOR' },
        ] },
      { fileKey: 'L2', colls: [{ collection_id: 'CS', default_mode: 's1', name: 'sub-brand',
        modes: [{ modeId: 's1', name: 'default' }, { modeId: 's2', name: 'Solar' }] }],
        vars: [{ library_key: K('cab'), local_id: 'VariableID:9:9', collection_id: 'CS',
          values_by_mode: { s1: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('ccc') + '/2:2' },
                            s2: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('ccc') + '/2:2' } },
          name: 'brand/accent', resolved_type: 'COLOR' }] },
    ];
    const r = resolveKeyInMode(buildGraph(cyc), K('acc'), new Map([['CT', 't2'], ['CS', 's2']]), true)!;
    expect(r.value).toBe('#000000');                       // vC resolved in stack-pinned t2 (Dark)
    expect(Object.keys(r.modes_applied!)).toHaveLength(2); // Theme once, sub-brand once
    expect(r.modes_applied).toEqual({ Theme: 'Dark (node)', 'sub-brand': 'Solar (node)' });
  });

  it('an invalid explicit stack entry surfaces as "(default)" on that axis', () => {
    const g = buildGraph(crossLibs());
    const r = resolveKeyInMode(g, K('acc'), new Map([['CS', 'bogus-mode-id']]), true)!;
    expect(r.mode_source).toBe('default');                 // invalid-explicit is never rescued
    expect(r.modes_applied).toEqual({ Theme: 'Light (default)', 'sub-brand': 'default (default)' });
  });
});

// Incident 2026-07-02: a consumer pin in subscribed form (<collKey>/<instance>) must join an
// ORIGIN (plain-id) collection via the collection's published key. Mirrors the cross-library shape:
// top Theme ('/'-form) aliases cross-lib into the ORIGIN SubBrand collection (plain id) whose
// published key equals the pin's 40-hex prefix; Solar mode id is valid there.
const originLibs = () => [
  { fileKey: 'L1', colls: [{ collection_id: 'CT', default_mode: 't1', name: 'Theme',
    modes: [{ modeId: 't1', name: 'Light' }, { modeId: 't2', name: 'Dark' }] }],
    vars: [{ library_key: K('acc'), local_id: 'VariableID:1:1', collection_id: 'CT',
      values_by_mode: {
        t1: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('bab') + '/9:9' },
        t2: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('bab') + '/9:9' },
      }, name: 'text icon/accent', resolved_type: 'COLOR' }] },
  { fileKey: 'ORIGIN', colls: [{ collection_id: 'VariableCollectionId:206:40514', default_mode: 's1',
    name: 'SubBrand', key: K('5eed'),
    modes: [{ modeId: 's1', name: 'Lunar' }, { modeId: 's2', name: 'Solar' }] }],
    vars: [{ library_key: K('bab'), local_id: 'VariableID:9:9', collection_id: 'VariableCollectionId:206:40514',
      values_by_mode: { s1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, s2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } },
      name: 'brand/600', resolved_type: 'COLOR' }] },
];

describe('resolveKeyInMode plain-id origin join via published collection key', () => {
  const pin = 'VariableCollectionId:' + K('5eed') + '/7856:948';   // subscribed form of the SAME collection

  it('subscribed-form pin joins the origin (plain-id) collection and resolves the pinned mode', () => {
    const g = buildGraph(originLibs());
    const r = resolveKeyInMode(g, K('acc'), new Map([[pin, 's2']]), true)!;
    expect(r.value).toBe('#8b6afb');                              // Solar, not Lunar default
    expect(r.mode_source).toBe('node');
    expect(r.modes_applied).toEqual({ Theme: 'Light (default)', SubBrand: 'Solar (node)' });
  });

  it('key-matched pin with an INVALID mode id is present-but-invalid: honest default, never node', () => {
    const g = buildGraph(originLibs());
    const r = resolveKeyInMode(g, K('acc'), new Map([[pin, 'bogus-mode']]), true)!;
    expect(r.value).toBe('#a73afd');                              // Lunar default value
    expect(r.mode_source).toBe('default');                       // invalidExplicit — coverage never rescues
  });

  it('origin collection WITHOUT a stored key keeps the old behavior (benign absent)', () => {
    const noKey = originLibs();
    delete (noKey[1].colls[0] as { key?: string }).key;
    const r = resolveKeyInMode(buildGraph(noKey), K('acc'), new Map([[pin, 's2']]), true)!;
    expect(r.value).toBe('#a73afd');
    expect(r.mode_source).toBe('node');                          // absent-from-stack + complete coverage
    expect(r.modes_applied).toEqual({ Theme: 'Light (default)', SubBrand: 'Lunar (default)' });
  });

  it("a pin for a DIFFERENT collection key does not join (guard: key must match)", () => {
    const g = buildGraph(originLibs());
    const alien = 'VariableCollectionId:' + K('a11e') + '/1:1';
    const r = resolveKeyInMode(g, K('acc'), new Map([[alien, 's2']]), true)!;
    expect(r.value).toBe('#a73afd');                              // s2 is a valid mode id, but key differs
    expect(r.mode_source).toBe('node');
  });

  it('join is case-insensitive: UPPERCASE pin prefix still joins the lower-hex stored key', () => {
    const g = buildGraph(originLibs());
    const upperPin = 'VariableCollectionId:' + K('5eed').toUpperCase() + '/7856:948';
    const r = resolveKeyInMode(g, K('acc'), new Map([[upperPin, 's2']]), true)!;
    expect(r.value).toBe('#8b6afb');
    expect(r.mode_source).toBe('node');
  });

  it('join is case-insensitive: UPPERCASE stored collection key still matched by a lower-hex pin', () => {
    const upperKey = originLibs();
    (upperKey[1].colls[0] as { key?: string }).key = K('5eed').toUpperCase();
    const r = resolveKeyInMode(buildGraph(upperKey), K('acc'), new Map([[pin, 's2']]), true)!;
    expect(r.value).toBe('#8b6afb');
    expect(r.mode_source).toBe('node');
  });

  it('an exact-but-invalid pin is TERMINAL — never rescued by a farther same-key entry', () => {
    const g = buildGraph(originLibs());
    const stack = new Map([
      ['VariableCollectionId:206:40514', 'junk-mode'],                       // exact pin, unmappable mode
      ['VariableCollectionId:' + K('5eed') + '/9999:1', 's2'],               // farther same-key entry
    ]);
    const r = resolveKeyInMode(g, K('acc'), stack, true)!;
    expect(r.value).toBe('#a73afd');       // collection default — what Figma renders for an unmappable pin
    expect(r.mode_source).toBe('default'); // present-but-invalid; complete coverage never rescues it
  });
});

describe('resolveKeyInMode pinned_axis_used (port-level, unconditional)', () => {
  it('true when a hop consumed a pin', () => {
    const g = buildGraph(crossLibs());
    const r = resolveKeyInMode(g, K('acc'), new Map([['CS', 's2']]), true)!;
    expect(r.pinned_axis_used).toBe(true);
  });
  it('false when everything defaulted', () => {
    const g = buildGraph(crossLibs());
    const r = resolveKeyInMode(g, K('acc'), new Map(), true)!;
    expect(r.pinned_axis_used).toBe(false);
  });
  it('present even on the non-multi branch (single-mode top, pinned multi-mode hop)', () => {
    // Single-mode top collection aliasing into a multi-mode target pinned via the stack.
    const libs = [
      { fileKey: 'L1', colls: [{ collection_id: 'CS1', default_mode: 'o1', name: 'Semantic',
        modes: [{ modeId: 'o1', name: 'Only' }] }],
        vars: [{ library_key: K('5e5e'), local_id: 'VariableID:1:1', collection_id: 'CS1',
          values_by_mode: { o1: { type: 'VARIABLE_ALIAS', id: 'VariableID:' + K('cab') + '/9:9' } },
          name: 'semantic/base', resolved_type: 'COLOR' }] },
      { fileKey: 'L2', colls: [{ collection_id: 'CB', default_mode: 'b1', name: 'Palette',
        modes: [{ modeId: 'b1', name: 'Light' }, { modeId: 'b2', name: 'Night' }] }],
        vars: [{ library_key: K('cab'), local_id: 'VariableID:9:9', collection_id: 'CB',
          values_by_mode: { b1: { r: 1, g: 1, b: 1, a: 1 }, b2: { r: 0, g: 0, b: 0, a: 1 } },
          name: 'palette/base', resolved_type: 'COLOR' }] },
    ];
    const r = resolveKeyInMode(buildGraph(libs), K('5e5e'), new Map([['CB', 'b2']]), true)!;
    expect(r.mode_dependent).toBe(false);       // Option-B shape unchanged
    expect(r.value).toBe('#000000');
    expect(r.pinned_axis_used).toBe(true);
  });
});
