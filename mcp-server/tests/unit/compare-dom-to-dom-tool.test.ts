// compare_dom_to_dom tool layer (feedback item 16, spec #9/#10): label-based identity, the
// aggregate pairs-scope receipt as the done-gate, per-side gates that NAME the side, and a
// report that never says Figma - there is no Figma side to speak of.
import { describe, it, expect } from 'vitest';
import { registerCompareDomToDomTool, DomPairSchema } from '../../src/adapters/driving/tools/compare-dom-to-dom-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { DomSnapshotOk } from '../../src/domain/layout-spec/types.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
function harness(extra: Partial<ToolDeps> = {}) {
  const { server, call } = makeFakeMcpServer();
  // deliberately NO defaultToken: the tool makes zero Figma calls and must not demand one
  const deps: ToolDeps = { buildApi: () => ({} as FigmaApi), defaultToken: undefined, logger, maxResultChars: 40000, ...extra };
  registerCompareDomToDomTool(server, deps);
  return (a: unknown): Promise<{ isError?: boolean; content: { text: string }[] }> => call('compare_dom_to_dom', a);
}
const parse = (r: { content: { text: string }[] }): any => JSON.parse(r.content[0].text);

// The vault shape: a padded list root whose first card sits at `firstCardY`.
const state = (firstCardY: number): DomSnapshotOk => ({
  schema: 6, status: 'ok', selector: '.shelf', innerWidth: 768,
  rect: { x: 0, y: 0, w: 768, h: 900 },
  borders: { top: 1, right: 1, bottom: 1, left: 1 },
  paddings: { top: 24, right: 16, bottom: 24, left: 16 },
  clientWidth: 766, clientHeight: 898, scrollHeight: 898,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  styles: { display: 'flex', backgroundColor: '#ffffff', borderRadius: 0, opacity: 1 },
  children: [
    { kind: 'element', tag: 'div', rect: { x: 17, y: firstCardY, w: 734, h: 140 } },
    { kind: 'element', tag: 'div', rect: { x: 17, y: firstCardY + 156, w: 734, h: 140 } },
    { kind: 'element', tag: 'div', rect: { x: 17, y: firstCardY + 312, w: 734, h: 140 } },
  ],
});

describe('compare_dom_to_dom tool', () => {
  it('works with NO token configured - the tool declares no figma_token and demands none', async () => {
    const call = harness();
    const res = await call({ pairs: [{ label: 'shelf', reference: { dom: state(366) }, candidate: { dom: state(366) } }] });
    expect(res.isError).toBeUndefined();
  });

  it('label identity + dom-dom report: node_id is the label, header names the roles, Figma never appears', async () => {
    const call = harness();
    const out = parse(await call({ pairs: [{ label: 'product-shelf', reference: { dom: state(366) }, candidate: { dom: state(306) } }] }));
    expect(out.pairs[0].node_id).toBe('product-shelf');
    expect(out.report_markdown).toMatch(/^Verified reference vs candidate/);
    expect(out.report_markdown).toMatch(/reference .* \/ candidate /);
    expect(out.report_markdown).not.toMatch(/Figma/);
    expect(out.file).toBeUndefined();
  });

  it('the vault acceptance through the wire: 306 vs 366 -> padding-top fail with delta 60, complete:false', async () => {
    const call = harness();
    const out = parse(await call({ pairs: [{ label: 'shelf', reference: { dom: state(366) }, candidate: { dom: state(306) } }] }));
    const pt = out.pairs[0].rows.find((r: any) => r.prop === 'padding-top');
    expect(pt.status).toBe('fail');
    expect(Math.abs(pt.figma - pt.dom)).toBe(60);
    expect(out.verification.complete).toBe(false);
  });

  it('aggregate receipt is the done-gate: one clean pair + one defective pair = ONE complete:false', async () => {
    const call = harness();
    const out = parse(await call({ pairs: [
      { label: 'clean', reference: { dom: state(366) }, candidate: { dom: state(366) } },
      { label: 'broken', reference: { dom: state(366) }, candidate: { dom: state(306) } },
    ] }));
    expect(out.verification.complete).toBe(false);
    expect(out.summary.fail).toBeGreaterThan(0);
    const clean = out.pairs.find((p: any) => p.node_id === 'clean');
    expect(clean.summary.fail).toBe(0);
  });

  it('identical states -> complete:true (the byte-identical lock survives the wire)', async () => {
    const call = harness();
    const out = parse(await call({ pairs: [{ label: 'same', reference: { dom: state(366) }, candidate: { dom: state(366) } }] }));
    expect(out.verification.complete).toBe(true);
    expect(out.verification.blocking).toEqual([]);
  });

  it('schema mismatch on ONE side -> the row names that side, the other side is not blamed', async () => {
    const call = harness();
    const stale = { ...state(366), schema: 5 };
    const out = parse(await call({ pairs: [{ label: 'p', reference: { dom: state(366) }, candidate: { dom: stale } }] }));
    const row = out.pairs[0].rows.find((r: any) => r.prop === 'snapshot_schema');
    expect(row.note).toMatch(/CANDIDATE/);
    expect(row.note).not.toMatch(/REFERENCE/);
  });

  it('dom_ref without a snapshot store -> per-side honest error naming the side (stdio path)', async () => {
    const call = harness();
    const out = parse(await call({ pairs: [{ label: 'p',
      reference: { dom_ref: { ref: 'r1', selector: '.shelf' } }, candidate: { dom: state(366) } }] }));
    const row = out.pairs[0].rows.find((r: any) => r.prop === 'snapshot_ref');
    expect(row.note).toMatch(/^reference: snapshot store unavailable/);
  });

  it('both dom and dom_ref on one side (or neither) -> schema rejection, not a silent pick', () => {
    // The fake server does not run zod - the schema is the validation surface, tested directly
    // (the house pattern from the compare_node_to_dom suite).
    const both = DomPairSchema.safeParse({ label: 'p',
      reference: { dom: state(366), dom_ref: { ref: 'r1', selector: '.shelf' } }, candidate: { dom: state(366) } });
    expect(both.success).toBe(false);
    const neither = DomPairSchema.safeParse({ label: 'p', reference: {}, candidate: { dom: state(366) } });
    expect(neither.success).toBe(false);
    const ok = DomPairSchema.safeParse({ label: 'p', reference: { dom: state(366) }, candidate: { dom: state(366) } });
    expect(ok.success).toBe(true);
  });

  it('token drift reaches blocking: the review row gates the receipt with the tokenization note', async () => {
    const call = harness();
    const withTok = (t: object): DomSnapshotOk => ({ ...state(366),
      styles: { display: 'flex', backgroundColor: '#ffffff', borderRadius: 0, opacity: 1, ...t } });
    const out = parse(await call({ pairs: [{ label: 'p',
      reference: { dom: withTok({ backgroundColorToken: { token: '--bg' } }) },
      candidate: { dom: withTok({ backgroundColorToken: { literal: true } }) } }] }));
    expect(out.verification.complete).toBe(false);
    const b = out.verification.blocking.find((x: any) => x.kind === 'unconfirmed_token');
    expect(b.node_id).toBe('p');
    expect(b.detail).toMatch(/tokenization changed/);
  });
});
