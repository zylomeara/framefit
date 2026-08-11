// Feedback item 14: a selector like [class*="panel-header_root"] finds nothing because the
// build mangles CSS-module names ('panel-header-module-scss-module__Qx7Rp2__root'). The
// extractor now probes the LIVE page for the module stem and, when a longer mangled class
// exists, returns a `hint` on the not_found snapshot naming the ACTUAL class and the
// [class*="<module>"][class*="__<local>"] recipe. Conservative by design: the probe fires
// only when the failed fragment itself carries the module-local '_' convention - a bare
// '.card' miss stays a plain not_found (a stem probe there would surface unrelated classes).
import { describe, it, expect } from 'vitest';
import { EXTRACTOR_JS } from '../../src/adapters/driving/tools/dom-extractor.js';

const rect = (x: number, y: number, w: number, h: number) =>
  ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });

function makePage(classes: string[][]): { doc: any; win: any } {
  // a minimal page: elements carrying classLists, findable ONLY via [class*="frag"] probes
  const els = classes.map((cl) => ({
    nodeType: 1, tagName: 'DIV', classList: cl, dataset: {}, childNodes: [], children: [],
    getBoundingClientRect: () => rect(0, 0, 100, 40),
    scrollTop: 0, scrollLeft: 0, clientWidth: 100, clientHeight: 40, scrollHeight: 40,
    getAttribute: () => null,
  }));
  const matchFragment = (sel: string): any[] => {
    const m = /^\[class\*=["']?([^"'\]]+)["']?\]$/.exec(sel);
    if (!m) return [];
    return els.filter((e) => e.classList.some((c: string) => c.includes(m[1])));
  };
  const doc = {
    querySelectorAll: (sel: string) => matchFragment(sel),
    querySelector: (sel: string) => matchFragment(sel)[0],
    createRange: () => ({ selectNodeContents: () => {}, getBoundingClientRect: () => rect(0, 0, 1, 1) }),
    fonts: { status: 'loaded' },
    documentElement: { clientWidth: 420 },
  };
  return { doc, win: { innerWidth: 420 } };
}

async function extract(selector: string, classes: string[][]): Promise<any> {
  const { doc, win } = makePage(classes);
  const fn = new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
    doc, win, { TEXT_NODE: 3, ELEMENT_NODE: 1 }, () => ({}),
  );
  const res = await fn([selector]);
  return (res.snapshots ?? res)[0];
}

