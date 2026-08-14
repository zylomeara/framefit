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
  return (a: unknown): Promise<any> => call('compare_dom_to_dom', a as Record<string, unknown>);
}
const parse = (r: { content: { text: string }[] }): any => JSON.parse(r.content[0].text);

// The vault shape: a padded list root whose first card sits at `firstCardY`.
const state = (firstCardY: number): DomSnapshotOk => ({
  schema: 7, status: 'ok', selector: '.shelf', innerWidth: 768,
  rect: { x: 0, y: 0, w: 768, h: 900 },
  borders: { top: 1, right: 1, bottom: 1, left: 1 },
  borderColors: { top: '#e0e0e0', right: '#e0e0e0', bottom: '#e0e0e0', left: '#e0e0e0' },
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
    // The footer's not-covered line prints THIS tool's list, not the Figma comparator's - a
    // report/JSON disagreement on a coverage claim is a false-green surface (0.24.0 changelog
    // verification, A26).
    expect(out.report_markdown).toMatch(/NOT covered by this tool.*content correctness/);
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

  it('schema mismatch rows attribute each stale version to its actual side and keep the gate red', async () => {
    const call = harness();
    const staleReference = { ...state(366), schema: 5 };
    const staleCandidate = { ...state(366), schema: 6 };
    const out = parse(await call({ pairs: [{ label: 'p',
      reference: { dom: staleReference }, candidate: { dom: staleCandidate } }] }));
    const rows = out.pairs[0].rows.filter((r: any) => r.prop === 'snapshot_schema');
    const reference = rows.find((r: any) => r.note.includes('REFERENCE'));
    const candidate = rows.find((r: any) => r.note.includes('CANDIDATE'));

    expect(reference).toMatchObject({ figma: 5, status: 'warn' });
    expect(reference).not.toHaveProperty('dom');
    expect(reference).not.toHaveProperty('delta');
    expect(reference.note).toMatch(/server.*re-capture/s);
    expect(candidate).toMatchObject({ dom: 6, status: 'warn' });
    expect(candidate).not.toHaveProperty('figma');
    expect(candidate).not.toHaveProperty('delta');
    expect(candidate.note).toMatch(/server.*re-capture/s);
    expect(out.report_markdown).toContain('reference 5 / candidate —');
    expect(out.report_markdown).toContain('reference — / candidate 6');
    expect(out.verification.complete).toBe(false);
    expect(out.verification.blocking.filter((b: any) => b.action === 're_extract_dom')).toHaveLength(2);
  });

  it('omits the overloaded pair selector whenever reference and candidate selectors differ', async () => {
    const call = harness();
    const reference = { ...state(366), selector: '.reference' };
    const candidate = { ...state(366), selector: '.candidate' };
    const expectLabelOnly = (out: any) => {
      expect(out.pairs[0]).not.toHaveProperty('selector');
      for (const blocker of out.verification.blocking) expect(blocker).not.toHaveProperty('selector');
      expect(out.report_markdown).not.toContain('(.reference)');
      expect(out.report_markdown).not.toContain('(.candidate)');
    };

    const cases = [
      parse(await call({ pairs: [{ label: 'schema-reference',
        reference: { dom: { ...reference, schema: 5 } }, candidate: { dom: candidate } }] })),
      parse(await call({ pairs: [{ label: 'schema-candidate',
        reference: { dom: reference }, candidate: { dom: { ...candidate, schema: 5 } } }] })),
      parse(await call({ pairs: [{ label: 'ref-reference',
        reference: { dom_ref: { ref: 'missing', selector: '.reference' } }, candidate: { dom: candidate } }] })),
      parse(await call({ pairs: [{ label: 'preflight-reference',
        reference: { dom: { ...reference, transformed: true } }, candidate: { dom: candidate } }] })),
      parse(await call({ pairs: [{ label: 'radius-reference', reference: { dom: { ...reference,
        styles: { ...reference.styles, borderRadiusUncomparable: true } } }, candidate: { dom: candidate } }] })),
      parse(await call({ pairs: [{ label: 'border-reference', reference: { dom: { ...reference,
        borderColors: { ...reference.borderColors, right: '#111111' } } }, candidate: { dom: candidate } }] })),
      parse(await call({ pairs: [{ label: 'fill-reference', reference: { dom: { ...reference,
        styles: { ...reference.styles, backgroundColor: 'oklch(0.5 0.1 10)' } } }, candidate: { dom: candidate } }] })),
      parse(await call({ pairs: [{ label: 'fonts-reference',
        reference: { dom: { ...reference, fontsLoaded: false } }, candidate: { dom: candidate } }] })),
    ];
    for (const out of cases) expectLabelOnly(out);

    const diagonalChildren = reference.children.map((child, i) => ({
      ...child,
      rect: { ...child.rect, x: child.rect.x + i * 180, w: 100 },
    }));
    const axis = parse(await call({ pairs: [{ label: 'axis-reference',
      reference: { dom: { ...reference, children: diagonalChildren } },
      candidate: { dom: { ...candidate, children: diagonalChildren } } }] }));
    expect(axis.verification.blocking).toContainEqual(expect.objectContaining({ action: 'resolve_skip' }));
    expectLabelOnly(axis);
  });

  it('keeps the pair selector when both captures use the same selector', async () => {
    const call = harness();
    const reference = { ...state(366), selector: '.shared', schema: 5 };
    const candidate = { ...state(366), selector: '.shared' };
    const out = parse(await call({ pairs: [{ label: 'same-selector',
      reference: { dom: reference }, candidate: { dom: candidate } }] }));

    expect(out.pairs[0].selector).toBe('.shared');
    expect(out.verification.blocking[0].selector).toBe('.shared');
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

  it('an unresolvable ref is a blocked verdict, not a skipped pair: complete:false + re_extract_dom naming the side', async () => {
    const call = harness();
    const out = parse(await call({ pairs: [{ label: 'p',
      reference: { dom_ref: { ref: 'r1', selector: '.x' } }, candidate: { dom: state(366) } }] }));
    expect(out.verification.complete).toBe(false);
    const b = out.verification.blocking.find((x: any) => x.action === 're_extract_dom');
    expect(b.detail).toMatch(/^reference: /);
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
