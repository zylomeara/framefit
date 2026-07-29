#!/usr/bin/env node
// Gate 3, EXECUTING HALF -- run the commands the documentation tells a reader to copy.
//
//   node scripts/run-doc-sequences.mjs docs/status.md
//   node scripts/run-doc-sequences.mjs docker/README.md
//   node scripts/run-doc-sequences.mjs --list docker/README.md      (classify, run nothing)
//
// The static half (tests/unit/docs-command-fences.test.ts) proves every bash fence on six pages is
// classified exactly once and that the executable ones are SHAPED to run. Shape is not arrival.
// This half takes the same pages, materialises the tree under review into a throwaway copy, and
// executes the executable fences in page order -- so a fence that is well-formed and wrong goes red.
//
// SCOPE, stated because a boundary nobody wrote down is a boundary nobody can audit. This runner
// drives exactly two of the six pages: `docs/status.md` and `docker/README.md`. `README.md`,
// `docs/deployment.md`, `examples/mcp-config/README.md` and `CONTRIBUTING.md` are covered by the
// STATIC half only -- their executable fences are shape-checked and never run here. Widening the
// executing half to those pages is deferred work, not a claim this gate makes. The boundary is the
// DRIVEN table below and nothing else; a page absent from it is refused, never silently ignored.
//
// THE FAILURE MODE THIS FILE IS BUILT AGAINST is reporting green over things it did not run. Every
// design decision below is aimed at one of its faces:
//   - a fence quietly skipped              -> the run loop has no skip branch, and `attempted`,
//                                             `executable` and DRIVEN[page] are asserted equal;
//   - an exit code read through a pipe     -> exit codes come from the child's `close` event, never
//                                             from a shell pipeline (`git ls-files | tar` is the one
//                                             pipeline, and it runs under `set -o pipefail`);
//   - a container that crash-loops while
//     the command that started it exits 0  -> not this file's problem: the PAGES end on assertions
//                                             and the static half polices the terminator set. Here
//                                             the job is to not undo that, so nothing is appended to
//                                             a fence body and nothing is run after it;
//   - a harness that supplies the missing
//     prerequisite and calls it a pass     -> the ONLY setup performed is `# precondition:`, and the
//                                             only precondition is a build. Notably the runner does
//                                             NOT create `mcp-server/.env`: creating it IS the thing
//                                             `docker/README.md`'s bootstrap fence exists to do, and
//                                             a harness that did it could never see its absence.
//
// WHY `git ls-files`, NOT `git archive HEAD` AND NOT `git clone`. Deliberate; do not "simplify" it.
//   - `git archive HEAD` would run the COMMITTED page. During a task the documentation fixes are
//     uncommitted, so an HEAD-reading harness verifies the wrong text and the red fixtures (which
//     edit the working tree) become unreproducible.
//   - `git ls-files` lists tracked PATHS and tar reads their CURRENT contents, so the copy is the
//     tree under review while still having the fresh-checkout property that matters: untracked and
//     ignored files are absent. `mcp-server/.env`, `mcp-server/dist/` and `node_modules/` therefore
//     do not exist in the copy, which is exactly the state the pages are written for.
//   - `git clone` is out: this repository is private and the gate may never reach the network.
//
// TIME-BOUNDING. `timeout(1)` does not exist on macOS -- measured: `command -v timeout` and
// `command -v gtimeout` both exit 1 on this machine, and a whole earlier measurement run returned
// 127 on every probe for that reason. So the bound is in-process: `spawn(..., { detached: true })`
// puts the fence in its own process GROUP and the deadline kills the group with `kill(-pid)`.
// Verified on darwin 24.6.0 / node 24.12.0 with a control: a bash script whose backgrounded
// subshell touches a marker file every second stops touching it after the group kill, and does NOT
// stop when only the direct child pid is killed (the marker kept advancing). Killing the direct pid
// alone leaks `docker compose` mid-build; killing the group does not.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/{README.md,docs,docker,...} and <root>/mcp-server/scripts/<this file>.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The pages this runner drives, and the number of EXECUTABLE fences each must have.
//
// Exact equality, not a floor, and the difference is the point. The static half uses floors because
// adding a fence to a page should stay legal there. Here the number is the runner's own scope: if a
// page gains an executable fence, somebody must decide what it costs in CI, whether it starts
// containers and what tears them down -- so it must fail until that decision is made. And if a page
// LOSES one (the cheap way to make a red gate green: add `# not-executed:` and move on), the count
// drops and this is what notices.
//
// Measured 2026-07-29 against the working tree by this file's own parser (`--list`).
const DRIVEN = {
  'docs/status.md': 1,
  'docker/README.md': 4,
};

// The one precondition the runner honours, and what honouring it means. Nothing else is set up.
const PRECONDITIONS = {
  'built-checkout': {
    // `docs/status.md`'s source-checkout fence legitimately starts at `node dist/index.js status`:
    // it is a diagnostics page reached after installation. `dist/` is git-ignored, so it is absent
    // from the materialised copy and the fence would fail with MODULE_NOT_FOUND from ANY directory
    // -- which would mask the defect the fence exists to pin (that it fails from the repo root and
    // succeeds from `mcp-server/`).
    cwd: 'mcp-server',
    steps: [
      ['pnpm', ['install', '--frozen-lockfile']],
      ['pnpm', ['build']],
    ],
  },
};

// Generous, because two fences build a container image from scratch on a cold cache. Measured warm
// on this machine: the whole of `docker/README.md` runs in well under two minutes. The bound exists
// to turn a HANG into a red rather than a job that runs until the CI runner is reclaimed -- and a
// timeout is a FAILURE here, never a skip.
const FENCE_TIMEOUT_MS = Number(process.env.DOC_SEQUENCES_FENCE_TIMEOUT_MS ?? 900_000);
const PRECONDITION_TIMEOUT_MS = Number(process.env.DOC_SEQUENCES_PRECONDITION_TIMEOUT_MS ?? 900_000);
const TEARDOWN_TIMEOUT_MS = 300_000;

// Variables the documented commands themselves read. They are dropped from the fence environment
// because the pages describe a CHECKOUT, not the operator's shell: a `FIGMA_TOKEN` exported in the
// caller's terminal turns `framefit status`'s figma check from SKIP into a live network call, so a
// green run would depend on the network and a red one would blame the page. Removing them moves the
// child TOWARDS the fresh-checkout state the copy already has, which is the opposite of supplying a
// missing prerequisite. COMPOSE_PROJECT_NAME is dropped and then set (see below).
const STRIPPED_ENV = [
  'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_FILE', 'COMPOSE_ENV_FILES',
  'FIGMA_TOKEN', 'DS_TEAM_IDS', 'DATABASE_URL', 'MULTI_TENANT', 'ENCRYPTION_KEY',
  'FRAMEFIT_READ_ONLY',
];

