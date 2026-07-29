#!/usr/bin/env node
// Cross-platform stdio-transport smoke test (pubready A-T3).
//
// TWO handshakes, and the success line names both. Either one failing fails the script.
//
//   1. CONTROL -- the BUILT server (`dist/index.js`), spawned with no `cwd`, driven through the
//      minimum MCP handshake (initialize -> initialized -> tools/list) and then the payload and CLI
//      assertions this gate has always carried. Unchanged, deliberately: this is the contract the
//      `stdio-smoke` matrix in `.github/workflows/ci.yml` has been running on three OSes, and that
//      job sets `working-directory: mcp-server`.
//
//   2. THE DOCUMENTED LIVE-ITERATION ARGV -- the `args` array `examples/mcp-config/README.md` prints
//      under "### Live iteration on the source", read out of that page AT RUNTIME (so the page and
//      this harness cannot drift) and spawned from `os.tmpdir()`. The foreign directory IS the test:
//      an MCP client's process cwd is the user's own project, never this checkout.
//
// Proves the packaged bin boots and answers as an MCP server WITHOUT a Figma token and WITHOUT
// multi-tenant env (single-tenant stdio mode never needs either -- see src/infrastructure/config.ts
// / src/infrastructure/server.ts:startStdioServer).
//
// WHY (2) EXISTS, AND WHY IT FAILS TWO WAYS. The page used to say "swap the last arg for
// `--import tsx --watch .../src/index.ts`". `tsx` there is a BARE specifier, which Node resolves
// against the process cwd, so the documented line worked only from `mcp-server/`. That one sentence
// produces THREE different failures, all measured on darwin 24.6.0 / node v24.12.0 spawning from a
// scratch directory, and they are not variations on each other:
//
//   - EXIT 9, with the page's own `--env-file=<absent .env>`: node aborts on the missing env file
//     printing `node: <path>/.env: not found`, before the loader is even reached;
//   - EXIT 0 in ~130ms, with the bare `tsx` and NOTHING WATCHABLE: the loader failure reaches
//     stderr as `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from <tmpdir>/`,
//     stdout gets `Failed running '...'. Waiting for file changes before restarting...` -- and then
//     the process leaves anyway. Measured five times at 116-153 ms. A success status from a server
//     that answered nothing, which is what a naive harness reads as a pass;
//   - STAYS ALIVE, with the bare `tsx` and something in the WATCH SET. This is the same argv as
//     above plus an env-file element, and that element is the whole difference: the loader failed
//     before the entry point was resolved, so no source file was ever registered, and node watches
//     the env-file path whether or not the file exists. Measured alive at 10s under three stdin
//     dispositions (pipe, pipe-then-end, ignore) and at 5s from a plain shell; `--watch-path` in
//     place of the env-file element does the same. The documented argv HAS an env-file element, so
//     this is the shape the real page produces.
//
// The watch set is the mechanism, not "`--watch` is a supervisor" -- the same supervisor exits in
// 130ms when the set is empty. Three shapes on ONE Node version, and `engines` is `>=20`, which
// spans versions none of this covers. So a session below fails on EITHER: the child exiting before
// it answers `initialize` (any status, including 0), or the deadline. A harness that watched only
// the deadline would be green on the first two; one that watched only the exit would hang on the
// third until CI reclaimed it.
//
// Deliberately avoids: shell:true (Windows quoting/PATH differences), any bash-isms, and the
// `timeout(1)` coreutil (not present on macOS runners). Framing matches the SDK's stdio transport:
// newline-delimited JSON, one message per line (see @modelcontextprotocol/sdk shared/stdio.js).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/{README.md,examples,docs,...} and <root>/mcp-server/scripts/<this file>.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const serverEntry = path.join(__dirname, '..', 'dist', 'index.js');
const pkgVersion = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
).version;

// The control has nothing to compile: it runs `dist/`.
const TIMEOUT_MS = 20_000;
// The documented argv does. `tsx` transpiles the whole reachable source tree on the way in, so the
// bound is sized for a cold CI runner rather than for this machine (measured warm here: initialize
// answered in 0.9-1.3s). Generous is safe in the one direction that matters -- the deadline is a
// FAILURE, never a skip, and it is not the guard that fires on the defect this run exists for; the
// premature-exit guard is, and it fires the instant the child dies.
const DOC_TIMEOUT_MS = 60_000;
const MIN_TOOLS = 26; // current count is exactly 26; assert a floor, not the exact number

