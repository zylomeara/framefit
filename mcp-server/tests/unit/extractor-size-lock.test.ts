// Gate -- extractor-size-lock. Every site that quotes the inline extractor's SIZE is checked against
// the live `EXTRACTOR_JS`, and no site may quote it without being named here.
//
// THE DEFECT THIS EXISTS FOR. The numbers this repo states about the extractor have gone stale
// twice, both times silently. "~90 lines" and a "<=7-line thunk" survived the script growing to 738
// lines and the loader to 8; the commit that corrected them wrote "738 lines, 54121 chars" into FOUR
// places and gated exactly ONE of them -- the elision placeholder on docs/tools/design-qa.md, which
// docs-response-examples.test.ts compared against the capture's real length at the time. The healthy
// stdio response now carries the short loader there; its live 495-character value remains locked by
// that capture gate, while this file continues to own only claims about the full inline script. Measured at that
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
//   them again. And it is applied to an EXACT REGION, never to a window: see NO_SIZE_SITES.
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
// WHAT THIS DELIBERATELY DOES NOT DO: hunt for size-shaped numbers generally, outside the regions
// named below. Both `docs/tools/design-qa.md` and `docs/design-qa-tutorial.md` legitimately carry
// `N chars` elisions for `report_markdown`. A "any 4-6 digit number near a chars unit" sweep would
// need an allowlist for each, and an allowlist that grows with unrelated work is a hole, not a gate.
// Those elisions have their own live check (docs-response-examples.test.ts compares each against its
// capture); the residual left open here is a NEW site inventing a size the extractor never had,
// which no check on this axis reaches without that allowlist.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXTRACTOR_JS } from '../../src/adapters/driving/tools/dom-extractor.js';
import { registerGetLayoutSpecTool } from '../../src/adapters/driving/tools/get-layout-spec-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';

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
    file: 'examples/first-verdict.mjs',
    what: "the client header's statement of what the inline paste costs -- the number `serve-extractor` exists to remove, and the one a reader weighs the loopback handoff against. The client's own OUTPUT states this live (it prints the fingerprint's length half), so only the header can rot",
    fragment: `${CHARS} characters`,
  },
];

/**
 * THE OTHER SIZE ON THIS AXIS, and it rotted the same way. `serve-extractor` exists to keep the
 * count above out of the agent's context, and what it sends instead is quoted as a "~N-character
 * thunk" -- the magnitude the whole handoff is sold on. It said ~350 in three shipped places while
 * the string was 278, the commit message said ~280, and mutating the pages to `~9999-character` left
 * the suite green: it was a hand-counted number with nothing reading it.
 *
 * MEASURED OFF THE FUNCTION THAT PRINTS IT, so there is no second copy to keep. Only the port varies
 * -- 277 characters at a 4-digit port, 278 at a 5-digit one -- and `listen(0)` hands out a 5-digit
 * ephemeral port on Linux and macOS alike, which is the number the pages state.
 */
async function liveThunkChars(): Promise<number> {
  const { fetchThunk } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'examples', 'first-verdict.mjs')).href
  ) as { fetchThunk: (base: string) => string };
  return fetchThunk('http://127.0.0.1:65535').length;
}

/** Every `~N-character thunk` claim on a page, with its N. */
const thunkClaims = (text: string): number[] =>
  [...text.matchAll(/~\s*(\d+)\s*-character thunk/g)].map((m) => Number(m[1]));

/** The files that quote the thunk size and must keep quoting the live one. */
const THUNK_SITES = [
  'README.md',
  'examples/first-verdict.mjs',
];

/**
 * The extractor_mode field description AS DELIVERED: registered through the real registerTool call
 * and read off the registered input schema, not off the source lines that produce it.
 *
 * THE DEFECT THIS SHAPE EXISTS FOR. The previous version of the arm below read the anchor line plus
 * the two either side -- a +/-2-line window. Measured: the anchor sits on line 27 of
 * get-layout-spec-tool.ts while the same `.describe()` call runs to line 30, so a size claim on
 * line 30 passed the gate, and with the tool-surface digest re-recorded (which any deliberate
 * wording edit does) the FULL suite went green while the claim shipped to MCP clients. That is this
 * file's own header's defect at this file's own header's site. A line window is a heuristic and a
 * heuristic has an edge; the delivered STRING has a boundary instead, so there is nothing left to
 * be off by.
 */
function deliveredExtractorModeDescription(): string {
  const { server, get } = makeFakeMcpServer();
  registerGetLayoutSpecTool(server, {
    buildApi: () => ({}), defaultToken: 'figd_x', logger: createLogger({ level: 'silent' }), maxResultChars: 40_000,
  } as unknown as ToolDeps);
  const shape = get('get_layout_spec')?.inputSchema as Record<string, { description?: string }> | undefined;
  const described = shape?.extractor_mode?.description;
  if (typeof described !== 'string' || described === '') {
    throw new Error('get_layout_spec registers no extractor_mode description, so the absence arm would check nothing');
  }
  return described;
}

