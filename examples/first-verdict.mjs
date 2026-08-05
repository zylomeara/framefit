#!/usr/bin/env node
// Your first verdict: a runnable stdio client that walks the design-QA cycle to a receipt.
//
//   node examples/first-verdict.mjs serve-extractor --file <url|key> --frame <node-id> --pair '<css>=<node-id>' ...
//   node examples/first-verdict.mjs verdict --file <url|key> --frame <node-id> --pair '<css>=<node-id>' ... --snapshots <file.json>
//
// The seam is deliberate and it is where a browser lives. Node cannot drive your page, so this
// client does the two halves it CAN do -- everything on the Figma side, and everything after the
// capture -- and hands you a short thunk to paste into whatever browser automation you already have
// (chrome-devtools MCP, Playwright, the devtools console). It never pretends to drive Chrome.
//
//   serve-extractor -> get_layout_spec -> holds the extractor on 127.0.0.1, prints two short thunks
//   [you]           -> paste thunk 1 (the page FETCHES the extractor), then thunk 2 to capture,
//                      and have your browser tool write what it returns to a FILE
//   verdict         -> suggest_pairs + compare_node_to_dom -> report, verification receipt, exit code
//
// WHY THE SEAM MOVED, AND WHAT IT IS WORTH. A developer who had never seen this project reached a
// real verdict over stdio by REFUSING the path this file used to document. Following it literally
// costs ~387,000 characters of agent context; theirs cost 87,000. Both crossings are avoidable and
// neither of them is a framefit tool call:
//
//   1. THE EXTRACTOR. `get_layout_spec {include_extractor:true}` returns the whole script inline on
//      stdio, because a stdio server has no public base URL for the browser to fetch it from. Pasted
//      through the agent, that is 55287 characters. `serve-extractor` puts those characters on a
//      loopback socket instead: they cross THIS process, which is not the agent's context, and what
//      the agent handles is a ~278-character thunk that fetches them.
//   2. THE SNAPSHOT. `verdict` reads the capture from a FILE. chrome-devtools' `evaluate_script`
//      takes a `filePath` and writes its result there, so the snapshot never has to come back as a
//      tool result and go out again as a tool argument.
//
// WHAT THIS DOES NOT CHANGE, said plainly because it is the honest limit: the MCP tool contract.
// `compare_node_to_dom` still takes `pairs[].dom` inline and `suggest_pairs` still takes
// `dom_snapshot` inline -- the snapshot crosses THIS client's memory on its way from the file to the
// tool call. A different client, or an agent driving the tools directly with no client in between,
// pays both costs in full. What is bought here is bought by the client standing in the middle, not
// by the server asking for less.
//
//   prepare -> the fallback: writes the extractor to a file for you to paste VERBATIM. Keep it for a
//   page whose CSP forbids `eval`, where thunk 1 cannot run at all.
//
// The cycle itself is stated once, in docs/tools/design-qa.md#the-cycle; this file is that cycle
// with the arguments filled in. Dependency-free on purpose: node 20+, nothing installed.
//
// WHAT IS GATED HERE, AND WHAT IS NOT. `mcp-server/tests/unit/first-verdict-client.test.ts` parses
// every argument object below with the tool's LIVE registered input schema, so a renamed or dropped
// argument is red before it ships; `design-qa-cycle-once.test.ts` holds the narrative above to the
// one place the cycle is defined. Neither of them runs this client: the end-to-end path needs a
// Figma token and a browser, so it is proven by hand and NOT by CI. The residual is therefore
// everything between two well-typed calls -- a thunk this file prints that the page will not run, a
// loopback port nothing can reach -- and it FAILS OPEN, silently, until somebody runs the recipe.
//
// NOT stdio-smoke.mjs's job and not its shape. mcp-server/scripts/stdio-smoke.mjs is a CI gate --
// two handshakes, a foreign cwd, exit-code forensics on a documented argv. The one thing both files
// genuinely share is newline-delimited JSON-RPC over a spawned child, which is the 30 lines of
// `rpc()` below; everything that made that file 39 KB is CI concern and stays there.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/examples/<this file> and <root>/mcp-server/dist/index.js.
const SERVER_ENTRY = path.resolve(__dirname, '..', 'mcp-server', 'dist', 'index.js');

