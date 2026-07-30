// mcp-server/tests/unit/dom-extractor.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EXTRACTOR_JS, buildExtractorLoader } from '../../src/adapters/driving/tools/dom-extractor.js';
import { DOM_SNAPSHOT_SCHEMA_VERSION, DomSnapshotSchema } from '../../src/adapters/driving/tools/dom-snapshot-schema.js';
import { MAX_SPEC_CHILDREN, MAX_NESTED_CHILDREN } from '../../src/domain/layout-spec/projector.js';

// Shared new-Function harness: builds a runnable EXTRACTOR_JS bound to a
// minimal fake DOM with a single 'main' element (rect 300x20) with two
// 10x50 children, so upload-path tests can assert concrete rect/childCount
// values in the emitted summaries without re-deriving the dense-tree fixture.
function buildExtractor(styleOverrides: Record<string, string> = {}): (selectors: string[], uploadUrl?: string) => Promise<unknown> {
  const rect = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });
  const makeEl = (tag: string, r: ReturnType<typeof rect>, kids: unknown[] = []): Record<string, unknown> => ({
    nodeType: 1, tagName: tag.toUpperCase(), classList: ['foo'], dataset: {},
    childNodes: kids, children: kids,
    getBoundingClientRect: () => r,
    scrollTop: 0, scrollLeft: 0, clientWidth: r.width, clientHeight: r.height, scrollHeight: r.height,
  });
  const child1 = makeEl('span', rect(0, 0, 50, 10));
  const child2 = makeEl('span', rect(0, 10, 50, 10));
  const root = makeEl('main', rect(0, 0, 300, 20), [child1, child2]);
  const fakeCS = () => ({
    display: 'block', position: 'static', transform: 'none',
    fontFamily: 'X', fontWeight: '400', fontSize: '10px', lineHeight: '12px', letterSpacing: 'normal',
    color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
    borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
    borderTopColor: 'rgb(0, 0, 0)', borderRightColor: 'rgb(0, 0, 0)',
    borderBottomColor: 'rgb(0, 0, 0)', borderLeftColor: 'rgb(0, 0, 0)', boxShadow: 'none',
    paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
    // All FOUR corners, here and in every other fake getComputedStyle below. The extractor now reads
    // the radius as four numbers, and a fixture that defines only the top-left one is a DOM whose
    // corners it cannot compare — it would read as asymmetric and change what these cases assert.
    borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
    borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px', opacity: '1',
    ...styleOverrides,
  });
  const fakeDoc = {
    querySelectorAll: () => [root],
    createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(0, 0, 1, 1) }),
    fonts: { status: 'loaded' },
  };
  const fakeWindow = { innerWidth: 420 };
  const fakeNode = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  return new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
    fakeDoc, fakeWindow, fakeNode, fakeCS,
  ) as (selectors: string[], uploadUrl?: string) => Promise<unknown>;
}

// Classifier harness: fakes a single 'main' element carrying an authored color binding so the
// value-anchored classifier can be exercised. Supplies el.style/el.matches, document.styleSheets
// (readable rules OR a cross-origin sheet whose .cssRules getter throws), and a getComputedStyle
// whose getPropertyValue('--x') resolves a custom-prop to its var value. Asserts snapshot.styles.colorToken.
// The hardening layer extends it to model the cascade shapes the core subset couldn't reach:
//  - backgroundColor/boxShadow: seed the COMPUTED pixel for the shorthand/composite-shadow axes.
//  - layers: wrap the readable rules in a fake CSSLayerBlockRule (r.constructor.name==='CSSLayerBlockRule',
//    the real Chrome name) so the classifier's @layer guard sees a layered match.
//  - group: a @media (type 4, matchMedia) / @supports (type 12, CSS.supports) grouping rule whose
//    condition→active mapping is honored by the domocked window.matchMedia / window.CSS.supports —
//    proves recursion descends only when the condition is active (never-false-green on inactive rules).
//  - crossOrigin: append an EXTRA throwing sheet ALONGSIDE readable rules (Minor-1 compound path).
// RuleSpec: a CSS rule for the fake CSSOM. `selector` present → a style rule (CSSStyleRule); omit `selector`
// for a bare nested-declarations block (CSSNestedDeclarations). `nested` emits `.cssRules` on the rule to
// model CSS NESTING (a style rule that carries both its own declarations AND nested rules).
type RuleSpec = { selector?: string; cssText: string; nested?: RuleSpec[] };
function buildExtractorCSS(opts: {
  inlineStyle?: string;
  rules?: RuleSpec[] | 'THROW';
  vars?: Record<string, string>;
  color?: string;
  backgroundColor?: string;
  // computed backgroundImage (getComputedStyle(el).backgroundImage) — a real browser resolves authored
  // gradient stops to rgb() literals here; seeds the classifyGradient axis. Defaults to 'none'.
  computedBackgroundImage?: string;
  boxShadow?: string;
  layers?: boolean;
  crossOrigin?: boolean;
  group?: { kind: 'media' | 'supports'; condition: string; active: boolean; rules: RuleSpec[] };
  // @container / other conditional grouping whose condition the classifier does NOT evaluate: a grouping
  // rule with cssRules, no CSSLayerBlockRule constructor and a type that is NOT 4/12 (media/supports).
  // defect C: such a block must be skipped entirely (never contribute a phantom candidate).
  container?: { rules: RuleSpec[] };
}): (selectors: string[], uploadUrl?: string) => Promise<unknown> {
  const rect = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });
  const vars = opts.vars ?? {};
  const color = opts.color ?? 'rgb(0, 0, 0)';
  const parseDecls = (cssText: string): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const decl of cssText.split(';')) {
      const i = decl.indexOf(':');
      if (i === -1) continue;
      const prop = decl.slice(0, i).trim();
      const val = decl.slice(i + 1).trim();
      if (prop) map[prop] = val;
    }
    return map;
  };
  const inlineDecls = opts.inlineStyle ? parseDecls(opts.inlineStyle) : {};
  const el: Record<string, unknown> = {
    nodeType: 1, tagName: 'MAIN', classList: [], dataset: {},
    childNodes: [], children: [],
    getBoundingClientRect: () => rect(0, 0, 100, 20),
    scrollTop: 0, scrollLeft: 0, clientWidth: 100, clientHeight: 20, scrollHeight: 20,
    style: { getPropertyValue: (p: string) => inlineDecls[p] ?? '' },
    // el is 'main' in the resting state. Unwrap :is(...) (how the classifier resolves nested '&') before
    // comparing, so a nested rule resolved to ':is(main)' matches, while ':is(main):hover' / ':is(main) .x'
    // (pseudo-state / descendant) do not — mirroring what the browser would match on this element.
    matches: (sel: string) => sel.replace(/:is\(([^)]*)\)/g, '$1') === 'main',
  };
  const toStyleRule = (r: RuleSpec): Record<string, unknown> => {
    const decls = parseDecls(r.cssText);
    const node: Record<string, unknown> = { style: { getPropertyValue: (p: string) => decls[p] ?? '' } };
    if (r.selector !== undefined) {
      node.selectorText = r.selector;
      // Chrome reality (112+): EVERY CSSStyleRule carries a .cssRules list — an EMPTY-but-TRUTHY CSSRuleList
      // for a flat rule, a populated one for a nesting rule. Modeling flat rules with cssRules:[] (NOT
      // undefined) is what lets a grouping-gate regression (`if (r.cssRules)` swallowing every flat rule)
      // fail in tests too — with undefined it was invisible to every flat test and only the browser exposed
      // it, which is how it once reached production. A bare CSSNestedDeclarations block (no selector)
      // carries NO cssRules, so it stays omitted.
      node.cssRules = r.nested ? r.nested.map(toStyleRule) : [];
    }
    return node;
  };
  const throwingSheet = (): Record<string, unknown> => {
    const sheet: Record<string, unknown> = {};
    Object.defineProperty(sheet, 'cssRules', { get() { throw new Error('cross-origin'); } });
    return sheet;
  };
  // A layer block rule is detected in the browser by its constructor name (CSSLayerBlockRule); a plain
  // object with a spoofed `constructor.name` reproduces that without needing the DOM global in Node.
  const layerWrap = (cssRules: unknown[]) => ({ cssRules, constructor: { name: 'CSSLayerBlockRule' } });
  const styleSheets: unknown[] = [];
  if (opts.rules === 'THROW') {
    styleSheets.push(throwingSheet());
  } else if (opts.rules && opts.rules.length) {
    let cssRules: unknown[] = opts.rules.map(toStyleRule);
    if (opts.layers) cssRules = [layerWrap(cssRules)];
    styleSheets.push({ cssRules });
  }
  if (opts.group) {
    styleSheets.push({ cssRules: [{
      type: opts.group.kind === 'media' ? 4 : 12,
      conditionText: opts.group.condition,
      cssRules: opts.group.rules.map(toStyleRule),
    }] });
  }
  if (opts.container) {
    // A grouping rule with cssRules but no type===4/12 and no CSSLayerBlockRule constructor — the shape a
    // real @container/@scope rule presents. The classifier does not evaluate its condition, so defect C
    // skips it: the block must NOT contribute a candidate.
    styleSheets.push({ cssRules: [{ cssRules: opts.container.rules.map(toStyleRule) }] });
  }
  if (opts.crossOrigin) styleSheets.push(throwingSheet());
  const fakeCS = () => ({
    display: 'block', position: 'static', transform: 'none',
    fontFamily: 'X', fontWeight: '400', fontSize: '10px', lineHeight: '12px', letterSpacing: 'normal',
    color, backgroundColor: opts.backgroundColor ?? 'rgba(0, 0, 0, 0)',
    backgroundImage: opts.computedBackgroundImage ?? 'none',
    borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
    borderTopColor: 'rgb(0, 0, 0)', borderRightColor: 'rgb(0, 0, 0)',
    borderBottomColor: 'rgb(0, 0, 0)', borderLeftColor: 'rgb(0, 0, 0)', boxShadow: opts.boxShadow ?? 'none',
    paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
    borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
    borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px', opacity: '1',
    getPropertyValue: (name: string) => vars[name] ?? '',
  });
  const fakeDoc = {
    querySelectorAll: () => [el],
    createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(0, 0, 1, 1) }),
    fonts: { status: 'loaded' },
    styleSheets,
  };
  const fakeWindow = {
    innerWidth: 420,
    matchMedia: (cond: string) => ({ matches: !!(opts.group && opts.group.kind === 'media' && cond === opts.group.condition && opts.group.active) }),
    CSS: { supports: (cond: string) => !!(opts.group && opts.group.kind === 'supports' && cond === opts.group.condition && opts.group.active) },
  };
  const fakeNode = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  return new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
    fakeDoc, fakeWindow, fakeNode, fakeCS,
  ) as (selectors: string[], uploadUrl?: string) => Promise<unknown>;
}

