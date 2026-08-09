import { describe, it, expect } from 'vitest';
import { buildVariableIndex, resolveBoundVariable, listTokens, listTokensForIds, collectNodeVariableIds, extractCssName, buildCssEvidence } from '../../src/domain/variables.js';
import type { RawVariablesResponse } from '../../src/domain/figma-raw.js';

const resp: RawVariablesResponse = {
  meta: {
    variableCollections: {
      'VC:1': { id: 'VC:1', name: 'Brand', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] },
    },
    variables: {
      'V:1': { id: 'V:1', name: 'color/brand/primary', resolvedType: 'COLOR', variableCollectionId: 'VC:1',
        valuesByMode: { m1: { r: 0.482, g: 0.380, b: 0.965 }, m2: { r: 0.6, g: 0.5, b: 1 } } },
      'V:2': { id: 'V:2', name: 'space/md', resolvedType: 'FLOAT', variableCollectionId: 'VC:1', valuesByMode: { m1: 16, m2: 16 } },
      'V:3': { id: 'V:3', name: 'color/bg', resolvedType: 'COLOR', variableCollectionId: 'VC:1',
        valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'V:1' }, m2: { type: 'VARIABLE_ALIAS', id: 'V:1' } } },
      'V:4': { id: 'V:4', name: 'theme/bg/accent', resolvedType: 'COLOR', variableCollectionId: 'VC:1',
        valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'VariableID:abc123/9:9' }, m2: { type: 'VARIABLE_ALIAS', id: 'VariableID:abc123/9:9' } } },
    },
  },
};

