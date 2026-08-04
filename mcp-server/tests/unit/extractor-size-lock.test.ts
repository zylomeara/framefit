// Gate -- extractor-size-lock. Every site that quotes the inline extractor's SIZE is checked against
// the live `EXTRACTOR_JS`, and no site may quote it without being named here.
//
// THE DEFECT THIS EXISTS FOR. The numbers this repo states about the extractor have gone stale
// twice, both times silently. "~90 lines" and a "<=7-line thunk" survived the script growing to 738
// lines and the loader to 8; the commit that corrected them wrote "738 lines, 54121 chars" into FOUR
// places and gated exactly ONE of them -- the elision placeholder on docs/tools/design-qa.md, which
// docs-response-examples.test.ts compares against the capture's real length. Measured at that
// commit: inserting ONE comment line into the EXTRACTOR_JS template literal left the other three
// sites stating 738/54121 with the full suite green, and one of the three was the DELIVERED
// `extractor_mode` field description that an MCP client reads.
//
// SO THE REPAIR IS NOT A BETTER NUMBER, IT IS A LOCK, and the lock is two-sided:
//
//   MUST_STATE -- a site that keeps a digit must state the LIVE one. The fragment it is checked
//   against is BUILT from `EXTRACTOR_JS.length`, so the row cannot be satisfied by a number that was
//   right when it was written.
//
//   NO_SIZE_DIGIT -- the sites that dropped their digits must not grow one back. A tools/list
//   description is cached by the client, cannot be corrected in the field, and nothing the caller
//   DOES depends on the exact count: "the whole script" carries the only decision it informs (loader
//   small, inline large). That delivered string, and its verbatim twin in the tool page's parameter
//   table, therefore state no size at all -- which is why they cannot rot, and why the check on them
//   is an ABSENCE rather than a value. The arm reads a size CLAIM (a number beside a size unit) at
//   ANY length, because the first version of it matched `\d{3,7}` and was therefore blind to the two
//   claims named above: "~90 lines" is two digits and "<=7-line thunk" is one. Measured at that
//   version: `(the script is ~90 lines)` in the delivered description and its doc twin left this
//   whole file green. The historical claims are run through the arm below, so it cannot go blind to
//   them again.
//
// AND A REGISTRY SWEEP, because a hand-kept list of sites is exactly the structure that failed here:
// three of the four sites were simply not on anyone's list. The sweep population is therefore
// DERIVED -- `git ls-files`, every tracked file -- and never typed out: a hand-kept CORPUS is that
// same self-selected population one layer up, and measured, it was one -- `54121` on
// `docs/snapshot-ingest.md`, a tracked page the list did not reach, left the whole suite green.
// Anything held out of the derived population must be named in EXCLUDED with a reason from a closed
// set. `every occurrence of the live count is in a named file` then makes MUST_STATE provably
// complete for today's value -- a fifth site that copies the number is reported by path and line the
// moment it lands.
//
// WHAT THIS DELIBERATELY DOES NOT DO: hunt for size-shaped numbers generally, outside the anchor
// windows. Both `docs/tools/design-qa.md` and `docs/design-qa-tutorial.md` legitimately carry
// `N chars` elisions for `report_markdown`. A "any 4-6 digit number near a chars unit" sweep would
// need an allowlist for each, and an allowlist that grows with unrelated work is a hole, not a gate.
// Those elisions have their own live check (docs-response-examples.test.ts compares each against its
// capture); the residual left open here is a NEW site inventing a size the extractor never had,
// which no check on this axis reaches without that allowlist.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRACTOR_JS } from '../../src/adapters/driving/tools/dom-extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/mcp-server/tests/unit/<this file>.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const CHARS = EXTRACTOR_JS.length;

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** Every site that quotes the size. The fragment is built from the LIVE value, so it rots red. */
const MUST_STATE: { file: string; what: string; fragment: string }[] = [
  {
    file: 'README.md',
    what: "Tier 1's inline-extractor cost sentence -- the magnitude a reader adopting the 10-minute path is deciding on",
    fragment: `${CHARS} characters`,
  },
  {
    file: 'docs/tools/design-qa.md',
    what: "the get_layout_spec response fence's extractor_js elision (its VALUE is also compared with the capture by docs-response-examples.test.ts; this row is what names the site)",
    fragment: `${CHARS} chars - elided`,
  },
];