describe('EXTRACTOR_JS', () => {
  it('is syntactically valid JavaScript (parses as a function expression)', () => {
    expect(() => new Function(`return (${EXTRACTOR_JS})`)()).not.toThrow();
    expect(typeof new Function(`return (${EXTRACTOR_JS})`)()).toBe('function');
  });

  it('is co-versioned with the zod schema', () => {
    expect(EXTRACTOR_JS).toContain(`const SCHEMA = ${DOM_SNAPSHOT_SCHEMA_VERSION};`);
  });

  it('🅱️: root styles carry justifyContent (cs.justifyContent)', () => {
    expect(EXTRACTOR_JS).toContain('justifyContent: cs.justifyContent');
  });

  it('captures borderColors via toHex (uniform)', async () => {
    const extractor = buildExtractor({ borderTopColor: 'rgb(255, 0, 0)', borderRightColor: 'rgb(255, 0, 0)',
      borderBottomColor: 'rgb(255, 0, 0)', borderLeftColor: 'rgb(255, 0, 0)' });
    const snap = ((await extractor(['main'])) as any[])[0];
    expect(snap.borderColors).toEqual({ top: '#ff0000', right: '#ff0000', bottom: '#ff0000', left: '#ff0000' });
  });
  it('oklch border color → toHex undefined', async () => {
    const extractor = buildExtractor({ borderTopColor: 'oklch(0.7 0.1 20)', borderRightColor: 'oklch(0.7 0.1 20)',
      borderBottomColor: 'oklch(0.7 0.1 20)', borderLeftColor: 'oklch(0.7 0.1 20)' });
    const snap = ((await extractor(['main'])) as any[])[0];
    expect(snap.borderColors).toEqual({ top: undefined, right: undefined, bottom: undefined, left: undefined });
  });

  describe('box-shadow capture', () => {
    const withShadow = (boxShadow: string) => buildExtractor({ boxShadow });

    it('single drop shadow → parsed components + count 1', async () => {
      const snap = ((await withShadow('rgba(0, 0, 0, 0.1) 0px 4px 6px 2px')(['main'])) as any[])[0];
      // schema v2: shadow carries an authored-binding colorToken — the fake DOM has no readable
      // stylesheet/inline source for the shadow color, so it honestly resolves to unknown:'inherited'.
      expect(snap.shadow).toEqual({ inset: false, x: 0, y: 4, blur: 6, spread: 2, colorHex: '#0000001a', count: 1, colorToken: { unknown: 'unattributed' } });
    });
    it('inset shadow → inset true', async () => {
      const snap = ((await withShadow('rgb(0, 0, 0) 0px 1px 2px 0px inset')(['main'])) as any[])[0];
      expect(snap.shadow.inset).toBe(true);
    });
    it('none → shadow undefined', async () => {
      const snap = ((await withShadow('none')(['main'])) as any[])[0];
      expect(snap.shadow).toBeUndefined();
    });
    it('multiple shadows → count 2', async () => {
      const snap = ((await withShadow('rgba(0, 0, 0, 0.1) 0px 4px 6px 0px, rgba(0, 0, 0, 0.2) 0px 8px 16px 0px')(['main'])) as any[])[0];
      expect(snap.shadow.count).toBe(2);
    });
  });

  it('encodes the shared semantics markers (visibility predicate, text nodes, contents expansion, cap, calibration fields)', () => {
    for (const marker of ["display === 'none'", "position === 'absolute'", "position === 'fixed'",
      "display === 'contents'", 'createRange', 'TEXT_NODE', `slice(0, ${MAX_SPEC_CHILDREN})`,
      'not_found', 'multiple', 'hidden',
      'paddingTop', 'clientWidth', 'clientHeight', 'scrollHeight',
      'depthLeft', 'pruneToBudget', `slice(0, ${MAX_NESTED_CHILDREN})`, 'child.children',
      'uploadUrl', 'upload_error', 'snapshot_ref', 'viewport_warning', 'async (selectors']) {
      expect(EXTRACTOR_JS).toContain(marker);
    }
  });

  it('extractor output on a dense tree parses against its own schema (total-cap C1 regression)', async () => {
    const rect = (y: number) => ({ x: 0, y, width: 100, height: 10, left: 0, top: y, right: 100, bottom: y + 10 });
    const makeEl = (tag: string, y: number, kids: unknown[] = []): Record<string, unknown> => ({
      nodeType: 1, tagName: tag.toUpperCase(), classList: [], dataset: {},
      childNodes: kids, children: kids,
      getBoundingClientRect: () => rect(y),
      scrollTop: 0, scrollLeft: 0, clientWidth: 100, clientHeight: 10, scrollHeight: 10,
    });
    const leafPair = (y: number) => [makeEl('i', y), makeEl('b', y + 3)];
    const root = makeEl('main', 0, Array.from({ length: 30 }, (_, i) => makeEl('li', i * 12, leafPair(i * 12 + 1))));
    const fakeCS = () => ({
      display: 'block', position: 'static', transform: 'none',
      fontFamily: 'X', fontWeight: '400', fontSize: '10px', lineHeight: '12px', letterSpacing: 'normal',
      color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
      borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
      borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px', opacity: '1',
    });
    const fakeDoc = {
      querySelectorAll: () => [root],
      createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(0) }),
      fonts: { status: 'loaded' },
    };
    const fakeWindow = { innerWidth: 420 };
    const fakeNode = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    const extractor = new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
      fakeDoc, fakeWindow, fakeNode, fakeCS,
    );
    const [snap] = await extractor(['main']);
    const parsed = DomSnapshotSchema.safeParse(snap);
    expect(parsed.success).toBe(true);
  });

  it('captures element nesting 4 levels deep — L1/L2/L3 keep .children, L4 is terminal (DOM-side depth mirror, flowChildren depthLeft 2→3)', async () => {
    const rect = (y: number) => ({ x: 0, y, width: 100, height: 10, left: 0, top: y, right: 100, bottom: y + 10 });
    const makeEl = (tag: string, y: number, kids: unknown[] = []): Record<string, unknown> => ({
      nodeType: 1, tagName: tag.toUpperCase(), classList: [], dataset: {},
      childNodes: kids, children: kids,
      getBoundingClientRect: () => rect(y),
      scrollTop: 0, scrollLeft: 0, clientWidth: 100, clientHeight: 10, scrollHeight: 10,
    });
    const l4 = makeEl('span', 0);
    const l3 = makeEl('div', 0, [l4]);
    const l2 = makeEl('div', 0, [l3]);
    const l1 = makeEl('div', 0, [l2]);
    const root = makeEl('main', 0, [l1]);
    const fakeCS = () => ({
      display: 'block', position: 'static', transform: 'none',
      fontFamily: 'X', fontWeight: '400', fontSize: '10px', lineHeight: '12px', letterSpacing: 'normal',
      color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
      borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
      borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px', opacity: '1',
    });
    const fakeDoc = {
      querySelectorAll: () => [root],
      createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(0) }),
      fonts: { status: 'loaded' },
    };
    const fakeWindow = { innerWidth: 420 };
    const fakeNode = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    const extractor = new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
      fakeDoc, fakeWindow, fakeNode, fakeCS,
    );
    const [snap] = await extractor(['main']) as [{ children: Array<{ tag?: string; children?: unknown[] }> }];
    const c1 = snap.children[0] as { tag?: string; children?: Array<{ tag?: string; children?: unknown[] }> };
    const c2 = c1.children?.[0] as { tag?: string; children?: Array<{ tag?: string; children?: unknown[] }> } | undefined;
    const c3 = c2?.children?.[0] as { tag?: string; children?: unknown[] } | undefined;
    const c4 = c3?.children?.[0] as { tag?: string; children?: unknown[] } | undefined;
    expect(c1.tag).toBe('div');
    expect(c2?.tag).toBe('div');
    expect(c3?.tag).toBe('div');
    expect(c4?.tag).toBe('span');
    expect(c3?.children).toBeDefined();     // L3 — field present ([l4])
    expect(c4?.children).toBeUndefined();   // L4 — beyond the cut, field absent
    expect(DomSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it('max_depth: depthLeft=5 (explicit 3rd arg) descends 6 levels — L1..L5 keep .children, L6 is terminal', async () => {
    const rect = (y: number) => ({ x: 0, y, width: 100, height: 10, left: 0, top: y, right: 100, bottom: y + 10 });
    const makeEl = (tag: string, y: number, kids: unknown[] = []): Record<string, unknown> => ({
      nodeType: 1, tagName: tag.toUpperCase(), classList: [], dataset: {},
      childNodes: kids, children: kids,
      getBoundingClientRect: () => rect(y),
      scrollTop: 0, scrollLeft: 0, clientWidth: 100, clientHeight: 10, scrollHeight: 10,
    });
    const l6 = makeEl('span', 0);
    const l5 = makeEl('i', 0, [l6]);
    const l4 = makeEl('b', 0, [l5]);
    const l3 = makeEl('div', 0, [l4]);
    const l2 = makeEl('div', 0, [l3]);
    const l1 = makeEl('div', 0, [l2]);
    const root = makeEl('main', 0, [l1]);
    const fakeCS = () => ({
      display: 'block', position: 'static', transform: 'none',
      fontFamily: 'X', fontWeight: '400', fontSize: '10px', lineHeight: '12px', letterSpacing: 'normal',
      color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
      borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
      borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px', opacity: '1',
    });
    const fakeDoc = {
      querySelectorAll: () => [root],
      createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(0) }),
      fonts: { status: 'loaded' },
    };
    const fakeWindow = { innerWidth: 420 };
    const fakeNode = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    const extractor = new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
      fakeDoc, fakeWindow, fakeNode, fakeCS,
    );
    const [snap] = await extractor(['main'], undefined, 5) as [{ children: Array<{ tag?: string; children?: unknown[] }> }];
    const c1 = snap.children[0] as { tag?: string; children?: Array<{ tag?: string; children?: unknown[] }> };
    const c2 = c1.children?.[0] as { tag?: string; children?: Array<{ tag?: string; children?: unknown[] }> } | undefined;
    const c3 = c2?.children?.[0] as { tag?: string; children?: Array<{ tag?: string; children?: unknown[] }> } | undefined;
    const c4 = c3?.children?.[0] as { tag?: string; children?: Array<{ tag?: string; children?: unknown[] }> } | undefined;
    const c5 = c4?.children?.[0] as { tag?: string; children?: unknown[] } | undefined;
    const c6 = c5?.children?.[0] as { tag?: string; children?: unknown[] } | undefined;
    expect(c5?.children).toBeDefined();     // L5 — field present ([l6])
    expect(c6?.children).toBeUndefined();   // L6 — beyond the cut, field absent
    expect(DomSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it('emits a per-node :nth-child path (elements-only indexing) — nested element, and text node inherits its parent-element path', async () => {
    const rect = (x: number, y: number, w = 10, h = 10) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });
    const makeTextNode = (text: string): Record<string, unknown> => ({ nodeType: 3, textContent: text });
    // childNodes mixes text + element nodes (real DOM semantics); .children is elements-only (real
    // DOM .children) — path indexing MUST read .children, not .childNodes, or indices would count
    // text nodes and drift from the real CSS :nth-child selector.
    const makeEl = (tag: string, r: ReturnType<typeof rect>, elementChildren: Record<string, unknown>[] = [],
      textChildren: Record<string, unknown>[] = []): Record<string, unknown> => {
      const node: Record<string, unknown> = {
        nodeType: 1, tagName: tag.toUpperCase(), classList: [], dataset: {},
        childNodes: [...textChildren, ...elementChildren],
        children: elementChildren,
        getBoundingClientRect: () => r,
        scrollTop: 0, scrollLeft: 0, clientWidth: r.width, clientHeight: r.height, scrollHeight: r.height,
      };
      // A text node in flow always has a parentElement (its owning element) — the per-child
      // classifier reads n.parentElement.style, so the fixture must mirror that real invariant.
      for (const t of textChildren) t.parentElement = node;
      return node;
    };

    const spanEl = makeEl('span', rect(0, 0), [], [makeTextNode('A')]);
    const bEl = makeEl('b', rect(0, 10), [], [makeTextNode('B')]);
    const pEl = makeEl('p', rect(0, 10), [bEl]);
    const root = makeEl('main', rect(0, 0, 100, 20), [spanEl, pEl]);

    const fakeCS = () => ({
      display: 'block', position: 'static', transform: 'none',
      fontFamily: 'X', fontWeight: '400', fontSize: '10px', lineHeight: '12px', letterSpacing: 'normal',
      color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
      borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
      borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px', opacity: '1',
    });
    const fakeDoc = {
      querySelectorAll: () => [root],
      createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(0, 0, 1, 1) }),
      fonts: { status: 'loaded' },
    };
    const fakeWindow = { innerWidth: 420 };
    const fakeNode = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    const extractor = new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
      fakeDoc, fakeWindow, fakeNode, fakeCS,
    ) as (selectors: string[]) => Promise<Array<{ children: Array<{ tag?: string; kind: string; text?: string; path?: string; children?: unknown[] }> }>>;

    const [snap] = await extractor(['main']);
    const [spanChild, pChild] = snap.children;
    expect(spanChild.tag).toBe('span');
    expect(spanChild.path).toBe('> :nth-child(1)');
    expect(pChild.tag).toBe('p');
    expect(pChild.path).toBe('> :nth-child(2)');

    const bChild = pChild.children?.[0] as { tag?: string; path?: string } | undefined;
    expect(bChild?.tag).toBe('b');
    expect(bChild?.path).toBe('> :nth-child(2) > :nth-child(1)');

    const textAChild = spanChild.children?.[0] as { kind: string; text?: string; path?: string } | undefined;
    expect(textAChild?.kind).toBe('text');
    expect(textAChild?.text).toBe('A');
    expect(textAChild?.path).toBe('> :nth-child(1)'); // inherits the path of the parent element (span)
  });

  it('honest truncation: node AT the depth limit with real flow content below is flagged childrenTruncated — anti-over-flag on absolute-only descendants, true leaves stay unflagged', async () => {
    const rect = (y: number) => ({ x: 0, y, width: 100, height: 10, left: 0, top: y, right: 100, bottom: y + 10 });
    const base = {
      display: 'block', position: 'static', transform: 'none',
      fontFamily: 'X', fontWeight: '400', fontSize: '10px', lineHeight: '12px', letterSpacing: 'normal',
      color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
      borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
      borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px', opacity: '1',
    };
    // fakeCS must read style FROM THE NODE (n.__cs), not be arg-blind — otherwise
    // per-child display/position (case b's absolute descendant) can't be expressed at all.
    const makeEl = (tag: string, kids: unknown[] = [], cs: typeof base = base): Record<string, unknown> => ({
      nodeType: 1, tagName: tag.toUpperCase(), classList: [], dataset: {},
      childNodes: kids, children: kids,
      getBoundingClientRect: () => rect(0),
      scrollTop: 0, scrollLeft: 0, clientWidth: 100, clientHeight: 10, scrollHeight: 10,
      __cs: cs,
    });
    // Depth chain (mirrors the existing "4 levels deep" fixture): root(depthLeft=3) -> a1 -> a2 -> a3
    // (depthLeft=1 context) -> {nodeA, nodeB, nodeC} are all created at depthLeft=0 — the at-limit
    // level under test. hasFlowContent(nodeX) peeks ONE level further (nodeX's own childNodes).
    const kidVisible = makeEl('span');                                   // (a) in-flow, visible
    const nodeA = makeEl('div', [kidVisible]);                            // at-limit, real content below
    const kidAbs = makeEl('span', [], { ...base, position: 'absolute' }); // (b) only absolute child
    const nodeB = makeEl('div', [kidAbs]);                                // at-limit, absolute-only below
    const nodeC = makeEl('div', []);                                      // (c) at-limit, true leaf
    // (d) I2-LOCK (core-review nit): the only descendant is a display:contents + position:absolute
    // wrapper hiding a VISIBLE grandchild. hasFlowContent MUST test contents BEFORE position (mirror
    // flowChildren) — swap the order and the absolute-skip fires first, the wrapper is dropped, and the
    // visible grandchild is silently lost (exactly the truncation #4 fixes). Locks the load-bearing order.
    const gVisible = makeEl('span');                                                             // visible grandchild
    const contentsAbsWrap = makeEl('div', [gVisible], { ...base, display: 'contents', position: 'absolute' });
    const nodeD = makeEl('div', [contentsAbsWrap]);                       // at-limit, content reachable only via contents
    const kidNone = makeEl('span', [], { ...base, display: 'none' });     // (e) only display:none child
    const nodeE = makeEl('div', [kidNone]);                              // at-limit, hidden-only below
    const a3 = makeEl('div', [nodeA, nodeB, nodeC, nodeD, nodeE]);
    const a2 = makeEl('div', [a3]);
    const a1 = makeEl('div', [a2]);
    const root = makeEl('main', [a1]);

    const fakeCS = (n?: Record<string, unknown>) => (n && n.__cs) ? n.__cs : base;
    const fakeDoc = {
      querySelectorAll: () => [root],
      createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(0) }),
      fonts: { status: 'loaded' },
    };
    const fakeWindow = { innerWidth: 420 };
    const fakeNode = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    const extractor = new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
      fakeDoc, fakeWindow, fakeNode, fakeCS,
    ) as (selectors: string[]) => Promise<[{ children: Array<{ children?: Array<{ children?: Array<{
      children?: Array<{ childrenTruncated?: boolean; children?: unknown[] }> }> }> }> }]>;

    const [snap] = await extractor(['main']);
    const a3Out = snap.children[0]?.children?.[0]?.children?.[0];
    const [outA, outB, outC, outD, outE] = a3Out?.children ?? [];
    expect(outA?.childrenTruncated).toBe(true);      // (a) real in-flow content below the limit — honest, not a fake leaf
    expect(outA?.children).toBeUndefined();           // still no .children — same shape as budget-cap truncation
    expect(outB?.childrenTruncated).toBeUndefined();  // (b) only absolute descendants — NOT flagged (anti-over-flag)
    expect(outC?.childrenTruncated).toBeUndefined();  // (c) true leaf — no flag
    expect(outD?.childrenTruncated).toBe(true);       // (d) visible content behind a contents+absolute wrapper — I2 order lock
    expect(outE?.childrenTruncated).toBeUndefined();  // (e) only display:none descendants — NOT flagged (anti-over-flag)
    expect(DomSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  describe('value-anchored authored-binding classifier', () => {
    it('inline var() proven by value-anchor → token', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(139, 106, 251)', inlineStyle: 'color: var(--accent)', vars: { '--accent': 'rgb(139, 106, 251)' } });
      const snap = ((await ex(['main'])) as any[])[0];
      expect(snap.styles.colorToken).toEqual({ token: '--accent' });
    });
    // defect A-hex (confirmed live false-red): a design system that authors its color custom props as
    // HEX / HSL / named-color (the common case — production DSs ship values like `--neutral-fg: #9e9e9e`) resolved the
    // custom-prop VALUE with rgb-only toHexLoose → the var never anchored → EVERY tokened color read as
    // {literal} → a false "tokenize" verdict on the whole DS. The value-anchor now parses the prop value with
    // litHex (hex/rgb/hsl/named). Each of these fails ({literal:true}) if line 314 reverts to toHexLoose.
    it('defect A-hex: inline var() whose custom prop is authored as #hex → token (not literal)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(139, 106, 251)', inlineStyle: 'color: var(--accent)', vars: { '--accent': '#8b6afb' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--accent' });
    });
    it('defect A-hex: inline var() whose custom prop is authored as a named color → token (not literal)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)', inlineStyle: 'color: var(--ink)', vars: { '--ink': 'black' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--ink' });
    });
    it('defect A-hex: inline var() whose custom prop is authored as hsl() → token (not literal)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(255, 0, 0)', inlineStyle: 'color: var(--danger)', vars: { '--danger': 'hsl(0, 100%, 50%)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--danger' });
    });
    // never-false-green counterpart to the widening: a purely numeric/keyword custom-prop value must NEVER
    // anchor (litHex → undefined). Guards defect-B non-regression — a leading non-color var in a shorthand
    // ('border: var(--w) solid var(--line)') must not be mistaken for the color token. Locks that widening
    // the resolver did NOT open a spurious {token} for non-color prop values.
    it('never-green: inline var() whose custom prop is a numeric value (2px) → literal, never token', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)', inlineStyle: 'color: var(--w)', vars: { '--w': '2px' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ literal: true });
    });
    it('inline LITERAL over a class var → literal (value-anchor rejects the class var)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(139, 106, 251)', inlineStyle: 'color: #8b6afb', rules: [{ selector: 'main', cssText: 'color: var(--accent)' }], vars: { '--accent': 'rgb(1, 2, 3)' } });
      const snap = ((await ex(['main'])) as any[])[0];
      expect(snap.styles.colorToken).toEqual({ literal: true });
    });
    it('no var anywhere → literal', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)', rules: [{ selector: 'main', cssText: 'color: #000' }] });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ literal: true });
    });
    it('unreadable (cross-origin) sheet → unknown, never literal', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)', rules: 'THROW' });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'cross-origin' });
    });

    // Review lock-ins (close before the whole-branch gate).
    // Minor-1: the compound branch `sawUnreadable ? {unknown:'cross-origin'} : {literal:true}` was only
    // covered on its literal half. A non-anchoring class var (over-ridden by an inline literal) that
    // coincides with an unreadable sheet MUST route to cross-origin, never literal — mutating the branch
    // to {literal:true} fails here.
    it('Minor-1: non-anchoring class var + inline literal + cross-origin sheet → cross-origin (never literal)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(139, 106, 251)', inlineStyle: 'color: #8b6afb',
        rules: [{ selector: 'main', cssText: 'color: var(--accent)' }], vars: { '--accent': 'rgb(1, 2, 3)' }, crossOrigin: true });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'cross-origin' });
    });
    // Minor-2: the `no own declaration → inherited` invariant was only held incidentally by the box-shadow
    // test; lock it directly on the color axis.
    it('Minor-2: bare inherited color (no rules, no inline) → unknown:inherited', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)' });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'inherited' });
    });
  });

  describe('value-anchored classifier hardening', () => {
    it('shorthand background: var(--x) → token (not literal)', async () => {
      const ex = buildExtractorCSS({ backgroundColor: 'rgb(246, 246, 249)', rules: [{ selector: 'main', cssText: 'background: var(--surface)' }], vars: { '--surface': 'rgb(246, 246, 249)' } });
      expect(((await ex(['main'])) as any[])[0].styles.backgroundColorToken).toEqual({ token: '--surface' });
    });
    it('shorthand border: var(--x) → token on each edge longhand (not literal)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)', rules: [{ selector: 'main', cssText: 'border: 1px solid var(--line)' }], vars: { '--line': 'rgb(0, 0, 0)' } });
      const snap = ((await ex(['main'])) as any[])[0];
      expect(snap.borderColorsToken.top).toEqual({ token: '--line' });
      expect(snap.borderColorsToken.left).toEqual({ token: '--line' });
    });
    it('@layer present and undecidable → unknown (never the specificity-winner)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0,0,0)', layers: true, rules: [{ selector: 'main', cssText: 'color: var(--a)' }], vars: { '--a': 'rgb(9,9,9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'layered-undecidable' });
    });
    it('@layer that does NOT declare the prop leaves other axes decidable (no over-flag)', async () => {
      // The layered rule sets only `color` (its var does NOT anchor rgb(0,0,0)) → layered-undecidable via the
      // never-literal-under-layers suppression; border has no rule → candidates===0 on a NON-inheriting prop →
      // 'unattributed' (reason-code rule (D): only the inheriting `color` prop labels candidates===0 as 'inherited').
      const ex = buildExtractorCSS({ color: 'rgb(0,0,0)', layers: true, rules: [{ selector: 'main', cssText: 'color: var(--a)' }], vars: { '--a': 'rgb(9,9,9)' } });
      const snap = ((await ex(['main'])) as any[])[0];
      expect(snap.styles.colorToken).toEqual({ unknown: 'layered-undecidable' });
      expect(snap.borderColorsToken.top).toEqual({ unknown: 'unattributed' });
    });
    it('composite box-shadow: var(--shadow-md) → token, never literal', async () => {
      const ex = buildExtractorCSS({ boxShadow: '0 2px 4px rgba(24,24,27,0.15)', rules: [{ selector: 'main', cssText: 'box-shadow: var(--shadow-md)' }], vars: { '--shadow-md': '0 2px 4px rgba(24,24,27,0.15)' } });
      expect(((await ex(['main'])) as any[])[0].shadow.colorToken).toEqual({ token: '--shadow-md' });
    });
    it('composite box-shadow: var(--x) that does NOT reproduce the computed shadow → composite-shadow (never literal)', async () => {
      const ex = buildExtractorCSS({ boxShadow: '0 2px 4px rgba(24,24,27,0.15)', rules: [{ selector: 'main', cssText: 'box-shadow: var(--shadow-md)' }], vars: { '--shadow-md': '0 1px 1px rgba(0,0,0,0.5)' } });
      expect(((await ex(['main'])) as any[])[0].shadow.colorToken).toEqual({ unknown: 'composite-shadow' });
    });
    it('literal composite box-shadow (no var) → composite-shadow (never literal)', async () => {
      const ex = buildExtractorCSS({ boxShadow: '0 2px 4px rgba(24,24,27,0.15)', rules: [{ selector: 'main', cssText: 'box-shadow: 0 2px 4px rgba(24,24,27,0.15)' }] });
      expect(((await ex(['main'])) as any[])[0].shadow.colorToken).toEqual({ unknown: 'composite-shadow' });
    });
    it('var(--undef, #lit) fallback → literal', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(139,106,251)', inlineStyle: 'color: var(--nope, #8b6afb)', vars: {} });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ literal: true });
    });
    it('@media active → recurse, var anchors → token', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)', group: { kind: 'media', condition: '(min-width: 600px)', active: true, rules: [{ selector: 'main', cssText: 'color: var(--a)' }] }, vars: { '--a': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--a' });
    });
    it('@media INACTIVE → not recursed, no false literal → inherited (never-false-green)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)', group: { kind: 'media', condition: '(min-width: 600px)', active: false, rules: [{ selector: 'main', cssText: 'color: var(--a)' }] }, vars: { '--a': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'inherited' });
    });
    it('@supports active → recurse, var anchors → token', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)', group: { kind: 'supports', condition: '(display: grid)', active: true, rules: [{ selector: 'main', cssText: 'color: var(--a)' }] }, vars: { '--a': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--a' });
    });
    it('@supports INACTIVE → not recursed → inherited (never-false-green)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)', group: { kind: 'supports', condition: '(display: grid)', active: false, rules: [{ selector: 'main', cssText: 'color: var(--a)' }] }, vars: { '--a': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'inherited' });
    });
  });

  describe('explain-based cascade classification (never-false-green)', () => {
    // case-1: an inline literal (==computed) AND a class rule set background:var(--surface) that also
    // resolves to the computed pixel. The old first-anchoring-var loop reads the var from the END and
    // returns {token} — a false-green (the DOM hardcoded a literal UNDER a matching token, the very defect
    // the tool must catch). explain-based: literal and token both explain the pixel → ambiguous-cascade.
    it('case-1: inline literal + anchoring shorthand var (both explain the pixel) → ambiguous-cascade (not token)', async () => {
      const ex = buildExtractorCSS({ backgroundColor: 'rgb(246, 246, 249)', inlineStyle: 'background: #f6f6f9',
        rules: [{ selector: 'main', cssText: 'background: var(--surface)' }], vars: { '--surface': 'rgb(246, 246, 249)' } });
      expect(((await ex(['main'])) as any[])[0].styles.backgroundColorToken).toEqual({ unknown: 'ambiguous-cascade' });
    });

    // case-2: an INACTIVE @container declaring color:var(--x) must NOT contribute a candidate (its
    // condition is not evaluated). With the container skipped the only candidate is the literal rule →
    // literal. (Without the skip, explain-based would see the anchoring var too and go ambiguous — the
    // grouping-skip is what keeps this an honest literal, so this test also locks defect C.)
    it('case-2: @container var not descended → literal (grouping-skip; not token, not ambiguous)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(17, 17, 17)', rules: [{ selector: 'main', cssText: 'color: rgb(17,17,17)' }],
        container: { rules: [{ selector: 'main', cssText: 'color: var(--x)' }] }, vars: { '--x': 'rgb(17, 17, 17)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ literal: true });
    });

    // case-3: inline literal (==computed) + a LAYERED rule with an anchoring var. inlineCount>0 makes the
    // @layer gate NOT fire, but explain-based still catches the literal/token ambiguity.
    it('case-3: inline literal + layered anchoring var (inlineCount>0 skips @layer gate) → ambiguous-cascade', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(139, 106, 251)', inlineStyle: 'color: #8b6afb', layers: true,
        rules: [{ selector: 'main', cssText: 'color: var(--a)' }], vars: { '--a': 'rgb(139, 106, 251)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'ambiguous-cascade' });
    });

    // defect B: multi-var shorthand `border: var(--w) solid var(--line)` — a first-var read anchors on --w
    // (2px, not a color) and misreads the edge as literal; extracting ALL vars anchors --line correctly.
    it('defect B: multi-var shorthand border → token on the color var (not literal)', async () => {
      const ex = buildExtractorCSS({ rules: [{ selector: 'main', cssText: 'border: var(--w) solid var(--line)' }],
        vars: { '--w': '2px', '--line': 'rgb(0, 0, 0)' } });
      expect(((await ex(['main'])) as any[])[0].borderColorsToken.top).toEqual({ token: '--line' });
    });

    // lock C-1: an inline anchoring var wins over a competing (non-anchoring) @layer rule → token. Still
    // valid after the layered-anchor relaxation: inline --a anchors, layered --b does not, single anchor → token.
    it('lock C-1: inline anchoring var + competing layered rule → token', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)', inlineStyle: 'color: var(--a)', layers: true,
        rules: [{ selector: 'main', cssText: 'color: var(--b)' }], vars: { '--a': 'rgb(9, 9, 9)', '--b': 'rgb(1, 1, 1)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--a' });
    });

    // Layered-anchor relaxation (defect A-layer): a LAYERED rule whose var ANCHORS the computed pixel now yields {token},
    // NOT the old blanket layered-undecidable. Value-anchoring is cascade/layer-agnostic (the anchor == the real
    // computed pixel = ground truth), so a single unambiguous anchor is a proof of the token even under @layer.
    // Restoring the old guard `if (sawLayeredMatch && inlineCount===0) return layered-undecidable` fails this.
    it('layered anchoring var, no inline → token (was layered-undecidable — the relaxation)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)', layers: true,
        rules: [{ selector: 'main', cssText: 'color: var(--a)' }], vars: { '--a': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--a' });
    });
    // Never-false-green: a layered var that does NOT anchor (no other explanation) stays layered-undecidable
    // (conservative — the true winner is an unparseable-form we can't see). Not flipped by the relaxation.
    it('layered NON-anchoring var, no inline → layered-undecidable (conservative)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)', layers: true,
        rules: [{ selector: 'main', cssText: 'color: var(--a)' }], vars: { '--a': 'rgb(1, 1, 1)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'layered-undecidable' });
    });
    // Never-literal-under-layers: a layered LITERAL (no anchoring var) must NOT report {literal:true} — an
    // unparseable-form winner in a winning layer could shadow it. Suppressed to layered-undecidable. Deleting
    // `if (sawLayeredMatch) return {unknown:'layered-undecidable'}` before the literal fallback fails this.
    it('layered literal, no anchoring var → layered-undecidable, NEVER {literal} (never-false-green)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)', layers: true,
        rules: [{ selector: 'main', cssText: 'color: #090909' }] });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'layered-undecidable' });
    });
    // Ambiguity survey still fires under layers: a layered literal AND a layered anchoring var both explain
    // the pixel → ambiguous-cascade (not a guessed {token}). The relaxation must not bypass the ambiguity gate.
    it('layered literal + layered anchoring var (both explain) → ambiguous-cascade (not token)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)', layers: true,
        rules: [{ selector: 'main', cssText: 'color: var(--a)' }, { selector: 'main', cssText: 'color: #090909' }],
        vars: { '--a': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'ambiguous-cascade' });
    });
    // Two DISTINCT layered vars both anchor → ambiguous-cascade (winner not provable), never a guessed token.
    it('two anchoring layered vars → ambiguous-cascade (not token)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)', layers: true,
        rules: [{ selector: 'main', cssText: 'color: var(--a)' }, { selector: 'main', cssText: 'color: var(--b)' }],
        vars: { '--a': 'rgb(9, 9, 9)', '--b': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'ambiguous-cascade' });
    });
    // S5 box-shadow ambiguity survey: two var-carriers each reproducing the WHOLE computed shadow → the winner
    // is not provable → composite-shadow, never a first-hit guessed token. The old last->first loop returned
    // {token:'--s1'} here (named whichever it hit first) — this locks the all-candidate survey fix.
    it('S5: two box-shadow vars both reproducing the shadow → composite-shadow (not a guessed token)', async () => {
      const ex = buildExtractorCSS({ boxShadow: '0 2px 4px rgba(0, 0, 0, 0.5)',
        rules: [{ selector: 'main', cssText: 'box-shadow: var(--s1)' }, { selector: 'main', cssText: 'box-shadow: var(--s2)' }],
        vars: { '--s1': '0 2px 4px rgba(0, 0, 0, 0.5)', '--s2': '0 2px 4px rgba(0, 0, 0, 0.5)' } });
      expect(((await ex(['main'])) as any[])[0].shadow.colorToken).toEqual({ unknown: 'composite-shadow' });
    });
    // Honest reason-code (D): a NON-inheriting prop (background) with a real color but no matched rule →
    // 'unattributed', not the misleading 'inherited' (background does not inherit). color stays 'inherited'.
    it('reason-code (D): background with no rule → unattributed (not inherited); non-inheriting prop', async () => {
      const ex = buildExtractorCSS({ backgroundColor: 'rgb(1, 2, 3)' });
      expect(((await ex(['main'])) as any[])[0].styles.backgroundColorToken).toEqual({ unknown: 'unattributed' });
    });

    // regression: a single anchoring class var with NO literal explanation stays {token} — explain-based
    // must not over-flag the ordinary happy path.
    it('regression happy-path: single anchoring class var, no literal → token', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)', rules: [{ selector: 'main', cssText: 'color: var(--a)' }], vars: { '--a': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--a' });
    });

    // minor-a (litHex widening): a NAMED-color literal (`black`) authored UNDER a pixel-anchoring var is the
    // exact residual false-green the widened litHex closes. Before: litHex('black')→undefined → the var scores
    // as a lone anchor → {token} (the DOM hardcoded a named literal beside a matching token, mis-read as
    // "both from the token"). After: namedHex('black')==pixel → literal AND token explain → ambiguous-cascade.
    // Mutation-lock: reverting the named arm of litHex drops this back to {token}.
    it('minor-a named literal: inline `black` + anchoring var (both explain the pixel) → ambiguous-cascade (not token)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)', inlineStyle: 'color: black',
        rules: [{ selector: 'main', cssText: 'color: var(--ink)' }], vars: { '--ink': 'rgb(0, 0, 0)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'ambiguous-cascade' });
    });

    // minor-a: an hsl() literal is likewise now recognized (pure-JS hsl→#hex) — same ambiguity catch.
    it('minor-a hsl literal: inline `hsl(0,0%,0%)` + anchoring var → ambiguous-cascade (not token)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)', inlineStyle: 'color: hsl(0, 0%, 0%)',
        rules: [{ selector: 'main', cssText: 'color: var(--ink)' }], vars: { '--ink': 'rgb(0, 0, 0)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'ambiguous-cascade' });
    });

    // minor-a never-false-RED control: a named literal that does NOT match the pixel (`white` vs black pixel)
    // must NOT fabricate ambiguity — namedHex is scored against the computed pixel, so the lone anchoring var
    // stays {token}. Locks that the widening only fires when the literal genuinely explains the pixel.
    it('minor-a control: non-matching named literal (`white` vs black pixel) + anchoring var → token (no false ambiguity)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)', inlineStyle: 'color: white',
        rules: [{ selector: 'main', cssText: 'color: var(--ink)' }], vars: { '--ink': 'rgb(0, 0, 0)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--ink' });
    });

    // minor-a: a named color as a WORD inside a multi-token shorthand (`1px solid black`) is caught by the
    // token-split arm of litHex — locks the shorthand path, not just lone longhand.
    it('minor-a shorthand named word: `border: 1px solid black` + anchoring border var → ambiguous-cascade on the edge', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(0, 0, 0)', inlineStyle: 'border: 1px solid black',
        rules: [{ selector: 'main', cssText: 'border: 1px solid var(--line)' }], vars: { '--line': 'rgb(0, 0, 0)' } });
      expect(((await ex(['main'])) as any[])[0].borderColorsToken.top).toEqual({ unknown: 'ambiguous-cascade' });
    });
  });

  // CSS nesting: modern CSS-module pipelines compile to nested CSS — a style rule carries BOTH its own
  // declarations AND nested rules (r.cssRules). The old grouping gate `if (r.cssRules)` swallowed such rules
  // whole (never read their color) → every nested-authored color read {unknown} on the whole DS (a production
  // live-acceptance root cause). The gate now keys on `cssRules AND NO selectorText` so nesting style rules
  // fall through to the style branch; nested rules are descended with & resolved via :is().
  describe('CSS nesting (style rule carrying nested cssRules)', () => {
    // THE fix: color in the parent rule's OWN declarations, rule ALSO has nested rules → token (not skipped).
    // Reverting the gate to `if (r.cssRules)` (drop `&& !r.selectorText`) makes this {unknown:'inherited'}.
    it('parent declaration color + nested rules present → token (nesting rule not skipped)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)',
        rules: [{ selector: 'main', cssText: 'color: var(--a)', nested: [{ selector: '&:hover', cssText: 'color: var(--h)' }] }],
        vars: { '--a': 'rgb(9, 9, 9)', '--h': 'rgb(1, 1, 1)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--a' });
    });
    // color authored in a BARE nested declarations block (CSSNestedDeclarations: no selectorText) applies to
    // the enclosing element → token. Locks the third walk branch (r.style && scopeSel).
    it('color in a bare nested-declarations block → token', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)',
        rules: [{ selector: 'main', cssText: 'font-size: 14px', nested: [{ cssText: 'color: var(--a)' }] }],
        vars: { '--a': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--a' });
    });
    // color in a nested `& { … }` rule → resolves & to :is(main) → matches → token. Locks & resolution.
    it('color in a nested & rule → token (& resolved via :is)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)',
        rules: [{ selector: 'main', cssText: 'font-size: 14px', nested: [{ selector: '&', cssText: 'color: var(--a)' }] }],
        vars: { '--a': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--a' });
    });
    // never-false-green: a nested &:hover var that WOULD anchor must NOT contribute in the resting snapshot
    // (el.matches(':is(main):hover') is false). Both --base and --hover resolve to the pixel; if :hover leaked
    // in, size===2 → ambiguous-cascade. Correct resting behavior → single anchor → {token:'--base'}.
    it('nested &:hover anchoring var does NOT leak into the resting verdict → token(base), not ambiguous', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)',
        rules: [{ selector: 'main', cssText: 'color: var(--base)', nested: [{ selector: '&:hover', cssText: 'color: var(--hover)' }] }],
        vars: { '--base': 'rgb(9, 9, 9)', '--hover': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--base' });
    });
    // nesting under @layer still resolves the layered token (layered-anchor relaxation + nesting compose).
    it('nested color under @layer → token (nesting + @layer relaxation compose)', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)', layers: true,
        rules: [{ selector: 'main', cssText: 'color: var(--a)', nested: [{ selector: '&:hover', cssText: 'color: var(--h)' }] }],
        vars: { '--a': 'rgb(9, 9, 9)', '--h': 'rgb(1, 1, 1)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--a' });
    });
    // Live-catch lock: in Chrome (112+) every CSSStyleRule carries an EMPTY-but-TRUTHY .cssRules list, never
    // undefined. The harness models flat rules that way, so a FLAT class-based color rule must still read →
    // token. Reverting the grouping gate to plain `if (r.cssRules)` (which swallows EVERY flat rule in
    // Chrome, not just nesting-compiled sheets) makes THIS flat test fail — closing the mock↔browser gap
    // that once let exactly that regression reach production invisibly.
    it('flat rule with empty-but-truthy cssRules (Chrome reality) → color still read → token', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)',
        rules: [{ selector: 'main', cssText: 'color: var(--a)' }],
        vars: { '--a': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ token: '--a' });
    });
    // never-false-green: a nested descendant rule (& .child) whose var anchors must NOT attach to the parent
    // (el is the parent, not .child) — el.matches(':is(main) .child') is false → color stays inherited.
    it('nested descendant (& .child) anchoring var does NOT attach to parent → inherited', async () => {
      const ex = buildExtractorCSS({ color: 'rgb(9, 9, 9)',
        rules: [{ selector: 'main', cssText: 'font-size: 14px', nested: [{ selector: '& .child', cssText: 'color: var(--c)' }] }],
        vars: { '--c': 'rgb(9, 9, 9)' } });
      expect(((await ex(['main'])) as any[])[0].styles.colorToken).toEqual({ unknown: 'inherited' });
    });
  });

  describe('browser-POST (uploadUrl)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('without uploadUrl stays back-compat: plain array, byte-for-byte the old shape', async () => {
      const extractor = buildExtractor();
      const result = await extractor(['main']);
      expect(Array.isArray(result)).toBe(true);
      const [snap] = result as unknown[];
      expect(DomSnapshotSchema.safeParse(snap).success).toBe(true);
    });

    it('with uploadUrl POSTs { snapshots } as text/plain and returns { snapshot_ref, expires_at, summaries } — no full snapshots', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ snapshot_ref: 'r1', expires_at: '2026-01-01T00:00:00Z' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const extractor = buildExtractor();
      const result = await extractor(['main'], 'https://example.com/api/dom-snapshots/tok') as Record<string, unknown>;

      expect(Object.keys(result).sort()).toEqual(['expires_at', 'snapshot_ref', 'summaries']);
      expect(result.snapshot_ref).toBe('r1');
      expect(result.expires_at).toBe('2026-01-01T00:00:00Z');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://example.com/api/dom-snapshots/tok');
      expect(opts.method).toBe('POST');
      expect((opts.headers as Record<string, string>)['content-type']).toBe('text/plain');
      const body = JSON.parse(opts.body as string) as { snapshots: unknown[] };
      expect(Array.isArray(body.snapshots)).toBe(true);
      expect(body.snapshots).toHaveLength(1);
      for (const snap of body.snapshots) {
        expect(DomSnapshotSchema.safeParse(snap).success).toBe(true);
      }

      const summaries = result.summaries as Array<{ selector: string; rect: { w: number; h: number } | null; childCount: number }>;
      expect(summaries).toHaveLength(1);
      expect(summaries[0].selector).toBe('main');
      expect(summaries[0].rect).toEqual({ w: 300, h: 20 });
      expect(summaries[0].childCount).toBe(2);
    });

    // (a') loader pass-through (viewport-ergonomics T3): the server's POST /api/dom-snapshots/:capToken
    // may answer with an honest viewport_warning (see dom-snapshot-routes.ts) — the extractor's own
    // response, served fresh by the server (not re-vendored into a stale inline cache), must forward
    // it untouched to the caller instead of dropping it on the floor.
    it('with uploadUrl + server response carrying viewport_warning → forwarded pass-through on the returned object', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ snapshot_ref: 'r1', expires_at: '2026-01-01T00:00:00Z',
          viewport_warning: 'window 1429px matches none of the requested nodes\' widths (1920) — resize' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const extractor = buildExtractor();
      const result = await extractor(['main'], 'https://example.com/api/dom-snapshots/tok') as Record<string, unknown>;

      expect(Object.keys(result).sort()).toEqual(['expires_at', 'snapshot_ref', 'summaries', 'viewport_warning']);
      expect(result.viewport_warning).toBe('window 1429px matches none of the requested nodes\' widths (1920) — resize');
    });

    // Meta-less/no-warning server response stays byte-for-byte the prior shape — no `viewport_warning:
    // undefined` key leaking in (m3 pass-through-removed mutation would also fail the test above, but
    // this locks the OTHER direction: an absent field on the server response must stay absent here too).
    it('with uploadUrl + server response WITHOUT viewport_warning → key absent, prior shape unchanged', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ snapshot_ref: 'r1', expires_at: '2026-01-01T00:00:00Z' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      const extractor = buildExtractor();
      const result = await extractor(['main'], 'https://example.com/api/dom-snapshots/tok') as Record<string, unknown>;

      expect('viewport_warning' in result).toBe(false);
      expect(Object.keys(result).sort()).toEqual(['expires_at', 'snapshot_ref', 'summaries']);
    });

    it('fetch rejection yields { upload_error, summaries } — no full snapshots', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const extractor = buildExtractor();
      const result = await extractor(['main'], 'https://example.com/api/dom-snapshots/tok') as Record<string, unknown>;

      expect(Object.keys(result).sort()).toEqual(['summaries', 'upload_error']);
      expect(String(result.upload_error)).toContain('network down');
      expect(result.summaries).toHaveLength(1);
    });

    it('resp.ok === false (HTTP 404) yields { upload_error, summaries } with the status and body text', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'not found',
        json: async () => { throw new Error('should not be called'); },
      }));
      const extractor = buildExtractor();
      const result = await extractor(['main'], 'https://example.com/api/dom-snapshots/tok') as Record<string, unknown>;

      expect(Object.keys(result).sort()).toEqual(['summaries', 'upload_error']);
      expect(String(result.upload_error)).toContain('HTTP 404');
      expect(String(result.upload_error)).toContain('not found');
      expect(result.summaries).toHaveLength(1);
    });

    it('resp.ok === false and resp.text() itself throws still yields an honest upload_error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => { throw new Error('body already consumed'); },
        json: async () => { throw new Error('should not be called'); },
      }));
      const extractor = buildExtractor();
      const result = await extractor(['main'], 'https://example.com/api/dom-snapshots/tok') as Record<string, unknown>;

      expect(result.upload_error).toBeDefined();
      expect(result.summaries).toHaveLength(1);
    });
  });
});