describe('variables', () => {
  it('resolveBoundVariable maps a node boundVariables entry to the token name', () => {
    const idx = buildVariableIndex(resp);
    const name = resolveBoundVariable({ fills: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'fills', idx);
    expect(name).toBe('color/brand/primary');
  });
  it('returns null when no binding for the key', () => {
    const idx = buildVariableIndex(resp);
    expect(resolveBoundVariable({ fills: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, 'cornerRadius', idx)).toBeNull();
  });
  it('listTokens emits name+type+default-mode value, resolving color to hex and one alias hop', () => {
    const tokens = listTokens(resp);
    const byName = Object.fromEntries(tokens.map((t) => [t.name, t]));
    expect(byName['color/brand/primary'].value).toBe('#7b61f6');
    expect(byName['color/brand/primary'].type).toBe('COLOR');
    expect(byName['space/md'].value).toBe(16);
    expect(byName['color/bg'].value).toBe('#7b61f6'); // alias → primary resolved
    expect(byName['color/brand/primary'].collection).toBe('Brand');
  });
  it('flags an unresolvable external-library alias instead of leaking the raw VariableID as a value', () => {
    const tokens = listTokens(resp);
    const t = Object.fromEntries(tokens.map((x) => [x.name, x]))['theme/bg/accent'];
    expect(t.value).toBeNull();
    expect(t.alias).toBe(true);
    expect(t.alias_of).toBe('VariableID:abc123/9:9');
  });
  it('listTokens resolves an external alias via the injected resolver (hex + resolved_via)', () => {
    const resolve = (id: string) => (id === 'VariableID:abc123/9:9' ? '#11ccff' : undefined);
    const t = Object.fromEntries(listTokens(resp, resolve).map((x) => [x.name, x]))['theme/bg/accent'];
    expect(t.value).toBe('#11ccff');
    expect(t.resolved_via).toBe('snapshot');
    expect(t.alias).toBeUndefined();
  });
  it('without a resolver, external alias stays honest (value:null, alias:true)', () => {
    const t = Object.fromEntries(listTokens(resp).map((x) => [x.name, x]))['theme/bg/accent'];
    expect(t.value).toBeNull(); expect(t.alias).toBe(true);
  });
  it('tags locally-resolved tokens with resolved_via: local', () => {
    const t = Object.fromEntries(listTokens(resp).map((x) => [x.name, x]))['space/md'];
    expect(t.resolved_via).toBe('local');
  });
  it('coerces a graph/snapshot-resolved FLOAT string back to a number via resolvedType', () => {
    const floatResp: RawVariablesResponse = {
      meta: {
        variableCollections: { VC: { id: 'VC', name: 'Space', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
        variables: { V: { id: 'V', name: 'space/ext', resolvedType: 'FLOAT', variableCollectionId: 'VC', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'VariableID:zzz/1:1' } } } },
      },
    };
    const resolve = (id: string) => (id === 'VariableID:zzz/1:1' ? { value: '18', resolved_via: 'graph' as const } : undefined);
    const t = listTokens(floatResp, resolve)[0];
    expect(t.value).toBe(18);
    expect(typeof t.value).toBe('number');
  });
  it('listTokensForIds returns only tokens whose variable id is in the set', () => {
    expect(listTokensForIds(resp, new Set(['V:2'])).map((t) => t.name)).toEqual(['space/md']);
  });
});

describe('collectNodeVariableIds', () => {
  it('collects bound variable ids from node-level, fills, gradient stops, and children', () => {
    const node = {
      id: '1:1', name: 'F', type: 'FRAME',
      boundVariables: { cornerRadius: { type: 'VARIABLE_ALIAS', id: 'V:cr' }, itemSpacing: { type: 'VARIABLE_ALIAS', id: 'V:is' } },
      fills: [{ type: 'SOLID', boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:fill' } } }],
      strokes: [{ type: 'GRADIENT_LINEAR', gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:stop' } } }] }],
      children: [{ id: '1:2', name: 'C', type: 'TEXT', boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: 'V:child' } } }],
    } as any;
    expect([...collectNodeVariableIds(node)].sort()).toEqual(['V:child', 'V:cr', 'V:fill', 'V:is', 'V:stop']);
  });
});

// ── codeSyntax evidence (semantic-confirm v3) ──
describe('extractCssName — anchored, phantom-proof', () => {
  it('accepts bare --x and single var(--x) / var(--x, fallback)', () => {
    expect(extractCssName('--ds-x')).toBe('--ds-x');
    expect(extractCssName('  var(--ds-x)  ')).toBe('--ds-x');
    expect(extractCssName('var(--ds-x, #fff)')).toBe('--ds-x');
    // one level of balanced parens in the fallback is an ordinary authored value (wave catch)
    expect(extractCssName('var(--ds-x, rgb(0,0,0))')).toBe('--ds-x');
    expect(extractCssName('var(--ds-x, rgba(0,0,0,.5))')).toBe('--ds-x');
  });
  it('phantom corpus: BEM/SCSS/JS-path/multi-var strings yield NO evidence (panel-measured trap)', () => {
    for (const s of ['$btn--primary', '.card--elevated', "tokens['bg--primary']",
      'border: var(--w) solid var(--line)', 'var(--bg-light) / var(--bg-dark)',
      'background: var(--bg); color: var(--fg)', 'theme.colors.x', '', '--ds-color-{theme}-bg']) {
      expect(extractCssName(s), s).toBeUndefined();
    }
  });
});

describe('buildCssEvidence — authored map + alias relatedness', () => {
  const evResp = {
    meta: {
      variableCollections: { 'VC': { id: 'VC', name: 'C', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'M' }] } },
      variables: {
        'V:1': { id: 'V:1', name: 'bg/x', resolvedType: 'COLOR', variableCollectionId: 'VC',
          valuesByMode: { m: { r: 1, g: 1, b: 1 } }, codeSyntax: { WEB: 'var(--ds-x)' } },
        'V:2': { id: 'V:2', name: 'bg/y', resolvedType: 'COLOR', variableCollectionId: 'VC',
          valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'V:1' } }, codeSyntax: { WEB: '--ds-y' } },
        'V:3': { id: 'V:3', name: 'bg/z', resolvedType: 'COLOR', variableCollectionId: 'VC',
          valuesByMode: { m: { r: 0, g: 0, b: 0 } }, codeSyntax: { WEB: '--ds-z' } },
        'V:4': { id: 'V:4', name: 'bg/dup', resolvedType: 'COLOR', variableCollectionId: 'VC',
          valuesByMode: { m: { r: 0, g: 0, b: 0 } }, codeSyntax: { WEB: '--ds-x' } },
        'V:5': { id: 'V:5', name: 'bg/plain', resolvedType: 'COLOR', variableCollectionId: 'VC',
          valuesByMode: { m: { r: 0, g: 0, b: 0 } }, codeSyntax: {} },
      },
    },
  } as unknown as Parameters<typeof buildVariableIndex>[0];

  it('nameOf / idsByName from authored codeSyntax; duplicates listed; codeSyntax:{} = no evidence', () => {
    const ev = buildCssEvidence(buildVariableIndex(evResp));
    expect(ev.nameOf('V:1')).toBe('--ds-x');
    expect(ev.idsByName('--ds-x').sort()).toEqual(['V:1', 'V:4']);
    expect(ev.idsByName('--absent')).toEqual([]);
    expect(ev.nameOf('V:5')).toBeUndefined(); // codeSyntax:{} — the REAL no-evidence payload shape
  });
  it('aliasRelated: V:2 aliases V:1 (both directions true); V:3 unrelated', () => {
    const ev = buildCssEvidence(buildVariableIndex(evResp));
    expect(ev.aliasRelated('V:2', 'V:1')).toBe(true);
    expect(ev.aliasRelated('V:1', 'V:2')).toBe(true);
    expect(ev.aliasRelated('V:3', 'V:1')).toBe(false);
    expect(ev.aliasRelated('V:1', 'V:1')).toBe(true);
  });
});
