// Gate -- design-qa-cycle-once. The design-QA cycle is DEFINED in one place, and every other
// enumeration of it in this repository is checked against that definition rather than trusted.
//
// THE DEFECT THIS EXISTS FOR. Four pages and one delivered string say "the cycle is stated once, in
// docs/tools/design-qa.md" -- and nothing enforced it. Measured against the commit before this one:
// a SECOND, CONTRADICTING numbered cycle appended to `docs/design-qa-tutorial.md` left the full suite
// green. That is the precise drift the "stated once" sentence was written to prevent, so the sentence
// was decoration. A reader who follows the wrong copy captures at the wrong step and reaches a verdict
// over the wrong measurement; this repository's whole claim is that it never does that.
//
// WHAT IS ACTUALLY GATED, and it is narrow on purpose:
//
//   THE DEFINITION -- the numbered list under `## The cycle` on docs/tools/design-qa.md -- is parsed,
//   and its ordered tool names are the canonical sequence. Nothing here types that sequence out; a
//   step reordered on that page reorders this gate with it, which is correct: that page IS the
//   definition. What the page cannot do is disagree with itself, so it is also required to name every
//   tool once and to be the only such list on its own page.
//
//   EVERY OTHER ENUMERATION must be a SUBSEQUENCE of it. Subsequence and not equality, because the
//   honest restatements are partial by design: the tutorial's table of contents skips step 1, the
//   client's header narrative skips it too, and both are correct. What a subsequence CANNOT be is
//   reordered -- `compare_node_to_dom` before `get_layout_spec`, or `suggest_pairs` after the
//   compare -- which is what a contradicting cycle looks like every time.
//
//   AND IT MUST DECLARE ITSELF a restatement, by citing the definition's anchor in the same file.
//   An enumeration that cites nothing is a second definition however well it happens to agree today.
//
// THE POPULATION IS DERIVED, not listed. A list of pages to sweep is the structure that already failed
// twice in this repository (extractor-size-lock.test.ts's header carries both). So: every TRACKED
// markdown file, every markdown numbered-list block in it, and a block enters the corpus when it names
// three or more of the canonical tools. `git ls-files` is the source, and a hold-out has to be written
// into EXCLUDED with a reason from a closed set.
//
// WHY "A NUMBERED LIST" AND NOT "ANY THREE TOOL NAMES IN ORDER". Measured over this tree, a
// paragraph-level rule reports nine violations that are all correct prose -- the tool table in
// README.md, the token-scope bullets, a test file's own fixture rows -- because a table of tool names
// has an order and it is alphabetical, not procedural. A rule with nine standing false positives is a
// rule nobody can leave red, so it would be relaxed within a week. The numbered list is what a CYCLE
// is written as, and over the same tree it finds exactly two blocks, both of them real.
//
// RESIDUAL, WITH ITS FAILURE DIRECTION. A contradicting cycle written as flowing prose, or as an
// arrow chain, or as bullets with no numbers, is invisible here -- this FAILS OPEN on any spelling of
// an enumeration that is not a markdown ordered list. The delivered `SERVER_INSTRUCTIONS` string is
// checked directly below precisely because it is one of those spellings and it ships to every client;
// the general case is not closed and cannot be by an enumeration of spellings (the same argument
// extractor-size-lock.test.ts makes about size claims, and for the same reason).
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_INSTRUCTIONS } from '../../src/infrastructure/server.js';
import { registerAllTools } from '../../src/adapters/driving/tools/register-all.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/docs/... and <root>/mcp-server/tests/unit/<this file>.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The page that DEFINES the cycle, and the anchor every restatement has to cite. */
const DEFINITION_PAGE = 'docs/tools/design-qa.md';
const DEFINITION_HEADING = '## The cycle';
const ANCHOR = 'design-qa.md#the-cycle';

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/**
 * snake_case tokens. This is a candidate filter, never the vocabulary: `include_extractor`,
 * `node_id` and `unmatched_dom` are all snake_case and all appear inside the definition list, so
 * "every snake_case token in the cycle list" is not the cycle -- measured, it produced a seven-name
 * sequence out of a five-step list. The vocabulary is the LIVE registered tool names, below.
 */
const TOOL_TOKEN = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

/**
 * Every tool name this server registers, through the real registration path. Being the vocabulary,
 * it also means a RENAMED tool reds here: the definition page would stop enumerating a tool that
 * exists, and the parse below refuses a cycle that has gone short.
 */