describe('gradient: classifyGradient parse', () => {
  it('literal linear-gradient → kind/angle/stops (bracket-aware split keeps rgb())', async () => {
    const ex = buildExtractorCSS({ computedBackgroundImage:
      'linear-gradient(270deg, rgb(32, 161, 176) 0%, rgb(87, 133, 213) 50%, rgb(147, 201, 224) 100%)' });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.kind).toBe('linear');
    expect(g.angleDeg).toBe(270);
    expect(g.stops.map((s: any) => s.hex)).toEqual(['#20a1b0', '#5785d5', '#93c9e0']);
    expect(g.stops.map((s: any) => s.position)).toEqual([0, 0.5, 1]);
  });
  it('to-right keyword → 90deg', async () => {
    const ex = buildExtractorCSS({ computedBackgroundImage: 'linear-gradient(to right, rgb(0,0,0), rgb(255,255,255))' });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.angleDeg).toBe(90);
  });
  it('no angle → default 180deg', async () => {
    const ex = buildExtractorCSS({ computedBackgroundImage: 'linear-gradient(rgb(0,0,0), rgb(255,255,255))' });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.angleDeg).toBe(180);
  });
  it('repeating → kind unknown', async () => {
    const ex = buildExtractorCSS({ computedBackgroundImage: 'repeating-linear-gradient(90deg, rgb(0,0,0) 0px, rgb(0,0,0) 10px)' });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.kind).toBe('unknown');
  });
  it('oklch stop → hex undefined (honest), not fabricated', async () => {
    const ex = buildExtractorCSS({ computedBackgroundImage: 'linear-gradient(90deg, oklch(0.7 0.1 200) 0%, rgb(0,0,0) 100%)' });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.stops[0].hex).toBeUndefined();
    expect(g.stops[1].hex).toBe('#000000');
  });
  it('background-image none → gradient undefined', async () => {
    const ex = buildExtractorCSS({});
    expect(((await ex(['main'])) as any[])[0].styles.gradient).toBeUndefined();
  });
  it('multi-layer → first gradient + multiLayer flag', async () => {
    const ex = buildExtractorCSS({ computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0), rgb(255,255,255)), url("x.png")' });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.kind).toBe('linear'); expect(g.multiLayer).toBe(true);
  });
});

