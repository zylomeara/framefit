import { describe, it, expect } from 'vitest';
import { buildVariableIndex, resolveAllModes, listTokens, resolveBoundVariableInMode } from '../../src/domain/variables.js';
import type { RawVariablesResponse } from '../../src/domain/figma-raw.js';
import type { ModeStack } from '../../src/domain/mode-resolve.js';

const resp: RawVariablesResponse = { meta: {
  variableCollections: {
    'VC:1': { id: 'VC:1', name: 'Theme', defaultModeId: 'm1',
      modes: [{ modeId: 'm1', name: 'Default' }, { modeId: 'm2', name: 'Dusk' }] },
    'VC:2': { id: 'VC:2', name: 'Prim', defaultModeId: 'p', modes: [{ modeId: 'p', name: 'Only' }] },
  },
  variables: {
    'V:1': { id: 'V:1', name: 'text color/accent', resolvedType: 'COLOR', variableCollectionId: 'VC:1',
      valuesByMode: { m1: { r: 0.655, g: 0.227, b: 0.992, a: 1 }, m2: { r: 0.545, g: 0.416, b: 0.984, a: 1 } } },
    'V:2': { id: 'V:2', name: 'space/md', resolvedType: 'FLOAT', variableCollectionId: 'VC:2',
      valuesByMode: { p: 16 } },
  },
} };

describe('resolveAllModes', () => {
  it('returns per-mode hex keyed by mode NAME for a multi-mode COLOR', () => {
    const idx = buildVariableIndex(resp);
    const r = resolveAllModes(resp.meta!.variables['V:1'], idx);
    expect(r).toEqual({ mode_dependent: true, modes: { Default: '#a73afd', Dusk: '#8b6afb' } });
  });

  it('returns null for a single-mode collection (no bloat)', () => {
    const idx = buildVariableIndex(resp);
    expect(resolveAllModes(resp.meta!.variables['V:2'], idx)).toBeNull();
  });
});

// FR-1 (local path): a multi-mode source variable whose confirmed-mode value aliases a
// MULTI-mode target in a DIFFERENT collection. When the node's stack confirms the source
// collection's mode but NOT the target collection's, resolveInMode must fall back to the
// target's default mode — and resolveBoundVariableInMode must label that honestly as
// mode_source:'default', never 'node' (the value shown is the target's DEFAULT).
const crossResp: RawVariablesResponse = { meta: {
  variableCollections: {
    'VC:A': { id: 'VC:A', name: 'Theme', defaultModeId: 'a1',
      modes: [{ modeId: 'a1', name: 'Default' }, { modeId: 'a2', name: 'Dark' }] },
    'VC:B': { id: 'VC:B', name: 'Palette', defaultModeId: 'b1',
      modes: [{ modeId: 'b1', name: 'Light' }, { modeId: 'b2', name: 'Night' }] },
  },
  variables: {
    'V:src': { id: 'V:src', name: 'src/accent', resolvedType: 'COLOR', variableCollectionId: 'VC:A',
      valuesByMode: { a1: { type: 'VARIABLE_ALIAS', id: 'V:tgt' }, a2: { type: 'VARIABLE_ALIAS', id: 'V:tgt' } } },
    'V:tgt': { id: 'V:tgt', name: 'tgt/base', resolvedType: 'COLOR', variableCollectionId: 'VC:B',
      valuesByMode: { b1: { r: 1, g: 1, b: 1, a: 1 }, b2: { r: 0, g: 0, b: 0, a: 1 } } },
  },
} };

describe('resolveBoundVariableInMode honesty on cross-collection hops', () => {
  it('downgrades to default when an alias hop falls back to the target default mode', () => {
    const idx = buildVariableIndex(crossResp);
    const stack: ModeStack = new Map([['VC:A', 'a2']]);   // confirms source (Dark), NOT the target
    const r = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:src' } }, 'fills', idx, stack)!;
    expect(r.value).toBe('#ffffff');           // target DEFAULT-mode (b1) value, best-effort
    expect(r.mode_dependent).toBe(true);
    expect(r.mode_source).toBe('default');     // honest: hop fell back — NOT 'node'
  });

  it('keeps node source when the resolved value needs no falling-back alias hop', () => {
    // Direct multi-mode COLOR (no cross-collection alias) with the node's mode confirmed → 'node'.
    const idx = buildVariableIndex(resp);
    const stack: ModeStack = new Map([['VC:1', 'm2']]);
    const r = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'fills', idx, stack)!;
    expect(r.value).toBe('#8b6afb');
    expect(r.mode_source).toBe('node');
  });
});

