import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetLayoutSpecTool } from '../../src/adapters/driving/tools/get-layout-spec-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { FETCH_DEPTH } from '../../src/domain/layout-spec/projector.js';
import { withFrameRaw } from './helpers/frame-raw.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';
import { RESULT_BUDGET_BYTES } from '../../src/adapters/driving/tools/response-budget.js';

const logger = createLogger({ level: 'silent' });
// Repo layout: <root>/mcp-server/tests/unit/<this file>.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Run a paste form the way chrome-devtools evaluate_script does: substitute the extractor into the
 * `<extractor_js VERBATIM>` slot, evaluate `(<what you sent>)`, then CALL the result with no
 * arguments and await it (the wrapper does `await fn(...args)`; a sync `expect(() => fn())` cannot
 * see a rejected promise, so this awaits and a future async form stays covered).
 *
 * The substitution takes a REPLACER FUNCTION, not a replacement string: EXTRACTOR_JS contains `$&`
 * and `$'`, which String.replace expands in a replacement string -- measured, that made the script
 * it evaluated 54213 chars against the extractor's 54164, diverging from char 27592, so the proof
 * proved a string nobody ships. The containment assert below is what keeps that honest.
 */
async function runsPasteForm(pasteForm: string, extractorJs: string, where: string): Promise<void> {
  const fnString = pasteForm.replace('<extractor_js VERBATIM>', () => extractorJs);
  expect(fnString.includes(extractorJs), `${where}: the substituted script is not the extractor byte for byte`).toBe(true);
  const fakeWindow: { __extract?: unknown } = {};
  const fn = new Function('window', `return (${fnString})`)(fakeWindow) as () => unknown;
  await expect((async () => fn())(), `${where}: the paste form throws when evaluate_script calls it`).resolves.toBeDefined();
  expect(typeof fakeWindow.__extract, `${where}: window.__extract is not a function after the paste`).toBe('function');
}

/**
 * The PER-CAPTURE form -- `async () => { const extract = <extractor_js VERBATIM>; return await
 * extract([…]); }` -- lifted out of whatever text carries it. One regex for all three sites: the
 * delivered `upload_hint` prints it on one line, the two doc pages print it as a fenced block.
 * Non-greedy to the first `}`, which is the thunk's own closer everywhere it ships.
 */
const CAPTURE_FORM_RE = /async \(\) => \{[\s\S]*?const extract = <extractor_js VERBATIM>;[\s\S]*?\}/;

/**
 * Run the per-capture form the way `runsPasteForm` runs the paste-once one. It is the form used on
 * EVERY capture and it was executed by NOTHING: measured, regressing it to the same non-executing
 * shape the paste-once form was just repaired for left the suite bit-identical to baseline. Precise
 * about "bit-identical": that holds for the two doc pages under every regression, and for the
 * delivered upload_hint under the narrow one (dropping the opening `async () => {`). A wider
 * regression that also drops the trailing `; }` already reddened a pre-existing row further down,
 * which pins the closing brace -- so the delivered carrier was never quite blind, only nearly.
 *
 * Two steps, because one of the form's reader placeholders IS the extractor:
 *
 *  1. With the real EXTRACTOR_JS in the `<extractor_js VERBATIM>` slot, byte for byte: evaluate
 *     `(<what you sent>)` the way chrome-devtools evaluate_script does, and require a callable back.
 *     This is the step a non-executing shape fails -- `const extract = <script>;` outside a thunk
 *     does not parse inside `(…)` at all.
 *  2. With a PROBE in that slot: CALL the result with no arguments and await it, and watch the call
 *     ARRIVE at `extract` with a selectors array. Running the real extractor here is neither the
 *     point nor possible -- it needs a live DOM and would POST to the literal "<upload_url>"
 *     placeholder; what this row is about is the CALL FORM around it.
 *
 * The only text touched is what a reader replaces: `<extractor_js VERBATIM>`, and the `…` that
 * stands for "more selectors here" and is not JS. Everything else runs exactly as it ships.
 */
async function runsCaptureForm(captureForm: string, extractorJs: string, where: string): Promise<void> {
  const fill = (slot: string): string =>
    captureForm.replace(/,\s*…/gu, '').replace('<extractor_js VERBATIM>', () => slot);

  const real = fill(extractorJs);
  expect(real.includes(extractorJs), `${where}: the substituted script is not the extractor byte for byte`).toBe(true);
  expect(typeof new Function(`return (${real})`)(), `${where}: the capture form does not evaluate to a callable`).toBe('function');

  const calls: unknown[][] = [];
  const probe = 'async (...a) => { __calls.push(a); return { snapshot_ref: "r", summaries: [] }; }';
  const fn = new Function('__calls', `return (${fill(probe)})`)(calls) as () => unknown;
  // Two failures reach this row, so the label names both: the form THROWING when evaluate_script
  // calls it, and the form resolving to NOTHING because it never returned the extractor's result
  // (measured: a thunk that assigns `extract` and returns nothing lands here, and it did not throw).
  await expect((async () => fn())(), `${where}: the capture form throws, or resolves to nothing, when evaluate_script calls it`).resolves.toBeDefined();
  expect(calls.length, `${where}: the capture form never calls the extractor`).toBe(1);
  expect(Array.isArray(calls[0][0]), `${where}: the extractor is not called with a selectors array`).toBe(true);
}