describe('gradient: provenance', () => {
  it('background-image: var(--g) whole-token, anchored', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: var(--g)' }],
      vars: { '--g': 'linear-gradient(90deg, #000000 0%, #ffffff 100%)' } });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.whole).toEqual({ token: '--g' });
  });
  it('literal gradient with var() stops → per-stop tokens, whole literal', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: linear-gradient(90deg, var(--s1) 0%, var(--s2) 100%)' }],
      vars: { '--s1': '#000000', '--s2': '#ffffff' } });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.whole).toEqual({ literal: true });
    expect(g.stops.map((s: any) => s.token)).toEqual([{ token: '--s1' }, { token: '--s2' }]);
  });
  it('hardcoded literal gradient → whole literal, stops literal', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: linear-gradient(90deg, #000000 0%, #ffffff 100%)' }] });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.whole).toEqual({ literal: true });
    expect(g.stops.every((s: any) => 'literal' in s.token)).toBe(true);
  });
  it('no authored rule → whole unattributed', async () => {
    const ex = buildExtractorCSS({ computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0), rgb(255,255,255))' });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.whole).toEqual({ unknown: 'unattributed' });
  });
  it('whole var whose value nests var() → unknown (honest, not token)', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0), rgb(255,255,255))',
      rules: [{ selector: 'main', cssText: 'background-image: var(--g)' }],
      vars: { '--g': 'linear-gradient(90deg, var(--x), var(--y))' } });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.whole).toEqual({ unknown: 'nested-var' });
  });
  it('whole var whose value mismatches computed stops → anchor-mismatch (honest)', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: var(--g)' }],
      vars: { '--g': 'linear-gradient(90deg, #111111 0%, #ffffff 100%)' } });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.whole).toEqual({ unknown: 'anchor-mismatch' });
  });
  it('literal gradient, authored stop var mismatches computed hex → stop-anchor-mismatch (honest)', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: linear-gradient(90deg, var(--s1) 0%, var(--s2) 100%)' }],
      vars: { '--s1': '#123456', '--s2': '#ffffff' } });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.stops[0].token).toEqual({ unknown: 'stop-anchor-mismatch' });
    expect(g.stops[1].token).toEqual({ token: '--s2' });
  });
  it('whole var read from a shorthand `background` carrier (fallback prop)', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background: var(--g)' }],
      vars: { '--g': 'linear-gradient(90deg, #000000 0%, #ffffff 100%)' } });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.whole).toEqual({ token: '--g' });
  });
  // Important-fix (task-review): CSSOM source order is NOT specificity/@layer order. A hardcoded literal
  // gradient (the real, more-specific winner) co-occurring with a source-LATER coincident `var(--g)` whose
  // value resolves to the SAME computed pixels must NOT be credited as a token — that would falsely praise a
  // DS token where the dev hardcoded (the exact defect the tool exists to catch). Survey ALL matched authored
  // values (mirror classifyColor): literal-explains + token-anchors → {unknown:'ambiguous-cascade'}, never {token}.
  // Mutation-lock: reverting the survey to source-order-last (only the var(--g)) regresses this to {token:'--g'}.
  it('literal winner co-occurs with a later coincident var(--g) → ambiguous-cascade (not false token)', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [
        { selector: 'main', cssText: 'background-image: linear-gradient(90deg, #000000 0%, #ffffff 100%)' },
        { selector: 'main', cssText: 'background-image: var(--g)' },
      ],
      vars: { '--g': 'linear-gradient(90deg, #000000 0%, #ffffff 100%)' } });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.whole).toEqual({ unknown: 'ambiguous-cascade' });
  });
  // Per-stop analogue: a hardcoded-stop literal gradient + a source-later var-stop literal gradient, both
  // reproducing the computed stops. whole stays {literal} (the gradient function IS literally authored), but
  // each stop is unprovable (hardcoded vs token) → {unknown:'ambiguous-cascade'}, never a false stop {token}.
  it('per-stop: hardcoded-stop literal + later var-stop literal → stops ambiguous-cascade, whole literal', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [
        { selector: 'main', cssText: 'background-image: linear-gradient(90deg, #000000 0%, #ffffff 100%)' },
        { selector: 'main', cssText: 'background-image: linear-gradient(90deg, var(--s1) 0%, var(--s2) 100%)' },
      ],
      vars: { '--s1': '#000000', '--s2': '#ffffff' } });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.whole).toEqual({ literal: true });
    expect(g.stops.map((s: any) => s.token)).toEqual([{ unknown: 'ambiguous-cascade' }, { unknown: 'ambiguous-cascade' }]);
  });
  // Unambiguous {token} must STAY green: a single anchoring var with no competing literal is a proof.
  it('single anchoring var, no competing literal → stays {token} (unambiguous)', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: var(--g)' }],
      vars: { '--g': 'linear-gradient(90deg, #000000 0%, #ffffff 100%)' } });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.whole).toEqual({ token: '--g' });
  });
});