// The single source for run 2, and the coupling the page itself advertises.
const CONFIG_PAGE = 'examples/mcp-config/README.md';
const LIVE_HEADING = '### Live iteration on the source';
const PLACEHOLDER_ROOT = '/absolute/path/to/framefit';
// One message for every way the page can fail to hold an argv, because the failure is one thing:
// there is nothing to run. An empty corpus is the shape this documentation line bans everywhere
// else; it is banned here too, rather than degrading into a skipped second run.
const NO_SOURCE = `no live-iteration args array in ${CONFIG_PAGE}`;

function fail(message) {
  console.error(`[stdio-smoke] FAIL: ${message}`);
  process.exitCode = 1;
}

function log(message) {
  console.log(`[stdio-smoke] ${message}`);
}

if (!existsSync(serverEntry)) {
  fail(`${serverEntry} not found - run "pnpm build" first`);
  process.exit(1);
}

// Explicit env: MCP_TRANSPORT=stdio, no FIGMA_TOKEN, no MULTI_TENANT — proves
// the handshake needs neither, regardless of what the invoking shell happens
// to have set. Both sessions get the same one.
const childEnv = { ...process.env };
delete childEnv.FIGMA_TOKEN;
delete childEnv.MULTI_TENANT;
childEnv.MCP_TRANSPORT = 'stdio';

// --- reading the documented argv ----------------------------------------------------------------

/**
 * The `args` array of the first `json` fence under LIVE_HEADING in CONFIG_PAGE.
 *
 * Anchored on the HEADING rather than on a hidden marker: the anchor is then something a reader of
 * the page can see and a renamer of the section will notice. Every way this can come back empty --
 * missing page, missing heading, a fence tagged something else, unparseable JSON, no `args` --
 * throws with NO_SOURCE as its first words, so "the page stopped carrying an argv" can never look
 * like "the argv passed".
 */
function readLiveIterationArgs() {
  const pagePath = path.join(REPO_ROOT, CONFIG_PAGE);
  if (!existsSync(pagePath)) throw new Error(`${NO_SOURCE}: the page does not exist at ${pagePath}`);
  const lines = readFileSync(pagePath, 'utf8').split('\n');

  const headingIdx = lines.findIndex((l) => l.trim() === LIVE_HEADING);
  if (headingIdx === -1) throw new Error(`${NO_SOURCE}: no line reads exactly \`${LIVE_HEADING}\``);

  // BOUNDED TO THE SECTION, not run to end of file. An unbounded scan says "the first fence after
  // this heading", which is a different claim from "this section's fence" the moment the section
  // stops having one: measured before this bound, deleting the block and leaving an equivalent
  // `json` fence 26 lines lower bound the harness to that one and reported two green handshakes over
  // an EMPTY section. The section ends at the next markdown heading of level 1-3 that is not inside
  // a fence (LIVE_HEADING is level 3, so a sibling `###` closes it just as `##` does).
  // KNOWN GAP: the boundary is an ATX heading in the markdown text. A setext underline (`---` under
  // a line of prose) and a raw `<h3>` are headings to a reader and are not seen here; neither form
  // occurs in this corpus, and both would fail open in the safe direction -- the scan would run past
  // them and hit the `no fence` or wrong-language error rather than silently binding elsewhere.
  const HEADING = /^ {0,3}#{1,3}\s/;
  let open = -1;
  let close = -1;
  let inFence = false;
  for (let i = headingIdx + 1; i < lines.length; i += 1) {
    const m = /^\s*(?:```|~~~)(.*)$/.exec(lines[i]);
    if (m === null) {
      // A `#` line inside a fence is a shell comment, not a heading, so the boundary test only
      // applies outside one.
      if (!inFence && HEADING.test(lines[i])) break;
      continue;
    }
    inFence = !inFence;
    if (open === -1) {
      const lang = m[1].trim();
      // The FIRST fence in the section, not the first `json` one: skipping over a fence would
      // let an edit that retags this block to `bash` (or drops the tag) silently redirect the
      // harness at some later, unrelated fence.
      if (lang !== 'json') {
        throw new Error(`${NO_SOURCE}: the first fence under the heading is tagged \`${lang === '' ? '<untagged>' : lang}\`, not \`json\``);
      }
      open = i;
    } else {
      close = i;
      break;
    }
  }
  if (open === -1) {
    throw new Error(`${NO_SOURCE}: the \`${LIVE_HEADING}\` section holds no fence (the scan stops at the next heading, so a fence in a LATER section is not this section's)`);
  }
  if (close === -1) throw new Error(`${NO_SOURCE}: the json fence under the heading is never closed before the section ends`);

  let doc;
  try {
    doc = JSON.parse(lines.slice(open + 1, close).join('\n'));
  } catch (err) {
    throw new Error(`${NO_SOURCE}: the fence at ${CONFIG_PAGE}:${open + 1} is not valid JSON (${err.message})`);
  }

  const servers = (doc && typeof doc === 'object' && doc.mcpServers) || {};
  const names = Object.keys(servers);
  if (names.length !== 1) {
    throw new Error(`${NO_SOURCE}: the fence declares ${names.length} servers under \`mcpServers\`, expected exactly 1`);
  }
  const args = servers[names[0]].args;
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error(`${NO_SOURCE}: \`mcpServers.${names[0]}\` carries no non-empty \`args\` array`);
  }
  if (!args.every((a) => typeof a === 'string')) {
    throw new Error(`${NO_SOURCE}: \`mcpServers.${names[0]}.args\` holds a non-string element`);
  }
  const command = servers[names[0]].command;
  // The harness spawns `process.execPath`. If the page ever documents a different command, running
  // its args under node would prove something about a line nobody is told to type.
  if (command !== 'node') {
    throw new Error(`${NO_SOURCE}: the fence's \`command\` is \`${command}\`, but this harness spawns node`);
  }
  return { args, fenceLine: open + 1 };
}