/** The single markdown table row whose first cell is `cell` -- a row is one line, so this is exact. */
const tableRow = (text: string, cell: string): string | undefined =>
  text.split('\n').find((l) => l.startsWith(`| \`${cell}\` |`));

/** The whole JSDoc block containing `anchor` -- delimited by its own comment markers, so exact. */
const jsdocContaining = (text: string, anchor: string): string | undefined =>
  text.match(/\/\*\*[\s\S]*?\*\//g)?.find((b) => b.includes(anchor));

/**
 * Every site that deliberately states NO size, and must not grow one back. Each names the EXACT
 * text it checks -- the delivered string, one table row, one comment block -- and never a window
 * around an anchor.
 */
const NO_SIZE_SITES: { where: string; what: string; text: () => string | undefined; holds: string }[] = [
  {
    where: 'get_layout_spec tools/list (delivered)',
    what: 'the DELIVERED extractor_mode field description an MCP client reads and caches',
    text: deliveredExtractorModeDescription,
    holds: 'instead of inlining the whole script',
  },
  {
    where: 'docs/tools/design-qa.md',
    what: "the extractor_mode row of the tool page's parameter table, a verbatim twin of the delivered string",
    text: () => tableRow(read('docs/tools/design-qa.md'), 'extractor_mode'),
    holds: 'instead of inlining the whole script every call',
  },
  {
    where: 'mcp-server/src/infrastructure/dom-snapshot-routes.ts',
    what: "GET /extractor.js's JSDoc, which carried the last surviving \"~90-line\" copy of the number this line set out to kill",
    text: () => jsdocContaining(read('mcp-server/src/infrastructure/dom-snapshot-routes.ts'),
      'instead of the caller re-pasting the whole'),
    holds: 'instead of the caller re-pasting the whole',
  },
];

/**
 * A size CLAIM: a number beside a size unit, at any length ("~90 lines", "<=7-line thunk",
 * "54121 chars"), plus a bare 3+ digit run, which inside one of the regions above is a size and
 * nothing else. Fresh regex per call -- a shared /g literal carries lastIndex between callers.
 *
 * WHAT THIS ENUMERATION CANNOT DO, AND WHICH WAY IT FAILS. It lists the LIKELY spellings; it cannot
 * prove the ABSENCE of a size claim in free prose. "kilobytes" spelled out, a magnitude suffix
 * ("54k"), a number in words ("fifty-four thousand characters") -- each passes, and adding the next
 * two spellings only moves the edge, because an enumeration over natural language never closes. It
 * FAILS OPEN: a claim it does not spell ships silently, exactly the way "~90 lines" did.
 *
 * So this arm is not the defence. The defence is that the strings above state no size BY DESIGN --
 * nothing a caller does depends on the count, so there is no reason to write one, and the reviewer
 * of any edit to those strings is looking at three short texts, not at a corpus. This arm is a
 * TRIPWIRE for the regression, cheap and worth having; treating it as a proof of absence is the
 * error, and this comment is here so nobody has to re-derive that by adding a seventh spelling.
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

/**
 * Every tracked file, or undefined outside a git checkout. DERIVED, never typed out -- a hand-kept
 * list is the failure this gate is about.
 *
 * LAZY AND MEMOISED ON PURPOSE. The population used to be built at MODULE scope, so in a
 * `git archive` copy (a release tarball, a vendored subtree) `git ls-files` threw during COLLECTION
 * and the whole file failed to load -- taking down the rows that only read files by path and need
 * no git at all. Now the git rows skip BY NAME and everything else still runs.
 *
 * RESIDUAL, WITH ITS FAILURE DIRECTION: the sweep sees TRACKED files only. A brand-new page that
 * copies the live count is invisible to it until `git add` -- i.e. it FAILS OPEN on exactly the run
 * a contributor makes just after writing the page. It closes itself the moment the file is staged,
 * and never reaches a commit unnamed; the gap is the working copy, not the history.
 */
let trackedCache: string[] | undefined;
let trackedAsked = false;
function trackedFiles(): string[] | undefined {
  if (!trackedAsked) {
    trackedAsked = true;
    // The ONE condition that legitimately means "this population cannot be built": no history here.
    // Everything else -- dubious ownership on a bind-mounted checkout, a broken PATH, a git that
    // exits non-zero for any reason at all -- is a FAILURE TO MEASURE inside a real repository, and
    // it must fail LOUD. A bare `catch` here swallowed all of them alike and turned the sweep into a
    // silent skip: measured with a `git` shim exiting 128 in a real checkout, a planted fifth copy
    // of the live count shipped GREEN. The whole point of deriving the population was that a
    // hand-kept list fails open; catching every error put the failure back one level up.
    if (!existsSync(path.join(REPO_ROOT, '.git'))) {
      trackedCache = undefined;
    } else {
      trackedCache = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .split('\0')
        .filter((f) => f !== '');
    }
  }
  return trackedCache;
}

/** Files searched for stray copies of the live count: everything tracked, minus the named exclusions. */
const corpus = (): string[] => (trackedFiles() ?? []).filter((f) => !(f in EXCLUDED));

/** True in a copy with no git history, where the DERIVED population cannot be built at all. */
const OUTSIDE_GIT = trackedFiles() === undefined;

describe('the extractor size is stated in exactly the places this gate names, and it is the live one', () => {
  it('states the LIVE character count wherever it states one at all', () => {
    expect(CHARS, 'EXTRACTOR_JS collapsed, so every fragment below would be trivially satisfiable').toBeGreaterThan(10_000);
    const stale = MUST_STATE.filter((s) => !read(s.file).includes(s.fragment)).map(
      (s) => `${s.file}: ${s.what} -- does not say "${s.fragment}"; EXTRACTOR_JS is now ${CHARS} chars`,
    );
    expect(stale, `EXTRACTOR_JS is ${CHARS} chars and these sites do not say so`).toEqual([]);
  });

  it('states the LIVE loader-thunk size in every place that quotes one', async () => {
    const live = await liveThunkChars();
    expect(live, 'the thunk collapsed, so every claim below would be trivially satisfiable')
      .toBeGreaterThan(100);
    // Named sites first: each must still carry a claim at all. A site that quietly drops its number
    // is a registry row checking nothing, which is how the last three went stale.
    const silent = THUNK_SITES.filter((f) => thunkClaims(read(f)).length === 0);
    expect(silent, 'a named site no longer quotes the thunk size, so this row would pass over it').toEqual([]);
    // Then every claim anywhere in the tracked tree -- outside git, the named sites alone. The
    // spelling is specific enough to sweep wide: `~<digits>-character thunk` is this number and
    // nothing else. Residual, with its direction: a claim written some OTHER way ("about 280 chars
    // of thunk") is invisible here and FAILS OPEN, the same residual the size-claim arm above
    // declares for prose it cannot enumerate.
    const files = OUTSIDE_GIT ? THUNK_SITES : corpus();
    const wrong: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const m of text.matchAll(/~\s*(\d+)\s*-character thunk/g)) {
        if (Number(m[1]) === live) continue;
        wrong.push(`${file}:${text.slice(0, m.index).split('\n').length}: says "${m[0]}", `
          + `and the thunk this client prints is ${live} characters`);
      }
    }
    expect(wrong, `the loader thunk is ${live} characters and these claims say otherwise`).toEqual([]);
  });

  it('keeps the WHOLE delivered description, and its doc twin, free of a size digit', () => {
    const regressed: string[] = [];
    for (const s of NO_SIZE_SITES) {
      const text = s.text();
      if (text === undefined) {
        regressed.push(`${s.where}: ${s.what} -- the region is gone, so this row checks nothing`);
        continue;
      }
      const found = sizeClaims(text);
      if (found.length) {
        regressed.push(
          `${s.where}: ${s.what} -- states a size again (${found.join(', ')}). A client caches this string; a digit in it cannot be corrected in the field, and gating it is the price of writing it`,
        );
      }
    }
    expect(regressed, 'a size digit came back into a string that deliberately states none').toEqual([]);
    // Not vacuous: each region must really be the text it claims to be, not an empty match.
    const wrong = NO_SIZE_SITES.filter((s) => !(s.text() ?? '').includes(s.holds));
    expect(wrong.map((s) => s.where), 'a region no longer holds the prose it is supposed to guard').toEqual([]);
  });

  it.skipIf(OUTSIDE_GIT)('names every file in the corpus that carries the live count', () => {
    const named = new Set(MUST_STATE.map((s) => s.file));
    const unregistered: string[] = [];
    for (const file of corpus()) {
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

  it.skipIf(OUTSIDE_GIT)('is not vacuous: every named file really carries the live count', () => {
    const carrying = corpus().filter((f) => new RegExp(`\\b${CHARS}\\b`).test(read(f)));
    expect(new Set(carrying), 'the set of files carrying the live count is not the set this gate names')
      .toEqual(new Set(MUST_STATE.map((s) => s.file)));
  });

  it.skipIf(OUTSIDE_GIT)('sweeps a DERIVED population, and every hold-out is tracked and named with a closed-set reason', () => {
    const tracked = new Set(trackedFiles());
    expect(tracked.size, 'git ls-files returned nothing, so the sweep would pass over an empty corpus').toBeGreaterThan(100);
    expect(corpus().length, 'the sweep corpus is not the tracked tree minus the exclusions')
      .toBe(tracked.size - Object.keys(EXCLUDED).length);
    const stale = Object.entries(EXCLUDED)
      .filter(([f, reason]) => !tracked.has(f) || !(reason in REASONS))
      .map(([f, reason]) => (tracked.has(f)
        ? `${f}: reason "${reason}" is not in the closed set`
        : `${f}: is not tracked, so the exclusion is stale`));
    expect(stale, 'an exclusion that no longer describes a tracked file, or a reason outside the closed set').toEqual([]);
    // Every MUST_STATE site must be IN the swept population -- an excluded site is an unswept claim.
    expect(MUST_STATE.map((s) => s.file).filter((f) => !corpus().includes(f)), 'a named site sits outside the sweep').toEqual([]);
  });
});
