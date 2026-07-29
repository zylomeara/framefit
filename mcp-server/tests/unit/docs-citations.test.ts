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
// FENCE RULE. Inside a fenced block, a line whose first non-space character is `#` or `//` is
// PROSE -- for the ban and for the citation collector alike. (`//` because
// `docs/design-qa-tutorial.md` annotates four `json` fences that way, and a banned citation there
// would otherwise be invisible.) Only NON-COMMENT fence lines are exempt from the ban, and they are
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
const CITATION_FLOOR = 3;

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
      lines.push({ page, line: i + 1, text: raw });
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

function collectCitations(lines: ProseLine[]): Citation[] {
  const out: Citation[] = [];
  for (const { page, line, text } of lines) {
    for (const m of text.matchAll(CITATION)) {
      out.push({ page, line, citedPath: m[1], literal: m[2] });
    }
  }
  return out;
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
    const { lines } = proseLines();
    const offenders: string[] = [];
    for (const { page, line, text } of lines) {
      for (const m of text.matchAll(CITATION_OPENER)) {
        const at = m.index ?? 0;
        CITATION_AT.lastIndex = at;
        if (CITATION_AT.test(text)) continue;
        // `(see below)` and `(see limits)` are ordinary prose, and so is a line that ends on a
        // wrapped `(see` before a markdown link on the next line. What is NOT ordinary prose is
        // reaching for a backticked or linked source right here: that is a citation, and it either
        // matches the sanctioned form or it is broken.
        const rest = text.slice(at);
        const close = rest.indexOf(')');
        const head = close === -1 ? rest : rest.slice(0, close);
        if (!head.includes('`') && !head.includes('](')) continue;
        offenders.push(
          `${page}:${line}: citation-shaped but not the sanctioned form (see \`<repo-relative-path>\`, \`<literal>\`): ${rest.slice(0, 90)}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('resolves every citation: path exists and the literal occurs exactly once', () => {
    const citations = collectCitations(proseLines().lines);
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
    const citations = collectCitations(proseLines().lines);
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