// --- fence collection -------------------------------------------------------------------------
// Deliberately the same reading of a fence as the static half: indentation-aware delimiters (one
// bash fence on `docs/deployment.md` is indented inside a bullet), language taken from the opening
// delimiter, and a fence classed EXCLUDED by a `# not-executed:` line INSIDE it. Kept as a separate
// implementation rather than imported, because the static half is a TypeScript vitest file and this
// is a plain node script; the cost of that duplication is that the two parsers could drift, and the
// DRIVEN counts above are what catches it -- a drift that changed which fences are executable
// changes the count and fails the run.
const NOT_EXECUTED = /^\s*#\s*not-executed:\s*(.+?)\s*$/;
const PRECONDITION = /^\s*#\s*precondition:\s*(.+?)\s*$/;
const CD_LINE = /^\s*cd\s+(\S+)\s*$/;

// The closed language whitelist, held here as well as in the static half, and this runner's FIRST
// defence against a truncated fence body. The attack: an INTERIOR pair of fence delimiters inside an
// executable fence. Delimiter parity is preserved, the bash-fence count is unchanged so `DRIVEN` is
// satisfied, the first half of the body still parses and still starts with `cd` -- but the body is
// cut short and the terminating assertion now sits in a SECOND fence that carries no language tag,
// so nothing runs it. The runner used to go green on the amputated half. An untagged (or unknown)
// fence on a driven page is now a hard failure, which is what the reopened half always is.
const ALLOWED_LANGS = new Set(['bash', 'json', 'dotenv', 'caddyfile']);