// Honest mode_source under COMPLETE ancestor coverage — the local (in-file) path,
// symmetric with the graph resolver. `usedMultiModeDefault` = a multi-mode collection took its
// default (either an absent collection, or a hop that fell back on a multi-mode target). Under
// complete coverage a benign absent-default genuinely renders on screen → 'node'; under incomplete
// coverage an unseen ancestor could override → 'default'. An INVALID explicit mode (present in the
// stack but not a real mode of the collection) is never rescued by coverage → always 'default'.
describe('resolveBoundVariableInMode honest mode_source under complete coverage', () => {
  it('#1 complete coverage + benign target default (source confirmed) → node; incomplete → default', () => {
    const idx = buildVariableIndex(crossResp);
    const stack: ModeStack = new Map([['VC:A', 'a2']]);   // confirms source (Dark); target absent → default
    const complete = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:src' } }, 'fills', idx, stack, true)!;
    expect(complete.value).toBe('#ffffff');               // target's default-mode (b1) value
    expect(complete.mode_source).toBe('node');            // complete coverage: absent collection genuinely defaults
    const incomplete = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:src' } }, 'fills', idx, stack, false)!;
    expect(incomplete.value).toBe('#ffffff');
    expect(incomplete.mode_source).toBe('default');       // uncertain: an unseen ancestor might set the target
  });

  it('#2 all modes explicit (no multi-mode default) → node regardless of coverage', () => {
    const idx = buildVariableIndex(resp);
    const stack: ModeStack = new Map([['VC:1', 'm2']]);
    expect(resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'fills', idx, stack, false)!.mode_source).toBe('node');
    expect(resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'fills', idx, stack, true)!.mode_source).toBe('node');
  });

  it('#3 incomplete coverage + a multi-mode default (collection absent from stack) → default', () => {
    const idx = buildVariableIndex(resp);
    const r = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'fills', idx, new Map(), false)!;
    expect(r.value).toBe('#a73afd');
    expect(r.mode_source).toBe('default');
  });

  it('#4 never-wrong: an invalid explicit mode stays default even under complete coverage', () => {
    const idx = buildVariableIndex(resp);
    const stack: ModeStack = new Map([['VC:1', 'bogus-mode']]);   // present but not a real mode → value falls back
    const r = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'fills', idx, stack, true)!;
    expect(r.value).toBe('#a73afd');
    expect(r.mode_source).toBe('default');
  });

  // #5 CONFIRMED SCENARIO (the C1 honesty regression): the downstream collection is VALIDLY PINNED
  // to a NON-default mode in the stack. The local resolver must RE-PICK the target's mode from the
  // stack at the cross-collection hop (symmetric with the graph path) so it returns the true
  // on-screen value (#000000, VC:B mode b2), NOT the target default (#ffffff). And since every mode
  // in the chain was explicitly confirmed, the label 'node' is honest on that correct value.
  it('#5 downstream validly pinned to a non-default mode → correct on-screen value AND honest node', () => {
    const idx = buildVariableIndex(crossResp);
    const stack: ModeStack = new Map([['VC:A', 'a2'], ['VC:B', 'b2']]); // pin BOTH source and target
    const r = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:src' } }, 'fills', idx, stack, true)!;
    expect(r.value).toBe('#000000');       // VC:B mode b2 — the value that actually renders on screen
    expect(r.mode_dependent).toBe(true);
    expect(r.mode_source).toBe('node');    // every mode explicitly confirmed → honest 'node'
  });

  // #6 downstream collection PRESENT in the stack but with an INVALID/unmappable mode → the hop
  // cannot apply it, falls back to the target default, and that default is UNSAFE (on screen the
  // node uses the unmappable mode which may differ) → never rescued to 'node', even under complete
  // coverage. Mirrors the graph path's downstream track.invalidExplicit.
  it('#6 downstream present-but-invalid mode → default value, default label even under complete coverage', () => {
    const idx = buildVariableIndex(crossResp);
    const stack: ModeStack = new Map([['VC:A', 'a2'], ['VC:B', 'bogus']]); // target pinned to a non-mode
    const r = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:src' } }, 'fills', idx, stack, true)!;
    expect(r.value).toBe('#ffffff');       // target default-mode (b1) value, best-effort
    expect(r.mode_source).toBe('default'); // present-but-invalid downstream mode is never trusted as 'node'
  });
});