describe('gradient mutation-locks + edge-cases', () => {
  // Lock bracket-split : dom-extractor.ts splitTop — the bracket-aware top-level comma split.
  //   rgb()/rgba()/var() carry INTERNAL commas; splitTop tracks paren depth so a stop stays ONE stop.
  //   Revert (naive `s.split(',')`) → `rgba(1, 2, 3, 0.5)` shatters into 3-4 broken stops → the count
  //   assertion fails. Also locks the transparent-stop alpha octet (alpha packed into the hex).
  it('lock bracket-split: rgba()/rgb() stop with internal commas stays ONE stop (+ alpha octet)', async () => {
    const ex = buildExtractorCSS({ computedBackgroundImage:
      'linear-gradient(90deg, rgba(1, 2, 3, 0.5) 0%, rgb(255, 255, 255) 100%)' });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.stops.length).toBe(2);
    expect(g.stops[0].hex).toBe('#01020380'); // transparent stop → alpha packed into hex octet
    expect(g.stops[1].hex).toBe('#ffffff');
  });

  // Lock whole-anchor : dom-extractor.ts classifyGradient — the `matchesComputed(val)` gate before a
  //   whole var() is credited. A `var(--g)` whose RESOLVED value does NOT reproduce the computed gradient
  //   must be honest {unknown:'anchor-mismatch'}, NEVER a false {token:'--g'}. Revert (drop the
  //   matchesComputed gate) → the var is credited unconditionally → {token:'--g'} → this test fails
  //   (false-green: praising a DS token the browser did not actually apply).
  it('lock whole-anchor: whole var() not reproducing computed stops → anchor-mismatch, not token', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: var(--g)' }],
      vars: { '--g': 'linear-gradient(90deg, #111111 0%, #ffffff 100%)' } });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.whole).toEqual({ unknown: 'anchor-mismatch' });
  });

  // Multi-layer idx-alignment (previously untested): classifyGradient picks the FIRST parseable
  //   gradient layer (here idx=1, behind a url() layer) and aligns the AUTHORED candidate at that SAME index
  //   (splitTop(authored)[idx]) when proving provenance. The authored literal gradient sits at idx 1 too →
  //   whole {literal:true}, multiLayer:true. Mutation (`idx = i` → `idx = 0`): the authored comparison reads
  //   layer 0 (the url()) → no gradient → whole degrades to {unknown:'unattributed'} → this test fails.
  //   Locks that authored/computed stay index-aligned (a hardcoded 0 would mis-attribute every
  //   gradient-not-first layer).
  it('multi-layer idx-alignment: gradient not first layer — authored/computed aligned at the same index', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'url("x.png"), linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: url("x.png"), linear-gradient(90deg, #000000 0%, #ffffff 100%)' }] });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.kind).toBe('linear');
    expect(g.multiLayer).toBe(true);
    expect(g.stops[0].hex).toBe('#000000');
    expect(g.whole).toEqual({ literal: true }); // idx-aligned authored literal proves whole literal
  });
});

