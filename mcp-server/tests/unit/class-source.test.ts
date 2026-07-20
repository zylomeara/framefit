import { describe, it, expect } from 'vitest';
import { parseCssModuleClass, hintForNode } from '../../src/domain/layout-spec/class-source.js';

describe('parseCssModuleClass — conservative CSS-modules parse', () => {
  // P1 Turbopack: the extension is CAPTURED (hardcoding .scss = false navigation)
  it('P1: a typical turbopack class + all 4 extensions', () => {
    expect(parseCssModuleClass('ds-header-module-scss-module__Qz4fXy__logoWrapper'))
      .toEqual({ module: 'ds-header.module.scss', local: 'logoWrapper', raw: 'ds-header-module-scss-module__Qz4fXy__logoWrapper' });
    expect(parseCssModuleClass('ds-banner-module-css-module__aB12cd__container')?.module).toBe('ds-banner.module.css');
    expect(parseCssModuleClass('foo-module-sass-module__aB12cd__root')?.module).toBe('foo.module.sass');
    expect(parseCssModuleClass('foo-module-less-module__aB12cd__root')?.module).toBe('foo.module.less');
  });
  // P2 Webpack: digit-lookahead, PascalCase local
  it('P2: both formats, PascalCase, module without an extension', () => {
    expect(parseCssModuleClass('header_logoWrapper__1a2b3c')).toEqual({ module: 'header', local: 'logoWrapper', raw: 'header_logoWrapper__1a2b3c' });
    expect(parseCssModuleClass('modal__body___a1B2c3')?.local).toBe('body');
    expect(parseCssModuleClass('Header_Button__1a2b3c')).toEqual({ module: 'Header', local: 'Button', raw: 'Header_Button__1a2b3c' });
  });
  it('P3 Vite: local without module, digit-lookahead', () => {
    expect(parseCssModuleClass('_button_1a2b3')).toEqual({ local: 'button', raw: '_button_1a2b3' });
    expect(parseCssModuleClass('_menu_hover')).toBeNull();
  });
  // Negatives — FP worse than FN (each proven by execution)
  it('negatives: minified/utilities/BEM/words-without-hash → null', () => {
    for (const cls of ['ab12cd', 'flex', 'mt-4', 'hover:bg-red-500', 'card__title--big',
      'menu__item_state_active', 'menu__item_visible', 'grid_col__spacing_lg',
      'is_active__hover_state', 'promo__title___highlighted', 'Header_logo__wrapper', '']) {
      expect(parseCssModuleClass(cls), cls).toBeNull();
    }
  });
  // digit-suffixed utilities — a tail with `_`/`-` gives away a utility,
  // not a hash; the mutation "allow _ in the tail" → RED here. A conscious residual: a pure
  // alphanumeric word-with-a-digit (`font_weight__bold700`) is indistinguishable from a hash — it hedges
  // the consumer rule "the resolve is not confirmed until the file is found".
  it('negatives with digits: utilities with _/- in the tail → null', () => {
    for (const cls of ['col_span__grid_12', 'p_x__mt_10', 'z_index__layer_10',
      'nav_item__depth_2', 'max_w__screen_2xl', 'btn_primary__size_lg2',
      'row_start__col_end_12', 'grid_cols__span_2']) {
      expect(parseCssModuleClass(cls), cls).toBeNull();
    }
  });
  // Pattern order is load-bearing: a turbopack class is NOT eaten by P2
  it('order: a turbopack class parses via P1 (module with extension), not garbage via P2', () => {
    const h = parseCssModuleClass('ds-header-module-scss-module__Qz4fXy__logoWrapper');
    expect(h?.module).toBe('ds-header.module.scss'); // P2 garbage would give module='ds-header-module-scss-module...' stub
  });
  // OVERLAP order lock: on a SIMPLE turbopack class P1/P2 are disjoint
  // (P2 requires a __hash TAIL after the local, and turbopack's local is last), and the order
  // mutation is a no-op there. The set intersection exists exactly on a turbopack class whose local
  // itself looks like `x__hash1`: P2, run first, would parse it into a stub
  // (module='foo-module-css-module__ab1c'). Synthetic, but it pins the P1→P2 order the only
  // way possible; the mutation "P2 before P1" → RED here.
  it('order on the overlap class: P1 beats P2 (module with extension, full local)', () => {
    expect(parseCssModuleClass('foo-module-css-module__ab1c__bar__baz123'))
      .toEqual({ module: 'foo.module.css', local: 'bar__baz123', raw: 'foo-module-css-module__ab1c__bar__baz123' });
  });
});

describe('hintForNode — picking a class from classList', () => {
  it('variant class first: prefer a local WITHOUT the BEM modifier of the same module', () => {
    const h = hintForNode([
      'ds-link-module-scss-module__Fq7wLa__variant--neutral',
      'ds-link-module-scss-module__Fq7wLa__root',
    ]);
    expect(h?.local).toBe('root'); // the mutation "take the first parse" → RED
  });
  it('a single variant class → it is the hint (better than nothing)', () => {
    expect(hintForNode(['ds-link-module-scss-module__Fq7wLa__variant--neutral'])?.local).toBe('variant--neutral');
  });
  it('empty/undefined/unparseable → null', () => {
    expect(hintForNode(undefined)).toBeNull();
    expect(hintForNode([])).toBeNull();
    expect(hintForNode(['flex', 'ab12cd'])).toBeNull();
  });
});