const USAGE = `first-verdict -- from a Figma frame to a machine-checkable verdict, over stdio.

  node examples/first-verdict.mjs serve-extractor --file <url|key> --frame <node-id> --pair '<css>=<node-id>' [...]
  node examples/first-verdict.mjs verdict --file <url|key> --frame <node-id> --pair '<css>=<node-id>' [...] --snapshots <file>
  node examples/first-verdict.mjs prepare --file <url|key> --frame <node-id> --pair '<css>=<node-id>' [...]

  --file        Figma file URL or bare key.
  --frame       The frame under check. A Figma URL says node-id=12-340; the tools take
                12:340 and this client accepts either -- it rewrites the dash for you.
  --pair        Repeatable, 'cssSelector=nodeId'. The FIRST one must be the frame itself: its
                snapshot is what suggest_pairs reads and what carries the subtree.
  --snapshots   (verdict) The file your browser tool wrote the capture to. chrome-devtools resolves
                a RELATIVE filePath against its own workspace root and refuses to write outside it,
                so this is normally the absolute path it echoed back, not a path in this checkout.
  --out         (prepare) Directory for the two paste files. Default: the current directory.
  --max-depth   Both sides, 4..8. Default 4. Raising it changes the capture call -- both
                serve-extractor and prepare emit the matching arguments, so re-run whichever you use.
  --profile     compare_node_to_dom match_profile: token-aware (default) | strict | layout.
  --timeout     (serve-extractor) Seconds the loopback server waits with nothing asking for the
                extractor before it stops itself. Default 180.

The Figma token is read from FIGMA_TOKEN in this process's environment and passed to the server
this client spawns. Either export it, or point node at a file that holds it:

  FIGMA_TOKEN=figd_... node examples/first-verdict.mjs serve-extractor ...
  node --env-file=mcp-server/.env examples/first-verdict.mjs serve-extractor ...

Exit codes: 0 verification.complete is true, 2 a verdict that is not green (the gate working,
not a crash), 1 this client or the server could not produce a verdict at all.`;

// --- argv ----------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { pairs: [], maxDepth: 4, out: process.cwd(), profile: undefined, timeout: 180 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) die(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--file') out.file = value();
    else if (a === '--frame') out.frame = nodeId(value());
    else if (a === '--pair') {
      const raw = value();
      const eq = raw.lastIndexOf('=');
      if (eq <= 0) die(`--pair must be 'cssSelector=nodeId', got '${raw}'`);
      out.pairs.push({ selector: raw.slice(0, eq), nodeId: nodeId(raw.slice(eq + 1)) });
    } else if (a === '--snapshots') out.snapshots = value();
    else if (a === '--out') out.out = value();
    else if (a === '--max-depth') out.maxDepth = Number(value());
    else if (a === '--profile') out.profile = value();
    else if (a === '--timeout') out.timeout = Number(value());
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else die(`unknown argument '${a}'`);
  }
  if (!out.file) die('--file is required');
  if (!out.frame) die('--frame is required');
  if (out.pairs.length === 0) die('at least one --pair is required (the first one is the frame)');
  if (!(out.maxDepth >= 4 && out.maxDepth <= 8)) die('--max-depth must be 4..8');
  if (!(out.timeout > 0)) die('--timeout must be a positive number of seconds');
  return out;
}

// A Figma URL writes the node id with a dash (`node-id=12-340`); every tool takes a colon
// (`12:340`). The schemas accept both spellings, so this rewrite is a convenience and not a
// correction -- it exists so one value can be pasted straight out of the address bar.
export const nodeId = (v) => v.replace(/^(\d+)-(\d+)$/, '$1:$2');

function die(message) {
  console.error(`first-verdict: ${message}\n\n${USAGE}`);
  process.exit(1);
}

// --- one MCP session over stdio ------------------------------------------------------------------

/**
 * Spawn the built server, speak the handshake, run `fn`, then close.
 *
 * Framing is the SDK's stdio transport: newline-delimited JSON, one message per line. Diagnostics
 * go to the child's stderr and are forwarded to ours -- that is where the server narrates a slow
 * Figma call, and on this transport it is the only place a wait is visible while it happens.
 */