// Shared fixture: bind 'fills' to V:src (crossResp) — reused by the modes_applied describe below
// and by the out-of-band pinnedAxisUsed describe appended at the end of this file.
const bind = { fills: { type: 'VARIABLE_ALIAS' as const, id: 'V:src' } };

describe('resolveBoundVariableInMode modes_applied (local path)', () => {
  it('emits both axes when the stack confirms both collections', () => {
    const idx = buildVariableIndex(crossResp);
    const stack: ModeStack = new Map([['VC:A', 'a2'], ['VC:B', 'b2']]);
    const r = resolveBoundVariableInMode(bind, 'fills', idx, stack)!;
    expect(r.value).toBe('#000000');
    expect(r.mode_source).toBe('node');
    expect(r.modes_applied).toEqual({ Theme: 'Dark (node)', Palette: 'Night (node)' });
  });

  it('marks an unconfirmed hop target "(default)" and still emits under mode_source:"default"', () => {
    const idx = buildVariableIndex(crossResp);
    const stack: ModeStack = new Map([['VC:A', 'a2']]);    // Palette unconfirmed -> default b1
    const r = resolveBoundVariableInMode(bind, 'fills', idx, stack)!;
    expect(r.value).toBe('#ffffff');
    expect(r.mode_source).toBe('default');
    expect(r.modes_applied).toEqual({ Theme: 'Dark (node)', Palette: 'Light (default)' });
  });

  it('single-collection multi-mode token (bg/level-1-base shape) -> no modes_applied', () => {
    const idx = buildVariableIndex(resp);                  // top-of-file fixture: V:1 in Theme only
    const stack: ModeStack = new Map([['VC:1', 'm2']]);
    const r = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'fills', idx, stack)!;
    expect(r.value).toBe('#8b6afb');
    expect(r.modes_applied).toBeUndefined();
  });
});

describe('listTokens attaches modes', () => {
  it('marks a local multi-mode token mode_dependent with per-mode values', () => {
    const tokens = listTokens(resp);
    const accent = tokens.find((t) => t.name === 'text color/accent')!;
    expect(accent.mode_dependent).toBe(true);
    expect(accent.modes).toEqual({ Default: '#a73afd', Dusk: '#8b6afb' });
    const space = tokens.find((t) => t.name === 'space/md')!;
    expect(space.mode_dependent).toBeUndefined();
    expect(space.modes).toBeUndefined();
  });
});

// mode_context (spec (1)): out-of-band pin-consumption signal, set even when the top-level
// variable's own collection is single-mode (the finding-4 topology: single-mode semantic token
// aliasing into a pinned multi-mode collection — the return carries no mode fields, but the
// consumed pin MUST still be reported).
const singleTopResp: RawVariablesResponse = { meta: {
  variableCollections: {
    'VC:S': { id: 'VC:S', name: 'Semantic', defaultModeId: 's1', modes: [{ modeId: 's1', name: 'Only' }] },
    'VC:B': { id: 'VC:B', name: 'Palette', defaultModeId: 'b1',
      modes: [{ modeId: 'b1', name: 'Light' }, { modeId: 'b2', name: 'Night' }] },
  },
  variables: {
    'V:sem': { id: 'V:sem', name: 'semantic/base', resolvedType: 'COLOR', variableCollectionId: 'VC:S',
      valuesByMode: { s1: { type: 'VARIABLE_ALIAS', id: 'V:pal' } } },
    'V:pal': { id: 'V:pal', name: 'palette/base', resolvedType: 'COLOR', variableCollectionId: 'VC:B',
      valuesByMode: { b1: { r: 1, g: 1, b: 1, a: 1 }, b2: { r: 0, g: 0, b: 0, a: 1 } } },
  },
} };