function collectFences(pageText, page) {
  const raw = pageText.split('\n');
  const out = [];
  let open = null;
  let delimiters = 0;
  raw.forEach((line, i) => {
    const m = /^\s*(?:```|~~~)(.*)$/.exec(line);
    if (m) {
      delimiters += 1;
      if (open === null) open = { startLine: i + 1, lang: m[1].trim(), lines: [] };
      else {
        out.push(open);
        open = null;
      }
      return;
    }
    if (open !== null) open.lines.push(line);
  });
  // An odd delimiter count silently re-partitions the page: prose becomes fence and fence becomes
  // prose. Refuse to classify garbage.
  if (delimiters % 2 !== 0) {
    throw new Error(`${page}: unbalanced code fences (${delimiters} delimiter lines, odd)`);
  }
  return out.map((f) => ({ ...f, page }));
}

function collectBashFences(pageText, page) {
  const all = collectFences(pageText, page);
  const bad = all.filter((f) => f.lang === '' || !ALLOWED_LANGS.has(f.lang));
  if (bad.length > 0) {
    throw new Error(
      `${page}: ${bad.length} fence(s) carry a language outside the closed set `
      + `(${[...ALLOWED_LANGS].join(', ')}): `
      + `${bad.map((f) => `${page}:${f.startLine} \`${f.lang === '' ? '<untagged>' : f.lang}\``).join(', ')}`
      + ' -- an untagged fence is what an interior delimiter pair leaves behind when it truncates a'
      + ' fence body and strands its terminating assertion outside the fence',
    );
  }
  return all.filter((f) => f.lang === 'bash');
}

// Backslash continuations are ONE logical command; the static half joins them for the same reason.
// A parser that treated a continuation as its own line would read the tail of `docker/README.md`'s
// wrapped bootstrap command as the fence's terminator.
function logicalLines(lines) {
  const out = [];
  let acc = null;
  for (const line of lines) {
    const joined = acc === null ? line : `${acc} ${line.trim()}`;
    if (/\\$/.test(joined.trimEnd())) acc = joined.trimEnd().replace(/\\$/, '').trimEnd();
    else {
      out.push(joined);
      acc = null;
    }
  }
  if (acc !== null) out.push(acc);
  return out;
}

// Strip a trailing `# ...` comment, but only when the `#` is outside quotes, so `grep -qE '^[0-9]+ ok'`
// and `--format '{{.State}}'` survive intact.
function stripInlineComment(line) {
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

function commandLines(fence) {
  return logicalLines(fence.lines)
    .filter((l) => l.trim() !== '' && !/^\s*#/.test(l))
    .map((l) => stripInlineComment(l).trim())
    .filter((l) => l !== '');
}

// --- terminator forms (closed set) --------------------------------------------------------------
// The same four shapes the static half enforces, re-derived here because the runner must not depend
// on another CI job having run first: nothing in `.github/workflows/ci.yml` orders `unit` before
// `doc-sequences`, so "the static half would have caught it" is a coincidence, not a defence. If a
// fence reaches this runner without ending in an assertion, the runner refuses it itself.
//
// THE TWO SETS HAVE ALREADY DIVERGED, and anyone extracting them into one module must start from
// their UNION rather than assuming they are equal:
//   - `isBackgrounded`, `masksFailure` and `isEarlyExit` below exist ONLY here;
//   - `BANNED_LAST` in tests/unit/docs-command-fences.test.ts (bare `docker compose ps`,
//     `docker compose up --wait` as a terminator, `curl` without `-f`) exists ONLY there.
// The arrangement is safe while it lasts for one reason and only one: `publish-image` needs BOTH
// jobs, so a fence must satisfy both halves to reach a published image and the enforced rule is the
// union of the two. A divergence therefore yields a red, never a green. That argument collapses the
// moment either job stops gating the publish -- which is why doc-sequences-ci.test.ts refuses a
// `continue-on-error` on any job in that `needs:` array.
const hasFlag = (cmd, letter) => cmd
  .split(/\s+/)
  .some((t) => t === `--${letter === 'f' ? 'fail' : letter}` || (/^-[A-Za-z]+$/.test(t) && t.includes(letter)));
const firstWord = (cmd) => cmd.trim().split(/\s+/)[0];
const lastPipelineSegment = (cmd) => cmd.split('|').pop().trim();

const TERMINATORS = [
  {
    name: 'curl -f health probe',
    match: (cmd) => firstWord(cmd) === 'curl' && hasFlag(cmd, 'f') && /\/health\b/.test(cmd),
  },
  {
    name: '[ docker compose ps --format ... ] state test',
    match: (cmd) => /^\[\s/.test(cmd.trim()) && /docker\s+compose\s+ps\b/.test(cmd)
      && /--format/.test(cmd) && /\]$/.test(cmd.trim()),
  },
  {
    name: 'node scripts/stdio-smoke.mjs',
    match: (cmd) => /^node\s+scripts\/stdio-smoke\.mjs$/.test(cmd.trim()),
  },
  {
    name: 'grep -q over a captured verdict',
    match: (cmd) => {
      const seg = lastPipelineSegment(cmd);
      return firstWord(seg) === 'grep' && hasFlag(seg, 'q');
    },
  },
];

// A trailing `&` backgrounds the command, so `bash -e` sees the SHELL's exit 0 and never sees the
// assertion's status at all -- the fence reports PASS with its own verdict unknown. `&&` and `||`
// are not this; the pattern demands a single `&` at end of line.
const isBackgrounded = (cmd) => /(^|[^&])&$/.test(cmd.trim());

// A terminator sitting in a chain that swallows its status is not an assertion. `|| true` is the
// obvious one and it defeats the matchers head-on: three of the four shapes (`curl`, `[ ... ]`,
// `node scripts/stdio-smoke.mjs`) test the WHOLE line, so `curl -fsS .../health/NOPE || true` is
// accepted as a health probe, exits 0, and prints its own 404 into the log while the fence reports
// PASS -- measured exactly that way before this check existed. `;` is the same hole with different
// punctuation. `&&` is deliberately allowed: it propagates failure from either side.
//
// (The `grep -q` shape happened to reject `|| true` already, because the pipeline splitter treats
// `||` as a `|` and reads `true` as the last segment. That is an accident of parsing, not a
// defence, and it protected exactly one of the four shapes.)
function masksFailure(cmd) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === '|' && cmd[i + 1] === '|') return '||';
      if (c === ';') return ';';
    }
  }
  return null;
}

// `exit` anywhere in the body ends the script early with a status of its own choosing, so every
// command after it -- including the terminating assertion -- never runs. Measured before this check:
// an `exit 0` inserted above the producing command made the fence report PASS in 73ms with the
// assertion never executed. Checked over EVERY command line, not just the last, because that is
// where it does its damage.
const isEarlyExit = (cmd) => /^exit\b/.test(cmd.trim());

// A fence's verdict is the exit status of the shell that runs it, and a fence body is arbitrary
// shell running in that same shell -- so whatever the body can do to that shell's disposition
// towards failure, or to what a command NAME resolves to, it can do to the verdict. Three such
// forms, none of which `masksFailure`, `isEarlyExit` or the static half sees, each measured green
// over a false assertion before this check existed: `set +e` before a failing command,
// `trap 'exit 0' EXIT`, and a function whose name shadows the terminator's own command.
//
// WHY THIS IS STILL AN ENUMERATION, AND WHAT WAS TRIED FIRST. The formulation that would not be one
// is to take the verdict from somewhere the body cannot reach: run the body, then re-run the
// terminating assertion in a FRESH shell and believe THAT process instead of the fence's own. The
// corpus refuses it. `docs/status.md`'s fence is `report=$(mktemp)` ... `node ... | tee "$report"`
// ... `grep -qE '...' "$report"` -- its assertion reads a variable the body set, so in a shell that
// did not run the body it is `grep -qE '...' ''`, measured `grep: : No such file or directory`,
// exit 2: a red on a fence that is correct. And every variant that carries the body's state across
// (dumping the environment at the end of the body, sourcing it back) hands the body exactly the
// forgery the separate process was supposed to deny it. So the verdict stays the fence shell's own
// exit status, and this is a TEXT check on what may run in that shell.
//
// What it refuses is a class, in the shell's own vocabulary rather than in attack shapes: commands
// that RECONFIGURE the shell deciding the verdict, or REBIND the names its terminator uses. Bash's
// mechanisms for that are few and they are named below. What it cannot do is read words that are
// not there yet -- see the KNOWN GAP under the function.
function reconfiguresShell(cmd) {
  const t = cmd.trim();
  // `set +e`, `set +o errexit`, `set +o pipefail`: undo the failure handling the runner started the
  // shell with. Tightening forms pass -- `docs/status.md`'s fence legitimately carries
  // `set -o pipefail`, and no `set -...` can make the shell more forgiving than `-eo pipefail`.
  if (/^set\b/.test(t) && /(^|\s)\+/.test(t)) {
    return '`set +<option>` turns off the failure handling this shell was started with';
  }
  if (/^trap\b/.test(t)) {
    return 'a `trap` handler runs at exit and can replace the status the fence reports';
  }
  if (/^(function\s+[\w.-]+|[\w.-]+\s*\(\s*\))/.test(t)) {
    return 'a function definition can shadow the command name the terminating assertion invokes';
  }
  if (/^alias\b/.test(t)) return '`alias` rebinds a command name';
  if (/^exec\b/.test(t)) {
    return '`exec` replaces this shell, so nothing after it runs and its own status becomes the fence\'s';
  }
  if (/^(eval|source|\.)\s/.test(t)) {
    return 'eval/source run text that is not in the fence, so this check cannot read what they do';
  }
  if (/(^|\s)PATH=/.test(t)) {
    return 'assigning PATH rebinds every command name, the terminating assertion\'s included';
  }
  return null;
}

// KNOWN GAP, stated rather than papered over, because a list of shapes presented as complete is the
// same false green this file exists to refuse. The check above reads WORDS; the shell obeys words
// only after expansion. It therefore does not catch:
//   - an indirected name -- `c=set; $c +e`, or the same trick holding `trap`: the offending word is
//     never written;
//   - PATH changed by any route other than a literal `PATH=` word (`env PATH=... grep ...`), or a
//     writable directory ALREADY on PATH gaining a `grep` this fence dropped there;
//   - the terminator's external binary replaced on disk.
// Nothing textual closes those three: they are all "the meaning is not in the text". What the check
// buys is that the cheap accident -- someone silencing a red fence with `set +e` and moving on --
// stops being cheap, and the remaining routes are unmistakably deliberate.
//
// NOT a gap, but a deliberate exemption: a failing INTERMEDIATE command masked by `if cmd; then`,
// `while cmd` or `! cmd`, which the shell exempts from `set -e` by its own documented rules. The
// terminator is the assertion; an intermediate failure either changes what the assertion sees, in
// which case the assertion fails, or it does not, in which case it is not this gate's business.
// `docker/README.md`'s bootstrap fence is built on exactly that shape -- two `||` chains that may
// legitimately not run their right-hand side, followed by a `grep -q` that asserts the result.

function classify(fence) {
  const excluded = fence.lines.map((l) => NOT_EXECUTED.exec(l)).filter(Boolean);
  const preconditions = fence.lines.map((l) => PRECONDITION.exec(l)).filter(Boolean).map((m) => m[1]);
  return {
    ...fence,
    executable: excluded.length === 0,
    reasons: excluded.flatMap((m) => m[1].split(',').map((r) => r.trim()).filter(Boolean)),
    preconditions,
  };
}

// Split an executable fence into the directory it names and the body to run there.
//
// The directory comes from the fence's FIRST command line and nothing else -- that is the whole
// convention the static half enforces, and re-deriving it here (rather than, say, defaulting to the
// repo root) is what makes `docs/status.md`'s defect visible: the page used to say "A source
// checkout" in prose and the command only works from `mcp-server/`.
//
// Everything after that line is passed through VERBATIM, comments and markers included. Nothing is
// appended: a teardown appended after the fence's terminating assertion would run whether or not the
// assertion held, and its exit status would be the one `bash -e` reports.
function split(fence) {
  const idx = fence.lines.findIndex((l) => l.trim() !== '' && !/^\s*#/.test(l));
  if (idx === -1) throw new Error(`${fence.page}:${fence.startLine}: executable fence has no command`);
  const m = CD_LINE.exec(fence.lines[idx]);
  if (m === null) {
    throw new Error(
      `${fence.page}:${fence.startLine}: first command is \`${fence.lines[idx].trim()}\`, `
      + 'not `cd <repo-relative-path>` -- the runner takes the working directory from that line and '
      + 'nothing else',
    );
  }

  // The fence must still END in an assertion when the runner receives it. Checked HERE, on the text
  // about to be executed, rather than trusted to the static half -- see the TERMINATORS note.
  const cmds = commandLines(fence);
  const last = cmds[cmds.length - 1];
  if (last === undefined) {
    throw new Error(`${fence.page}:${fence.startLine}: executable fence has no command`);
  }
  for (const cmd of cmds) {
    if (isEarlyExit(cmd)) {
      throw new Error(
        `${fence.page}:${fence.startLine}: \`${cmd}\` ends the fence early, so every command after `
        + 'it -- including the terminating assertion -- never runs',
      );
    }
    // Over EVERY command line, not just the last: all three forms do their damage from above the
    // assertion, by changing the shell that will judge it.
    const how = reconfiguresShell(cmd);
    if (how !== null) {
      throw new Error(
        `${fence.page}:${fence.startLine}: \`${cmd}\` reconfigures the shell whose exit status IS `
        + `this fence's verdict -- ${how}. See the KNOWN GAP beside reconfiguresShell() for what `
        + 'this check does and does not reach',
      );
    }
  }
  if (isBackgrounded(last)) {
    throw new Error(
      `${fence.page}:${fence.startLine}: last command \`${last}\` ends in \`&\`, which backgrounds `
      + 'it -- the shell exits 0 immediately and the fence reports PASS with the assertion\'s status '
      + 'never observed',
    );
  }
  const masked = masksFailure(last);
  if (masked !== null) {
    throw new Error(
      `${fence.page}:${fence.startLine}: last command \`${last}\` contains a top-level \`${masked}\`, `
      + 'which can swallow the assertion\'s exit status -- a terminator in a failure-masking chain '
      + 'is not an assertion',
    );
  }
  if (!TERMINATORS.some((t) => t.match(last))) {
    throw new Error(
      `${fence.page}:${fence.startLine}: last command \`${last}\` is not a terminator from the closed `
      + `set (${TERMINATORS.map((t) => t.name).join('; ')}). A fence that reaches the runner without `
      + 'an assertion at the end proves nothing by exiting 0',
    );
  }

  const body = fence.lines.filter((_, i) => i !== idx).join('\n');
  return { dir: m[1], body };
}

// --- process plumbing -------------------------------------------------------------------------

// Run a command with a deadline, streaming its output, and return the REAL exit status. The status
// comes from the `close` event; it is never inferred from output and never passes through a shell
// pipeline. A deadline hit is reported as its own outcome so it can never be mistaken for a pass.
function run(cmd, args, { cwd, env, timeoutMs, label }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    const keep = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line !== '') tail.push(line);
      }
      while (tail.length > 40) tail.shift();
    };
    child.stdout.on('data', (c) => { keep(c); process.stdout.write(c); });
    child.stderr.on('data', (c) => { keep(c); process.stderr.write(c); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(`\n[doc-sequences] ${label}: deadline of ${timeoutMs}ms hit, killing process group\n`);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (err) {
        process.stderr.write(`[doc-sequences] group kill failed (${err.code}), killing the child alone\n`);
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, status: null, why: `could not spawn ${cmd}: ${err.message}`, ms: Date.now() - started, tail });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (timedOut) resolve({ ok: false, status: null, why: `timed out after ${timeoutMs}ms`, ms, tail });
      else if (signal !== null) resolve({ ok: false, status: null, why: `killed by ${signal}`, ms, tail });
      else resolve({ ok: code === 0, status: code, why: code === 0 ? 'exit 0' : `exit ${code}`, ms, tail });
    });
  });
}