function registeredToolNames(): Set<string> {
  const { server, registrations } = makeFakeMcpServer();
  registerAllTools(server, {
    buildApi: () => { throw new Error('buildApi must not be called during tool registration'); },
    logger: createLogger({ level: 'silent' }),
  } as unknown as ToolDeps);
  expect(registrations.size, 'the recording server captured no registrations').toBeGreaterThan(0);
  return new Set(registrations.keys());
}

/** The contiguous markdown ordered-list blocks of a text: `1.`/`1)` opening, items and their bodies. */
interface Block { startLine: number; text: string }
function orderedListBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const out: Block[] = [];
  let open: { startLine: number; lines: string[] } | null = null;
  const close = (): void => {
    if (open) out.push({ startLine: open.startLine, text: open.lines.join('\n') });
    open = null;
  };
  lines.forEach((line, i) => {
    if (/^\s*\d+[.)]\s/.test(line)) {
      if (!open) open = { startLine: i + 1, lines: [] };
      open.lines.push(line);
    } else if (open && line.trim() !== '') {
      // A continuation line of the item above it -- the definition's step 3 wraps onto three.
      open.lines.push(line);
    } else {
      close();
    }
  });
  close();
  return out;
}

/** The tool names a text mentions, in order of FIRST mention, deduplicated. */
function mentionOrder(text: string, vocabulary: Set<string>): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(TOOL_TOKEN)) {
    if (vocabulary.has(m[1]) && !seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

/** Is `candidate` an ordered subsequence of `canonical`? */
function isSubsequence(candidate: string[], canonical: string[]): boolean {
  let i = 0;
  for (const name of candidate) {
    const at = canonical.indexOf(name, i);
    if (at === -1) return false;
    i = at + 1;
  }
  return true;
}

/**
 * The canonical sequence, parsed from the definition page's `## The cycle` section. Everything below
 * quantifies over this, so it is asserted to be a real, plural, deduplicated list before it is used --
 * a heading that stopped matching would otherwise silently make every row vacuous.
 */
function canonicalCycle(): { names: string[]; block: Block } {
  const text = read(DEFINITION_PAGE);
  const start = text.indexOf(`\n${DEFINITION_HEADING}\n`);
  expect(start, `${DEFINITION_PAGE} has no \`${DEFINITION_HEADING}\` section`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  const blocks = orderedListBlocks(section);
  expect(blocks.length, `${DEFINITION_PAGE}: \`${DEFINITION_HEADING}\` must hold exactly one numbered list`)
    .toBe(1);
  return { names: mentionOrder(blocks[0].text, registeredToolNames()), block: blocks[0] };
}

/**
 * Why a tracked page may sit outside the sweep. Closed, so "it was inconvenient" cannot become a
 * reason. Empty today, and that is the point: nothing is held out, so nothing has to be trusted.
 */
const REASONS = {} as const;
const EXCLUDED: Record<string, keyof typeof REASONS> = {};

/** Tracked markdown, or undefined outside a git checkout (a release tarball, a vendored subtree). */
let trackedCache: string[] | undefined;
let trackedAsked = false;
function trackedMarkdown(): string[] | undefined {
  if (!trackedAsked) {
    trackedAsked = true;
    // No history here is the ONE condition that legitimately means "this population cannot be built".
    // Every other git failure inside a real repository is a failure to MEASURE and must fail loud --
    // a bare catch turns this whole sweep into a silent skip, which is the shape of the defect above.
    trackedCache = existsSync(path.join(REPO_ROOT, '.git'))
      ? execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .split('\0').filter((f) => f !== '' && !(f in EXCLUDED))
      : undefined;
  }
  return trackedCache;
}
const OUTSIDE_GIT = trackedMarkdown() === undefined;

/** Every ordered-list block in the tracked tree that enumerates three or more cycle tools. */
function enumerations(names: string[]): { page: string; block: Block; order: string[] }[] {
  const vocabulary = new Set(names);
  const out: { page: string; block: Block; order: string[] }[] = [];
  for (const page of trackedMarkdown() ?? []) {
    for (const block of orderedListBlocks(read(page))) {
      const order = mentionOrder(block.text, vocabulary);
      if (order.length >= 3) out.push({ page, block, order });
    }
  }
  return out;
}

describe('the design-QA cycle is defined once, and every restatement of it agrees', () => {
  it('parses a real ordered cycle out of the definition page', () => {
    const { names } = canonicalCycle();
    expect(names.length, `${DEFINITION_PAGE} \`${DEFINITION_HEADING}\` yields too few tool names to order`)
      .toBeGreaterThanOrEqual(4);
    expect(new Set(names).size, `${DEFINITION_PAGE}: a tool is enumerated twice in the definition`)
      .toBe(names.length);
  });

  it.skipIf(OUTSIDE_GIT)('sweeps a derived population that really holds the definition and at least one restatement', () => {
    const { names } = canonicalCycle();
    const tracked = trackedMarkdown()!;
    expect(tracked.length, 'git listed no markdown, so this sweep would pass over nothing').toBeGreaterThan(10);
    const found = enumerations(names);
    expect(found.map((f) => f.page), 'the definition page is not in the swept population')
      .toContain(DEFINITION_PAGE);
    expect(found.length, 'only the definition was found, so every rule below holds over one row it '
      + 'cannot fail -- the restatements are what this gate exists to check').toBeGreaterThan(1);
    // Both directions on the excuse table, so it cannot rot into a hole.
    const staleExclusions = Object.keys(EXCLUDED).filter((f) => !existsSync(path.join(REPO_ROOT, f)));
    expect(staleExclusions, 'an exclusion that names no file').toEqual([]);
  });

  it.skipIf(OUTSIDE_GIT)('states the cycle once: every other enumeration is a subsequence of it, and cites it', () => {
    const { names } = canonicalCycle();
    const offenders: string[] = [];
    let definitionBlocks = 0;
    for (const { page, block, order } of enumerations(names)) {
      const at = `${page}:${block.startLine}`;
      if (page === DEFINITION_PAGE) {
        definitionBlocks += 1;
        if (order.join(' ') !== names.join(' ')) {
          offenders.push(`${at}: a second numbered cycle on the definition page itself (${order.join(' -> ')})`);
        }
        continue;
      }
      if (!isSubsequence(order, names)) {
        offenders.push(
          `${at}: enumerates the cycle as ${order.join(' -> ')}, which is not the order `
          + `${DEFINITION_PAGE} defines (${names.join(' -> ')}). Restate it in that order, or change the `
          + 'definition -- what this repository cannot ship is two cycles that disagree',
        );
      }
      if (!read(page).includes(ANCHOR)) {
        offenders.push(
          `${at}: enumerates the cycle without citing \`${ANCHOR}\` anywhere on the page, so it reads `
          + 'as a second definition rather than as a restatement of the one',
        );
      }
    }
    expect(offenders).toEqual([]);
    expect(definitionBlocks, `${DEFINITION_PAGE} must carry exactly one numbered cycle`).toBe(1);
  });

  it('the delivered SERVER_INSTRUCTIONS carry the same cycle, whole and in order', () => {
    // Checked directly, not through the markdown sweep: it is not markdown, it is not a numbered
    // list this parser would see, and it is the ONLY design-QA guidance that reaches an agent on a
    // host with no skills mechanism. Whole, not a subsequence, because it is the compression that
    // stands in for the page when the page is not read -- a step missing there is a step missing
    // everywhere.
    const { names } = canonicalCycle();
    expect(mentionOrder(SERVER_INSTRUCTIONS, new Set(names)),
      'the initialize instructions enumerate a different cycle from the one the docs define').toEqual(names);
    expect(SERVER_INSTRUCTIONS, 'and they must point at where it is defined').toContain('docs/tools/design-qa.md');
  });

  it('is not vacuous: the detector sees a contradicting cycle, and a truthful partial one passes', () => {
    // The mutation this file was written against, run through the two rules that would catch it.
    // Without this row every assertion above could be satisfied by a detector that finds nothing.
    const { names } = canonicalCycle();
    const contradicting = [
      `1. [Compare](#a) (\`${names[names.length - 1]}\`)`,
      `2. [Capture](#b) (\`${names[1]}\`)`,
      `3. [Pairs](#c) (\`${names[names.length - 2]}\`)`,
    ].join('\n');
    const blocks = orderedListBlocks(contradicting);
    expect(blocks.length, 'the ordered-list parser did not see a three-item list at all').toBe(1);
    const order = mentionOrder(blocks[0].text, new Set(names));
    expect(order.length, 'the detector did not pick the tool names out of the block').toBeGreaterThanOrEqual(3);
    expect(isSubsequence(order, names), 'a reordered cycle reads as a legal subsequence, so the rule is blind').toBe(false);
    // ...and the honest partial restatement, which skips optional steps, is NOT reported.
    const partial = [`1. a (\`${names[1]}\`)`, `2. b (\`${names[names.length - 1]}\`)`].join('\n');
    expect(isSubsequence(mentionOrder(partial, new Set(names)), names),
      'skipping an optional step must stay legal, or every truthful restatement goes red').toBe(true);
  });
});
