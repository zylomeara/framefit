#!/usr/bin/env node
// Your first verdict: a runnable stdio client that walks the design-QA cycle to a receipt.
//
//   node examples/first-verdict.mjs prepare --file <url|key> --frame <node-id> --pair '<css>=<node-id>' ...
//   node examples/first-verdict.mjs verdict --file <url|key> --frame <node-id> --pair '<css>=<node-id>' ... --snapshots <file.json>
//
// The seam is deliberate and it is where a browser lives. Node cannot drive your page, so this
// client does the two halves it CAN do -- everything on the Figma side, and everything after the
// capture -- and hands you two files to paste into whatever browser automation you already have
// (chrome-devtools MCP, Playwright, the devtools console). It never pretends to drive Chrome.
//
//   prepare  -> get_layout_spec           -> writes 1-paste-extractor.js and 2-capture.js
//   [you]    -> paste both into the page  -> save what the second one returns as snapshots.json
//   verdict  -> suggest_pairs + compare_node_to_dom -> report, verification receipt, exit code
//
// The cycle itself is stated once, in docs/tools/design-qa.md#the-cycle; this file is that cycle
// with the arguments filled in. Dependency-free on purpose: node 20+, nothing installed.
//
// NOT stdio-smoke.mjs's job and not its shape. mcp-server/scripts/stdio-smoke.mjs is a CI gate --
// two handshakes, a foreign cwd, exit-code forensics on a documented argv. The one thing both files
// genuinely share is newline-delimited JSON-RPC over a spawned child, which is the 30 lines of
// `rpc()` below; everything that made that file 39 KB is CI concern and stays there.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/examples/<this file> and <root>/mcp-server/dist/index.js.
const SERVER_ENTRY = path.resolve(__dirname, '..', 'mcp-server', 'dist', 'index.js');

const USAGE = `first-verdict -- from a Figma frame to a machine-checkable verdict, over stdio.

  node examples/first-verdict.mjs prepare --file <url|key> --frame <node-id> --pair '<css>=<node-id>' [...]
  node examples/first-verdict.mjs verdict --file <url|key> --frame <node-id> --pair '<css>=<node-id>' [...] --snapshots <file>

  --file        Figma file URL or bare key.
  --frame       The frame under check. A Figma URL says node-id=33153-93531; the tools take
                33153:93531 and this client accepts either -- it rewrites the dash for you.
  --pair        Repeatable, 'cssSelector=nodeId'. The FIRST one must be the frame itself: its
                snapshot is what suggest_pairs reads and what carries the subtree.
  --snapshots   (verdict) The JSON array 2-capture.js returned, one snapshot per --pair, in order.
  --out         (prepare) Directory for the two paste files. Default: the current directory.
  --max-depth   Both sides, 4..8. Default 4. Raising it changes the capture call -- prepare writes
                the matching arguments into 2-capture.js, so re-run prepare if you change it.
  --profile     compare_node_to_dom match_profile: token-aware (default) | strict | layout.

The Figma token is read from FIGMA_TOKEN in this process's environment and passed to the server
this client spawns. Either export it, or point node at a file that holds it:

  FIGMA_TOKEN=figd_... node examples/first-verdict.mjs prepare ...
  node --env-file=mcp-server/.env examples/first-verdict.mjs prepare ...

Exit codes: 0 verification.complete is true, 2 a verdict that is not green (the gate working,
not a crash), 1 this client or the server could not produce a verdict at all.`;

// --- argv ----------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { pairs: [], maxDepth: 4, out: process.cwd(), profile: undefined };
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
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else die(`unknown argument '${a}'`);
  }
  if (!out.file) die('--file is required');
  if (!out.frame) die('--frame is required');
  if (out.pairs.length === 0) die('at least one --pair is required (the first one is the frame)');
  if (!(out.maxDepth >= 4 && out.maxDepth <= 8)) die('--max-depth must be 4..8');
  return out;
}

// A Figma URL writes the node id with a dash (`node-id=33153-93531`); every tool takes a colon
// (`33153:93531`). The schemas accept both spellings, so this rewrite is a convenience and not a
// correction -- it exists so one value can be pasted straight out of the address bar.
const nodeId = (v) => v.replace(/^(\d+)-(\d+)$/, '$1:$2');

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

// --- prepare -------------------------------------------------------------------------------------

