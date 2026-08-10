// Phase 1 of the icon-color axis (feedback item 6): the extractor learns to read an icon's
// painted color. Panel-locked value rules: survey ALL path-like descendants (first-path-only
// was a one-sided multi-color detector), fill -> none => stroke (outline icons are the
// commonest family), alpha folded through fill-opacity and the element opacity chain up to the
// svg (the 8-digit-hex convention), computed fill ALREADY resolves currentColor (no fallback -
// for unset it would replace SVG-initial black with an invented inherited color), unreadable
// paints (url()/gradients) emit an explicit {unknown} - a new extractor always writes
// SOMETHING for a detected svg, which is what makes absent-field = stale-capture decidable.
import { describe, it, expect } from 'vitest';
import { EXTRACTOR_JS } from '../../src/adapters/driving/tools/dom-extractor.js';

type FakeEl = Record<string, unknown> & { __cs: Record<string, string>; children: FakeEl[] };

const rect = (x: number, y: number, w: number, h: number) =>
  ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });

const BASE_CS: Record<string, string> = {
  display: 'block', position: 'static', transform: 'none',
  fontFamily: 'X', fontWeight: '400', fontSize: '10px', lineHeight: '12px', letterSpacing: 'normal',
  color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
  borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
  borderTopColor: 'rgb(0, 0, 0)', borderRightColor: 'rgb(0, 0, 0)',
  borderBottomColor: 'rgb(0, 0, 0)', borderLeftColor: 'rgb(0, 0, 0)', boxShadow: 'none',
  paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
  borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
  borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px', opacity: '1',
  fill: 'rgb(0, 0, 0)', stroke: 'none', fillOpacity: '1', scrollbarGutter: 'auto',
};

function makeEl(tag: string, r: ReturnType<typeof rect>, kids: FakeEl[] = [], cs: Record<string, string> = {}, attrs: Record<string, string> = {}): FakeEl {
  const el: FakeEl = {
    nodeType: 1, tagName: tag.toUpperCase(), classList: ['x'], dataset: {},
    childNodes: kids, children: kids,
    getBoundingClientRect: () => r,
    scrollTop: 0, scrollLeft: 0, clientWidth: r.width, clientHeight: r.height, scrollHeight: r.height,
    __cs: { ...BASE_CS, ...cs },
    getAttribute: (n: string) => attrs[n] ?? null,
    querySelectorAll: (sel: string) => {
      const names = sel.split(',').map((s) => s.trim().toUpperCase());
      const found: FakeEl[] = [];
      const walk = (n: FakeEl): void => {
        for (const k of (n.children as FakeEl[]) ?? []) {
          if (names.includes(k.tagName as string)) found.push(k);
          walk(k);
        }
      };
      walk(el);
      return found;
    },
  };
  for (const k of kids) (k as { parentElement?: FakeEl }).parentElement = el;
  return el;
}

async function extract(root: FakeEl): Promise<any> {
  const fakeDoc = {
    querySelectorAll: () => [root],
    createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(0, 0, 1, 1) }),
    fonts: { status: 'loaded' },
    documentElement: { clientWidth: 420 },
  };
  const fn = new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
    fakeDoc, { innerWidth: 420 }, { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    (el: FakeEl) => el.__cs ?? BASE_CS,
  );
  const res = await fn(['.x']);
  return res.snapshots ? res.snapshots[0] : res[0];
}

const path = (fill: string, extra: Record<string, string> = {}, attrs: Record<string, string> = {}) =>
  makeEl('path', rect(2, 2, 12, 12), [], { fill, ...extra }, attrs);
const svgOf = (paths: FakeEl[], cs: Record<string, string> = {}) =>
  makeEl('svg', rect(0, 0, 16, 16), paths, cs);
const rootWith = (kids: FakeEl[]) => makeEl('main', rect(0, 0, 300, 40), kids);