async function withServer(fn) {
  if (!existsSync(SERVER_ENTRY)) {
    die(`${SERVER_ENTRY} does not exist - run 'pnpm install && pnpm build' in mcp-server/ first`);
  }
  if (!process.env.FIGMA_TOKEN) {
    die('FIGMA_TOKEN is not set in this process environment. Export it, or run this client as\n'
      + '  node --env-file=mcp-server/.env examples/first-verdict.mjs ...');
  }
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, MCP_TRANSPORT: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Forwarded, not swallowed: `figma.request` lines here are what tell you a 90-second wait is a
  // slow Figma endpoint and not a hang. The response says so too (`degraded_stages`), afterwards.
  child.stderr.on('data', (c) => process.stderr.write(c));

  const pending = new Map();
  let buf = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${JSON.stringify(msg.error)}`));
      else waiter.resolve(msg.result);
    }
  });
  child.on('exit', (code) => {
    for (const { reject } of pending.values()) reject(new Error(`server exited (code=${code})`));
    pending.clear();
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  /** One tool call, unwrapped. A tool that reports isError has produced no result to work with. */
  const call = async (name, args) => {
    const started = Date.now();
    const res = await rpc('tools/call', { name, arguments: args });
    const text = (res.content ?? []).map((c) => c.text ?? '').join('');
    console.error(`[first-verdict] ${name}: ${Math.round((Date.now() - started) / 1000)}s, ${text.length} chars`);
    if (res.isError) throw new Error(`${name} failed: ${text.slice(0, 800)}`);
    return JSON.parse(text);
  };

  try {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'first-verdict', version: '1' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    return await fn(call);
  } finally {
    child.kill();
  }
}

// --- the arguments of every tool call this client makes ------------------------------------------

/**
 * The three tool-call argument objects, as functions of the parsed argv (and, for the two that need
 * it, the captured snapshots). Exported and pure so they can be checked against the LIVE registered
 * input schemas rather than against a copy of them.
 *
 * WHY THEY ARE NOT WRITTEN INLINE AT THE CALL SITES. Nothing here was gated. Measured against the
 * previous commit: renaming an argument in the `compare_node_to_dom` call left the whole suite green
 * -- this file is a `.mjs` under `examples/`, so no typecheck reaches it, and no test knew what it
 * sends. A client whose arguments have drifted off the schema fails at the reader's first run, which
 * is the one run this file exists to make succeed. Pulled out here they are values a test can build
 * and hand to `z.object(<registered shape>).strict().parse(...)`, so a renamed or dropped argument is
 * red before it ships (mcp-server/tests/unit/first-verdict-client.test.ts).
 */
export const TOOL_ARGS = {
  get_layout_spec: (args) => ({
    file: args.file,
    node_ids: [...new Set([args.frame, ...args.pairs.map((p) => p.nodeId)])],
    include_extractor: true,
    max_depth: args.maxDepth,
  }),
  suggest_pairs: (args, snapshots) => ({
    file: args.file,
    frame_node_id: args.frame,
    dom_snapshot: snapshots[0],
    max_depth: args.maxDepth,
  }),
  compare_node_to_dom: (args, snapshots) => ({
    file: args.file,
    frame_node_id: args.frame,
    pairs: args.pairs.map((p, i) => ({ node_id: p.nodeId, dom: snapshots[i], label: p.selector })),
    max_depth: args.maxDepth,
    ...(args.profile ? { match_profile: args.profile } : {}),
  }),
};

// --- the paste guard -----------------------------------------------------------------------------

/**
 * A 54 KB verbatim paste that arrives truncated or re-escaped measures the wrong page and says
 * nothing about it. So the paste echoes a fingerprint of what actually landed, computed the same
 * way on both sides: length, plus a rolling 32-bit hash over the source text of the function the
 * browser ended up holding. Cheap beats clever here -- length alone catches truncation, the hash
 * catches a mangled escape that kept the length.
 */
function fingerprint(source) {
  let h = 0;
  for (let i = 0; i < source.length; i += 1) h = (Math.imul(h, 31) + source.charCodeAt(i)) >>> 0;
  return `${source.length}:${h.toString(16)}`;
}

// --- the Figma side, shared by both browser-facing commands ---------------------------------------

/** One get_layout_spec call: the extractor, the frame width, and the fingerprint of the extractor. */
async function figmaSide(args) {
  const spec = await withServer((call) => call('get_layout_spec', TOOL_ARGS.get_layout_spec(args)));
  if (typeof spec.extractor_js !== 'string') {
    die('get_layout_spec returned no extractor_js - this client asked for one, so something is wrong');
  }
  return {
    extractor: spec.extractor_js,
    expected: fingerprint(spec.extractor_js),
    specCount: spec.specs?.length ?? 0,
    frameWidth: spec.specs?.find((s) => s.node_id === args.frame)?.spec?.rect?.w,
  };
}

/**
 * The extractor's own arguments, and the server's mapping of max_depth onto them:
 * 4 -> (3, 90), 6 -> (5, 180), 8 -> (7, 180). Written out rather than defaulted, so raising
 * --max-depth cannot leave the DOM side three levels shallower than the Figma side.
 */
const captureCall = (args, global) =>
  `async () => await window.${global}([${args.pairs.map((p) => JSON.stringify(p.selector)).join(', ')}], `
  + `undefined, ${args.maxDepth - 1}, ${args.maxDepth > 4 ? 180 : 90})`;

// The Figma URL is single-quoted because a dev-mode one ends `?node-id=12-340&m=dev`, and an
// unquoted `&` backgrounds the command at that character - the reader's paste would run
// `node ... --file https://...?node-id=12-340` in the background and then `m=dev`.
/** The `verdict` line that closes both recipes, with this run's own arguments already in it. */
const verdictLine = (args, snapshotsPath) =>
  `node examples/first-verdict.mjs verdict --file '${args.file}' --frame ${args.frame} `
  + args.pairs.map((p) => `--pair '${p.selector}=${p.nodeId}'`).join(' ')
  + ` --snapshots ${snapshotsPath}`;

function frameWidthNote(args, side) {
  console.log(`\nFigma side: ${side.specCount} spec(s), frame ${args.frame}`
    + (side.frameWidth ? ` is ${side.frameWidth}px wide` : ' has no rect (is that id really the frame?)'));
  if (side.frameWidth) {
    console.log(`  Size the browser viewport to ${side.frameWidth}px wide FIRST. A window that disagrees`);
    console.log('  with the frame does not produce red rows - it demotes every geometry row to unchecked.');
  }
}

// --- serve-extractor: the extractor reaches the page without crossing the agent -------------------

const EXTRACTOR_PATH = '/extractor.js';

/**
 * Thunk 1, as printed: fetch the extractor over loopback, park it, and hand back the same
 * `<length>:<hash>` fingerprint this client computed on its own copy.
 *
 * A FUNCTION, AND EXPORTED, SO ITS LENGTH CAN BE MEASURED. The "~N-character thunk" this file's
 * header and the README both quote is what a reader weighs the loopback handoff against, and it was
 * a hand-written number: it said ~350 while the string was 278, and mutating it to ~9999 left the
 * whole suite green. `extractor-size-lock.test.ts` calls this and checks both sites against what it
 * returns. Only the port varies - 277 characters at a 4-digit port, 278 at a 5-digit one, which is
 * every ephemeral port `listen(0)` hands out on Linux and macOS alike.
 */
export function fetchThunk(base) {
  return `async () => { const s = await (await fetch('${base}${EXTRACTOR_PATH}')).text(); (0,eval)(s);`
    + ' const t = String(window.__extract); let h = 0;'
    + " for (let i = 0; i < t.length; i += 1) h = (Math.imul(h, 31) + t.charCodeAt(i)) >>> 0; return t.length + ':' + h.toString(16); }";
}

/**
 * Hold the extractor on loopback and hand back the URL.
 *
 * The whole surface, deliberately: it binds 127.0.0.1 (never 0.0.0.0 - this is an eval-able script,
 * and a LAN-reachable one is a LAN-reachable code injection), takes an ephemeral port so two runs
 * cannot collide, answers ONE exact path with ONE string held in memory, and touches the filesystem
 * nowhere. There is no directory to serve and no path to traverse: anything that is not
 * `GET /extractor.js` is a 404, and `..` in a URL cannot name a file this process never opens.
 *
 * `Access-Control-Allow-Origin: *` is what makes the page's `fetch` legal - the page is on its own
 * origin (localhost:3000, :3673, whatever you render on) and this is not it. It is scoped by what is
 * served rather than by who may read it: the response body is a script this same reader is about to
 * paste into their own page by hand.
 *
 * STOPPING ITSELF, and what it can actually observe. The extractor is needed exactly ONCE per page:
 * after `window.__extract` is parked, the capture thunk re-runs from the page with no server
 * involved. So the server cannot see "the capture finished" and does not pretend to - it stops a
 * short grace period after it has SERVED the script (long enough to re-paste a thunk that raced the
 * page's own navigation), and otherwise after `--timeout` seconds of nobody asking at all.
 */
function serveExtractorScript(source, { idleMs, graceMs }) {
  const body = `window.__extract = ${source};`;
  const bytes = Buffer.byteLength(body);
  let timer;
  let stopped;
  const arm = (ms) => {
    clearTimeout(timer);
    // NOT unref()'d, and that is the whole lifetime of this command: the process must stay up while
    // the reader pastes, and the listening socket alone would keep it up forever. The timer is what
    // ends the run, so it has to hold the loop open until it fires.
    timer = setTimeout(() => server.close(), ms);
  };
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method !== 'GET' || pathname !== EXTRACTOR_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'content-length': bytes,
    }).end(body);
    console.error(`[first-verdict] extractor served (${bytes} bytes); `
      + `stopping in ${Math.round(graceMs / 1000)}s unless asked again`);
    arm(graceMs);
  });
  const done = new Promise((resolve) => { stopped = resolve; });
  server.on('close', () => { clearTimeout(timer); stopped(); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      arm(idleMs);
      resolve({ base: `http://127.0.0.1:${server.address().port}`, done });
    });
  });
}