// Synchronous, because it must also work from a signal handler and from `process.on('exit')`.
function runSync(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: TEARDOWN_TIMEOUT_MS, ...opts });
}

// --- teardown ------------------------------------------------------------------------------------
// The pages deliberately END on their assertions: `docker/README.md`'s local bring-up used to finish
// with `docker compose --profile local down`, and a teardown after the assertion is a command whose
// exit status replaces the assertion's. So the pages leave containers up and the RUNNER tears them
// down. Two properties this needs, both measured rather than assumed:
//
//   1. PER FENCE, not once at the end. `docker/README.md`'s two bring-ups both publish
//      `127.0.0.1:${MCP_PORT:-3846}` -- `framefit-local` under the `local` profile and `framefit`
//      under `full`. Measured: running the page's executable fences in page order without tearing
//      down in between makes the third one die with
//      `Bind for 127.0.0.1:3846 failed: port is already allocated`. Tearing down between fences is
//      therefore required for the page to be runnable at all, and it costs nothing that matters:
//      the FILESYSTEM effect the next fence depends on (the bootstrap fence's `mcp-server/.env`)
//      lives in the temp copy and survives `down`.
//   2. UNDER A PRIVATE PROJECT NAME. Compose's default project name is the basename of the compose
//      file's directory -- `docker` -- which is what a developer's own checkout also resolves to.
//      A `down -v` under that name would delete THEIR `figma-pgdata` volume with their data in it.
//      Every run gets its own `COMPOSE_PROJECT_NAME`, so `down -v --rmi local` can only ever reach
//      what this run created.
//   3. GATED ON WHAT THE RUN CREATED, not on what its text looked like. This used to key off a
//      regex for `docker compose` over the fence body, which is a guess about behaviour dressed up
//      as a fact: `docker run`, the hyphenated `docker-compose`, and any script that shells out to
//      either (`./smoke-local.sh` is one line away from being executable) all create containers
//      while matching nothing. The runner now takes a CENSUS of docker's four object axes before
//      the page and again after every fence; anything that appeared is something this run made, and
//      that -- not the text -- is what turns teardown and the residue check on.
//
// The four axes, each queried whole for the census and by project label for the residue check.
// Compose labels BUILT IMAGES too (measured: `com.docker.compose.project` is on the image config of
// `<project>-<service>`), which is what makes `--rmi local` verifiable rather than hopeful.
const DOCKER_AXES = [
  { name: 'container', all: ['ps', '-aq'], labelled: (f) => ['ps', '-aq', '--filter', f] },
  { name: 'volume', all: ['volume', 'ls', '-q'], labelled: (f) => ['volume', 'ls', '-q', '--filter', f] },
  { name: 'image', all: ['images', '-aq'], labelled: (f) => ['images', '-q', '--filter', f] },
  { name: 'network', all: ['network', 'ls', '-q'], labelled: (f) => ['network', 'ls', '-q', '--filter', f] },
];

