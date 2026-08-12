// Batch 2 item 5 remainder (panel-locked, 3 lenses, 32 findings, 8 blockers - the
// feedback's collapse ask was REFUTED with measurement). The live incident's real defect:
// under a dead variables resolve every diverged row lands in ONE rsn:bound-unresolved /
// rsn:fig-unresolved aggregate (PR #108 already collapsed the flood) whose advice
// ("confirm the token") is unexecutable AS STATED - but the road exists and is measured:
// the negative cache is cap-aware, get_variables {timeout_ms: 120000} bypasses it BY
// DESIGN, warms the positive cache on success, and the next compare resolves everything.
// The ship is ONE wording change: those aggregates' detail names the escalation road,
// gated conjunctively (no-token reason key AND variablesDegraded AND not dom-dom).
// Nothing is suppressed: blocking stays non-empty (the suppressed population would have
// been exactly the diverged-hex rows), the #60 hatch and Gate 5B are untouched, places[]
// addressability is intact, and tok:<name> groups (mode-unconfirmed - an executable
// mode-road unrelated to /variables/local) keep their wording byte-identically, as do
// bound-unresolved rows under a HEALTHY fetch (unsynced-library / shadow-bound residuals
// are permanent - a bigger budget buys nothing there).
import { describe, it, expect } from 'vitest';
import { buildVerification } from '../../src/domain/layout-spec/verification.js';

const mk = (node_id: string, rows: unknown[]): never => ({ node_id, rows,
  summary: { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0,
    review: (rows as { status: string }[]).filter((r) => r.status === 'review').length } }) as never;
const rev = (prop: string, token?: string, tokenReason?: string, note = 'confirm') =>
  ({ prop, status: 'review', note, ...(token ? { token } : {}), ...(tokenReason ? { tokenReason } : {}) });
const blockingOf = (pairs: never[], opts: Record<string, unknown> = {}) =>
  buildVerification(pairs, { depthLevels: 4, ...opts } as never).blocking
    .filter((b: { kind: string }) => b.kind === 'unconfirmed_token');

const ESCALATION = /run get_variables \{timeout_ms: 120000\}/;

describe('the escalation detail (item 5 remainder): a dead-resolve aggregate names the executable road', () => {
  it('bound-unresolved x3 + variablesDegraded -> ONE aggregate, detail carries the road, places intact, blocking NON-empty', () => {
    const p = mk('1:1', [rev('color[a]', undefined, 'bound-unresolved'), rev('color[b]', undefined, 'bound-unresolved'),
      rev('color[c]', undefined, 'bound-unresolved')]);
    const v = buildVerification([p], { depthLevels: 4, variablesDegraded: true } as never);
    const b = v.blocking.filter((x: { kind: string }) => x.kind === 'unconfirmed_token');
    expect(b).toHaveLength(1);
    expect(b[0].detail).toMatch(ESCALATION);
    expect(b[0].detail).toMatch(/re-run this compare/);
    expect(b[0].detail).toMatch(/degraded_stages/);
    expect(b[0].places).toHaveLength(3);
    expect(b[0].action).toBe('confirm_token');
    expect(v.complete).toBe(false);
  });

  it('WITHOUT the flag the detail is byte-identical to today (healthy-fetch and unsynced/shadow residuals keep the old wording)', () => {
    const rows = [rev('color[a]', undefined, 'bound-unresolved'), rev('color[b]', undefined, 'bound-unresolved')];
    const plain = blockingOf([mk('1:1', rows)]);
    expect(plain).toHaveLength(1);
    expect(plain[0].detail).not.toMatch(ESCALATION);
  });

  it('tok:<name> groups (mode-unconfirmed) keep their wording under the flag - the mode road is executable and unrelated', () => {
    const p = mk('1:1', [rev('color[a]', 'ds/icon/fg', 'mode-unconfirmed'), rev('color[b]', 'ds/icon/fg', 'mode-unconfirmed')]);
    const b = blockingOf([p], { variablesDegraded: true });
    expect(b).toHaveLength(1);
    expect(b[0].detail).toContain('ds/icon/fg');
    expect(b[0].detail).not.toMatch(ESCALATION);
  });

  it('a single-place fig-unresolved group gains the clause too (the firstNote branch)', () => {
    const b = blockingOf([mk('1:1', [rev('color[a]', undefined, 'fig-unresolved', 'the token cannot be checked')])],
      { variablesDegraded: true });
    expect(b).toHaveLength(1);
    expect(b[0].detail).toContain('the token cannot be checked');
    expect(b[0].detail).toMatch(ESCALATION);
  });

  it('dom-dom is structurally inert: the no-key road mints byte-identically even with the flag FORCED on', () => {
    // fillTokenDrift-shaped rows carry neither token nor tokenReason - the no-key push.
    const rows = [rev('fill-token', undefined, undefined, 'the reference is var-bound, the candidate is a literal')];
    const withFlag = blockingOf([mk('card', rows)], { mode: 'dom-dom', variablesDegraded: true });
    const without = blockingOf([mk('card', rows)], { mode: 'dom-dom' });
    expect(withFlag).toEqual(without);
    expect(withFlag[0].detail).not.toMatch(ESCALATION);
    // and even a reason-keyed row in dom-dom mode never gains the compare-specific advice
    const reasoned = blockingOf([mk('card', [rev('fill', undefined, 'bound-unresolved')])],
      { mode: 'dom-dom', variablesDegraded: true });
    expect(reasoned[0].detail).not.toMatch(ESCALATION);
  });
});
