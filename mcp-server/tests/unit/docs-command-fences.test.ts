// Gate 3, STATIC HALF -- docs-command-fences. Every `bash` fence on a page a reader is told to copy
// from is classified exactly once: it either runs unattended, or it declares WHY it cannot.
//
// The motivating defect: `docs/status.md` opened with a fence whose first line was English prose
// ("A source checkout") and whose command was `node dist/index.js status`. `dist/` is git-ignored
// and is never built at the repo root, so the page's own first command fails with MODULE_NOT_FOUND
// from the directory its comment named. Measured on a tree materialised from `git ls-files` and
// then built: from the repo root exit 1 (`Cannot find module '<tmp>/dist/index.js'`), from
// `mcp-server/` exit 0 (`1 ok, 5 skipped, 0 failed`). Nothing in the repo could notice, because
// nothing knew which directory the fence was supposed to run in.
//
// So: the directory comes from ONE place -- the fence's own first line, `cd <repo-relative-path>`.
// Four conventions existed before this gate (a bare `cd`, English prose in a comment, a trailing
// `# source checkout, from mcp-server/` annotation, and a `cd` buried mid-fence); after it there is
// one, and the executing half (5b, `scripts/run-doc-sequences.mjs`) takes the directory from that
// line and nothing else.
//
// WHY CLASSIFY AND NOT MERELY ORDER. Two fences in this corpus cannot be made to run by any amount
// of reordering: `docker/README.md`'s operator-CLI block drives a running `full` stack through
// literal `<keycloak-user-id>` placeholders, and `docker/README.md`'s smoke-test block is three
// ALTERNATIVES whose top-to-bottom execution is three full image builds proving something no reader
// is meant to do. A vocabulary that could not say those two things would force the executing half
// to either lie about them or skip them silently, which is the same defect one level up.
//
// TWO CLASSES, and the marker is what separates them:
//   - EXCLUDED  -- carries `# not-executed: <reason>[,<reason>...]`, every reason from EXCLUSION_REASONS.
//   - EXECUTABLE -- carries no such marker, so it must be shaped to run: `cd <path>` first, a
//                   terminator from TERMINATORS last, and no banned form.
// "Executable" is a property of the FENCE (can this run unattended), not a statement about which
// fences CI drives. Which subset the executing half actually runs is 5b's scope, declared in the
// runner -- deliberately not encoded here, so a scope decision can never quietly re-label a fence
// as unrunnable.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/{README.md,docs,docker,...} and <root>/mcp-server/tests/unit/<this file>.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// The pages that carry commands a reader is told to copy. Per-page floors, NOT pinned line numbers:
// every task on this line moves fences, and a pinned list of line numbers was measured twice a day
// apart and disagreed with itself. A floor cannot rot into a false red, and it still catches the
// failure that matters -- a fence silently dropping out of the corpus.
//
// Re-derived from the committed files on 2026-07-29 with `grep -cE '^[[:space:]]*```bash'`:
// README 4, docs/status.md 3, docker/README.md 7, examples/mcp-config/README.md 3,
// docs/deployment.md 9, CONTRIBUTING.md 1 -- total 27. Note docs/deployment.md is 9 and not 8: one
// fence is INDENTED two spaces inside a bullet, which `grep '^```bash'` does not see. The collector
// below is indentation-aware for exactly that reason.
const FENCE_FLOOR: Record<string, number> = {
  'README.md': 4,
  'docs/status.md': 3,
  'docker/README.md': 7,
  'examples/mcp-config/README.md': 3,
  'docs/deployment.md': 9,
  'CONTRIBUTING.md': 1,
};
const PAGES = Object.keys(FENCE_FLOOR);

