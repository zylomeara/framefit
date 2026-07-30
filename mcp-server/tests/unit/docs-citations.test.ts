// Gate 4 -- docs-citations. Every source citation in `docs/` must be a repo-relative path plus a
// literal that occurs in that file EXACTLY ONCE:
//
//     (see `<repo-relative-path>`, `<literal>`)
//
// `file:line` is forbidden. Line numbers rot silently: nothing in the repo re-checks them, and the
// three citations this gate was built on were all wrong or one edit away from being wrong.
//
// Why UNIQUENESS and not "the literal appears somewhere". An anchor-substring check is not a check.
// `docs/status.md:14` cited `docker/Dockerfile:21` for the `bin` symlink; `:21` is a COPY line and
// the symlink is on `:26`, yet `bin` is in that file on 6 LINES (what `grep -c bin` counts) at 7
// OCCURRENCES (what this gate counts, and what its failure string reports) -- so a substring check
// on the word the sentence shares with its target stays green on a citation that points at the
// wrong line. `docs/status.md:232` cited `mcp-server/package.json:23` for
// `--env-file-if-exists=.env`, which occurs on `:22` AND `:23` -- right today, and green under any
// substring check after it rots by one line. Exactly-once is what makes a citation checkable.
//
// A NEAR MISS IS A BROKEN CITATION, NOT AN ABSENCE. The trap this gate is built to avoid is
// checking one syntax and banning one syntax while everything in between degrades to "not a
// citation": a citation wrapped over two lines, one whose path is a markdown link, one with a
// doubled space around the separator -- each would be collected by nothing, so a citation naming a
// nonexistent file and a nonexistent literal would pass. The sanctioned form runs to 125 characters
// on one of these pages, so wrapping is not hypothetical. `citation-shaped prose that misses the
// sanctioned form` closes that: anything that opens `(see` and reaches for a backticked or linked
// source must match the sanctioned form exactly or be named.
//
// THE WRAP WAS THE ONE VARIANT LEFT OPEN, AND IT WAS REACHED. Round 1 closed the doubled space and
// the markdown-link path and left the WRAP -- because every row here read the corpus LINE BY LINE,
// and a line that ends on `(see` holds no backtick, so the near-miss row took its "ordinary prose"
// branch and the collector never saw a citation at all. Reproduced, not argued: appending
//
//     The mode table is derived from the resolver (see
//     `mcp-server/src/nowhere-at-all.ts`, `a literal that exists nowhere in this repository`).
//
// to docs/coverage.md left all four rows GREEN -- a citation naming a file that does not exist and a
// literal that exists nowhere. That is the exact defect this gate was built for, one line break away.
// Two citations landed in it before it was noticed.
//
// SO A WRAPPED OPENER IS FOLDED BEFORE ANY ROW READS IT. `foldWrappedOpeners` joins a prose line that
// ends on `(see` (optional trailing whitespace) with the line after it, keeping the FIRST line's
// number, and both the collector and the near-miss row read the folded text. A wrapped citation is
// therefore either sanctioned -- and then path-checked, uniqueness-checked and counted like any other
// -- or reported. It cannot be neither, which is what it was.
//
// THE COLLECTOR IS WHERE THAT BLINDNESS WAS SHARED. `path exists` and `literal occurs exactly once`
// consume whatever `collectCitations` produced, so a collector that missed a citation silenced all
// three rows at once, and only the FLOOR noticed -- by counting 7 where 9 were expected. Folding at
// the collector is what makes those two rows see a wrapped citation at all.
//
// WHAT COUNTS AS REACHING FOR A SOURCE, once the fold is in place. On a single line the round-1 rule
// is unchanged (a backtick or a `](` in the head). For a FOLDED opener it cannot be: measured over
// docs/, all three real wrapped openers are markdown CROSS-REFERENCES -- two plain links, and
// `docs/tools/design-system.md`'s `` [`get_design_context`](navigation.md#get_design_context) ``,
// whose head carries both a backtick and a `](` while being ordinary prose. So a folded opener is a
// citation attempt when its head reaches for a SOURCE: a token shaped like a source file
// (SOURCE_PATH_SHAPED -- the ban's extension vocabulary minus `md`, plus Dockerfile/Caddyfile,
// existence NOT required, so a nonexistent `.ts` is still an attempt), or a BACKTICKED token that
// resolves to a file in this repository (which reaches `LICENSE` and a `.md` page without making the
// extension list decide it). Residual, stated rather than discovered later: a wrapped near-miss whose
// path is neither source-shaped nor an existing repo file -- a misspelled `.md` page, say -- is not
// reported. No citation in this corpus targets a `.md` page, and the floor still catches deletion.
//
// FENCE RULE. Inside a fenced block, a line whose first non-space character is `#` or `//` is
// PROSE -- for the ban and for the citation collector alike. (`//` because
// `docs/design-qa-tutorial.md` opens each of its four request fences with a `// <tool>` line, and a
// banned citation there would otherwise be invisible. The rule is tag-agnostic, which is why those
// fences moving from `json` to `jsonc` changes nothing here.) Only NON-COMMENT fence lines are
// exempt from the ban, and they are
// never collected as citations, because a shell transcript may legitimately print `file:line` (a
// grep result, a stack frame, a compiler error). That exemption is a FORWARD GUARD, not a hole: as
// of this gate landing there are ZERO non-comment in-fence `file:line` tokens anywhere under
// `docs/`. All three tokens the gate was built on were in scope, and one of them --
// `docs/status.md:14`, a `#` comment inside the first `bash` fence of that page -- is in scope only
// because of this rule. A blanket "exempt everything inside a fence" would delete that fixture and
// put CITATION_FLOOR = 3 out of reach.
//
// HTML comments are not prose either: `<!-- ... -->` must not hide a banned token, and a
// commented-out citation must not hold the floor up on behalf of a deleted real one.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/docs/**/*.md and <root>/mcp-server/tests/unit/<this file>.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