async function serveExtractor(args) {
  const side = await figmaSide(args);
  const idleMs = args.timeout * 1000;
  const graceMs = Math.min(idleMs, 30_000);
  const { base, done } = await serveExtractorScript(side.extractor, { idleMs, graceMs });

  frameWidthNote(args, side);
  console.log('\n  1. Paste this into evaluate_script. It fetches the extractor over loopback, so the'
    + `\n     ${side.expected.split(':')[0]} characters of it never cross your context. It must return exactly ${side.expected} -`
    + '\n     that is the same length:hash of the same script, computed on both sides; anything else'
    + '\n     means what landed in the page is not what this client was handed, so do not measure it.\n');
  console.log(fetchThunk(base));
  console.log('\n  2. Then paste this one, and have your browser tool write the result to a FILE rather'
    + '\n     than return it: chrome-devtools evaluate_script takes a `filePath`. It resolves a relative'
    + '\n     path against ITS OWN workspace root and refuses to write outside it, so do not try to aim'
    + '\n     it at this checkout - give it a bare name and use the absolute path it echoes back.\n');
  console.log(captureCall(args, '__extract'));
  console.log('\n  3. Then, with the path it printed:\n');
  console.log(verdictLine(args, '<the absolute path evaluate_script echoed back>'));
  console.error(`\n[first-verdict] serving until asked, or ${args.timeout}s from now. Ctrl-C to stop early.`);
  await done;
  console.error('[first-verdict] extractor server stopped. Re-run serve-extractor if you need it again.');
}