function harness(api: Partial<FigmaApi>, depsOverrides: Partial<ToolDeps> = {}) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => withFrameRaw(api) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000, ...depsOverrides };
  registerGetLayoutSpecTool(server, deps);
  return (a: any): Promise<any> => call('get_layout_spec', a);
}

const doc: RawSceneNode = {
  id: '1:1', name: 'frame', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 800 },
  layoutMode: 'VERTICAL', itemSpacing: 20,
  children: [{ id: '1:2', name: 'title', type: 'TEXT', absoluteBoundingBox: { x: 16, y: 0, width: 300, height: 24 } }],
};

describe('get_layout_spec tool', () => {
  it('normalizes ids, fetches FETCH_DEPTH in one batch, returns specs', async () => {
    expect(FETCH_DEPTH).toBe(5); // 4→5 (peek headroom): projection stays L4, raw fetch peeks L5
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
    const run = harness({ getNodesRaw });
    const res = await run({ file: 'abc', node_ids: ['1-1'], include_extractor: false });
    expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1'], 5);
    const out = JSON.parse(res.content[0].text);
    expect(out.snapshot_schema).toBe(7);
    expect(out.specs[0].spec.rect.w).toBe(375);
    expect(out.specs[0].spec.children[0].name).toBe('title');
    expect(out.extractor_js).toBeUndefined();
  });

  it('include_extractor returns the canonical script', async () => {
    const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: doc } } })) });
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
    expect(out.extractor_js).toContain('const SCHEMA = 7;');
  });

  it('include_extractor script slices text at SNIPPET_CAP 120, not the old 40', async () => {
    const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: doc } } })) });
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
    expect(out.extractor_js).toContain('slice(0, 120)');
    expect(out.extractor_js).not.toContain('slice(0, 40)');
  });

  it('missing node → per-id error, others survive', async () => {
    const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: doc }, '9:9': null } })) });
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1', '9:9'] })).content[0].text);
    expect(out.specs).toHaveLength(2);
    expect(out.specs[1]).toEqual({ node_id: '9:9', error: 'not found' });
  });

  it('resolves component set names via getComponent + getFileComponentSets (best-effort)', async () => {
    const instanceDoc = { ...doc, id: '2:1', children: [], componentId: '5:1' };
    const getNodesRaw = vi.fn(async () => ({ nodes: { '2:1': {
      document: instanceDoc, components: { '5:1': { key: 'pubkey', name: 'Type=Basic', componentSetId: '4:1' } },
    } } }));
    const getComponent = vi.fn(async () => ({ key: 'pubkey', file_key: 'libfile', node_id: '5:1', name: 'Type=Basic' }));
    const getFileComponentSets = vi.fn(async () => ([{ key: 'sk', file_key: 'libfile', node_id: '4:1', name: 'listItem', description: '' }]));
    const run = harness({ getNodesRaw, getComponent, getFileComponentSets });
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['2:1'] })).content[0].text);
    expect(out.specs[0].spec.component).toMatchObject({ name: 'Type=Basic', setName: 'listItem' });
  });

  // MUTATION LOCK on the meta-first path buildSetNames(api, entry, …). The componentSets meta
  // of the /nodes response already carries the set name → setName resolves FROM IT, the REST cascade (getComponent→
  // getFileComponentSets) is NOT called. Fixture: components '5:1' with componentSetId+key (which would make
  // legacy resolveSetNames(api, entry.components) call getComponent), BUT componentSets '4:1' covers the
  // setId via the meta. The mutation "revert to resolveSetNames(api, entry.components, …)" → getComponent('pubkey')
  // called + setName lost → RED on both asserts. Mirror of compare :201.
  it('setName from the componentSets meta → spec.component.setName from the meta, getComponent NOT called (meta-first buildSetNames)', async () => {
    const instanceDoc = { ...doc, id: '2:1', children: [], componentId: '5:1' };
    const getNodesRaw = vi.fn(async () => ({ nodes: { '2:1': {
      document: instanceDoc,
      components: { '5:1': { key: 'pubkey', name: 'Type=Basic', remote: true, componentSetId: '4:1' } },
      componentSets: { '4:1': { key: 'sk1', name: 'listItem', remote: true } },
    } } }));
    const getComponent = vi.fn();
    const run = harness({ getNodesRaw, getComponent });
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['2:1'] })).content[0].text);
    expect(out.specs[0].spec.component).toMatchObject({ name: 'Type=Basic', setName: 'listItem' });
    expect(getComponent).not.toHaveBeenCalled(); // meta-resolve: zero /v1/components fetches
  });

  describe('upload_url minting', () => {
    function mockStore(capToken = 'cap-token-abc') {
      return { mint: vi.fn(() => capToken) } as unknown as ToolDeps['snapshotStore'];
    }
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));

    it('include_extractor + snapshotStore + publicBaseUrl → mints upload_url with tenantId, plus upload_hint', async () => {
      const snapshotStore = mockStore('cap-token-abc');
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test', tenantId: 'user-42' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      // (a') mint-meta (viewport-ergonomics T3, a DELIBERATE UPDATE): mint is now two-argument —
      // the fixture `doc` gives rect.w 375, so expectedWidths is non-empty. toHaveBeenCalledWith matches
      // the FULL argument list, so the old single-argument lock would break (RED) without this update.
      expect(snapshotStore!.mint).toHaveBeenCalledWith('user-42', { expectedWidths: [375] });
      expect(out.upload_url).toBe('https://figma.test/api/dom-snapshots/cap-token-abc');
      expect(typeof out.upload_hint).toBe('string');
      expect(out.upload_hint.length).toBeGreaterThan(0);
    });

    it('defaults tenantId to "local" when deps.tenantId is undefined', async () => {
      const snapshotStore = mockStore();
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test' });
      await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true });
      expect(snapshotStore!.mint).toHaveBeenCalledWith('local', { expectedWidths: [375] });
    });

    it("(a') mint-meta: expectedWidths = the rounded rect.w of ALL successful nodes, deduped by width, error nodes excluded", async () => {
      const dup = { ...doc, id: '1:3' }; // the same width 375 as doc — should collapse into a single element
      const wideDoc = { ...doc, id: '2:2', absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 800 } };
      const snapshotStore = mockStore('cap-token-multi');
      const getNodesRawMulti = vi.fn(async () => ({ nodes: {
        '1:1': { document: doc }, '1:3': { document: dup }, '2:2': { document: wideDoc }, '9:9': null,
      } }));
      const run = harness({ getNodesRaw: getNodesRawMulti }, { snapshotStore, publicBaseUrl: 'https://figma.test', tenantId: 'user-42' });
      await run({ file: 'abc', node_ids: ['1:1', '1:3', '2:2', '9:9'], include_extractor: true });
      expect(snapshotStore!.mint).toHaveBeenCalledWith('user-42', { expectedWidths: [375, 1920] });
    });

    it("(a') no successful nodes (all error) → mint is called WITHOUT meta (undefined, not {expectedWidths:[]})", async () => {
      const snapshotStore = mockStore('cap-token-empty');
      const getNodesRawNone = vi.fn(async () => ({ nodes: { '9:9': null } }));
      const run = harness({ getNodesRaw: getNodesRawNone }, { snapshotStore, publicBaseUrl: 'https://figma.test', tenantId: 'user-42' });
      await run({ file: 'abc', node_ids: ['9:9'], include_extractor: true });
      expect(snapshotStore!.mint).toHaveBeenCalledWith('user-42', undefined);
    });

    it('without include_extractor → no upload_url even with store+baseUrl', async () => {
      const snapshotStore = mockStore();
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: false })).content[0].text);
      expect(out.upload_url).toBeUndefined();
      expect(out.upload_hint).toBeUndefined();
      expect(snapshotStore!.mint).not.toHaveBeenCalled();
    });

    it('without publicBaseUrl → no upload_url even with include_extractor + store', async () => {
      const snapshotStore = mockStore();
      const run = harness({ getNodesRaw }, { snapshotStore });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(out.upload_url).toBeUndefined();
      expect(out.upload_hint).toBeUndefined();
      expect(snapshotStore!.mint).not.toHaveBeenCalled();
    });

    it('without snapshotStore → no upload_url even with include_extractor + publicBaseUrl', async () => {
      const run = harness({ getNodesRaw }, { publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(out.upload_url).toBeUndefined();
      expect(out.upload_hint).toBeUndefined();
    });
  });

  describe('extractor_mode (loader/inline)', () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));

    it('bridge-shaped deps return the short loader, upload URL, and dom_ref instructions', async () => {
      const snapshotStore = { mint: vi.fn(() => 'stdio-cap-token') } as unknown as ToolDeps['snapshotStore'];
      const run = harness({ getNodesRaw }, {
        snapshotStore,
        publicBaseUrl: 'http://127.0.0.1:3846',
        tenantId: 'local',
      });
      const out = JSON.parse((await run({
        file: 'abc', node_ids: ['1:1'], include_extractor: true,
      })).content[0].text);

      expect(out.extractor_js).toContain('/api/dom-snapshots/extractor.js');
      expect(out.extractor_js).not.toContain('pruneToBudget');
      expect(out.upload_url).toBe('http://127.0.0.1:3846/api/dom-snapshots/stdio-cap-token');
      expect(out.upload_hint).toContain('dom_ref');
    });

    it('default mode (loader) + publicBaseUrl → thunk pointing at /api/dom-snapshots/extractor.js, not the full script', async () => {
      const run = harness({ getNodesRaw }, { publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(out.extractor_js).toContain('__figmaDomDiff');
      expect(out.extractor_js).toContain('/api/dom-snapshots/extractor.js');
      expect(out.extractor_js).not.toContain('pruneToBudget');
      expect(out.extractor_note).toBeUndefined();
    });

    it('extractor_mode: "inline" → full canonical script even when publicBaseUrl is set', async () => {
      const run = harness({ getNodesRaw }, { publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true, extractor_mode: 'inline' })).content[0].text);
      expect(out.extractor_js).toContain('pruneToBudget');
      expect(out.extractor_note).toBeUndefined();
    });

    it('loader mode without publicBaseUrl → falls back to the full script + an honest extractor_note', async () => {
      const run = harness({ getNodesRaw }); // no publicBaseUrl
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(out.extractor_js).toContain('pruneToBudget');
      expect(out.extractor_note).toBe('loader unavailable without public base URL — inline returned');
    });

    it('bridge startup failure adds the exact receipt only when the extractor is requested', async () => {
      const browserBridgeDegraded = {
        status: 'unavailable' as const,
        reason: 'loopback bridge could not start; using inline extractor' as const,
      };
      const run = harness({ getNodesRaw }, { browserBridgeDegraded } as Partial<ToolDeps>);

      const withExtractor = JSON.parse((await run({
        file: 'abc', node_ids: ['1:1'], include_extractor: true,
      })).content[0].text);
      expect(withExtractor.extractor_js).toContain('pruneToBudget');
      expect(withExtractor.browser_bridge).toEqual(browserBridgeDegraded);

      const withoutExtractor = JSON.parse((await run({
        file: 'abc', node_ids: ['1:1'], include_extractor: false,
      })).content[0].text);
      expect(withoutExtractor.browser_bridge).toBeUndefined();
    });
  });

  // The call-form guidance used to exist ONLY inside upload_hint, i.e. only on the branch a stdio
  // server never reaches: a stdio caller got the whole inline extractor and no instructions at all.
  describe('extractor_hint (the branch with no upload_url)', () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));

    it('names the 1-arg call form, the reusable handle, include_extractor:false and pairs[i].dom', async () => {
      const run = harness({ getNodesRaw }); // no publicBaseUrl, no snapshotStore
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(out.extractor_hint).toContain("() => { window.__extract = <extractor_js VERBATIM>; return 'ok'; }");
      expect(out.extractor_hint).toContain('await window.__extract(["<sel>", …])');
      expect(out.extractor_hint).toContain('include_extractor:false');
      expect(out.extractor_hint).toContain('pairs[i].dom');
    });

    // The previous version of the row above asserted `window.__extract = <extractor_js VERBATIM>;`,
    // which is what the hint said and what does not run: chrome-devtools evaluate_script evaluates
    // `(<what you sent>)` and CALLS the result with no arguments (chrome-devtools-mcp
    // build/src/tools/script.js, `evaluateHandle(\`(${fnString})\`)` then `fn(...args)` with an empty
    // args array -- byte-identical across installed versions 1.0.1 through 1.6.0). So the shipped
    // text was a SyntaxError with the trailing `;` and a TypeError inside the extractor without it,
    // and a toContain() gate went green on both. This row therefore does not read the hint, it RUNS
    // it, through the wrapper's own two steps.
    it('EXECUTES: the paste form the hint delivers really parks the extractor on window.__extract', async () => {
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);

      // Lift the paste form out of the delivered string -- no second copy of it in this file, so a
      // hint that stops carrying one fails here rather than testing a literal nobody ships.
      const pasteForm = /`(\(\) => \{ window\.__extract = <extractor_js VERBATIM>;[^`]*)`/.exec(out.extractor_hint)?.[1];
      expect(pasteForm, 'the hint carries no `() => { window.__extract = ... }` paste form').toBeDefined();

      await runsPasteForm(pasteForm!, out.extractor_js, 'the delivered extractor_hint');
    });

    // The hint is not the only place this form ships: three pages print it for a reader to paste, and
    // only the delivered string was executed here. Measured: putting the old non-executing
    // `window.__extract = <extractor_js VERBATIM>;` back on all three left the whole suite green. So
    // each page's copy is lifted and RUN, exactly as the delivered one is.
    it.each([
      ['README.md', "Tier 1's paste-once parenthetical"],
      ['docs/agents/design-qa-skill.md', 'the agent skill the workflow is written against'],
      ['docs/design-qa-tutorial.md', "the tutorial's step-2 paste block"],
    ])('EXECUTES: the paste form printed on %s runs too', async (page, what) => {
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);

      const text = readFileSync(path.join(REPO_ROOT, page), 'utf8');
      const pasteForm = /\(\) => \{ window\.__extract = <extractor_js VERBATIM>;[^`\n]*?\}/.exec(text)?.[0];
      expect(pasteForm, `${page} (${what}) prints no executable \`() => { window.__extract = ... }\` paste form`).toBeDefined();

      await runsPasteForm(pasteForm!, out.extractor_js, `${page} (${what})`);
    });

    it('EXECUTES: the per-capture form in the delivered upload_hint really calls the extractor', async () => {
      const snapshotStore = { mint: vi.fn(() => 'cap-token') } as unknown as ToolDeps['snapshotStore'];
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true, extractor_mode: 'inline' })).content[0].text);

      const form = CAPTURE_FORM_RE.exec(out.upload_hint)?.[0];
      expect(form, 'upload_hint carries no `async () => { const extract = … }` capture form').toBeDefined();
      await runsCaptureForm(form!, out.extractor_js, 'the delivered upload_hint');
    });

    // The per-capture form is not only delivered, it is PRINTED for a reader to paste. Only the
    // paste-once form was executed from these pages; measured, regressing the capture form here to a
    // non-executing shape left the suite bit-identical to baseline. So each page's copy is run too.
    it.each([
      ['docs/agents/design-qa-skill.md', 'the agent skill the workflow is written against'],
      ['docs/design-qa-tutorial.md', "the tutorial's extractor_js bullet"],
    ])('EXECUTES: the per-capture form printed on %s runs too', async (page, what) => {
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);

      const form = CAPTURE_FORM_RE.exec(readFileSync(path.join(REPO_ROOT, page), 'utf8'))?.[0];
      expect(form, `${page} (${what}) prints no executable \`async () => { const extract = … }\` capture form`).toBeDefined();
      await runsCaptureForm(form!, out.extractor_js, `${page} (${what})`);
    });

    it('carries depth/budget in the uploadUrl-less positional form when max_depth is given', async () => {
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true, max_depth: 6 })).content[0].text);
      expect(out.extractor_hint).toContain('await window.__extract(["<sel>", …], undefined, 5, 180)');
    });

    it('is absent where there IS an upload_url, and absent when no extractor was asked for', async () => {
      const snapshotStore = { mint: vi.fn(() => 'cap-token') } as unknown as ToolDeps['snapshotStore'];
      const withUpload = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test' });
      const uploaded = JSON.parse((await withUpload({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(uploaded.upload_hint).toBeDefined();
      expect(uploaded.extractor_hint).toBeUndefined();

      const run = harness({ getNodesRaw });
      const noExtractor = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'] })).content[0].text);
      expect(noExtractor.extractor_hint).toBeUndefined();
    });
  });

  describe('max_depth (drill-down)', () => {
    it('default (no max_depth) still fetches FETCH_DEPTH (5) — backward-compat', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw });
      await run({ file: 'abc', node_ids: ['1-1'], include_extractor: false });
      expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1'], 5);
    });

    it('max_depth:6 fetches max_depth+1 = 7', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw });
      await run({ file: 'abc', node_ids: ['1-1'], include_extractor: false, max_depth: 6 });
      expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1'], 7);
    });

    it('without max_depth: output is byte-for-byte the same as explicit max_depth:4 (backward-compat)', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw });
      const withoutField = JSON.parse((await run({ file: 'abc', node_ids: ['1-1'], include_extractor: false })).content[0].text);
      const withDefault = JSON.parse((await run({ file: 'abc', node_ids: ['1-1'], include_extractor: false, max_depth: 4 })).content[0].text);
      expect(withDefault).toEqual(withoutField);
    });

    it('upload_hint shows the 4-arg extractor call (depthLeft, budget) when max_depth is given', async () => {
      const snapshotStore = { mint: vi.fn(() => 'cap-token') } as unknown as ToolDeps['snapshotStore'];
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true, max_depth: 6 })).content[0].text);
      expect(out.upload_hint).toContain('"<upload_url>", 5, 180');
    });

    it('upload_hint stays the prior 2-arg call when max_depth is absent (backward-compat)', async () => {
      const snapshotStore = { mint: vi.fn(() => 'cap-token') } as unknown as ToolDeps['snapshotStore'];
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: doc } } }));
      const run = harness({ getNodesRaw }, { snapshotStore, publicBaseUrl: 'https://figma.test' });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], include_extractor: true })).content[0].text);
      expect(out.upload_hint).toContain('"<upload_url>"); }');
      expect(out.upload_hint).not.toMatch(/"<upload_url>",\s*\d/);
    });
  });

  describe('result budget clamp (design-QA payload)', () => {
    it('keeps an ordered positional prefix under the compact and pretty UTF-8 limit', async () => {
      const big: RawSceneNode = { id: 'n', name: 'n', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 9, height: 9 },
        children: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, name: '界'.repeat(1500) + i, type: 'TEXT',
          absoluteBoundingBox: { x: 0, y: i, width: 9, height: 1 }, characters: 'text',
          style: { fontFamily: 'Inter', fontSize: 12 } })) };
      const ids = [...Array.from({ length: 19 }, (_, i) => `${i}:1`), '0:1'];
      const nodes: Record<string, { document: RawSceneNode }> = {};
      for (const id of ids) nodes[id] = { document: { ...big, id } };
      const previous = process.env.MCP_PRETTY_JSON;

      try {
        for (const pretty of [false, true]) {
          if (pretty) process.env.MCP_PRETTY_JSON = 'true';
          else delete process.env.MCP_PRETTY_JSON;
          const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes })) });
          const result = await run({ file: 'abc', node_ids: ids, include_extractor: true, extractor_mode: 'inline' });
          const text = result.content[0].text;
          const out = JSON.parse(text);

          expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
          expect(text.startsWith('{\n')).toBe(pretty);
          expect(out.result_truncated).toBe(true);
          expect(out.extractor_js).toBeTruthy();
          expect(out.omitted_node_ids.length).toBeGreaterThan(0);
          expect(out.specs.length).toBeLessThan(ids.length);
          expect(out.specs.map((s: any) => s.node_id).concat(out.omitted_node_ids)).toEqual(ids);
          expect(out.hydration.map((h: any) => h.node_id)).toEqual(out.specs.map((s: any) => s.node_id));
        }
      } finally {
        if (previous === undefined) delete process.env.MCP_PRETTY_JSON;
        else process.env.MCP_PRETTY_JSON = previous;
      }
    });

    it('returns a bounded static error when one complete spec cannot fit', async () => {
      const big: RawSceneNode = { id: '1:1', name: 'root', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 9, height: 9 },
        children: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, name: '界'.repeat(20_000) + i, type: 'FRAME',
          absoluteBoundingBox: { x: 0, y: i, width: 9, height: 1 }, children: [] })) };
      const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: big } } })) });
      const result = await run({ file: 'abc', node_ids: ['1:1'] });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({
        code: 'response_too_large',
        reason: 'first_item_oversize',
        action: 'narrow_request',
      });
      expect(Buffer.byteLength(result.content[0].text, 'utf8')).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    });

    it('returns envelope_oversize when fixed metadata alone cannot fit', async () => {
      const run = harness({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: doc } } })) });
      const result = await run({ file: 'k'.repeat(RESULT_BUDGET_BYTES), node_ids: ['1:1'] });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({
        code: 'response_too_large',
        reason: 'envelope_oversize',
        action: 'narrow_request',
      });
    });

    it('does NOT flag when the result fits (default small call unchanged)', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: { id: '1:1', name: 'f', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } } } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'] })).content[0].text);
      expect(out.result_truncated).toBeUndefined();
      expect(out.specs).toHaveLength(1);
    });
  });

  describe('🅰️-2: text_leaves', () => {
    // card→list→item→label(TEXT '1:4'), label at L4 (reachable at max_depth:6, cut at max_depth:2)
    const deep = {
      id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
      layoutMode: 'VERTICAL',
      children: [
        { id: '1:2', name: 'list', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 }, layoutMode: 'VERTICAL',
          children: [
            { id: '1:3', name: 'item', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 40 }, layoutMode: 'VERTICAL',
              children: [
                { id: '1:4', name: 'label', type: 'TEXT', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
                  characters: 'Настройки', style: { fontFamily: 'Inter', fontWeight: 450, fontSize: 14 } },
              ] },
          ] },
      ],
    } as any;
    it('text_leaves:true — spec REPLACED by text_leaves, spec absent', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: deep } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], text_leaves: true, max_depth: 6 })).content[0].text);
      expect(out.specs[0].spec).toBeUndefined();
      expect(out.specs[0].text_leaves.some((l: any) => l.id === '1:4')).toBe(true);
      expect(out.specs[0].text_leaves_truncated).toBeUndefined();
    });
    it('depth mirror: max_depth:2 → leaf absent + text_leaves_truncated', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: deep } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'], text_leaves: true, max_depth: 2 })).content[0].text);
      expect(out.specs[0].text_leaves_truncated).toBe(true);
    });
    it('backward-compat: without the flag — spec as before, text_leaves absent', async () => {
      const getNodesRaw = vi.fn(async () => ({ nodes: { '1:1': { document: deep } } }));
      const run = harness({ getNodesRaw });
      const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'] })).content[0].text);
      expect(out.specs[0].spec).toBeDefined();
      expect(out.specs[0].text_leaves).toBeUndefined();
    });
  });
});