describe('resolveBoundVariableInMode stats.pinnedAxisUsed (out-of-band)', () => {
  it('sets the flag when the TOP pin is consumed', () => {
    const idx = buildVariableIndex(crossResp);
    const stats = { pinnedAxisUsed: false, unconfirmedDefaultUsed: false };
    resolveBoundVariableInMode(bind, 'fills', idx, new Map([['VC:A', 'a2']]), true, stats);
    expect(stats.pinnedAxisUsed).toBe(true);
  });

  it('sets the flag for a SINGLE-MODE top whose multi-mode hop consumed a pin (no mode fields on the return)', () => {
    const idx = buildVariableIndex(singleTopResp);
    const stats = { pinnedAxisUsed: false, unconfirmedDefaultUsed: false };
    const r = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:sem' } }, 'fills', idx,
      new Map([['VC:B', 'b2']]), true, stats)!;
    expect(r.value).toBe('#000000');            // pinned Night value
    expect(r.mode_dependent).toBeUndefined();   // single-mode top: Option-B inline shape unchanged
    expect(stats.pinnedAxisUsed).toBe(true);    // ...but the consumed pin IS reported out-of-band
  });

  it('leaves the flag false when everything resolves via defaults', () => {
    const idx = buildVariableIndex(crossResp);
    const stats = { pinnedAxisUsed: false, unconfirmedDefaultUsed: false };
    resolveBoundVariableInMode(bind, 'fills', idx, new Map(), true, stats);
    expect(stats.pinnedAxisUsed).toBe(false);
  });

  it('never appears on the returned token (globalVars dedup safety)', () => {
    const idx = buildVariableIndex(crossResp);
    const r = resolveBoundVariableInMode(bind, 'fills', idx, new Map([['VC:A', 'a2'], ['VC:B', 'b2']]), true, { pinnedAxisUsed: false, unconfirmedDefaultUsed: false })!;
    expect('pinned_axis_used' in r).toBe(false);
    expect('pinnedAxisUsed' in r).toBe(false);
  });
});

// Edge case (post-whole-branch): a SINGLE-MODE-top semantic token that aliases a MULTI-mode
// downstream primitive whose hop FALLS BACK to the target default (the downstream collection is absent
// from the stack). The composite value IS mode-dependent (a downstream theme change repaints it), and
// the resolver already computes track.fellBack / usedMultiModeDefault / mode_source honestly — but the
// mode fields were gated on the TOP collection being multi (`multi`), so they were silently dropped.
// That dropped mode_dependent made colorVerdict skip verdict group B → a legitimate default-mode color
// false-red'd as group C fail. The mode fields must now be emitted whenever the value fell back on a
// downstream multi-mode hop (`multi || track.fellBack`) — with honest coverage-driven mode_source.
describe('resolveBoundVariableInMode single-mode top with downstream multi-mode fellback', () => {
  it('incomplete coverage → emits mode_dependent:true, mode_source:"default" (was silently dropped → group-B false-red)', () => {
    const idx = buildVariableIndex(singleTopResp);
    const stack: ModeStack = new Map();   // downstream Palette (VC:B) ABSENT from stack → hop falls back
    const r = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:sem' } }, 'fills', idx, stack, false)!;
    expect(r.value).toBe('#ffffff');       // Palette default-mode (b1) value, best-effort
    expect(r.mode_dependent).toBe(true);   // the composite IS mode-dependent via the downstream palette
    expect(r.mode_source).toBe('default'); // incomplete coverage: an unseen ancestor could set VC:B
  });

  it('complete coverage mirror → same topology, mode_source:"node" (absent downstream genuinely defaults on screen)', () => {
    const idx = buildVariableIndex(singleTopResp);
    const stack: ModeStack = new Map();   // Palette absent, but coverage is COMPLETE → default renders on screen
    const r = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:sem' } }, 'fills', idx, stack, true)!;
    expect(r.value).toBe('#ffffff');
    expect(r.mode_dependent).toBe(true);
    expect(r.mode_source).toBe('node');    // complete coverage: absent collection genuinely defaults → honest node
  });

  it('no downstream fellback (single-mode top, pin CONFIRMED) → mode fields still absent (Option-B shape unchanged)', () => {
    // Regression guard: the fix must NOT emit mode fields when the downstream hop did NOT fall back
    // (here VC:B is validly pinned to b2), keeping the pre-fix single-mode-top inline shape.
    const idx = buildVariableIndex(singleTopResp);
    const r = resolveBoundVariableInMode({ fills: { type: 'VARIABLE_ALIAS', id: 'V:sem' } }, 'fills', idx,
      new Map([['VC:B', 'b2']]), true)!;
    expect(r.value).toBe('#000000');            // pinned Night value — on screen, no fallback
    expect(r.mode_dependent).toBeUndefined();   // track.fellBack=false → no mode fields (unchanged)
    expect(r.mode_source).toBeUndefined();
  });
});