// The EXECUTABLE side needs its own floor, and this is what makes the partition mean anything.
// `executable + excluded === total` is satisfied by an EMPTY executable side: mark every fence
// `# not-executed:` with a plausible reason and the census identity still holds, the reason set
// still holds, and the `cd`, precondition and terminator rules all pass VACUOUSLY because they
// quantify over an empty set. The executing half would then drive nothing and report green over
// nothing -- this gate's own motivating defect, one level up. These floors refuse that, and they
// refuse the cheaper version too: quietly demoting one executable fence to excluded.
//
// Re-derived in round 2 by RUNNING each disputed fence in a materialised tree, not by reading its
// neighbours. Total 8.
const EXECUTABLE_FLOOR: Record<string, number> = {
  'README.md': 1,
  'docs/status.md': 1,
  'docker/README.md': 4,
  'examples/mcp-config/README.md': 1,
  'docs/deployment.md': 1,
  'CONTRIBUTING.md': 0,
};

// The closed set of reasons a fence may decline to run. Extend it DELIBERATELY, in this file, with
// a fence that needs it -- `every declared reason is actually used` below refuses dead vocabulary,
// so a speculative reason fails rather than sitting here inviting misuse.
const EXCLUSION_REASONS = new Set([
  // `git clone` of this repository: it is private, so an unauthenticated clone cannot succeed.
  'requires-public-repo',
  // Needs the `claude` CLI, which CI does not have, AND mutates the caller's MCP client config.
  'requires-mcp-host',
  // Pulls from the GHCR package, which is private: an anonymous token carries no pull scope.
  'requires-registry-auth',
  // Needs a container this fence did not create -- one to `exec` into or attach to. NOT a synonym
  // for "mentions docker": `docker compose run --rm` deliberately does NOT need one, and marking a
  // `run` fence with this reason was the round-1 defect that excluded the crash-loop recipe from the
  // very runner that exists to prove it.
  'requires-running-deployment',
  // Needs a git-ignored env file that no fence on the same page creates. Measured: the full-profile
  // `framefit` service declares `env_file: ../mcp-server/.env`, and compose exits 1 with
  // `env file .../mcp-server/.env not found` before starting anything.
  'requires-env-file',
  // Prompts on a tty (`caddy hash-password`), so it cannot run unattended at all.
  'requires-interactive-input',
  // The fence is a MENU, not a sequence: running it top to bottom does something no reader intends.
  'alternative-forms',
  // Carries a literal the reader must substitute (`<keycloak-user-id>`, `your-vps`, `figd_...`).
  'contains-placeholder',
  // Contains a command that never returns (`pnpm dev`, `ssh -N`), so nothing after it would run.
  'long-running-process',
  // Depends on an npm package that is not published yet.
  'unpublished-package',
]);

// At most one per page, and it must also be stated in the page's prose.
const PRECONDITIONS = new Set(['built-checkout']);

// Every fence language in the corpus, as a CLOSED set. A fence tagged anything outside it is red.
//
// Why a whitelist rather than "widen the census to every shell-ish tag": a list of shell spellings
// (`sh`, `shell`, `console`, `zsh`, `shell-session`, `terminal`, ...) is open-ended, and the tag
// nobody thought of is exactly the one that escapes. Measured in round 2: a ```sh fence carrying a
// bare `docker compose ps`, an unguarded `curl` and a direct run passed EVERY round-1 assertion --
// it was tagged, so the untagged check was satisfied, and it was not `bash`, so it was never
// classified at all. A whitelist inverts the default: an unknown tag is red until someone adds it
// here deliberately, shell-ish or not, and the empty tag is red for the same reason. The corpus uses
// exactly one shell spelling today (measured: 27 bash, 2 json, 2 dotenv, 1 caddyfile) and this keeps
// it that way.
const ALLOWED_LANGS = new Set(['bash', 'json', 'dotenv', 'caddyfile']);

// A marker only counts INSIDE its fence. One line above it is a markdown comment on nothing, and in
// round 1 it was silently ignored -- a fence could look excluded to a reader and be executable to
// the gate, or vice versa. Rejected loudly instead: see `refuses a marker stranded above its fence`.
const MARKER_LINE = /^\s*#\s*(?:not-executed|precondition):/;