describe('get_layout_spec hydration receipt (Phase 1)', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });
  const chain = (levels: number): any => {
    const mk = (id: string, kids?: any[]): any =>
      ({ id, name: id, type: 'FRAME', absoluteBoundingBox: box(0, 0, 40, 8), ...(kids ? { children: kids } : {}) });
    let cur = mk('L' + levels);
    for (let i = levels - 1; i >= 1; i -= 1) cur = mk('L' + i, [cur]);
    return { id: 'dd:0', name: 'root', type: 'FRAME', layoutMode: 'VERTICAL', absoluteBoundingBox: box(0, 0, 300, 100), children: [cur] };
  };

  it('emits a per-node hydration receipt; a cold depth cut is an honest hedge, not backed', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: { 'dd:0': { document: chain(6) } } }));
    // self-contained harness (McpServer, registerGetLayoutSpecTool, logger, FigmaApi are already
    // imported at the top of this test file); wrap the api with withFrameRaw so the tool's
    // getFrameRaw call resolves through the getNodesRaw mock:
    const { server, call } = makeFakeMcpServer();
    registerGetLayoutSpecTool(server, { buildApi: () => withFrameRaw({ getNodesRaw }) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 } as any);
    const run = (a: any): Promise<any> => call('get_layout_spec', a);
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['dd:0'], max_depth: 4 })).content[0].text);
    expect(Array.isArray(out.hydration)).toBe(true);
    const rec = out.hydration.find((h: any) => h.node_id === 'dd:0');
    expect(rec.cause_breakdown.depth).toBeGreaterThan(0);
    expect(rec.hydrated).toBe(false); // withFrameRaw passthrough → not held
    expect(rec.note).not.toMatch(/already held|уже держ/i);
  });

  it('keeps hydration in request order when concurrent metadata lookups finish out of order', async () => {
    const getNodesRaw = vi.fn(async () => ({ nodes: {
      '1:1': { document: { ...doc, id: '1:1' }, components: { a: { key: 'slow', name: 'a', componentSetId: 's:1' } } },
      '2:2': { document: { ...doc, id: '2:2' }, components: { b: { key: 'fast', name: 'b', componentSetId: 's:2' } } },
    } }));
    const getComponent = vi.fn(async (key: string) => {
      if (key === 'slow') await new Promise((resolve) => setTimeout(resolve, 20));
      return { key, file_key: 'lib', node_id: key, name: key };
    });
    const getFileComponentSets = vi.fn(async () => []);
    const run = harness({ getNodesRaw, getComponent, getFileComponentSets });
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1', '2:2'] })).content[0].text);

    expect(out.hydration.map((h: any) => h.node_id)).toEqual(['1:1', '2:2']);
  });
});