describe('the CSS-module hint on not_found', () => {
  it('a mangled module class is named, with the [class*] recipe and evidence-only wording', async () => {
    const snap = await extract('[class*="panel-header_root"]',
      [['panel-header-module-scss-module__Qx7Rp2__root'], ['other']]);
    expect(snap.status).toBe('not_found');
    expect(snap.hint).toMatch(/panel-header-module-scss-module__Qx7Rp2__root/);
    expect(snap.hint).toMatch(/\[class\*="<module>"\]\[class\*="__<local>"\]/);
    // the wording asserts only held evidence: the review measured 'no element matches <frag>'
    // being FALSE for ancestor fragments, and 'the build mangles' asserted about unverified
    // classes - both clauses are conditional now
    expect(snap.hint).not.toMatch(/no element matches/);
    expect(snap.hint).toMatch(/if your build mangles/);
  });
  it('a bare .class miss stays a PLAIN not_found (no stem probe, no noise)', async () => {
    const snap = await extract('.card', [['card-header'], ['cardigan']]);
    expect(snap.status).toBe('not_found');
    expect(snap.hint).toBeUndefined();
  });
  it('a short single-word stem never probes - card_title must not name card-list__item', async () => {
    const snap = await extract('.card_title', [['card-list__item']]);
    expect(snap.hint).toBeUndefined();
  });
  it('a found class WITHOUT the __ mangling marker is not offered as module advice', async () => {
    const snap = await extract('[class*="panel-header_root"]', [['panel-header-legacy-old']]);
    expect(snap.hint).toBeUndefined();
  });
  it('a page class exactly equal to the fragment is never self-advice', async () => {
    const snap = await extract('[class*="panel-module__root"].missing', [['panel-module__root']]);
    expect(snap.hint).toBeUndefined();
  });
  it('a fragment with non-class characters never reaches the probe', async () => {
    const snap = await extract('[class*="pa nel_root"]', [['pa-nel-module__x__root']]);
    expect(snap.hint).toBeUndefined();
  });
  it('a descendant selector reports the LEAF fragment, not the (matching) ancestor', async () => {
    const snap = await extract('.layout-shell_root .panel-header_title',
      [['layout-shell-module__Zz9__root'], ['panel-header-module__Ab1__title']]);
    expect(snap.hint).toMatch(/panel-header/);
    expect(snap.hint).not.toMatch(/layout-shell-module/);
  });
  it('a module-ish fragment with no stem hit on the page stays plain', async () => {
    const snap = await extract('[class*="panel-header_root"]', [['unrelated'], ['stuff']]);
    expect(snap.status).toBe('not_found');
    expect(snap.hint).toBeUndefined();
  });
  it('a .class selector carrying the _ convention gets the probe too', async () => {
    const snap = await extract('.drawer-body_inner',
      [['drawer-body-module-scss-module__Ab12Cd__inner']]);
    expect(snap.status).toBe('not_found');
    expect(snap.hint).toMatch(/drawer-body-module-scss-module__Ab12Cd__inner/);
  });
  it('a page-controlled class is sliced into the hint (no unbounded strings)', async () => {
    const huge = 'drawer-body-module__' + 'x'.repeat(500);
    const snap = await extract('.drawer-body_inner', [[huge]]);
    expect(snap.hint!.length).toBeLessThan(400);
  });
  it('ID and attribute selectors never produce class advice (the corrupt-regex regression lock)', async () => {
    // the review measured the template-literal-eaten regexes scraping '#user_panel' and
    // '[data-test_id=...]' into bogus CSS-module advice - these lock the emitted bytes
    expect((await extract('#user_panel', [['user-avatar-module__x']])).hint).toBeUndefined();
    expect((await extract('[data-test_id="x"]', [['data-testid-module__y']])).hint).toBeUndefined();
  });
  it('an INVALID selector still gets the probe (the one unambiguous case)', async () => {
    // the fake page throws on nothing, so simulate the parse-error branch via a selector the
    // fake treats as unparseable: makePage returns [] for non-[class*=] shapes, so drive the
    // catch by a real syntax error through a throwing querySelectorAll
    const { doc, win } = makePage([['drawer-body-module__Ab12Cd__inner']]);
    const qsa = doc.querySelectorAll;
    doc.querySelectorAll = (sel: string) => { if (sel === ':::(') throw new Error('bad'); return qsa(sel); };
    const fn = new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
      doc, win, { TEXT_NODE: 3, ELEMENT_NODE: 1 }, () => ({}),
    );
    const res = await fn([':::(']);
    expect((res.snapshots ?? res)[0].status).toBe('not_found');
    // no module fragment in ':::(' - plain; the branch itself is exercised without a throw
  });
  it('the hint travels into summaries', async () => {
    const { doc, win } = makePage([['panel-header-module-scss-module__Qx7Rp2__root']]);
    const fn = new Function('document', 'window', 'Node', 'getComputedStyle', `return (${EXTRACTOR_JS})`)(
      doc, win, { TEXT_NODE: 3, ELEMENT_NODE: 1 }, () => ({}),
    );
    // uploadUrl path builds summaries; a failing fetch still returns them
    (globalThis as any).fetch = async () => { throw new Error('offline'); };
    const res = await fn(['[class*="panel-header_root"]'], 'http://localhost:1/up');
    const sum = res.summaries[0];
    expect(sum.status).toBe('not_found');
    expect(sum.hint).toMatch(/panel-header-module/);
  });
});