describe('icon color capture (phase 1)', () => {
  it('a single-color multi-path svg -> iconColor with the shared hex', async () => {
    const svg = svgOf([path('rgb(36, 36, 41)'), path('rgb(36, 36, 41)')]);
    const snap = await extract(rootWith([svg]));
    const child = snap.children[0];
    expect(child.tag).toBe('svg');
    expect(child.styles.iconColor).toBe('#242429');
    expect(child.styles.iconColorMulti).toBeUndefined();
  });
  it('differing path fills -> iconColorMulti, never a confident hex', async () => {
    const svg = svgOf([path('rgb(36, 36, 41)'), path('rgb(108, 93, 211)')]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBeUndefined();
    expect(snap.children[0].styles.iconColorMulti).toBe(true);
  });
  it('outline icons: fill none -> the stroke carries the color', async () => {
    const svg = svgOf([path('none', { stroke: 'rgb(36, 36, 41)' })]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBe('#242429');
  });
  it('alpha folds: rgba fill x fill-opacity x element opacity chain -> 8-digit hex', async () => {
    // 0.5 (rgba) * 0.6 (fill-opacity) * 0.8 (path opacity) = 0.24 -> 0x3d
    const svg = svgOf([path('rgba(17, 17, 17, 0.5)', { fillOpacity: '0.6', opacity: '0.8' })]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBe('#1111113d');
  });
  it('unreadable paint (url(#grad)) -> an explicit iconColorUnknown, never silence', async () => {
    const svg = svgOf([path('url("#grad")')]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBeUndefined();
    expect(typeof snap.children[0].styles.iconColorUnknown).toBe('string');
  });
  it('a wrapper spanning one svg is surveyed too (the padded-span shape)', async () => {
    const svg = svgOf([path('rgb(36, 36, 41)')]);
    const span = makeEl('span', rect(0, 0, 24, 24), [svg]);
    const snap = await extract(rootWith([span]));
    expect(snap.children[0].tag).toBe('span');
    expect(snap.children[0].styles.iconColor).toBe('#242429');
  });
  it('a wrapper whose svg covers less than half the box is NOT claimed', async () => {
    const svg = makeEl('svg', rect(0, 0, 8, 8), [path('rgb(36, 36, 41)')]);
    const wide = makeEl('span', rect(0, 0, 60, 24), [svg]);
    const snap = await extract(rootWith([wide]));
    expect(snap.children[0].styles.iconColor).toBeUndefined();
    expect(snap.children[0].styles.iconColorUnknown).toBeUndefined();
  });
  it('an attribute whose VALUE produced the pixel classifies as a LITERAL', async () => {
    const svg = svgOf([path('rgb(36, 36, 41)', {}, { fill: '#242429' })]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColorToken).toEqual({ literal: true });
  });
  it('fill="currentColor" is a deferral, NEVER a literal (the ecosystem-dominant icon idiom)', async () => {
    const svg = svgOf([path('rgb(36, 36, 41)', {}, { fill: 'currentColor' })]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBe('#242429');
    expect(snap.children[0].styles.iconColorToken).not.toEqual({ literal: true });
  });
  it('an attribute beaten by author CSS painted nothing - not a literal either', async () => {
    const svg = svgOf([path('rgb(36, 36, 41)', {}, { fill: '#ff0000' })]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColorToken).not.toEqual({ literal: true });
  });
  it('a value-anchored STROKE attribute is a literal through the stroke property', async () => {
    const svg = svgOf([path('none', { stroke: 'rgb(36, 36, 41)' }, { stroke: '#242429' })]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBe('#242429');
    expect(snap.children[0].styles.iconColorToken).toEqual({ literal: true });
  });
  it('parts under a display:none ancestor are invisible (display does not inherit)', async () => {
    const hidden = makeEl('g', rect(0, 0, 16, 16), [path('rgb(255, 0, 0)')], { display: 'none' });
    const svg = svgOf([hidden, path('rgb(36, 36, 41)')]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBe('#242429');
    expect(snap.children[0].styles.iconColorMulti).toBeUndefined();
  });
  it('template geometry (defs/clipPath/mask) is not rendered - not surveyed', async () => {
    const defs = makeEl('defs', rect(0, 0, 0, 0), [path('rgb(255, 0, 0)')]);
    const svg = svgOf([defs, path('rgb(36, 36, 41)')]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBe('#242429');
    expect(snap.children[0].styles.iconColorMulti).toBeUndefined();
  });
  it('a fully transparent paint contributes nothing - never the false "unreadable"', async () => {
    const svg = svgOf([path('rgba(0, 0, 0, 0)'), path('rgb(36, 36, 41)')]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBe('#242429');
    expect(snap.children[0].styles.iconColorUnknown).toBeUndefined();
  });
  it('pure BLACK - the SVG-initial and commonest icon color - is a color, not transparency', async () => {
    const svg = svgOf([path('rgb(0, 0, 0)')]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBe('#000000');
    expect(snap.children[0].styles.iconColorUnknown).toBeUndefined();
  });
  it('a zero-blue channel never reads as transparent: black + purple is MULTI, not purple', async () => {
    const svg = svgOf([path('rgb(0, 0, 0)'), path('rgb(108, 93, 211)')]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBeUndefined();
    expect(snap.children[0].styles.iconColorMulti).toBe(true);
  });
  it('an anchored #fff shorthand attribute is a literal too (litHex, not a parser subset)', async () => {
    const svg = svgOf([path('rgb(255, 255, 255)', {}, { fill: '#fff' })]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColorToken).toEqual({ literal: true });
  });
  it('the WRAPPER\'s own opacity folds into the hex (the projector folds the candidate\'s)', async () => {
    const svg = svgOf([path('rgb(17, 17, 17)')]);
    const span = makeEl('span', rect(0, 0, 24, 24), [svg], { opacity: '0.5' });
    const snap = await extract(rootWith([span]));
    expect(snap.children[0].styles.iconColor).toBe('#11111180');
  });
  it('one readable part + one unreadable part -> unknown, the hex is never claimed', async () => {
    const svg = svgOf([path('rgb(36, 36, 41)'), path('url("#grad")')]);
    const snap = await extract(rootWith([svg]));
    expect(snap.children[0].styles.iconColor).toBeUndefined();
    expect(snap.children[0].styles.iconColorUnknown).toMatch(/unreadable/);
  });
  it('the half-cover threshold is per-DIMENSION: one passing dimension is not enough', async () => {
    const svg = makeEl('svg', rect(0, 0, 16, 8), [path('rgb(36, 36, 41)')]);
    const wide = makeEl('span', rect(0, 0, 24, 24), [svg]);
    const snap = await extract(rootWith([wide]));
    expect(snap.children[0].styles.iconColor).toBeUndefined();
  });
  it('non-svg children carry NO icon fields (absence stays meaningful)', async () => {
    const div = makeEl('div', rect(0, 0, 40, 40), []);
    const snap = await extract(rootWith([div]));
    expect(snap.children[0].styles.iconColor).toBeUndefined();
    expect(snap.children[0].styles.iconColorUnknown).toBeUndefined();
  });
  it('the pair ROOT itself an svg is surveyed (the direct icon pair)', async () => {
    const svg = svgOf([path('rgb(36, 36, 41)')]);
    svg.classList = ['x'];
    const snap = await extract(svg as FakeEl);
    expect(snap.styles.iconColor).toBe('#242429');
  });
});