/**
 * Turn the documented argv into one that runs in THIS checkout: substitute the placeholder root,
 * then assert the result names files that exist, so a typo in the page fails by name here instead
 * of arriving as a timeout later.
 *
 * WHAT THE EXISTENCE CHECK COVERS, AND WHAT IT DOES NOT. It looks at the elements that name a path
 * under this checkout after substitution, and it knows exactly one thing about flags: an env file
 * (EITHER spelling) is allowed to be absent, so only its directory is checked. Everything else that
 * resolves under the checkout must be an existing file.
 *
 * Why BOTH spellings and not just `--env-file-if-exists`, when only that one tolerates an absent
 * file: because the difference between them is a RUNTIME behaviour, and it is one of the two
 * failures this whole run exists to catch. `mcp-server/.env` is git-ignored and absent in CI, so a
 * page that regressed to `--env-file=` makes the child exit 9 with `node: <path>/.env: not found`
 * BEFORE the handshake -- which is precisely what the premature-exit guard names. Asserting it here
 * instead would report the same defect one step earlier and leave that guard undemonstrated, and a
 * guard nothing has ever fired is a guard nobody has checked.
 *
 * It does NOT check: flags that carry no path; a path outside the checkout (nothing rewrote it, so
 * nothing here knows what it should be); and above all it cannot tell that `--import` names a module
 * which actually REGISTERS a TypeScript loader -- only the handshake proves that, which is why the
 * handshake and not this function is the assertion.
 */