/** Every site that deliberately states NO size, and must not grow one back. */
const NO_SIZE_DIGIT: { file: string; what: string; anchor: string }[] = [
  {
    file: 'mcp-server/src/adapters/driving/tools/get-layout-spec-tool.ts',
    what: 'the DELIVERED extractor_mode field description an MCP client reads',
    // Just the phrase, and not the string-concat quote that follows it in the source: an anchor that
    // includes the punctuation a digit would be inserted BEFORE is broken by the very edit it exists
    // to catch, and the row then reports a missing anchor instead of the digit.
    anchor: 'instead of inlining the whole script',
  },
  {
    file: 'docs/tools/design-qa.md',
    what: "the extractor_mode row of the tool page's parameter table, a verbatim twin of the delivered string",
    anchor: 'instead of inlining the whole script every call',
  },
  {
    file: 'mcp-server/src/infrastructure/dom-snapshot-routes.ts',
    what: "GET /extractor.js's JSDoc, which carried the last surviving \"~90-line\" copy of the number this line set out to kill",
    anchor: 'instead of the caller re-pasting the whole',
  },
];

/**
 * A size CLAIM: a number beside a size unit, at any length ("~90 lines", "<=7-line thunk",
 * "54121 chars"), plus a bare 3+ digit run, which inside an anchor window is a size and nothing else.
 * Fresh regex per call -- a shared /g literal carries lastIndex between callers.
 */
function sizeClaims(text: string): string[] {
  const re = /\b\d[\d,.]*\s*-?\s*(?:lines?|chars?|characters?|bytes?|[kKmM]B)\b|\b\d{3,}\b/g;
  return [...text.matchAll(re)].map((m) => m[0]);
}

/**
 * Why a tracked file may sit OUTSIDE the sweep. A closed set: an exclusion must be one of these, so
 * "it was inconvenient" cannot become a reason and the population cannot be quietly narrowed again.
 */
const REASONS = {
  recorded_capture:
    'a recorded tool response, not a claim -- the number is there because the server printed it, and it is '
    + 're-recorded with the extractor (docs-response-examples.test.ts compares it against the live capture)',
  gate_header:
    "this gate's own header, which QUOTES the historical claim it exists to prevent; the quote is history and "
    + 'must not track the live value',
} as const;

const EXCLUDED: Record<string, keyof typeof REASONS> = {
  'mcp-server/tests/fixtures/doc-response-captures/get_layout_spec.json': 'recorded_capture',
  'mcp-server/tests/unit/extractor-size-lock.test.ts': 'gate_header',
};

/** Every tracked file. DERIVED, never typed out -- a hand-kept list is the failure this gate is about. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '');
}

/** Files searched for stray copies of the live count: everything tracked, minus the named exclusions. */
const CORPUS = trackedFiles().filter((f) => !(f in EXCLUDED));

/** The anchor line plus the two either side of it -- where a reintroduced digit would land. */
function anchorWindow(text: string, anchor: string): string | undefined {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(anchor));
  return i === -1 ? undefined : lines.slice(Math.max(0, i - 2), i + 3).join('\n');
}