describe('classifyGradient @layer honesty', () => {
  // Parity with the shipped SOLID cascade-honesty doctrine (classifyColor): a literal authored inside an @layer block is
  // UNPROVABLE (an unparseable-form winner — oklch/lab/color-mix — in a WINNING layer can shadow a coincident
  // literal gradient in a LOSING layer, and litHex can't see it), so the {literal:true} fallback is suppressed
  // to {unknown:'layered-undecidable'} → REVIEW instead of a false FAIL against a Figma token.
  it('literal gradient authored UNDER @layer → whole {unknown:layered-undecidable}, not {literal}', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      layers: true,
      rules: [{ selector: 'main', cssText: 'background-image: linear-gradient(90deg, #000000 0%, #ffffff 100%)' }] });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.whole).toEqual({ unknown: 'layered-undecidable' });
  });
  it('per-stop literal under @layer → each stop {unknown:layered-undecidable}', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      layers: true,
      rules: [{ selector: 'main', cssText: 'background-image: linear-gradient(90deg, #000000 0%, #ffffff 100%)' }] });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.stops.map((s: any) => s.token)).toEqual([{ unknown: 'layered-undecidable' }, { unknown: 'layered-undecidable' }]);
  });
  // NEVER-GREEN LOCK: identical hardcoded literal gradient NOT under a layer stays {literal:true} (whole + stops).
  // Reverting the @layer thread (walkA inLayer) must NOT change this row — a plain literal is byte-identical to
  // before (NO-OP when nothing is layered). Direction: converting {literal}→{unknown} can ONLY move
  // fig=token × dom=literal FAIL→REVIEW; nothing PASS becomes FAIL, and a non-layered literal never converts.
  it('NEVER-GREEN LOCK: identical literal gradient NOT under a layer → whole + stops {literal:true}', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: linear-gradient(90deg, #000000 0%, #ffffff 100%)' }] });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.whole).toEqual({ literal: true });
    expect(g.stops.map((s: any) => s.token)).toEqual([{ literal: true }, { literal: true }]);
  });
  // A provable var stays a token even under a layer — only the {literal} fallbacks convert. Value-anchoring is
  // cascade/@layer-agnostic (the resolved var == the real computed pixel = ground truth = the winner's value).
  it('a var()-anchored whole under @layer still resolves to {token} (layer does not nuke a provable var)', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      layers: true,
      rules: [{ selector: 'main', cssText: 'background-image: var(--g)' }],
      vars: { '--g': 'linear-gradient(90deg, #000000 0%, #ffffff 100%)' } });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.whole).toEqual({ token: '--g' });
  });
  // Lock sawLayered pushed-contribution guard: dom-extractor.ts authoredCandidates/walkA — sawLayered is
  //   set ONLY when a matched rule ACTUALLY CONTRIBUTES a background-image candidate (`pushFrom(...) && inLayer`).
  //   Here the @layer rule matches `main` but declares only `color` (NO background-image) → it must NOT trip
  //   sawLayered; the literal gradient lives in a NON-layered @media rule (inLayer stays false) → whole stays
  //   {literal:true}. Revert the guard to `if (m) { pushFrom(r.style); if (inLayer) sawLayered = true; }` → the
  //   matching layered color rule sets sawLayered → whole degrades to {unknown:'layered-undecidable'} (a soft
  //   false-green: a real hardcoded-literal gradient demoted to REVIEW) → this test flips and fails.
  it('lock sawLayered-guard: layered rule matching WITHOUT a background-image + a separate non-layered literal gradient → whole {literal:true}, NOT layered-undecidable', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      layers: true,
      rules: [{ selector: 'main', cssText: 'color: red' }],   // layered, MATCHES, no background-image contribution
      group: { kind: 'media', condition: '(min-width: 1px)', active: true,
        rules: [{ selector: 'main', cssText: 'background-image: linear-gradient(90deg, #000000 0%, #ffffff 100%)' }] } });
    expect(((await ex(['main'])) as any[])[0].styles.gradient.whole).toEqual({ literal: true });
  });
  // Lock layered-stop conversion : dom-extractor.ts classifyGradient — the no-litGrads per-stop branch
  //   `stopTokens = parsed.stops.map(() => (sawLayered ? {unknown:'layered-undecidable'} : {literal:true}))`.
  //   When the whole is authored as a var() (its stops are the WHOLE token's concern, so `/^var\(/` skips them
  //   from litGrads → the no-litGrads arm), a resolvable @layer whole keeps its {token}, but each per-stop
  //   de-escalates literal→{layered-undecidable} (the same unparseable-winner-in-a-winning-layer hazard as the
  //   literal path). The sibling test above pins ONLY the whole; the per-stop `sawLayered ?` conversion on THIS
  //   arm was unlocked. Revert (drop the ternary → always {literal:true}) → the stops become {literal:true} →
  //   this test fails. Direction-safe: literal→unknown can only move FAIL→REVIEW, never PASS→FAIL.
  it('lock layered-stop: whole var() under @layer → whole {token} but every per-stop {unknown:layered-undecidable}', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      layers: true,
      rules: [{ selector: 'main', cssText: 'background-image: var(--g)' }],
      vars: { '--g': 'linear-gradient(90deg, #000000 0%, #ffffff 100%)' } });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.whole).toEqual({ token: '--g' });   // provable var stays a token even under @layer
    expect(g.stops.map((s: any) => s.token)).toEqual([{ unknown: 'layered-undecidable' }, { unknown: 'layered-undecidable' }]);
  });
});