function resolveDocArgv(args) {
  const substituted = args.map((a) => a.split(PLACEHOLDER_ROOT).join(REPO_ROOT));
  if (substituted.every((a, i) => a === args[i])) {
    throw new Error(
      `${CONFIG_PAGE}: no element of the live-iteration args array contains \`${PLACEHOLDER_ROOT}\`, `
      + 'so nothing was rewritten to this checkout and the spawn would name another machine\'s paths',
    );
  }

  const underRoot = (p) => p === REPO_ROOT || p.startsWith(REPO_ROOT + path.sep);
  const problems = [];
  for (const element of substituted) {
    const eq = /^(--[A-Za-z][A-Za-z0-9-]*)=(.*)$/.exec(element);
    const flag = eq === null ? null : eq[1];
    const value = eq === null ? element : eq[2];
    if (!path.isAbsolute(value) || !underRoot(path.resolve(value))) continue;
    const target = path.resolve(value);
    if (flag === '--env-file' || flag === '--env-file-if-exists') {
      const dir = path.dirname(target);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        problems.push(`\`${element}\` names no directory (${dir})`);
      }
      continue;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      problems.push(`\`${element}\` names no file in this checkout`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `${CONFIG_PAGE}: the live-iteration argv does not resolve in this checkout: ${problems.join('; ')}`
      + ' -- fix the page, or run `pnpm install` if the loader is what is missing',
    );
  }

  // RUN 2 MUST BE A DIFFERENT TEST FROM THE CONTROL. Without this, a page that regressed its
  // live-iteration block back to `dist/index.js` spawns the built artifact from a temp directory,
  // answers, and the script reports TWO green handshakes for one test -- measured exactly that,
  // exit 0, `the 2-element live-iteration argv ... serverInfo.name="framefit"`. Two properties, both
  // about WHICH TREE is being run:
  //   - some element names a file under `mcp-server/src/`  -- it runs the sources;
  //   - no element names a file under `mcp-server/dist/`   -- it is not the control's artifact.
  // The second is not implied by the first: an argv naming both would satisfy only the first.
  //
  // WHAT THIS DELIBERATELY DOES NOT CHECK, and why not a loader-flag list. The obvious third rule is
  // "the argv must carry `--import`/`--loader`/`--experimental-loader`". That is an enumeration of
  // today's spellings, and it would be a FALSE RED tomorrow: measured on node v24.12.0, `node t.ts`
  // runs a TypeScript file with no flag at all, so a future revision of this page could legitimately
  // drop tsx entirely. How the sources are made runnable is a behaviour, and the handshake below is
  // what proves it -- an argv naming `src/index.ts` with no working loader does not answer, and the
  // premature-exit guard names it.
  const srcDir = path.join(REPO_ROOT, 'mcp-server', 'src') + path.sep;
  const distDir = path.join(REPO_ROOT, 'mcp-server', 'dist') + path.sep;
  const namedPaths = substituted
    .map((element) => {
      const eq = /^--[A-Za-z][A-Za-z0-9-]*=(.*)$/.exec(element);
      return eq === null ? element : eq[1];
    })
    .filter((value) => path.isAbsolute(value))
    .map((value) => path.resolve(value));
  if (!namedPaths.some((p) => p.startsWith(srcDir))) {
    throw new Error(
      `${CONFIG_PAGE}: the live-iteration argv names no file under mcp-server/src/, so it does not run `
      + 'the sources and this run is not a different test from the dist/index.js control',
    );
  }
  const fromDist = namedPaths.filter((p) => p.startsWith(distDir));
  if (fromDist.length > 0) {
    throw new Error(
      `${CONFIG_PAGE}: the live-iteration argv names the BUILT artifact (${fromDist.join(', ')}), `
      + 'which is what the control already runs -- this run would report a second green handshake for '
      + 'the same test',
    );
  }

  // The Windows spelling the page documents. `--import` is resolved as an ESM specifier, so a
  // drive-letter path is read as a URL whose scheme is the drive letter and rejected with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME; the page tells a Windows reader to pass a `file://` URL there
  // and this applies the same rule to the same element. On POSIX nothing is touched, so what runs
  // on the ubuntu and macos legs is byte-for-byte the array the page prints.
  // Only `--import` in its two spellings; any other flag that takes an ESM specifier would need the
  // same treatment and does not get it -- no such flag is in the documented argv.
  if (process.platform === 'win32') {
    for (let i = 0; i < substituted.length; i += 1) {
      const eq = /^--import=(.*)$/.exec(substituted[i]);
      if (eq !== null) {
        substituted[i] = `--import=${pathToFileURL(eq[1]).href}`;
      } else if (substituted[i] === '--import' && i + 1 < substituted.length) {
        substituted[i + 1] = pathToFileURL(substituted[i + 1]).href;
      }
    }
  }
  return substituted;
}

// --- one handshake session ------------------------------------------------------------------------

// Killing the documented argv's child is not `child.kill()`: `node --watch` is a supervisor that
// runs the entry in a grandchild, so killing the direct pid can leave the server behind. On POSIX
// the child is spawned `detached`, which gives it its own process GROUP, and the group is what gets
// the signal. Windows has no process group to signal, so the tree goes to `taskkill /T` (present on
// every windows-latest runner), with `child.kill` as the last resort on both.
function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    if (r.status === 0) return;
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // no such group (already reaped, or never detached) - fall through
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already dead
  }
}