// --- prepare: the fallback, for a page whose CSP will not eval --------------------------------

async function prepare(args) {
  const side = await figmaSide(args);

  mkdirSync(args.out, { recursive: true });
  const pasteFile = path.join(args.out, '1-paste-extractor.js');
  const captureFile = path.join(args.out, '2-capture.js');

  // evaluate_script CALLS what you send, so both files are thunks. The first parks the extractor on
  // the page and returns the fingerprint of what landed; the second is short enough to re-run freely.
  writeFileSync(pasteFile,
    '// Paste the WHOLE of this file into your browser tool\'s evaluate_script (chrome-devtools MCP:\n'
    + '// evaluate_script { function: <this file> }). It must return exactly:\n'
    + `//   ${side.expected}\n`
    + '// Any other value means the paste did not arrive intact - re-paste, do not measure.\n'
    + '() => {\n'
    + `  window.__extract = ${side.extractor};\n`
    + '  const s = String(window.__extract);\n'
    + '  let h = 0;\n'
    + '  for (let i = 0; i < s.length; i += 1) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;\n'
    + '  return s.length + \':\' + h.toString(16);\n'
    + '}\n');

  writeFileSync(captureFile,
    '// Run this in the SAME page, after 1-paste-extractor.js. Save what it returns to a file\n'
    + '// (a JSON array, one snapshot per selector, in this order) and pass it to `verdict --snapshots`.\n'
    + `${captureCall(args, '__extract')}\n`);

  frameWidthNote(args, side);
  console.log(`\n  1. Paste ${pasteFile} into the page. It must return ${side.expected}`);
  console.log(`     This is the FALLBACK path: that paste is ${side.expected.split(':')[0]} characters through your`);
  console.log('     context. `serve-extractor` sends a ~278-character thunk instead; use this one only');
  console.log('     when the page\'s CSP forbids the `eval` that thunk needs.');
  console.log(`  2. Paste ${captureFile}; write the array it returns to a file`);
  console.log(`  3. ${verdictLine(args, '<that file>')}`);
}