// A group that adds a citation raises this constant DELIBERATELY. It exists so the corpus cannot
// silently become empty -- a collector that quietly matches nothing would otherwise pass forever,
// and every assertion below would be vacuous. It guards against DELETION only: a newly added
// citation is path- and uniqueness-checked the moment it lands, floor or no floor. NOT an equality
// assert: later work legitimately adds citations, and an equality assert would read correct work as
// a regression.
// Raised to 4 by docs/deployment.md's citation of `mcp-server/.env.example`, `DS_LIBRARY_TTL_SEC=86400`.
// Raised to 6 by docs/status.md's two: `docker/Dockerfile`, `FROM node:20-alpine AS runtime` (the
// runtime stage declares no ENTRYPOINT and inherits docker-entrypoint.sh from its base -- the page
// used to claim the image was "CMD-only") and `mcp-server/src/infrastructure/env-graph.ts`,
// `throws on a garbage id` (an unparseable DS_TEAM_IDS aborts boot, so it belongs in the
// boot-aborts bullet and not the still-boots one).
// Raised to 7 by docs/design-qa-tutorial.md's citation of
// `mcp-server/src/adapters/driving/tools/get-layout-spec-tool.ts`,
// `useLoader = extractorMode === 'loader' && !!deps.publicBaseUrl` -- the condition that degrades the
// default loader mode to the full inline script, which is why the stdio reader is handed an
// `extractor_note` and never an `upload_url`.
// Raised to 9 by docs/design-qa-tutorial.md's two, both added where the page had been asserting
// something a reader could not check: `mcp-server/src/adapters/driving/tools/dom-snapshot-schema.ts`,
// `borders: EdgesSchema,` (the required keys a trimmed step-4 snapshot was missing, which had the
// page printing a request the handler refuses) and
// `mcp-server/src/domain/layout-spec/verification.ts`,
// `frame_node_id given, but the frame node was not found in the file` (the only site that emits
// `fix_frame_id`, the thirteenth blocking action, which occurred nowhere under docs/ before).
const CITATION_FLOOR = 9;

// Ban, rule 1 -- a path-shaped token with a known extension followed by `:<digits>`. Existence is
// NOT required here: `get-variables-tool.ts:141` cited a real file by bare basename, which resolves
// nowhere, and was still a citation and still wrong.
const BANNED_BY_EXTENSION =
  /(?:[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|sh|md|example)|(?:[A-Za-z0-9_.-]+\/)*(?:Dockerfile|Caddyfile)[A-Za-z0-9_.-]*):[0-9]+/g;