describe('the extractor size is stated in exactly the places this gate names, and it is the live one', () => {
  it('states the LIVE character count wherever it states one at all', () => {
    const stale = MUST_STATE.filter((s) => !read(s.file).includes(s.fragment)).map(
      (s) => `${s.file}: ${s.what} -- does not say "${s.fragment}"; EXTRACTOR_JS is now ${CHARS} chars`,
    );
    expect(stale, `EXTRACTOR_JS is ${CHARS} chars and these sites do not say so`).toEqual([]);
  });

  it('keeps the delivered description and its doc twin free of a size digit', () => {
    const regressed: string[] = [];
    for (const s of NO_SIZE_DIGIT) {
      const window_ = anchorWindow(read(s.file), s.anchor);
      if (window_ === undefined) {
        regressed.push(`${s.file}: ${s.what} -- the anchor "${s.anchor}" is gone, so this row checks nothing`);
        continue;
      }
      const found = sizeClaims(window_);
      if (found.length) {
        regressed.push(
          `${s.file}: ${s.what} -- states a size again (${found.join(', ')}). A client caches this string; a digit in it cannot be corrected in the field, and gating it is the price of writing it`,
        );
      }
    }
    expect(regressed, 'a size digit came back into a string that deliberately states none').toEqual([]);
  });

  it('names every file in the corpus that carries the live count', () => {
    const named = new Set(MUST_STATE.map((s) => s.file));
    const unregistered: string[] = [];
    for (const file of CORPUS) {
      const text = read(file);
      for (const m of text.matchAll(new RegExp(`\\b${CHARS}\\b`, 'g'))) {
        if (named.has(file)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        unregistered.push(`${file}:${line}: quotes the extractor size (${CHARS}) but is not in MUST_STATE -- an unnamed size claim is how the last two went stale`);
      }
    }
    expect(unregistered, 'a size claim exists that this gate does not name').toEqual([]);
  });

  // The arm above is what the two stale claims in this file's header actually looked like. Its first
  // version matched `\d{3,7}`, so it saw NEITHER of them -- the gate could not catch the defect it
  // names. This row is those exact texts, put through the arm.
  it('the size-digit arm sees the historical claims: one digit, two digits, and the live count', () => {
    const blind = ['the script is ~90 lines', 'a <=7-line thunk', `${CHARS} chars`, 'roughly 30 kB']
      .filter((claim) => sizeClaims(claim).length === 0);
    expect(blind, 'the arm is blind to a size claim of this shape, which is how "~90 lines" survived').toEqual([]);
    // ...and does not fire on the prose that legitimately surrounds the anchors.
    expect(sizeClaims('GET /api/dom-snapshots/extractor.js, tens of kilobytes'), 'false positive on anchor prose').toEqual([]);
  });

  it('is not vacuous: the live count is a real measurement and every named file really carries it', () => {
    expect(CHARS, 'EXTRACTOR_JS collapsed, so every fragment above would be trivially satisfiable').toBeGreaterThan(10_000);
    const carrying = CORPUS.filter((f) => new RegExp(`\\b${CHARS}\\b`).test(read(f)));
    expect(new Set(carrying), 'the set of files carrying the live count is not the set this gate names')
      .toEqual(new Set(MUST_STATE.map((s) => s.file)));
  });

  it('sweeps a DERIVED population, and every hold-out is tracked and named with a closed-set reason', () => {
    const tracked = new Set(trackedFiles());
    expect(tracked.size, 'git ls-files returned nothing, so the sweep would pass over an empty corpus').toBeGreaterThan(100);
    expect(CORPUS.length, 'the sweep corpus is not the tracked tree minus the exclusions')
      .toBe(tracked.size - Object.keys(EXCLUDED).length);
    const stale = Object.entries(EXCLUDED)
      .filter(([f, reason]) => !tracked.has(f) || !(reason in REASONS))
      .map(([f, reason]) => (tracked.has(f)
        ? `${f}: reason "${reason}" is not in the closed set`
        : `${f}: is not tracked, so the exclusion is stale`));
    expect(stale, 'an exclusion that no longer describes a tracked file, or a reason outside the closed set').toEqual([]);
    // Every MUST_STATE site must be IN the swept population -- an excluded site is an unswept claim.
    expect(MUST_STATE.map((s) => s.file).filter((f) => !CORPUS.includes(f)), 'a named site sits outside the sweep').toEqual([]);
  });
});