// --- verdict -------------------------------------------------------------------------------------

function readSnapshots(file, pairs) {
  if (!file) die('--snapshots is required for the verdict step');
  // Measured, and it is the snag the file handoff actually has: chrome-devtools resolves a relative
  // `filePath` against ITS OWN workspace root - not this checkout, not your shell's cwd - and refuses
  // outright to write anywhere outside its configured roots ("Access denied: ... is not within any of
  // the configured workspace roots"). So a reader who aims it at `framefit/snapshots.json` gets no
  // file, and a reader who passes the bare name they gave it gets ENOENT here. Neither needs guessing:
  // the tool echoes the absolute path it wrote, and that is the value this flag wants.
  if (!existsSync(file)) {
    die(`${file} does not exist. If your browser tool wrote it, use the ABSOLUTE path it echoed back - `
      + 'chrome-devtools resolves a relative filePath against its own workspace root, which is not this '
      + 'checkout, and refuses to write outside it.');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    die(`could not read ${file} as JSON: ${err.message}`);
  }
  // Some browser tools wrap an evaluate_script result. Accept the array, or one object holding it.
  const snapshots = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.snapshots) ? parsed.snapshots
      : Array.isArray(parsed?.result) ? parsed.result : undefined;
  if (!snapshots) die(`${file} does not hold a JSON array of snapshots`);
  if (snapshots.length !== pairs.length) {
    die(`${file} holds ${snapshots.length} snapshot(s) for ${pairs.length} --pair argument(s). `
      + 'The extractor returns one per selector, in selector order - capture them all in one call.');
  }
  snapshots.forEach((s, i) => {
    if (s?.status !== 'ok') {
      die(`snapshot ${i} for '${pairs[i].selector}' has status '${s?.status}' - the selector matched `
        + 'nothing, matched several elements, or the element is hidden. Fix the selector and re-capture.');
    }
    for (const key of ['rect', 'borders', 'paddings', 'scroll', 'children']) {
      if (s[key] === undefined) {
        die(`snapshot ${i} for '${pairs[i].selector}' is missing '${key}' - it was hand-edited or `
          + 'truncated in transit. Re-capture it whole; the diff refuses a short snapshot.');
      }
    }
  });
  return snapshots;
}