// Ban, rule 2 -- ANY token followed by `:<digits>` whose left side resolves to a file in this
// repository. This is what reaches the extensionless family (`LICENSE:3`, `Makefile:12`) without
// the false positives a bare `word:digits` ban would produce: gating on existence takes today's
// docs from 14 false positives (`127.0.0.1:3846`, node ids like `12:340`, `2026-01-01T00:00`,
// `max_depth:6`) down to ZERO, measured over every prose line under `docs/`.
const PATH_SHAPED_TOKEN = /([A-Za-z0-9_][A-Za-z0-9_./-]*):[0-9]+/g;

// A token shaped like a SOURCE file: the ban's extension vocabulary minus `md`, plus the
// extensionless family. `md` is excluded deliberately and it is the whole reason this constant is
// separate from BANNED_BY_EXTENSION: every citation in this corpus names a source file (`.ts`,
// `.json`, `.example`, `Dockerfile`) and every markdown link in it names a `.md` page, so including
// `md` would classify all three of the corpus' real wrapped cross-references as broken citations.
// Existence is NOT required, exactly as in the ban above: a citation naming a `.ts` that does not
// exist is still a citation and still wrong.
const SOURCE_PATH_SHAPED =
  /[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|sh|example)\b|(?:[A-Za-z0-9_.-]+\/)*(?:Dockerfile|Caddyfile)[A-Za-z0-9_.-]*/;