async function prepare(args) {
  const spec = await withServer((call) => call('get_layout_spec', {
    file: args.file,
    node_ids: [...new Set([args.frame, ...args.pairs.map((p) => p.nodeId)])],
    include_extractor: true,
    max_depth: args.maxDepth,
  }));

  if (typeof spec.extractor_js !== 'string') {
    die('get_layout_spec returned no extractor_js - this client asked for one, so something is wrong');
  }
  const frameSpec = spec.specs?.find((s) => s.node_id === args.frame);
  const frameWidth = frameSpec?.spec?.rect?.w;

  mkdirSync(args.out, { recursive: true });
  const pasteFile = path.join(args.out, '1-paste-extractor.js');
  const captureFile = path.join(args.out, '2-capture.js');
  const expected = fingerprint(spec.extractor_js);

  // evaluate_script CALLS what you send, so both files are thunks. The first parks the extractor on
  // the page and returns the fingerprint of what landed; the second is short enough to re-run freely.
  writeFileSync(pasteFile,
    '// Paste the WHOLE of this file into your browser tool\'s evaluate_script (chrome-devtools MCP:\n'
    + '// evaluate_script { function: <this file> }). It must return exactly:\n'
    + `//   ${expected}\n`
    + '// Any other value means the paste did not arrive intact - re-paste, do not measure.\n'
    + '() => {\n'
    + `  window.__extract = ${spec.extractor_js};\n`
    + '  const s = String(window.__extract);\n'
    + '  let h = 0;\n'
    + '  for (let i = 0; i < s.length; i += 1) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;\n'
    + '  return s.length + \':\' + h.toString(16);\n'
    + '}\n');

  // depthLeft/budget are the extractor's own arguments and the server's mapping of max_depth onto
  // them: 4 -> (3, 90), 6 -> (5, 180), 8 -> (7, 180). Written out rather than defaulted, so raising
  // --max-depth cannot leave the DOM side three levels shallower than the Figma side.
  const depthLeft = args.maxDepth - 1;
  const budget = args.maxDepth > 4 ? 180 : 90;
  const selectors = args.pairs.map((p) => JSON.stringify(p.selector)).join(', ');
  writeFileSync(captureFile,
    '// Run this in the SAME page, after 1-paste-extractor.js. Save what it returns as snapshots.json\n'
    + '// (a JSON array, one snapshot per selector, in this order) and pass it to `verdict --snapshots`.\n'
    + `async () => await window.__extract([${selectors}], undefined, ${depthLeft}, ${budget})\n`);

  console.log(`\nFigma side: ${spec.specs?.length ?? 0} spec(s), frame ${args.frame}`
    + (frameWidth ? ` is ${frameWidth}px wide` : ' has no rect (is that id really the frame?)'));
  if (frameWidth) {
    console.log(`  1. Size the browser viewport to ${frameWidth}px wide. A window that disagrees with the`);
    console.log('     frame does not produce red rows - it demotes every geometry row to unchecked.');
  }
  console.log(`  2. Paste ${pasteFile} into the page. It must return ${expected}`);
  console.log(`  3. Paste ${captureFile}; save the array it returns as snapshots.json`);
  console.log(`  4. node examples/first-verdict.mjs verdict --file ... --frame ${args.frame} `
    + args.pairs.map((p) => `--pair '${p.selector}=${p.nodeId}'`).join(' ') + ' --snapshots snapshots.json');
}

// --- verdict -------------------------------------------------------------------------------------

function readSnapshots(file, pairs) {
  if (!file) die('--snapshots is required for the verdict step');
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
      proposals = await call('suggest_pairs', {
        file: args.file,
        frame_node_id: args.frame,
        dom_snapshot: snapshots[0],
        max_depth: args.maxDepth,
      });
    } catch (err) {
      console.error(`[first-verdict] suggest_pairs did not run: ${err.message}`);
    }

    const compare = await call('compare_node_to_dom', {
      file: args.file,
      frame_node_id: args.frame,
      pairs: args.pairs.map((p, i) => ({ node_id: p.nodeId, dom: snapshots[i], label: p.selector })),
      max_depth: args.maxDepth,
      ...(args.profile ? { match_profile: args.profile } : {}),
    });
    return { proposals, compare };
  });

  const { proposals, compare } = out;
  if (proposals) {
    const paired = new Set(args.pairs.map((p) => p.nodeId));
    const unpaired = (proposals.pairs ?? []).filter((p) => !paired.has(p.node_id));
    console.log(`\n--- suggest_pairs: ${(proposals.pairs ?? []).length} proposal(s), `
      + `${unpaired.length} of them not in your --pair list. dom_path is relative to the frame-root`
      + '\n    snapshot, so turn it into a selector of your own before passing it as --pair:');
    for (const p of unpaired.slice(0, 10)) {
      console.log(`  ${p.node_id}  <-  ${p.dom_path ?? '<no dom_path>'}`
        + `   confidence ${p.confidence ?? '?'}${p.ambiguous ? ' (ambiguous - check it)' : ''}`);
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

const [command, ...rest] = process.argv.slice(2);
if (command === undefined || command === '-h' || command === '--help') {
  console.log(USAGE);
  process.exit(0);
}
if (command !== 'prepare' && command !== 'verdict') die(`unknown command '${command}'`);

const args = parseArgs(rest);
try {
  process.exit(command === 'prepare' ? ((await prepare(args)) ?? 0) : await verdict(args));
} catch (err) {
  console.error(`\nfirst-verdict: ${err.message}`);
  process.exit(1);
}