async function verdict(args) {
  const snapshots = readSnapshots(args.snapshots, args.pairs);

  const out = await withServer(async (call) => {
    // suggest_pairs, on the frame-root snapshot: it is how you find the node ids for the regions you
    // have not paired yet, and its unmatched lists are the same regions the receipt will hold you to.
    let proposals;
    try {
      proposals = await call('suggest_pairs', TOOL_ARGS.suggest_pairs(args, snapshots));
    } catch (err) {
      console.error(`[first-verdict] suggest_pairs did not run: ${err.message}`);
    }

    const compare = await call('compare_node_to_dom', TOOL_ARGS.compare_node_to_dom(args, snapshots));
    return { proposals, compare };
  });

  const { proposals, compare } = out;
  if (proposals) {
    const paired = new Set(args.pairs.map((p) => p.nodeId));
    const unpaired = (proposals.pairs ?? []).filter((p) => !paired.has(p.node_id));
    const box = (r) => (r ? `${Math.round(r.w)}x${Math.round(r.h)}` : '?');
    console.log(`\n--- suggest_pairs: ${(proposals.pairs ?? []).length} proposal(s), `
      + `${unpaired.length} of them not in your --pair list. dom_selector is pasteable as --pair as it`
      + '\n    stands; the two rects on the line are how you reject a wrong one without opening a browser.'
      + '\n    A score below ~46 means no text matched on either side - confirm those by hand:');
    for (const p of unpaired.slice(0, 10)) {
      console.log(`  ${p.node_id} ${box(p.figma_rect)}  <-  ${p.dom_selector ?? p.dom_path ?? '<no dom_path>'}`
        + ` <${p.dom_tag ?? '?'}> ${box(p.dom_rect)}`
        + `   ${p.confidence ?? '?'} score ${p.score ?? '?'} margin ${p.margin ?? '-'}`
        + `${p.ambiguous ? ' (ambiguous - check it)' : ''}`
        + `${p.children_skipped ? ' (children not inspected - confirm this pair first)' : ''}`);
    }
    for (const key of ['unmatched_figma', 'unmatched_dom']) {
      const n = (proposals[key] ?? []).length;
      if (n) console.log(`  ${key}: ${n} - unpaired regions come back as add_pair items in the receipt`);
    }
  }

  console.log('\n' + compare.report_markdown);

  const v = compare.verification ?? {};
  console.log(`\n--- verification: complete=${v.complete} scope=${v.scope} `
    + `pairs ${v.pairs?.checked ?? '?'} checked / ${v.pairs?.clean ?? '?'} clean`);
  for (const stage of compare.degraded_stages ?? []) {
    console.log(`  degraded: ${stage.stage} (${stage.reason}${stage.ms ? `, ${Math.round(stage.ms / 1000)}s spent`: ''})`);
  }
  for (const b of v.blocking ?? []) {
    console.log(`  blocking: ${b.action} - ${b.node_id ?? b.selector ?? ''} - ${b.detail ?? ''}`);
  }
  if (v.complete === true) {
    console.log('\ncomplete: true - every paired region was measured and nothing was left unchecked.');
    return 0;
  }
  console.log('\ncomplete: false - this is the gate working, not a failure of the run. The rows above'
    + '\nare measured; the blocking list is what is still unmeasured. Do those, re-capture the pairs'
    + '\nthey name, and run verdict again. Nothing here is green until this line says true.');
  return 2;
}

// --- main ----------------------------------------------------------------------------------------

/**
 * The commands, and the ONE place their names are written. A test that quantifies over the client's
 * tool calls needs to be able to import this file; a module that runs `main()` on import cannot be
 * imported by anything. Hence the direct-invocation guard below - `import` gets the exports and no
 * side effects, `node examples/first-verdict.mjs ...` gets the CLI, and neither knows about the other.
 *
 * `serve-extractor` resolves only when its loopback server stops (served + grace, or idle timeout),
 * so its `await` is the visible wait while you paste; the other two are ordinary.
 */
const COMMANDS = { 'serve-extractor': serveExtractor, prepare, verdict };

export async function main(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help') {
    console.log(USAGE);
    return 0;
  }
  const run = COMMANDS[command];
  if (!run) die(`unknown command '${command}' (expected: ${Object.keys(COMMANDS).join(', ')})`);
  return (await run(parseArgs(rest))) ?? 0;
}

// process.argv[1] is the resolved script path; comparing its file:// URL to this module's own is
// what tells "run as a program" from "imported by a test", on every platform, without string paths.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(`\nfirst-verdict: ${err.message}`);
    process.exit(1);
  }
}