// A fence is a run of lines between two fence delimiters. Indentation-aware: `docs/deployment.md`
// indents one bash fence two spaces inside a bullet, and an anchored `^```` would drop it from the
// census entirely -- which is precisely the silent-disappearance this gate exists to prevent.
interface Fence {
  page: string;
  startLine: number;
  lang: string;
  lines: string[];
  // The contiguous run of non-blank lines immediately ABOVE the opening delimiter. A marker stranded
  // there looks authoritative to a reader and is invisible to the parser, so it is checked, not used.
  precedingBlock: string[];
}

function collectFences(page: string): Fence[] {
  const text = readFileSync(path.join(REPO_ROOT, page), 'utf8');
  const raw = text.split('\n');
  const out: Fence[] = [];
  let open: { startLine: number; lang: string; lines: string[]; precedingBlock: string[] } | null = null;
  let delimiters = 0;
  const blockAbove = (i: number): string[] => {
    const block: string[] = [];
    for (let j = i - 1; j >= 0 && raw[j].trim() !== ''; j -= 1) block.unshift(raw[j]);
    return block;
  };
  raw.forEach((line, i) => {
    const m = /^\s*(?:```|~~~)(.*)$/.exec(line);
    if (m) {
      delimiters += 1;
      if (open === null) {
        open = { startLine: i + 1, lang: m[1].trim(), lines: [], precedingBlock: blockAbove(i) };
      } else {
        out.push({
          page, startLine: open.startLine, lang: open.lang, lines: open.lines,
          precedingBlock: open.precedingBlock,
        });
        open = null;
      }
      return;
    }
    if (open !== null) open.lines.push(line);
  });
  // A bare parity toggle means ONE stray delimiter silently re-partitions the whole page, turning
  // prose into fences and fences into prose. Fail loudly rather than assert over garbage.
  expect(delimiters % 2, `unbalanced code fences in ${page}: ${delimiters} delimiter lines (odd)`).toBe(0);
  return out;
}

// Backslash continuations are ONE logical command. `docker/README.md`'s bootstrap and README's
// `claude mcp add` both wrap, and a parser that treated the continuation as its own line would read
// `  echo "..." >> ../mcp-server/.env` as a fence's terminator.
function logicalLines(lines: string[]): string[] {
  const out: string[] = [];
  let acc: string | null = null;
  for (const line of lines) {
    const joined: string = acc === null ? line : `${acc} ${line.trim()}`;
    if (/\\$/.test(joined.trimEnd())) acc = joined.trimEnd().replace(/\\$/, '').trimEnd();
    else {
      out.push(joined);
      acc = null;
    }
  }
  if (acc !== null) out.push(acc);
  return out;
}

// Strip a trailing `# ...` comment, but only when the `#` is outside quotes -- `grep -qE '^[0-9]+ ok'`
// and `--format '{{.State}}'` must survive intact.
function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

const isCommentLine = (line: string): boolean => /^\s*#/.test(line);

// The command lines of a fence: logical lines that are neither blank nor a whole-line comment.
function commandLines(fence: Fence): string[] {
  return logicalLines(fence.lines)
    .filter((l) => l.trim() !== '' && !isCommentLine(l))
    .map((l) => stripInlineComment(l).trim())
    .filter((l) => l !== '');
}

function markers(fence: Fence, key: 'not-executed' | 'precondition'): string[] {
  const re = new RegExp(`^\\s*#\\s*${key}:\\s*(.+?)\\s*$`);
  return fence.lines.map((l) => re.exec(l)).filter((m): m is RegExpExecArray => m !== null).map((m) => m[1]);
}

// --- terminator forms (closed set) ------------------------------------------------------------
// Every executable fence ends in an ASSERTION of the page's promise, never in the last command --
// because the last command's exit 0 is routinely compatible with the page's claim being false.

// Does a command carry `-f` / `--fail`? (`-fsS` is a cluster, so scan the letters.)
function hasFailFlag(cmd: string): boolean {
  return cmd
    .split(/\s+/)
    .some((t) => t === '--fail' || (/^-[A-Za-z]+$/.test(t) && t.includes('f')));
}

const firstWord = (cmd: string): string => cmd.trim().split(/\s+/)[0];
// The last segment of a pipeline is what determines the command's exit status without
// `set -o pipefail`; for our purposes it is what the assertion actually is.
const lastPipelineSegment = (cmd: string): string => cmd.split('|').pop()!.trim();

// T1 -- an HTTP health probe that FAILS on a failing status. `-f` is the whole point.
const isHealthProbe = (cmd: string): boolean =>
  firstWord(cmd) === 'curl' && hasFailFlag(cmd) && /\/health\b/.test(cmd);
// T2 -- a settled container-state test. `docker compose ps` inside a `[ ... ]` comparison.
const isStateTest = (cmd: string): boolean =>
  /^\[\s/.test(cmd.trim()) && /docker\s+compose\s+ps\b/.test(cmd) && /--format/.test(cmd) && /\]$/.test(cmd.trim());
// T3 -- the stdio handshake smoke script.
const isStdioSmoke = (cmd: string): boolean => /^node\s+scripts\/stdio-smoke\.mjs$/.test(cmd.trim());
// T4 -- a quiet grep over a captured verdict: a file, or the tail of a pipeline.
const isQuietGrep = (cmd: string): boolean => {
  const seg = lastPipelineSegment(cmd);
  return firstWord(seg) === 'grep'
    && seg.split(/\s+/).some((t) => /^-[A-Za-z]+$/.test(t) && t.includes('q'));
};

const TERMINATORS: { name: string; match: (cmd: string) => boolean }[] = [
  { name: 'curl -f health probe', match: isHealthProbe },
  { name: '[ docker compose ps --format ... ] state test', match: isStateTest },
  { name: 'node scripts/stdio-smoke.mjs', match: isStdioSmoke },
  { name: 'grep -q over a captured verdict', match: isQuietGrep },
];

// --- banned forms -----------------------------------------------------------------------------
// Each is banned because it is GREEN on the very defect it looks like it is checking.

// Banned ANYWHERE in an executable fence: `curl` without `-f` exits 0 on a 500, so an unhealthy
// server reads as a passing line whether it sits mid-sequence or last.
const isUncheckedCurl = (cmd: string): boolean => firstWord(cmd) === 'curl' && !hasFailFlag(cmd);

// Banned AS THE LAST LINE only.
//
// `docker compose up --wait` is banned as a TERMINATOR because a wait is not an assertion: it is
// exit 0 on a healthcheck-less service the instant the container is "running", which is the crash
// loop this whole gate cites as the reason exit status is not arrival. It is NOT banned
// mid-sequence, and two fences use it there on purpose: measured on a probe project (alpine, image
// HEALTHCHECK, no compose healthcheck, docker 29.6.2) `up -d --build --wait` blocked 9s for a
// container that turns healthy at ~6s and reported `(healthy)`, so compose DOES honour an
// image-level healthcheck. `docker/Dockerfile` declares one, so both framefit services carry it
// even though `docker/docker-compose.yml` declares a healthcheck only on `figma-postgres`. That
// makes `--wait` a legitimate way to remove a boot race before the assertion -- but never the
// assertion itself.
const BANNED_LAST: { name: string; match: (cmd: string) => boolean }[] = [
  {
    name: 'bare `docker compose ps` (prints `restarting` and exits 0 on a crash loop)',
    match: (cmd) => /docker\s+compose\s+ps\b/.test(cmd) && !/^\[\s/.test(cmd.trim()),
  },
  {
    name: '`docker compose up --wait` (a wait, not an assertion; exit 0 on a healthcheck-less service)',
    match: (cmd) => /docker\s+compose\s+up\b/.test(cmd) && /--wait\b/.test(cmd),
  },
  {
    name: '`curl` without `-f` (exits 0 on a 500)',
    match: isUncheckedCurl,
  },
];

interface Classified {
  fence: Fence;
  executable: boolean;
  reasons: string[];
  commands: string[];
}

function classify(page: string): { all: Fence[]; bash: Classified[] } {
  const all = collectFences(page);
  const bash = all
    .filter((f) => f.lang === 'bash')
    .map((fence) => {
      const declared = markers(fence, 'not-executed');
      const reasons = declared.flatMap((d) => d.split(',').map((r) => r.trim()).filter((r) => r !== ''));
      return { fence, executable: declared.length === 0, reasons, commands: commandLines(fence) };
    });
  return { all, bash };
}

const at = (f: Fence): string => `${f.page}:${f.startLine}`;

describe('Gate 3 (static): every bash fence is classified, and every executable one is shaped to run', () => {
  it('keeps every page at or above its measured fence floor', () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      const { bash } = classify(page);
      if (bash.length < FENCE_FLOOR[page]) {
        offenders.push(`${page}: ${bash.length} bash fences, floor is ${FENCE_FLOOR[page]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares every fence language from the closed set, so none escapes classification', () => {
    // The floor above counts `bash` fences, so a fence can leave the census two ways: by losing its
    // tag, and by gaining a DIFFERENT one. The second is the dangerous one -- a ```sh fence is still
    // a shell fence a reader will copy, but it is not `bash`, so it is never classified, never
    // `cd`-checked and never terminator-checked. A closed whitelist catches both, and catches the
    // spelling nobody predicted, because the default for an unknown tag is red.
    const offenders: string[] = [];
    for (const page of PAGES) {
      for (const f of classify(page).all) {
        if (f.lang === '') {
          offenders.push(`${at(f)}: fence has no language tag`);
        } else if (!ALLOWED_LANGS.has(f.lang)) {
          offenders.push(
            `${at(f)}: language \`${f.lang}\` is not in the closed set `
            + `(${[...ALLOWED_LANGS].join(', ')}) -- a shell fence must be tagged \`bash\` so it is classified`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every page at or above its executable floor, so the partition cannot go vacuous', () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      const executable = classify(page).bash.filter((c) => c.executable).length;
      if (executable < EXECUTABLE_FLOOR[page]) {
        offenders.push(
          `${page}: ${executable} executable fences, floor is ${EXECUTABLE_FLOOR[page]} `
          + '-- excluding a fence that runs makes every shape rule below vacuous for it',
        );
      }
    }
    expect(offenders).toEqual([]);
    // Belt and braces against a future edit that zeroes the table itself rather than the pages.
    const total = Object.values(EXECUTABLE_FLOOR).reduce((a, b) => a + b, 0);
    expect(total, 'EXECUTABLE_FLOOR sums to zero, which asserts nothing').toBeGreaterThan(0);
  });

  it('refuses a marker stranded above its fence, rather than ignoring it silently', () => {
    // `# not-executed:` on the markdown line above the opening delimiter is prose: the parser never
    // sees it, so the fence is treated as executable while every reader reads it as excluded. Loud,
    // not silent -- the failure names the line and says to move it inside.
    const offenders: string[] = [];
    for (const page of PAGES) {
      for (const f of classify(page).all) {
        for (const line of f.precedingBlock) {
          if (MARKER_LINE.test(line)) {
            offenders.push(
              `${at(f)}: marker \`${line.trim()}\` sits ABOVE the fence, where it is inert -- `
              + 'move it inside the fence',
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('classifies every bash fence exactly once, as executable or excluded', () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      const { bash } = classify(page);
      const executable = bash.filter((c) => c.executable);
      const excluded = bash.filter((c) => !c.executable);
      // The identity the classification rests on. It can genuinely fail: an excluded fence whose
      // marker carries no reason at all is neither -- it is caught by the reason assertion below,
      // and this one keeps the two partitions covering the whole census meanwhile.
      expect(executable.length + excluded.length, `${page}: partition does not cover the census`)
        .toBe(bash.length);
      for (const c of excluded) {
        if (c.reasons.length === 0) offenders.push(`${at(c.fence)}: \`# not-executed:\` with no reason`);
      }
      // More than one marker in one fence is ambiguous, not additive.
      for (const c of bash) {
        const declared = markers(c.fence, 'not-executed');
        if (declared.length > 1) offenders.push(`${at(c.fence)}: ${declared.length} \`# not-executed:\` lines`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('draws every exclusion reason from the closed set', () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      for (const c of classify(page).bash) {
        for (const r of c.reasons) {
          if (!EXCLUSION_REASONS.has(r)) {
            offenders.push(`${at(c.fence)}: undeclared reason \`${r}\` (add it to EXCLUSION_REASONS deliberately)`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses every declared reason at least once, so the vocabulary cannot rot into dead options', () => {
    const used = new Set<string>();
    for (const page of PAGES) {
      for (const c of classify(page).bash) c.reasons.forEach((r) => used.add(r));
    }
    const unused = [...EXCLUSION_REASONS].filter((r) => !used.has(r));
    expect(unused, `EXCLUSION_REASONS entries no fence uses: ${unused.join(', ')}`).toEqual([]);
  });

  it('starts every executable fence with `cd <path>` naming a directory that exists', () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      for (const c of classify(page).bash) {
        if (!c.executable) continue;
        const first = c.commands[0];
        if (first === undefined) {
          offenders.push(`${at(c.fence)}: executable fence has no command at all`);
          continue;
        }
        const m = /^cd (\S+)$/.exec(first);
        if (m === null) {
          offenders.push(`${at(c.fence)}: first command is \`${first}\`, not \`cd <repo-relative-path>\``);
          continue;
        }
        const target = path.resolve(REPO_ROOT, m[1]);
        if (!target.startsWith(REPO_ROOT) || !existsSync(target) || !statSync(target).isDirectory()) {
          offenders.push(`${at(c.fence)}: \`cd ${m[1]}\` names no directory under the repo root`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('allows at most one declared precondition per page, from the closed set', () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      const found = classify(page).bash.flatMap((c) =>
        markers(c.fence, 'precondition').map((v) => ({ fence: c.fence, value: v, executable: c.executable })));
      if (found.length > 1) {
        offenders.push(`${page}: ${found.length} \`# precondition:\` lines (at most one per page)`);
      }
      for (const f of found) {
        if (!PRECONDITIONS.has(f.value)) {
          offenders.push(`${at(f.fence)}: unknown precondition \`${f.value}\``);
        }
        // A precondition on a fence nobody runs is a claim the runner will never honour.
        if (!f.executable) {
          offenders.push(`${at(f.fence)}: \`# precondition:\` on a fence marked \`# not-executed:\``);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ends every executable fence in a terminator from the closed set', () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      for (const c of classify(page).bash) {
        if (!c.executable) continue;
        const last = c.commands[c.commands.length - 1];
        if (last === undefined) continue; // already reported by the `cd` assertion
        if (!TERMINATORS.some((t) => t.match(last))) {
          offenders.push(
            `${at(c.fence)}: last command \`${last}\` is not a terminator `
            + `(allowed: ${TERMINATORS.map((t) => t.name).join('; ')})`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('bans terminator forms that are green on the defect they look like they check', () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      for (const c of classify(page).bash) {
        if (!c.executable) continue;
        const last = c.commands[c.commands.length - 1];
        if (last !== undefined) {
          for (const b of BANNED_LAST) {
            if (b.match(last)) offenders.push(`${at(c.fence)}: terminates in ${b.name}`);
          }
        }
        // Unchecked `curl` is banned everywhere in an executable fence, not just last: a 500
        // mid-sequence is exactly as invisible as a 500 at the end.
        for (const cmd of c.commands) {
          if (cmd !== last && isUncheckedCurl(cmd)) {
            offenders.push(`${at(c.fence)}: \`${cmd}\` is a curl without \`-f\` (exits 0 on a 500)`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