describe('classifyGradient per-stop inner-var unreadable', () => {
  // A stop authored as a var() WRAPPED in an unparseable function — color-mix / light-dark / relative-color —
  // is not a leading var(…), so litHex cannot isolate the literal and the stop used to fall through to
  // {literal:true} → a false-RED FAIL ("you hardcoded it") against a stop the DOM actually tokenized. Default
  // such stops to {unknown:'inner-var-unreadable'} → REVIEW. Computed stop-0 hex is a distinctive #20a1b0 so
  // litHex's named-color word-scan cannot accidentally "explain" the color-mix (no word inside == #20a1b0).
  it('stop authored as color-mix(..., var(--x), ...) → stop token {unknown:inner-var-unreadable}, not literal', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(32, 161, 176) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: linear-gradient(90deg, color-mix(in srgb, var(--brand) 50%, black) 0%, #ffffff 100%)' }] });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.stops[0].token).toEqual({ unknown: 'inner-var-unreadable' });
    expect(g.stops[1].token).toEqual({ literal: true });
  });
  // NEVER-GREEN LOCK (direction A): a plain hardcoded stop (#hex, no var anywhere) MUST stay {literal:true} — the
  // convert is strictly scoped to stops that wrap an inner var(). Reverting the sawInnerVar return does NOT touch
  // this row (NO-OP when no stop wraps a var); converting {literal}→{unknown} can only move fig=token × dom=literal
  // FAIL→REVIEW, never PASS→FAIL, and a plain hardcoded stop never converts.
  it('NEVER-GREEN LOCK: plain hardcoded stop (#hex, no var) → {literal:true}', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: linear-gradient(90deg, #000000 0%, #ffffff 100%)' }] });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.stops.map((s: any) => s.token)).toEqual([{ literal: true }, { literal: true }]);
  });
  // A leading var()-anchored stop is proved by value-anchoring (resolved var == computed pixel) and is reached by
  // the `if (vm)` branch BEFORE the new else-if, so the inner-var tracker never fires — {token} is unchanged.
  it('leading var()-anchored stop still resolves to {token} (unchanged by the inner-var convert)', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(0,0,0) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: linear-gradient(90deg, var(--s1) 0%, var(--s2) 100%)' }],
      vars: { '--s1': '#000000', '--s2': '#ffffff' } });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.stops.map((s: any) => s.token)).toEqual([{ token: '--s1' }, { token: '--s2' }]);
  });
  // Lock inner-var scoping guard : dom-extractor.ts classifyGradient per-stop — the `/var\(/` SCOPING of
  //   the `else if (/var\(/.test(colorTok)) sawInnerVar = true` arm. The inner-var-unreadable REVIEW is meant
  //   ONLY for a stop that WRAPS a var() in an unparseable form (color-mix/light-dark/relative-color). A stop
  //   that is a genuinely HARDCODED oklch()/lab() literal with NO var — litHex cannot parse it, so it is not
  //   'explaining' — must stay {literal:true} (a true FAIL "you hardcoded it", not a REVIEW). The sawInnerVar
  //   RETURN is already locked, but the /var\(/ GUARD was not — broadening it to `else if (colorTok)` left the
  //   whole suite green. Stop 0 authored as oklch() (no var); computed stop-0 is a distinctive rgb(32,161,176)
  //   so litHex's named-color word-scan cannot accidentally "explain" it. Revert (`/var\(/.test(colorTok)` →
  //   `colorTok`) → the truthy 'oklch(...)' sets sawInnerVar → wrongly {unknown:'inner-var-unreadable'} → fails.
  it('lock inner-var scoping: hardcoded oklch() stop (no var, litHex cannot parse) stays {literal:true}, NOT inner-var-unreadable', async () => {
    const ex = buildExtractorCSS({
      computedBackgroundImage: 'linear-gradient(90deg, rgb(32, 161, 176) 0%, rgb(255,255,255) 100%)',
      rules: [{ selector: 'main', cssText: 'background-image: linear-gradient(90deg, oklch(0.7 0.13 200) 0%, #ffffff 100%)' }] });
    const g = ((await ex(['main'])) as any[])[0].styles.gradient;
    expect(g.stops[0].hex).toBe('#20a1b0');               // emitted hex is the COMPUTED rgb (parsed), which resolves fine
    expect(g.stops[0].token).toEqual({ literal: true });  // authored oklch() is a genuine hardcoded literal → FAIL, never a REVIEW
    expect(g.stops[1].token).toEqual({ literal: true });
  });
});