// Anything still running when this process leaves, for any reason, including a throw nobody caught.
const liveChildren = new Set();
process.on('exit', () => {
  for (const c of liveChildren) killTree(c);
});

/**
 * Spawn one server, drive it, and resolve with whatever `drive` returned.
 *
 * Rejects, never resolves, on: a spawn error, the child exiting before `drive` finished (ANY status,
 * including 0), the deadline, or anything `drive` threw. Every rejection carries the label, the
 * child's own last words, and the full stderr for the caller to print.
 *
 * `strictStdout` is the difference between the two runs and it is a real concession, so it is stated
 * here rather than buried: the control demands that EVERY line on stdout be an MCP frame, which is
 * the server's stdout-hygiene contract (src/infrastructure/cli.ts keeps diagnostics on stderr for
 * exactly this reason). The documented argv cannot be held to it, because there the process on the
 * other end of the pipe is `node --watch`, whose own supervisor messages -- including
 * `Failed running '...'` -- go to stdout by design. So run 2 records non-protocol lines and quotes
 * the last one when it fails, instead of failing on the first one. What that gives up is stdout
 * hygiene under `tsx`; it stays locked by the control, on the built artifact, on every OS and Node
 * in the CI matrix.
 */
function withSession({ argv, cwd, label, timeoutMs, strictStdout }, drive) {
  return new Promise((resolve, reject) => {
    const pending = new Map();
    let settled = false;
    let nextId = 1;
    let stdoutBuf = '';
    let stderrBuf = '';
    const otherStdout = [];

    // The child's own last words: the last non-empty stderr line, plus the first line that names an
    // Error, because those are often not the same line -- node prints a stack and then its own
    // version banner, so the last line alone would be `Node.js v24.12.0`. Neither is guaranteed to
    // be the informative one, which is why the full stderr is dumped by the caller regardless.
    const lastWords = () => {
      const parts = [];
      const errLines = stderrBuf.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      const firstError = errLines.find((l) => /\bError\b/.test(l));
      if (firstError !== undefined) parts.push(`stderr: ${firstError.slice(0, 200)}`);
      const last = errLines[errLines.length - 1];
      if (last !== undefined && last !== firstError) parts.push(`last stderr line: ${last.slice(0, 200)}`);
      const lastOther = otherStdout[otherStdout.length - 1];
      if (lastOther !== undefined) parts.push(`last non-protocol stdout line: ${lastOther.slice(0, 200)}`);
      return parts.length === 0 ? '' : ` -- ${parts.join('; ')}`;
    };

    const sessionError = (why) => {
      const err = new Error(`${label}: ${why}${lastWords()}`);
      err.stderrDump = stderrBuf;
      return err;
    };

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const { reject: rejectPending } of pending.values()) {
        rejectPending(new Error(`${label}: session closing`));
      }
      pending.clear();
      killTree(child);
      liveChildren.delete(child);
      if (err) reject(err);
      else resolve(value);
    };

    const child = spawn(process.execPath, argv, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    liveChildren.add(child);

    const timer = setTimeout(() => {
      settle(sessionError(`timed out after ${timeoutMs}ms waiting on the handshake`));
    }, timeoutMs);

    child.on('error', (err) => {
      settle(sessionError(`failed to spawn server process: ${err.message}`));
    });

    // ANY exit before the drive finished is a failure, exit 0 included: a server that answered
    // nothing and exited successfully is the shape a naive harness reads as a pass.
    child.on('exit', (code, signal) => {
      settle(sessionError(`the child exited (code=${code}, signal=${signal}) before the handshake completed`));
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          if (strictStdout) {
            settle(sessionError(`non-JSON line on stdout (expected only MCP protocol frames): ${line.slice(0, 200)}`));
            return;
          }
          otherStdout.push(line.trim());
          while (otherStdout.length > 10) otherStdout.shift();
          continue;
        }
        if (msg && typeof msg.id !== 'undefined' && pending.has(msg.id)) {
          const { resolve: resolvePending, reject: rejectPending } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) {
            rejectPending(new Error(`JSON-RPC error for id ${msg.id}: ${JSON.stringify(msg.error)}`));
          } else {
            resolvePending(msg.result);
          }
        }
      }
    });

    const send = (payload) => {
      child.stdin.write(JSON.stringify(payload) + '\n');
    };
    const request = (method, params) => {
      const id = nextId++;
      return new Promise((resolveReq, rejectReq) => {
        pending.set(id, { resolve: resolveReq, reject: rejectReq });
        send({ jsonrpc: '2.0', id, method, params });
      });
    };
    const notify = (method, params) => {
      send({ jsonrpc: '2.0', method, params });
    };

    // A rejection that already carries a stderr dump came from `settle` itself and is passed
    // through; anything else is whatever `drive` threw, and it is re-wrapped so it too arrives with
    // the label and the child's last words. `String(err)` rather than `err.message`, because a
    // thrown non-Error would otherwise report a message of `undefined`.
    drive({ request, notify }).then(
      (value) => settle(null, value),
      (err) => settle(
        err instanceof Error && err.stderrDump !== undefined
          ? err
          : sessionError(err instanceof Error ? err.message : String(err)),
      ),
    );
  });
}