// A QUERY THAT DID NOT RUN IS NOT AN EMPTY QUERY. `docker ps` exiting non-zero (absent binary,
// daemon down) means the answer is unknown, and reporting unknown as "nothing there" is the same
// "green over what it did not check" this file exists to refuse. Every query returns its readability
// alongside its result and every caller treats unreadable as a failure.
function dockerQuery(args) {
  const r = runSync('docker', args);
  if (r.status !== 0) {
    return { readable: false, why: r.error?.message ?? `exit ${r.status}`, ids: [] };
  }
  return { readable: true, why: null, ids: String(r.stdout).split('\n').filter((l) => l.trim() !== '') };
}

const dockerUsable = () => dockerQuery(['version', '--format', '{{.Server.Version}}']).readable;

function census() {
  const byAxis = {};
  const unreadable = [];
  for (const axis of DOCKER_AXES) {
    const q = dockerQuery(axis.all);
    if (!q.readable) unreadable.push(`docker ${axis.all.join(' ')} (${q.why})`);
    byAxis[axis.name] = new Set(q.ids);
  }
  return { byAxis, unreadable };
}

// Everything present now that was not present at the baseline, as `axis:id` strings.
function appearedSince(baseline, now) {
  const out = [];
  for (const axis of DOCKER_AXES) {
    for (const id of now.byAxis[axis.name]) {
      if (!baseline.byAxis[axis.name].has(id)) out.push(`${axis.name}:${id}`);
    }
  }
  return out;
}

// AN IMAGE A COLD STORE GAINED IS NOT NECESSARILY RESIDUE, AND THIS DISTINCTION IS LOAD-BEARING.
//
// `docker/README.md`'s full bring-up starts `figma-postgres`, whose service declares
// `image: pgvector/pgvector:pg16`. On a store that does not already hold that image compose PULLS
// it, the image census rises, and a delta that could not tell a pull from a build called that
// residue -- so the job went red on every cold runner, which is every fresh CI runner, and blocked
// the release path it had just joined. Measured, on a genuinely cold tag (the compose file pointed
// at `postgres:17-alpine`, absent from this machine):
// `ERROR 1 docker object(s) appeared during this run and still exist: image:742f40ea20b9`, exit 1.
//
// THE TEST IS FOR A REPO TAG, and the obvious candidate for a test of ORIGIN does not work.
// `RepoDigests` looks like exactly the right field -- "did this come from a registry" -- and it is
// useless on this engine.
// Measured on docker 29.6.2 with the containerd snapshotter (`io.containerd.snapshotter.v1`):
//   built:  RepoTags ["framefit-<proj>-framefit-local:latest"]
//           RepoDigests ["framefit-<proj>-framefit-local@sha256:fc1ccf..."]  -- equals its own .Id
//   pulled: RepoTags ["node:20-alpine"]
//           RepoDigests ["node@sha256:fb4cd12c..."]                          -- equals its own .Id
// BOTH carry a RepoDigest, and under this snapshotter the image Id IS the manifest digest, so
// neither "has a digest" nor "digest differs from Id" separates them. The first cut of this function
// used `len .RepoDigests` and would have classified a LEFT-BEHIND BUILT IMAGE as a harmless pull --
// caught by measuring the built side instead of assuming it.
//
// What is left, given that the label check above already covers every image compose built for THIS
// run, is a test for DANGLING rather than a test for origin -- and the two must not be confused:
//   - a new image carrying no repo tag at all is dangling: nobody's, and left here by this run;
//   - every other new image is TAGGED, so it is not this run's litter, and is left alone.
// The second bucket is not "pulled". A tag records a name, never a provenance: an image this run's
// compose BUILT and failed to remove is tagged too, and lands in the same bucket. That is why the
// log line for it says what is known (tagged, appeared during this run, not removed) and not where
// the image came from, and why an image can legitimately be reported on the project-label line as
// residue AND appear in this bucket in the same run -- the label knows it is ours, the tag does not.
//
// KNOWN GAP, stated rather than papered over: a fence running `docker build -t somename .` outside
// compose would leave a tagged, unlabelled image, which this rule does not count as residue. No
// fence in the corpus does, and the alternative -- a hard red on every cold CI runner -- is
// measurably worse.
//
// CLOSING IT LATER, if the corpus ever earns the machinery: `{{.Created}}` does separate the two on
// this engine, where the digest fields do not. Measured on docker 29.6.2: a pulled
// `pgvector/pgvector:pg16` carries `2026-05-15T14:23:22Z`, the publisher's build time, months before
// any run; images built on this machine carry the moment they were built. So "created after this run
// started" identifies a built image. It is not adopted here because it trades this rule's stated gap
// for a clock-window one -- an image published upstream DURING a run would be called built, and a
// wrong window is a hard red on cold runners, which is the exact failure this classification already
// caused once.
//
// Unreadable is neither: an image that cannot be inspected is reported, not assumed innocent. An
// image that has since vanished is simply gone, which is the outcome residue asks about.
function partitionAppeared(appeared) {
  const residue = [];
  const tagged = [];
  const unreadable = [];
  for (const entry of appeared) {
    if (!entry.startsWith('image:')) {
      residue.push(entry);
      continue;
    }
    const id = entry.slice('image:'.length);
    const q = dockerQuery(['image', 'inspect', id, '--format', '{{len .RepoTags}}']);
    if (!q.readable) {
      const stillThere = dockerQuery(['image', 'inspect', id, '--format', '{{.Id}}']);
      if (!stillThere.readable) continue; // gone between census and inspect
      unreadable.push(`docker image inspect ${id} (${q.why})`);
      continue;
    }
    if (Number(q.ids[0] ?? '0') === 0) residue.push(entry); // dangling: this run left it
    else tagged.push(entry); // tagged: not litter, and NOT thereby known to have been pulled
  }
  return { residue, tagged, unreadable };
}