// ── token-parity line (feedback 15/15.1): get_layout_spec resolves bound colors through the
// SAME resolver compare_node_to_dom uses. Before this line the tool returned fillBoundVar (a raw
// VariableID no human can act on) and NO name, while fillHex stayed a stale library-default
// snapshot — the caller ported wrong-mode hexes into code. The name is the portable artifact.
describe('get_layout_spec — bound colors resolve to token names (shared resolver)', () => {
  const VARS = {
    meta: {
      variableCollections: { 'VC:1': { id: 'VC:1', name: 'Brand', defaultModeId: 'm1',
        modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] } },
      variables: { 'V:1': { id: 'V:1', name: 'color/brand/primary', resolvedType: 'COLOR', variableCollectionId: 'VC:1',
        valuesByMode: { m1: { r: 0.482, g: 0.380, b: 0.965 }, m2: { r: 0.6, g: 0.5, b: 1 } } } },
    },
  };
  const boundDoc = (extra: Partial<RawSceneNode> = {}): RawSceneNode => ({
    id: '1:1', name: 'card', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:1' } } }],
    ...extra,
  } as RawSceneNode);

  const tokenHarness = (doc: RawSceneNode, over: Partial<FigmaApi> = {}) => {
    const getVariablesLocal = vi.fn(async () => VARS);
    const caps: (number | undefined)[] = [];
    const { server, call } = makeFakeMcpServer();
    const api = withFrameRaw({ getNodesRaw: vi.fn(async () => ({ nodes: { '1:1': { document: doc } } })), getVariablesLocal, ...over } as Partial<FigmaApi>);
    const deps = { buildApi: (_t: string, capMs?: number) => { caps.push(capMs); return api as FigmaApi; },
      defaultToken: 'figd_x', logger, maxResultChars: 40000 } as ToolDeps;
    registerGetLayoutSpecTool(server, deps);
    return { run: (a: any): Promise<any> => call('get_layout_spec', a), getVariablesLocal, caps };
  };

  it('paint-level bound fill keeps the default diagnostic but does not claim an effective ancestor mode', async () => {
    const { run, getVariablesLocal, caps } = tokenHarness(boundDoc());
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'] })).content[0].text);
    const spec = out.specs[0].spec;
    expect(spec.fillHex).toBe('#ffffff');                       // RAW snapshot, documented as raw
    expect(spec.fillBoundVar).toBe('V:1');
    expect(spec.fillToken).toMatchObject({
      token: 'color/brand/primary',
      defaultHex: '#7b61f6',
      effectiveHex: null,
      effectiveModeSource: 'unverifiable',
    });
    expect(spec.fillToken.all_modes).toBeUndefined();           // compare's confirm payload, not navigation data
    expect(out.degraded_stages).toBeUndefined();
    expect(getVariablesLocal).toHaveBeenCalledTimes(1);
    // The variables fetch goes through a CAPPED api build — always, unlike compare's MT-only cap:
    // a bounded miss with a receipt beats a measured ~90s stall on the navigation hot path.
    expect(caps).toContain(20_000);
  });

  it('NODE-level binding (the July 15.1 shape) resolves the same name', async () => {
    const doc = boundDoc({
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
      boundVariables: { fills: { type: 'VARIABLE_ALIAS', id: 'V:1' } },
    } as Partial<RawSceneNode>);
    const { run } = tokenHarness(doc);
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'] })).content[0].text);
    expect(out.specs[0].spec.fillToken?.token).toBe('color/brand/primary');
    expect(out.specs[0].spec.fillBoundVar).toBe('V:1');
  });

  it('a subtree explicitVariableModes pin produces an explicit effective value', async () => {
    const { run } = tokenHarness(boundDoc({ explicitVariableModes: { 'VC:1': 'm2' } } as Partial<RawSceneNode>));
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'] })).content[0].text);
    expect(out.specs[0].spec.fillToken).toMatchObject({
      token: 'color/brand/primary',
      defaultHex: '#7b61f6',
      effectiveHex: '#9980ff',
      effectiveModeSource: 'explicit_node',
      effectiveModes: { Brand: { mode: 'Dark', source: 'explicit_node', node_id: '1:1' } },
    });
  });

  it('demand gate: a batch that binds no colour never fetches variables', async () => {
    const plain: RawSceneNode = { id: '1:1', name: 'card', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 },
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] } as RawSceneNode;
    const { run, getVariablesLocal } = tokenHarness(plain);
    const out = JSON.parse((await run({ file: 'abc', node_ids: ['1:1'] })).content[0].text);
    expect(getVariablesLocal).not.toHaveBeenCalled();
    expect(out.specs[0].spec.fillToken).toBeUndefined();
  });

  it('variables fetch failure → degraded_stages receipt; fillBoundVar survives, no fillToken, no throw', async () => {
    const { run } = tokenHarness(boundDoc(), { getVariablesLocal: vi.fn(async () => { throw new FigmaApiError('upstream', 500, 'boom'); }) });
    const res = await run({ file: 'abc', node_ids: ['1:1'] });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0].text);
    expect(out.specs[0].spec.fillToken).toBeUndefined();
    expect(out.specs[0].spec.fillBoundVar).toBe('V:1');
    // Without this receipt an absent fillToken is ambiguous between "no resolver can name it"
    // and "the fetch degraded" — the exact invisible-degradation defect compare already fixed.
    expect(out.degraded_stages).toMatchObject([{ stage: 'variables', reason: 'error' }]);
    expect(out.degraded_stages[0].ms).toBeTypeOf('number');
  });

  it('rate_limited rethrows (agent must back off) — never swallowed into degradation', async () => {
    const { run } = tokenHarness(boundDoc(), { getVariablesLocal: vi.fn(async () => { throw new FigmaApiError('rate_limited', 429, 'slow down', 30); }) });
    const res = await run({ file: 'abc', node_ids: ['1:1'] });
    expect(res.isError).toBe(true);
  });
});