/**
 * Run the packaged CLI's `status --json --no-probe` in its own process and collect both streams.
 *
 * An EXPLICIT minimal env, never childEnv: that object is `{...process.env}` minus FIGMA_TOKEN and
 * MULTI_TENANT, so an inherited DATABASE_URL would make this spawn open a real connection pool.
 */
function runStatus(extraEnv = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, MCP_TRANSPORT: 'stdio', ...extraEnv };
  return new Promise((resolve, reject) => {
    // `statusChild`, not `child`: the sessions above drive servers of their own, and shadowing a
    // name here is one rename away from a teardown killing the wrong process.
    const statusChild = spawn(process.execPath, [serverEntry, 'status', '--json', '--no-probe'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const killer = setTimeout(() => statusChild.kill('SIGKILL'), 10_000);
    let stdout = '';
    let stderr = '';
    statusChild.stdout.on('data', (c) => { stdout += c; });
    // Drained, not ignored: an unread pipe can fill, and this text is the only diagnostic when the
    // command printed no document at all.
    statusChild.stderr.on('data', (c) => { stderr += c; });
    statusChild.on('error', (e) => { clearTimeout(killer); reject(e); });
    statusChild.on('close', (code) => { clearTimeout(killer); resolve({ stdout, stderr, code }); });
  });
}

function parseStatusReport({ stdout, stderr }) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `status --json did not print one JSON document: stdout=${stdout.slice(0, 200) || '<empty>'} stderr=${stderr.slice(0, 200) || '<empty>'}`,
    );
  }
}

/**
 * The directory run 2 spawns from -- checked, not assumed.
 *
 * The foreign working directory IS the property under test: Node resolves a bare specifier by
 * walking UP from the process cwd, so a cwd inside this checkout finds `mcp-server/node_modules` and
 * the documented argv answers whether or not it names the loader properly. `os.tmpdir()` honours
 * `TMPDIR`, and `TMPDIR` pointing into the checkout is a normal thing for a sandbox or a wrapper
 * script to do. Measured with `TMPDIR=<checkout>/mcp-server` against a page carrying the BROKEN bare
 * `tsx` argv: exit 0, two green handshakes, the defect entirely invisible -- and, incidentally, a
 * `tsx-<uid>/` transpile cache left behind in the working tree.
 *
 * Real paths on both sides: on macOS `os.tmpdir()` is `/var/folders/...`, a symlink to
 * `/private/var/...`, and a containment test on the unresolved strings compares two different
 * spellings of the same place.
 *
 * The rule is containment, not equality: `<checkout>` itself and anything under it are refused. A
 * cwd ABOVE the checkout is fine -- the walk up from there never enters it.
 */