function composeDown(tmp, projectName) {
  const dir = path.join(tmp, 'docker');
  if (!existsSync(dir)) return { ran: false, status: 0, stderr: '' };
  // Both profiles in one call: naming them is what makes `down` consider services it did not start,
  // so a fence that failed halfway still has its partial stack removed. `--rmi local` because the
  // project name is unique per run, so the images the fences build are unique too and would
  // otherwise accumulate one set per invocation. Build CACHE layers survive, so rebuilds stay warm.
  const r = runSync('docker', [
    'compose', '--profile', 'local', '--profile', 'full',
    'down', '-v', '--rmi', 'local', '--remove-orphans',
  ], { cwd: dir, env: { ...process.env, COMPOSE_PROJECT_NAME: projectName } });
  return { ran: true, status: r.status, stderr: String(r.stderr ?? '') };
}

// Teardown that reports rather than hopes, on both axes of "gone":
//   - by LABEL: nothing may still carry this run's compose project label. Positive control for the
//     filter, measured per profile because the two differ: `local` up matches 1 container, 1 image,
//     1 network and 0 volumes (that profile declares none); `full` up matches 2 containers, 1 image,
//     1 network and 1 volume (`figma-pgdata`). Both go to 0/0/0/0 after `down -v --rmi local`.
//   - by CENSUS DELTA: nothing that appeared during the run may still exist, which is the only check
//     that reaches objects compose never labelled. Positive control: a `docker run -d` container
//     planted while a fence was building was reported as
//     `1 docker object(s) appeared during this run and still exist: container:<id>`, and the run went
//     red. It was REPORTED, not removed -- teardown stays scoped to this run's own compose project,
//     so the harness can never delete a container it did not create.
function residue(projectName, baseline) {
  const filter = `label=com.docker.compose.project=${projectName}`;
  const labelled = [];
  const unreadable = [];
  for (const axis of DOCKER_AXES) {
    const q = dockerQuery(axis.labelled(filter));
    if (!q.readable) unreadable.push(`docker ${axis.name} query (${q.why})`);
    for (const id of q.ids) labelled.push(`${axis.name}:${id}`);
  }
  const now = census();
  unreadable.push(...now.unreadable);
  const split = partitionAppeared(appearedSince(baseline, now));
  unreadable.push(...split.unreadable);
  return { labelled, leaked: split.residue, tagged: split.tagged, unreadable };
}

// --- main ----------------------------------------------------------------------------------------

function usage(msg) {
  process.stderr.write(`${msg}\n\nusage: node scripts/run-doc-sequences.mjs [--list] [<page>...]\n`
    + `with no page argument every driven page runs: ${Object.keys(DRIVEN).join(', ')}\n`);
  process.exit(2);
}