// CRITICAL: buildExtractorLoader is the production-default extractor path (loader extractor_mode,
// used whenever the server has a public base URL) — if it silently drops the depth/budget args on
// the way to window.__figmaDomDiff, max_depth becomes a no-op in the loader path even though the
// Figma-side projection genuinely drilled deeper (silent mirror desync, invisible to the
// unit suite unless this exact round-trip is asserted).
describe('buildExtractorLoader (loader round-trip — forwards depthLeft/budget to window.__figmaDomDiff)', () => {
  function buildLoader(): { loader: (...args: unknown[]) => Promise<unknown>; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const fakeWindow: Record<string, unknown> = {
      __figmaDomDiff: (...args: unknown[]) => { calls.push(args); return Promise.resolve('ok'); },
    };
    const fakeDocument = { createElement: () => ({}), head: { appendChild: () => {} } };
    const loader = new Function('window', 'document', `return (${buildExtractorLoader('https://example.com')})`)(
      fakeWindow, fakeDocument,
    ) as (...args: unknown[]) => Promise<unknown>;
    return { loader, calls };
  }

  it('4-arg call (sels, up, 5, 180) forwards all 4 args to window.__figmaDomDiff — detects a forward-less regression', async () => {
    const { loader, calls } = buildLoader();
    await loader(['sel'], 'https://example.com/upload', 5, 180);
    expect(calls).toEqual([[['sel'], 'https://example.com/upload', 5, 180]]);
  });

  it('2-arg call (backward-compat) forwards depthLeft/budget as undefined — EXTRACTOR_JS defaults (3, 90) apply on the other end', async () => {
    const { loader, calls } = buildLoader();
    await loader(['sel'], 'https://example.com/upload');
    expect(calls).toEqual([[['sel'], 'https://example.com/upload', undefined, undefined]]);
  });
});

// v5: a per-element fakeCS — the child's styles differ from the root's. childData is controlled separately from
// childStyles: dataset is BY ITSELF a significant value (emitted when non-empty), so the "flat
// child" in the compactness test must have an EMPTY dataset, otherwise data is honestly emitted (the test would give
// a false omit signal). The default { component: 'Banner' } serves the significance test.
function buildExtractorPerEl(childStyles: Record<string, string>,
  childData: Record<string, string> = { component: 'Banner' }): (selectors: string[]) => Promise<any> {
  const rect = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });
  const makeEl = (tag: string, r: any, kids: any[] = [], ds: Record<string, string> = {}): any => ({
    nodeType: 1, tagName: tag.toUpperCase(), classList: ['bnr'], dataset: ds,
    childNodes: kids, children: kids, getBoundingClientRect: () => r,
    scrollTop: 0, scrollLeft: 0, clientWidth: r.width, clientHeight: r.height, scrollHeight: r.height,
  });
  const child = makeEl('div', rect(0, 0, 300, 20), [], childData);
  const root = makeEl('main', rect(0, 0, 300, 20), [child]);
  const base = {
    display: 'block', position: 'static', transform: 'none',
    fontFamily: 'X', fontWeight: '400', fontSize: '10px', lineHeight: '12px', letterSpacing: 'normal',
    color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none',
    borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
    borderTopColor: 'rgb(0, 0, 0)', borderRightColor: 'rgb(0, 0, 0)',
    borderBottomColor: 'rgb(0, 0, 0)', borderLeftColor: 'rgb(0, 0, 0)', boxShadow: 'none',
    paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
    borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
    borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px', opacity: '1', justifyContent: 'normal',
  };
  let sheetsReads = 0;
  const fakeDoc = {
    querySelectorAll: () => [root],
    createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(0, 0, 1, 1) }),
    get styleSheets() { sheetsReads++; return []; },
    fonts: { status: 'loaded' },
  };
  const fakeCS = (el: any) => ({ ...base, ...(el === child ? childStyles : {}) });
  const run = new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
    fakeDoc, { innerWidth: 1920 }, { TEXT_NODE: 3, ELEMENT_NODE: 1 }, fakeCS);
  (run as any).__sheetsReads = () => sheetsReads;
  return run;
}

// A corner radius is FOUR numbers in CSS and ONE in Figma. Reading the top-left corner alone made
// `border-radius: 8px 0 0 0` indistinguishable from a uniform 8px, so the diff answered `pass` about a
// difference it had never measured. Both emitting sites are locked here -- the child style bundle and
// the root styles -- because the false pass was reachable through either one.
describe('the corner radius is read from all four corners', () => {
  const asym = { borderTopLeftRadius: '8px', borderTopRightRadius: '0px',
    borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px' };
  const uniform = { borderTopLeftRadius: '8px', borderTopRightRadius: '8px',
    borderBottomRightRadius: '8px', borderBottomLeftRadius: '8px' };

  it('child: 8px 0 0 0 -> no borderRadius at all, and borderRadiusAsymmetric true', async () => {
    const [snap]: any = await buildExtractorPerEl(asym)(['main']);
    const c = snap.children[0];
    expect(c.styles.borderRadius).toBeUndefined(); // NOT 8 -- a lone corner is not the radius
    expect(c.styles.borderRadiusAsymmetric).toBe(true);
    expect(DomSnapshotSchema.safeParse(snap).success).toBe(true);
  });
  it('child: 8px 8px 8px 8px -> borderRadius 8 and no flag (the uniform case is untouched)', async () => {
    const [snap]: any = await buildExtractorPerEl(uniform)(['main']);
    const c = snap.children[0];
    expect(c.styles.borderRadius).toBe(8);
    expect(c.styles.borderRadiusAsymmetric).toBeUndefined();
  });
  it('root: 8px 0 0 0 -> no borderRadius at all, and borderRadiusAsymmetric true', async () => {
    const [snap]: any = await buildExtractor(asym)(['main']);
    expect(snap.styles.borderRadius).toBeUndefined();
    expect(snap.styles.borderRadiusAsymmetric).toBe(true);
    expect(DomSnapshotSchema.safeParse(snap).success).toBe(true);
  });
  it('root: 8px 8px 8px 8px -> borderRadius 8 and no flag (the uniform case is untouched)', async () => {
    const [snap]: any = await buildExtractor(uniform)(['main']);
    expect(snap.styles.borderRadius).toBe(8);
    expect(snap.styles.borderRadiusAsymmetric).toBeUndefined();
  });
});

describe('v5: the style bundle on children', () => {
  it("a child's significant styles are emitted: radius/gradient/bg/data", async () => {
    // All four corners at 24px: an override that set only the top-left one over the four-corner base
    // would describe an ASYMMETRIC child, and the toBe(24) below would be asserting the wrong thing.
    const run = buildExtractorPerEl({ borderTopLeftRadius: '24px', borderTopRightRadius: '24px',
      borderBottomRightRadius: '24px', borderBottomLeftRadius: '24px', backgroundColor: 'rgb(246, 246, 249)',
      backgroundImage: 'conic-gradient(rgb(0,0,0), rgb(255,255,255))' });
    const [snap]: any = await run(['main']);
    const c = snap.children[0];
    expect(c.styles.borderRadius).toBe(24);
    expect(c.styles.backgroundColor).toBe('#f6f6f9');
    expect(c.styles.gradient?.kind).toBe('conic');
    expect(c.data).toEqual({ component: 'Banner' });
  });
  it('compactness: a flat child carries NO style fields', async () => {
    const run = buildExtractorPerEl({}, {}); // empty dataset → a truly flat child
    const [snap]: any = await run(['main']);
    const c = snap.children[0];
    expect(c.styles.borderRadius).toBeUndefined();
    expect(c.styles.gradient).toBeUndefined();
    expect(c.shadow).toBeUndefined();
    expect(c.borders).toBeUndefined();
    expect(c.data).toBeUndefined();
    expect(c.styles.opacity).toBeUndefined(); // 1 → omitted
  });
  it('opacity < 1 is emitted', async () => {
    const run = buildExtractorPerEl({ opacity: '0.5' });
    const [snap]: any = await run(['main']);
    expect(snap.children[0].styles.opacity).toBe(0.5);
  });
  it('compute-invariant: a flat child adds no stylesheet walks over the root baseline', async () => {
    const flat = buildExtractorPerEl({});
    await flat(['main']);
    const flatReads = (flat as any).__sheetsReads();
    const styled = buildExtractorPerEl({ borderTopLeftRadius: '24px', borderTopRightRadius: '24px',
      borderBottomRightRadius: '24px', borderBottomLeftRadius: '24px', backgroundColor: 'rgb(1, 2, 3)' });
    await styled(['main']);
    const styledReads = (styled as any).__sheetsReads();
    expect(styledReads).toBeGreaterThan(flatReads); // classify was called ONLY for the styled child
  });
  it('schema = 6', async () => {
    const run = buildExtractorPerEl({});
    const [snap]: any = await run(['main']);
    expect(snap.schema).toBe(6);
    expect(DOM_SNAPSHOT_SCHEMA_VERSION).toBe(6);
  });

  // F2: a raster background-image: url(...) is invisible to the gradient detector
  // (classifyGradient → undefined on url) → descend through a visually significant wrapper. We emit
  // styles.bgImage:true (compact — only when present) as a transparency disqualifier.
  it("F2: a child's url background → styles.bgImage true (raster invisible to the gradient detector)", async () => {
    const run = buildExtractorPerEl({ backgroundImage: 'url("http://x/y.png")' });
    const [snap]: any = await run(['main']);
    const c = snap.children[0];
    expect(c.styles.bgImage).toBe(true);
    expect(c.styles.gradient).toBeUndefined();
  });
  it('F2: a gradient child → bgImage is NOT set (gradient already disqualifies)', async () => {
    const run = buildExtractorPerEl({ backgroundImage: 'conic-gradient(rgb(0,0,0), rgb(255,255,255))' });
    const [snap]: any = await run(['main']);
    const c = snap.children[0];
    expect(c.styles.gradient).toBeDefined();
    expect(c.styles.bgImage).toBeUndefined();
  });

  // F3: the emission of child.shadow / child.borders is locked POSITIVELY — a field rename
  // (shadow→shadowMUT / borders→bordersMUT) otherwise survived 434 tests (the compactness test catches
  // only the ABSENCE on a flat child, which survives a rename).
  it('F3: a child with boxShadow → c.shadow {y, blur, colorHex}', async () => {
    const run = buildExtractorPerEl({ boxShadow: '0px 4px 6px rgba(0,0,0,0.1)' });
    const [snap]: any = await run(['main']);
    const c = snap.children[0];
    expect(c.shadow).toBeDefined();
    expect(c.shadow.y).toBe(4);
    expect(c.shadow.blur).toBe(6);
    expect(c.shadow.colorHex).toBe('#0000001a');
  });
  it('F3: a child with borderTopWidth → c.borders.top + c.borderColors.top', async () => {
    const run = buildExtractorPerEl({ borderTopWidth: '2px', borderTopColor: 'rgb(255, 0, 0)' });
    const [snap]: any = await run(['main']);
    const c = snap.children[0];
    expect(c.borders).toBeDefined();
    expect(c.borders.top).toBe(2);
    expect(c.borderColors.top).toBe('#ff0000');
  });
});