function foreignWorkingDirectory() {
  const raw = tmpdir();
  if (!existsSync(raw) || !statSync(raw).isDirectory()) {
    throw new Error(`os.tmpdir() is ${raw}, which is not a directory (TMPDIR is set to something unusable)`);
  }
  const cwd = realpathSync(raw);
  const root = realpathSync(REPO_ROOT);
  if (cwd === root || cwd.startsWith(root + path.sep)) {
    throw new Error(
      `os.tmpdir() resolves to ${cwd}, which is inside this checkout (${root}) -- run 2 spawns there to `
      + 'prove the documented argv works from a cwd that is NOT the checkout, and a cwd inside it '
      + 'resolves bare specifiers against this tree, which is the very thing being tested. Unset or '
      + 'repoint TMPDIR.',
    );
  }
  return raw;
}

// --- run 1: the control ---------------------------------------------------------------------------

async function driveControl({ request, notify }) {
  const initResult = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stdio-smoke', version: '0.0.0' },
  });

  if (!initResult || !initResult.serverInfo || initResult.serverInfo.name !== 'framefit') {
    throw new Error(
      `unexpected serverInfo.name: ${JSON.stringify(initResult && initResult.serverInfo)} (expected "framefit")`,
    );
  }

  // The initialize response must carry the design-QA instructions (the done-gate contract
  // for hosts without a skills mechanism) — a live lock across every OS in the CI matrix.
  if (!initResult.instructions || !initResult.instructions.includes('verification.complete')) {
    throw new Error('initialize response is missing the design-QA instructions (done-gate contract)');
  }

  // The version lives in two places — package.json (what npm publishes, what the release
  // tag claims) and VERSION in src/infrastructure/version.ts (what the handshake tells
  // every host). A release bumps both by hand, so they can silently drift and the server
  // would then misreport its own version to every connected agent. Lock them together
  // against the BUILT artifact, so the check covers the shipped bundle, not the source.
  if (initResult.serverInfo.version !== pkgVersion) {
    throw new Error(
      `version drift: handshake reports "${initResult.serverInfo.version}", package.json says "${pkgVersion}" ` +
        '- bump both (package.json + VERSION in src/infrastructure/version.ts)',
    );
  }

  notify('notifications/initialized', {});

  const listResult = await request('tools/list', {});
  const tools = (listResult && listResult.tools) || [];
  if (!Array.isArray(tools) || tools.length < MIN_TOOLS) {
    throw new Error(`tools/list returned ${tools.length} tools, expected >= ${MIN_TOOLS}`);
  }

  // The tools/list payload is the product's interface: every MCP client shows it to a user or feeds
  // it to a model. It must be English ASCII - no em dashes, no arrow glyphs, no emoji, and above all
  // no example values in the author's working language. Asserted HERE, on the BUILT artifact over
  // the real protocol, because a check over the source files proves nothing about the bytes a client
  // is handed; the unit suite asserts the same property from two other vantages.
  // A character CLASS, not a list of the strings that were once removed - such a list can only ever
  // catch what somebody had already found. EVERY string in the entry, walked recursively, not just
  // `description`: two of the offenders found on 2026-07-28 sat a level below the top, under
  // `inputSchema.properties.pairs.items.properties`, where a hand-aimed check does not look. And
  // every KEY as well as every value: a schema property NAME ships in this same payload, and a
  // values-only walk called a tool with a Cyrillic-named property "every delivered string ASCII".
  const nonAscii = [];
  const walk = (value, at) => {
    if (typeof value === 'string') {
      const chars = [...new Set([...value].filter((c) => c.codePointAt(0) > 0x7f))];
      if (chars.length) {
        const points = chars
          .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
          .join(' ');
        nonAscii.push(`${at}: ${points}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${at}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        walk(k, `${at}.${k} <property name>`);
        walk(v, `${at}.${k}`);
      }
    }
  };
  for (const t of tools) walk(t, t.name);
  if (nonAscii.length) {
    throw new Error(`non-ASCII in ${nonAscii.length} delivered string(s): ${nonAscii.join(' | ')}`);
  }

  // The handshake version and the CLI's own report must agree, or `status` has grown a third
  // version literal and could name a version the server never reports.
  const run1 = await runStatus();
  const statusReport = parseStatusReport(run1);
  if (statusReport.version !== initResult.serverInfo.version) {
    throw new Error(`version drift: handshake says "${initResult.serverInfo.version}", status --json says "${statusReport.version}" - both must come from src/infrastructure/version.ts`);
  }
  // Negative control for the notice asserted below: with a sane LOG_LEVEL nothing warns about one.
  if (/LOG_LEVEL/.test(run1.stderr)) {
    throw new Error(`status warned about LOG_LEVEL when none was set: ${run1.stderr.slice(0, 200)}`);
  }

  // An invalid LOG_LEVEL must be REPORTED, not silently downgraded. index.ts's CLI logger falls back
  // to 'info' because pino throws on a bad level and a diagnostic command must survive the very
  // misconfiguration it exists to name - but a fallback nobody is told about is a setting that
  // vanished. buildCliLogger is private to a module whose scope dispatches argv, so this can only be
  // gated from the outside, on the built artifact.
  const run2 = await runStatus({ LOG_LEVEL: 'not-a-level' });
  if (!/LOG_LEVEL/.test(run2.stderr) || !/falling back/.test(run2.stderr)) {
    throw new Error(`an invalid LOG_LEVEL was accepted silently; stderr was: ${run2.stderr.slice(0, 300) || '<empty>'}`);
  }
  // And the command still has to DO its job: the notice goes to stderr, so stdout must still carry
  // exactly one JSON document, and it must still name the same version.
  const report2 = parseStatusReport(run2);
  if (report2.version !== statusReport.version) {
    throw new Error(`status reported version "${report2.version}" with a bad LOG_LEVEL, "${statusReport.version}" without it`);
  }
  if (report2.checks.length !== statusReport.checks.length) {
    throw new Error(`status ran ${report2.checks.length} checks with a bad LOG_LEVEL, ${statusReport.checks.length} without it`);
  }

  return { toolCount: tools.length, statusVersion: statusReport.version };
}

// --- run 2: the documented live-iteration argv ------------------------------------------------------

// What this run owns is arrival: that the argv the page prints ANSWERS, from a directory that is not
// the checkout. It does not re-run the control's payload assertions (tool count, delivered-string
// ASCII, the done-gate instructions) -- those are properties of the tools/list payload, the control
// locks them on the BUILT artifact across the whole matrix, and repeating them here would double the
// run for the same constants. The version line IS repeated, because it is cheap and it is read from
// the SOURCE tree rather than from `dist/`.
async function driveDocumented({ request }) {
  const initResult = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stdio-smoke', version: '0.0.0' },
  });
  if (!initResult || !initResult.serverInfo || initResult.serverInfo.name !== 'framefit') {
    throw new Error(
      `unexpected serverInfo.name: ${JSON.stringify(initResult && initResult.serverInfo)} (expected "framefit")`,
    );
  }
  if (initResult.serverInfo.version !== pkgVersion) {
    throw new Error(
      `version drift: the source tree's handshake reports "${initResult.serverInfo.version}", `
      + `package.json says "${pkgVersion}"`,
    );
  }
  return { version: initResult.serverInfo.version };
}

// --- main -------------------------------------------------------------------------------------------

async function main() {
  const control = await withSession({
    argv: [serverEntry],
    cwd: undefined,
    label: 'control (dist/index.js)',
    timeoutMs: TIMEOUT_MS,
    strictStdout: true,
  }, driveControl);

  const { args, fenceLine } = readLiveIterationArgs();
  const docArgv = resolveDocArgv(args);
  const foreignCwd = foreignWorkingDirectory();
  const documented = await withSession({
    argv: docArgv,
    cwd: foreignCwd,
    label: `documented live-iteration argv from ${CONFIG_PAGE}:${fenceLine}, spawned in ${foreignCwd}`,
    timeoutMs: DOC_TIMEOUT_MS,
    strictStdout: false,
  }, driveDocumented);

  log(
    `2 handshakes ok - [1] control dist/index.js: serverInfo.name="framefit", ${control.toolCount} tools `
    + `(>= ${MIN_TOOLS}), every delivered string ASCII, status --json version="${control.statusVersion}", `
    + 'bad LOG_LEVEL reported and survived; '
    + `[2] the ${docArgv.length}-element live-iteration argv from ${CONFIG_PAGE}:${fenceLine}, spawned in `
    + `${foreignCwd}: serverInfo.name="framefit", version="${documented.version}"`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    fail(err.message);
    if (err.stderrDump && err.stderrDump.trim()) {
      console.error('[stdio-smoke] server stderr:\n' + err.stderrDump.trim());
    }
    process.exit(1);
  },
);