// A prose line whose LAST content is the opener. `[ \t]*` and not `\s*`: the line has already been
// split, so a `\s` class could only match the same trailing spaces, and being explicit says that a
// wrap is what is being detected rather than any whitespace run.
const WRAPPED_OPENER = /\(see[ \t]*$/i;

// The sanctioned form. `[^`]+` on the literal is how "the literal must not itself contain a
// backtick" is enforced -- structurally, so a backticked literal simply is not a citation.
const CITATION = /\(see `([^`]+)`, `([^`]+)`\)/g;
// Same source, anchored: used to ask "does the sanctioned form start exactly HERE".
const CITATION_AT = /\(see `([^`]+)`, `([^`]+)`\)/y;
// Anything that opens a citation. Deliberately looser than the sanctioned form -- that gap is the
// point.
const CITATION_OPENER = /\(see\b/gi;

interface ProseLine {
  page: string;
  line: number;
  text: string;
  /**
   * Offsets, within `text`, of the `(see` openers that sat at a FOLD point -- i.e. the ones that were
   * wrapped in the file. Empty on an unfolded line. Recorded rather than re-derived because a folded
   * line can hold several openers and only some of them were wrapped, and the two get different
   * near-miss rules.
   */
  wrapOffsets: number[];
}

interface Citation {
  page: string;
  line: number;
  citedPath: string;
  literal: string;
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

// Every line of every docs page that counts as prose: outside a fence, or a `#`/`//` comment inside
// one. Fence delimiters themselves are never prose, and neither is anything inside an HTML comment.
function proseLines(): { lines: ProseLine[]; pages: string[] } {
  const files = markdownFiles(DOCS_DIR);
  // The corpus cannot silently be empty: an empty docs/ would make every assertion below vacuous.
  expect(files.length, `no .md files found under ${DOCS_DIR}`).toBeGreaterThan(0);
  const lines: ProseLine[] = [];
  for (const file of files) {
    const page = path.relative(REPO_ROOT, file);
    // Blank the contents of HTML comments but keep the newlines, so offender line numbers stay
    // true to the file on disk.
    const text = readFileSync(file, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
    let inFence = false;
    let delimiters = 0;
    text.split('\n').forEach((raw, i) => {
      if (/^\s*(?:```|~~~)/.test(raw)) {
        inFence = !inFence;
        delimiters += 1;
        return;
      }
      if (inFence && !/^\s*(?:#|\/\/)/.test(raw)) return;
      lines.push({ page, line: i + 1, text: raw, wrapOffsets: [] });
    });
    // `inFence` is a bare parity toggle, so ONE stray delimiter silently exempts the whole rest of
    // a page from both the ban and the collector. Fail loudly rather than go quiet.
    expect(
      delimiters % 2,
      `unbalanced code fences in ${page}: ${delimiters} fence delimiter lines (odd), so every line after the stray one is misclassified`,
    ).toBe(0);
  }
  return { lines, pages: files.map((f) => path.relative(REPO_ROOT, f)) };
}

/**
 * Prose lines with every WRAPPED opener joined to the line that follows it.
 *
 * The joined line keeps the FIRST line's number, so an offender is reported where its `(see` is
 * written rather than where the wrap happened to land. Folding is iterative, because a line that ends
 * on `(see` may be followed by one that does too; it terminates because each step consumes a line.
 * The join is a single space: the two halves were separate lines, so nothing else can have been meant,
 * and it is what makes `(see` + `` `path`, `literal`) `` read as the one-line sanctioned form.
 *
 * NOT used by the ban row, and that is a decision: folding would join a `foo.ts` at the end of one
 * line with a `:12` at the start of the next into a `file:line` token that nobody wrote, and it would
 * report tokens from the second line under the first line's number. Concatenation cannot HIDE a
 * banned token, so the ban row loses nothing by reading the raw lines.
 */
function foldWrappedOpeners(lines: ProseLine[]): ProseLine[] {
  const out: ProseLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const { page, line } = lines[i];
    let text = lines[i].text;
    const wrapOffsets: number[] = [];
    while (WRAPPED_OPENER.test(text) && i + 1 < lines.length && lines[i + 1].page === page) {
      wrapOffsets.push(text.search(WRAPPED_OPENER));
      i += 1;
      text = `${text.replace(/[ \t]+$/, '')} ${lines[i].text.trim()}`;
    }
    out.push({ page, line, text, wrapOffsets });
  }
  return out;
}

function collectCitations(lines: ProseLine[]): Citation[] {
  const out: Citation[] = [];
  for (const { page, line, text } of lines) {
    for (const m of text.matchAll(CITATION)) {
      out.push({ page, line, citedPath: m[1], literal: m[2] });
    }
  }
  return out;
}

/**
 * Every citation-shaped fragment that is not the sanctioned form, given FOLDED prose lines.
 *
 * Extracted from the row that asserts it so the classification can be driven by fixtures too: the
 * variant that shipped open was one nobody had written, and a rule proved only against today's corpus
 * cannot be shown to handle a case today's corpus lacks.
 *
 * Two rules, by whether the opener was WRAPPED:
 *   - NOT wrapped: round 1's rule, unchanged -- a backtick or a `](` in the head is a citation
 *     attempt. (Measured: on the current corpus this reports nothing, and every case it used to
 *     report still reports.)
 *   - WRAPPED: the head must reach for a SOURCE, because a wrapped opener is overwhelmingly a
 *     markdown cross-reference in this corpus and all three real ones carry a `](` (one of them a
 *     backtick as well). Reaching for a source means a source-shaped path token, or a backticked
 *     token that is a file in this repo.
 */
function nearMissOffenders(lines: ProseLine[]): string[] {
  const offenders: string[] = [];
  for (const { page, line, text, wrapOffsets } of lines) {
    for (const m of text.matchAll(CITATION_OPENER)) {
      const at = m.index ?? 0;
      CITATION_AT.lastIndex = at;
      // The sanctioned form starting exactly here is the escape, folded or not -- which is what makes
      // a wrapped-but-well-formed citation legal, and then collected and path-checked like any other.
      if (CITATION_AT.test(text)) continue;
      const rest = text.slice(at);
      const close = rest.indexOf(')');
      const head = close === -1 ? rest : rest.slice(0, close);
      const wrapped = wrapOffsets.includes(at);
      const reaches = wrapped
        ? SOURCE_PATH_SHAPED.test(head)
          || [...head.matchAll(/`([^`]+)`/g)].some((b) => resolvesInRepo(b[1]) !== undefined)
        : head.includes('`') || head.includes('](');
      // `(see below)` and `(see limits)` are ordinary prose, and so is a wrapped opener before a
      // markdown link to another page. What is NOT ordinary prose is reaching for a source right
      // here: that is a citation, and it either matches the sanctioned form or it is broken.
      if (!reaches) continue;
      offenders.push(
        `${page}:${line}: citation-shaped but not the sanctioned form (see \`<repo-relative-path>\`, \`<literal>\`)`
        + `${wrapped ? ' [wrapped over two lines, folded before this check]' : ''}: ${rest.slice(0, 90)}`,
      );
    }
  }
  return offenders;
}

// A token is banned by rule 2 if the token itself, or any of its path suffixes, is a file in the
// repo -- so a citation that gets the directory prefix wrong is still caught.
function resolvesInRepo(token: string): string | undefined {
  const parts = token.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const candidate = parts.slice(i).join('/');
    if (candidate === '' || candidate === '.' || candidate.includes('..')) continue;
    const target = path.resolve(REPO_ROOT, candidate);
    if (target.startsWith(REPO_ROOT + path.sep) && existsSync(target) && statSync(target).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

describe('docs citations resolve to a path plus a literal that occurs once', () => {
  it('bans the `file:line` form in docs prose', () => {
    const { lines } = proseLines();
    const offenders: string[] = [];
    for (const { page, line, text } of lines) {
      // Keyed by start offset: a token can trip both rules, and it is one defect either way.
      const found = new Map<number, string>();
      for (const m of text.matchAll(BANNED_BY_EXTENSION)) {
        found.set(m.index ?? -1, `banned file:line citation \`${m[0]}\``);
      }
      for (const m of text.matchAll(PATH_SHAPED_TOKEN)) {
        const at = m.index ?? -1;
        if (found.has(at)) continue;
        const resolved = resolvesInRepo(m[1]);
        if (resolved === undefined) continue;
        found.set(at, `banned file:line citation \`${m[0]}\` (\`${resolved}\` is a file in this repo)`);
      }
      for (const at of [...found.keys()].sort((a, b) => a - b)) {
        offenders.push(`${page}:${line}: ${found.get(at)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reports citation-shaped prose that misses the sanctioned form', () => {
    const offenders = nearMissOffenders(foldWrappedOpeners(proseLines().lines));
    expect(offenders).toEqual([]);
  });

  it('classifies a wrapped opener: sanctioned or reported, and cross-references stay prose', () => {
    // The fold is the fix, so the fold's CLASSIFICATION is checked against fixtures rather than
    // against the corpus alone. A corpus-only proof would have said nothing about the case that was
    // open, because the case that was open was one nobody had written yet.
    const cases: { name: string; body: string[]; reported: boolean }[] = [
      {
        name: "the reproduction: wrapped, well-formed, nonexistent path -- sanctioned HERE and caught by `path exists`",
        body: ['A sentence (see', '`mcp-server/src/nowhere-at-all.ts`, `a literal that exists nowhere`).'],
        reported: false,
      },
      {
        name: 'wrapped, missing the literal -- a near miss, and now named',
        body: ['A sentence (see', '`mcp-server/src/domain/layout-spec/verification.ts`).'],
        reported: true,
      },
      {
        name: 'wrapped, doubled space before the path -- a near miss, and now named',
        body: ['A sentence (see', ' `mcp-server/package.json`,  `"start"`).'],
        reported: true,
      },
      {
        name: 'wrapped, path written as a markdown link -- a near miss, and now named',
        body: ['A sentence (see', '[mcp-server/src/index.ts](x), `a literal`).'],
        reported: true,
      },
      {
        name: 'wrapped before a plain markdown link -- an ordinary cross-reference',
        body: ['A sentence (see', '[docker/README](../../docker/README.md)).'],
        reported: false,
      },
      {
        name: 'wrapped before a link whose LABEL is backticked -- still an ordinary cross-reference',
        body: ['A sentence (see', '[`get_design_context`](navigation.md#get_design_context)).'],
        reported: false,
      },
      {
        // Wrapped at a DIFFERENT point: the line does not end on `(see`, so nothing is folded and
        // round 1's unchanged rule is what names it. Present so the fold cannot be mistaken for the
        // only thing standing between this gate and a wrapped citation.
        name: 'wrapped after the path instead -- no fold, and round 1\'s rule names it',
        body: ['A sentence (see `mcp-server/package.json`,', '`"start"`).'],
        reported: true,
      },
      { name: '`(see below)` is prose', body: ['A sentence (see below) and more.'], reported: false },
      { name: '`(see limits)` is prose', body: ['A sentence (see limits).'], reported: false },
    ];
    const wrong: string[] = [];
    for (const c of cases) {
      const lines: ProseLine[] = c.body.map((text, i) => ({ page: 'fixture.md', line: i + 1, text, wrapOffsets: [] }));
      const got = nearMissOffenders(foldWrappedOpeners(lines));
      if ((got.length > 0) !== c.reported) {
        wrong.push(`${c.name}: expected ${c.reported ? 'reported' : 'prose'}, got ${JSON.stringify(got)}`);
      }
    }
    expect(wrong).toEqual([]);
    // The fold itself, separately: a wrapped opener must end up on ONE line carrying the FIRST line's
    // number, or every rule above is being applied to text nobody reads.
    const folded = foldWrappedOpeners([
      { page: 'p.md', line: 7, text: 'left (see', wrapOffsets: [] },
      { page: 'p.md', line: 8, text: '  `a/b.ts`, `lit`) right', wrapOffsets: [] },
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0].line).toBe(7);
    expect(folded[0].text).toBe('left (see `a/b.ts`, `lit`) right');
    expect(folded[0].wrapOffsets).toEqual([5]);
  });

  it('leaves the ban row nothing to be blind to: no banned token is split across a line break', () => {
    // The blindness the wrap exposed was SHARED -- every row read the corpus line by line -- so the one
    // row deliberately left on RAW lines has to answer for itself. It is left raw because folding
    // could JOIN a `foo.ts` at the end of one line with a `:12` at the start of the next into a
    // `file:line` token nobody wrote, and would report second-line tokens under the first line's
    // number. The cost of that decision is this: a banned token written across a line break would not
    // be seen. Measured at zero, and asserted so it stays a forward guard rather than becoming a hole
    // the way the wrap did.
    const { lines } = proseLines();
    const offenders: string[] = [];
    for (let i = 0; i + 1 < lines.length; i += 1) {
      const here = lines[i];
      const next = lines[i + 1];
      if (here.page !== next.page) continue;
      if (!/^\s*:[0-9]+/.test(next.text)) continue;
      // A path-shaped tail, with or without an extension: `LICENSE` and `Makefile` are as citable as
      // `foo.ts`, and the ban's rule 2 reaches them by existence rather than by extension.
      if (/[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(here.text.replace(/\s+$/, ''))) {
        offenders.push(`${here.page}:${here.line}: a path-shaped token ends this line and \`:<digits>\` opens the next -- a file:line citation the ban row reads as two harmless halves`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('resolves every citation: path exists and the literal occurs exactly once', () => {
    const citations = collectCitations(foldWrappedOpeners(proseLines().lines));
    const offenders: string[] = [];
    for (const { page, line, citedPath, literal } of citations) {
      if (path.isAbsolute(citedPath) || citedPath.split('/').includes('..')) {
        offenders.push(`${page}:${line}: ${citedPath} -- not a repo-relative path; literal occurs 0 times`);
        continue;
      }
      const target = path.resolve(REPO_ROOT, citedPath);
      if (!existsSync(target) || !statSync(target).isFile()) {
        offenders.push(`${page}:${line}: ${citedPath} -- no such file under the repo root; literal occurs 0 times`);
        continue;
      }
      const occurrences = readFileSync(target, 'utf8').split(literal).length - 1;
      // Exactly once. Zero means the citation is wrong; more than once means it is not an anchor --
      // it cannot tell a reader which line the sentence is about, which is the defect being removed.
      if (occurrences !== 1) {
        offenders.push(`${page}:${line}: ${citedPath} -- literal occurs ${occurrences} times`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps at least CITATION_FLOOR distinct citations in the corpus', () => {
    const citations = collectCitations(foldWrappedOpeners(proseLines().lines));
    // DISTINCT (path, literal) pairs. Counting occurrences would let one citation repeated three
    // times -- or three copies of it inside an HTML comment -- hold the floor up while every real
    // one is deleted.
    const distinct = new Set(citations.map((c) => `${c.citedPath} ${c.literal}`));
    expect(
      distinct.size,
      `expected at least ${CITATION_FLOOR} distinct citations under docs/, found ${distinct.size} (from ${citations.length} occurrences)`,
    ).toBeGreaterThanOrEqual(CITATION_FLOOR);
  });
});