async function main() {
  // NO ARGUMENT MEANS EVERY DRIVEN PAGE, and that is what binds CI's coverage to `DRIVEN`. The
  // workflow used to name the two pages in two `- run:` lines, so deleting one line silently dropped
  // four of the five executed fences and CI stayed green over the remainder -- this gate's own
  // failure mode, living in the job that runs it. The job now passes no arguments, so the page list
  // has exactly one home. Explicit pages remain accepted for local use.
  const pages = process.argv.slice(2).filter((a) => a !== '--list');
  const selected = pages.length === 0 ? Object.keys(DRIVEN) : pages;
  for (const page of selected) {
    // A page outside the declared scope is refused, not skipped: "the runner ignored it" and "the
    // runner passed it" must never look the same from the outside.
    if (!(page in DRIVEN)) {
      usage(`\`${page}\` is not a page this runner drives (see the SCOPE note at the top of this file)`);
    }
  }

  // The stated hazard: `docker/README.md`'s bootstrap fence WRITES `mcp-server/.env`. It must only
  // ever do so inside the temp copy. Creation is not the only way to damage the working tree's copy,
  // so the guard hashes the file rather than merely testing for existence -- an OVERWRITE of an
  // existing `.env` (a developer's real encryption key) would otherwise pass unnoticed.
  const workTreeEnv = path.join(REPO_ROOT, 'mcp-server', '.env');
  const envFingerprint = () => (existsSync(workTreeEnv)
    ? createHash('sha256').update(readFileSync(workTreeEnv)).digest('hex')
    : null);
  const workTreeEnvBefore = envFingerprint();

  const stamp = `${process.pid}${Date.now().toString(36)}`;
  const projectName = `framefit-docgate-${stamp}`;
  const tmp = mkdtempSync(path.join(tmpdir(), 'framefit-doc-seq-'));
  const keep = process.env.DOC_SEQUENCES_KEEP === '1';

  // Docker state. `dockerReady` is probed once: with no usable docker nothing a fence does can
  // create a container, and a fence that tries fails loudly on its own (measured: exit 127). With a
  // usable docker we take a baseline census, and from then on "did this run create anything" is a
  // question answered by docker rather than by a regex over the page.
  const dockerReady = dockerUsable();
  const baseline = dockerReady ? census() : null;
  let createdDocker = false;
  const teardownProblems = [];

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (createdDocker) {
      const down = composeDown(tmp, projectName);
      // A teardown whose exit status nobody reads is a teardown nobody performed. The residue check
      // below is the real verdict, but a non-zero `down` explains it.
      if (down.ran && down.status !== 0) {
        teardownProblems.push(`\`docker compose down\` exited ${down.status}: ${down.stderr.trim().split('\n').slice(-3).join(' / ')}`);
      }
    }
    if (!keep) rmSync(tmp, { recursive: true, force: true });
    else process.stderr.write(`[doc-sequences] DOC_SEQUENCES_KEEP=1, temp copy left at ${tmp}\n`);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { cleanup(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  }
  process.on('exit', cleanup);

  let failed = false;
  let pagesProcessed = 0;
  let fencesRun = 0;
  try {
    // Materialise. `set -o pipefail` because a three-stage pipeline otherwise reports only the last
    // stage's status -- a failing `git ls-files` would be invisible behind a happy `tar -x`.
    const materialise = runSync('bash', ['-c',
      'set -o pipefail; git ls-files -z | tar --null -T - -c | tar -x -C "$1"', 'bash', tmp,
    ], { cwd: REPO_ROOT });
    if (materialise.status !== 0) {
      throw new Error(`could not materialise the tree under review (exit ${materialise.status}): ${materialise.stderr}`);
    }
    process.stdout.write(`[doc-sequences] tree under review materialised at ${tmp}\n`);
    process.stdout.write(`[doc-sequences] compose project name for this run: ${projectName}\n`);

    // `selected`, never the raw argv: with no argument `pages` is empty and this loop would run
    // zero times and report GREEN over nothing. That is not hypothetical -- it is exactly what the
    // first cut of the no-argument default did, and `pagesProcessed` below is the assertion that
    // makes the class of mistake impossible rather than merely fixed.
    for (const page of selected) {
      pagesProcessed += 1;
      const pagePath = path.join(tmp, page);
      if (!existsSync(pagePath)) throw new Error(`${page}: not present in the materialised tree`);
      const fences = collectBashFences(readFileSync(pagePath, 'utf8'), page).map(classify);
      const executable = fences.filter((f) => f.executable);
      const excluded = fences.filter((f) => !f.executable);

      process.stdout.write(`\n[doc-sequences] ${page}: ${fences.length} bash fences, `
        + `${executable.length} executable, ${excluded.length} declared not-executed\n`);
      for (const f of excluded) {
        process.stdout.write(`[doc-sequences]   NOT RUN  ${page}:${f.startLine}  `
          + `# not-executed: ${f.reasons.join(',')}\n`);
      }

      // The count assertion, BEFORE anything runs. A page that lost an executable fence must fail
      // even if every remaining fence passes -- that is the whole "green over what it did not run"
      // failure, and it is cheapest to catch here.
      if (executable.length !== DRIVEN[page]) {
        throw new Error(
          `${page}: ${executable.length} executable fences, this runner is declared to drive `
          + `${DRIVEN[page]}. A DROP means a fence was demoted to \`# not-executed:\` (or lost its `
          + '`bash` tag) and would silently stop being run; a RISE means a new fence needs a scope '
          + 'decision. Update DRIVEN in this file deliberately.',
        );
      }

      // Preconditions. The only setup the runner performs, and it performs no other.
      const declared = [...new Set(executable.flatMap((f) => f.preconditions))];
      for (const name of declared) {
        const spec = PRECONDITIONS[name];
        if (spec === undefined) throw new Error(`${page}: unknown \`# precondition: ${name}\``);
        for (const [cmd, args] of spec.steps) {
          process.stdout.write(`[doc-sequences]   precondition ${name}: ${cmd} ${args.join(' ')}\n`);
          const r = await run(cmd, args, {
            cwd: path.join(tmp, spec.cwd),
            env: process.env,
            timeoutMs: PRECONDITION_TIMEOUT_MS,
            label: `precondition ${name}`,
          });
          if (!r.ok) throw new Error(`${page}: precondition \`${name}\` failed (${r.why}) on \`${cmd} ${args.join(' ')}\``);
        }
      }

      // The run loop. It has NO skip branch and no `continue`: every executable fence is attempted,
      // in page order, and `attempted` is asserted against the count afterwards so that a future
      // edit which introduces one is caught rather than merely discouraged. Page order is
      // load-bearing on `docker/README.md`, where the bootstrap fence must run before the bring-up
      // that reads the file it writes.
      let attempted = 0;
      let passed = 0;
      const results = [];
      for (const fence of executable) {
        const { dir, body } = split(fence);
        const cwd = path.resolve(tmp, dir);
        // Boundary-aware containment: a bare `startsWith(tmp)` also accepts a SIBLING whose name
        // merely begins with the temp copy's, so `cd ../framefit-doc-seq-abc123-evil` would pass.
        const inside = cwd === tmp || cwd.startsWith(tmp + path.sep);
        if (!inside || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
          throw new Error(`${page}:${fence.startLine}: \`cd ${dir}\` names no directory in the materialised tree`);
        }
        const scriptPath = path.join(tmp, `.doc-sequence-${page.replace(/\W/g, '_')}-${fence.startLine}.sh`);
        writeFileSync(scriptPath, `${body}\n`);
        const label = `${page}:${fence.startLine}`;
        attempted += 1;
        process.stdout.write(`\n[doc-sequences] RUN      ${label}  (cd ${dir})\n`);
        // `-eo pipefail`, not `-e`. Without `pipefail` a terminating assertion inside a pipeline
        // reports the LAST segment's status, so `curl -fsS .../health/NOPE | cat` exits 22, prints
        // its 404 body into this runner's own log, and the fence passes. The static half cannot see
        // this -- the terminator is structurally valid -- so it has to be the shell's setting here.
        const r = await run('bash', ['-eo', 'pipefail', scriptPath], {
          cwd,
          env: (() => {
            const e = { ...process.env };
            for (const k of STRIPPED_ENV) delete e[k];
            e.COMPOSE_PROJECT_NAME = projectName;
            return e;
          })(),
          timeoutMs: FENCE_TIMEOUT_MS,
          label,
        });
        // Did THIS fence create docker objects? Asked of docker, not of the fence's text. Teardown
        // happens whether the fence passed or failed, before the next one starts -- the two
        // bring-ups on `docker/README.md` publish the same host port, so the next fence cannot even
        // start until this one's stack is gone.
        if (dockerReady) {
          const after = census();
          if (after.unreadable.length > 0) {
            teardownProblems.push(`census after ${label} unreadable: ${after.unreadable.join('; ')}`);
            createdDocker = true; // unknown is not "nothing": tear down anyway
          } else if (appearedSince(baseline, after).length > 0) {
            createdDocker = true;
          }
          if (createdDocker) {
            const down = composeDown(tmp, projectName);
            if (down.ran && down.status !== 0) {
              teardownProblems.push(`\`docker compose down\` after ${label} exited ${down.status}`);
            }
          }
        }
        results.push({ label, dir, ...r });
        if (r.ok) {
          passed += 1;
          fencesRun += 1;
        }
        else {
          failed = true;
          process.stderr.write(`\n[doc-sequences] FAIL     ${label} (cd ${dir}): ${r.why}\n`);
          for (const line of r.tail.slice(-15)) process.stderr.write(`[doc-sequences]   | ${line}\n`);
          break; // page order is a sequence: a later fence may depend on this one having worked
        }
      }

      process.stdout.write(`\n[doc-sequences] ${page} summary\n`);
      for (const r of results) {
        process.stdout.write(`[doc-sequences]   ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}  (cd ${r.dir})  ${r.why}  ${r.ms}ms\n`);
      }
      const notReached = executable.length - attempted;
      process.stdout.write(`[doc-sequences]   executed ${passed}/${executable.length} executable fences`
        + `${notReached > 0 ? `, ${notReached} not reached (an earlier fence failed)` : ''}`
        + `, ${excluded.length} declared not-executed\n`);

      if (!failed && attempted !== executable.length) {
        // Unreachable while the loop above has no skip branch. Asserted anyway: this is the exact
        // shape of the defect the gate exists for, and it must not depend on reading the loop.
        throw new Error(`${page}: attempted ${attempted} of ${executable.length} executable fences -- a fence was skipped silently`);
      }
      if (!failed && passed !== executable.length) {
        throw new Error(`${page}: ${passed} of ${executable.length} executable fences passed`);
      }
      if (failed) break;
    }
  } catch (err) {
    failed = true;
    process.stderr.write(`\n[doc-sequences] ERROR ${err.message}\n`);
  } finally {
    cleanup();
  }

  // Post-conditions on the harness itself, checked even when the fences passed.
  //
  // A COUNT EQUALITY CANNOT EXCLUDE EMPTINESS. The previous version of this asserted
  // `pagesProcessed !== selected.length`, which is `0 !== 0` when `DRIVEN` is empty -- so emptying
  // the table gave GREEN over zero pages at exit 0, reproducing one level up the very vacuity the
  // assertion was added to close. Measured before this fix: `const DRIVEN = {}` -> exit 0, `GREEN`.
  // The fix is a FLOOR on work actually done, at each level, so that nothing can be satisfied by
  // arranging for there to be nothing to do.
  const expectedFences = selected.reduce((n, p) => n + DRIVEN[p], 0);
  const floors = [
    [Object.keys(DRIVEN).length > 0, 'DRIVEN is empty, so this runner drives nothing'],
    [selected.length > 0, 'no page was selected'],
    [expectedFences > 0, `the selected pages declare ${expectedFences} fences between them`],
    [pagesProcessed === selected.length,
      `processed ${pagesProcessed} of ${selected.length} selected page(s) -- a page was skipped before it ran`],
    [fencesRun === expectedFences,
      `ran ${fencesRun} fences, the selected pages declare ${expectedFences}`],
  ];
  for (const [holds, why] of floors) {
    if (!failed && !holds) {
      failed = true;
      process.stderr.write(`\n[doc-sequences] ERROR ${why} -- a run that did nothing is not a pass\n`);
    }
  }
  if (createdDocker) {
    const res = residue(projectName, baseline);
    if (res.unreadable.length > 0) {
      failed = true;
      process.stderr.write(`\n[doc-sequences] ERROR could not verify teardown for project ${projectName}: `
        + `${res.unreadable.join('; ')} -- "could not look" is not "nothing there"\n`);
    }
    if (res.labelled.length > 0) {
      failed = true;
      process.stderr.write(`\n[doc-sequences] ERROR teardown left ${res.labelled.length} object(s) still carrying `
        + `this run's compose project label (${projectName}), so this run created them and they are `
        + `still here: ${res.labelled.join(', ')}\n`);
    }
    if (res.leaked.length > 0) {
      failed = true;
      process.stderr.write(`\n[doc-sequences] ERROR ${res.leaked.length} docker object(s) appeared during this `
        + `run and still exist: ${res.leaked.join(', ')}\n`);
    }
    // Not a failure, but said out loud: an image store this run grew is a fact worth seeing in the
    // log, and stating it is what keeps "we ignore tagged images" from being a silent rule. The line
    // reports only what was measured -- that these appeared during the run and carry a repo tag.
    // Where they came from is NOT measured: a registry pull and an image this run built but failed
    // to remove are indistinguishable by tag, so an id can appear both here and on the project-label
    // line above, and when it does the label is the one telling the truth.
    if (res.tagged.length > 0) {
      process.stdout.write(`[doc-sequences] ${res.tagged.length} tagged image(s) appeared during this run and `
        + `were left in the local image store: ${res.tagged.join(', ')} -- tagged, so not counted as this `
        + 'run\'s residue; origin not determined (see partitionAppeared)\n');
    }
  }
  for (const problem of teardownProblems) {
    failed = true;
    process.stderr.write(`\n[doc-sequences] ERROR teardown: ${problem}\n`);
  }
  const workTreeEnvAfter = envFingerprint();
  if (workTreeEnvAfter !== workTreeEnvBefore) {
    failed = true;
    process.stderr.write(`\n[doc-sequences] ERROR a fence ${workTreeEnvBefore === null ? 'created' : 'modified'} `
      + 'mcp-server/.env in the WORKING TREE; it must only ever be written inside the materialised copy\n');
  }

  process.stdout.write(`\n[doc-sequences] ${failed ? 'RED' : 'GREEN'}\n`);
  process.exit(failed ? 1 : 0);
}

// `--list` shares main()'s parsing but must not execute anything; it is handled by exiting before
// the run loop rather than by a flag threaded through it, so there is no code path where "listing"
// could be mistaken for "running".
if (process.argv.includes('--list')) {
  const given = process.argv.slice(2).filter((a) => a !== '--list');
  const pages = given.length === 0 ? Object.keys(DRIVEN) : given;
  for (const page of pages) {
    const fences = collectBashFences(readFileSync(path.join(REPO_ROOT, page), 'utf8'), page).map(classify);
    process.stdout.write(`${page}: ${fences.length} bash fences\n`);
    for (const f of fences) {
      const how = f.executable
        ? `EXECUTABLE  cd ${(CD_LINE.exec(f.lines.find((l) => l.trim() !== '' && !/^\s*#/.test(l)) ?? '') ?? [, '?'])[1]}`
        : `excluded    ${f.reasons.join(',')}`;
      const pre = f.preconditions.length > 0 ? `  [precondition: ${f.preconditions.join(',')}]` : '';
      process.stdout.write(`  ${page}:${String(f.startLine).padStart(4)}  ${how}${pre}\n`);
    }
    process.stdout.write(`  -> ${fences.filter((f) => f.executable).length} executable`
      + `${page in DRIVEN ? ` (DRIVEN declares ${DRIVEN[page]})` : ' (page not driven by this runner)'}\n`);
  }
  process.exit(0);
}

await main();
