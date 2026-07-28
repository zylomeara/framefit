#!/usr/bin/env node
// Cross-platform stdio-transport smoke test (pubready A-T3).
//
// Spawns the built server (dist/index.js) with MCP_TRANSPORT=stdio and drives
// the minimum MCP handshake over stdin/stdout: initialize -> initialized ->
// tools/list. Proves the packaged bin boots and answers as an MCP server
// WITHOUT a Figma token and WITHOUT multi-tenant env (single-tenant stdio
// mode never needs either — see src/infrastructure/config.ts /
// src/infrastructure/server.ts:startStdioServer).
//
// Deliberately avoids: shell:true (Windows quoting/PATH differences), any
// bash-isms, and the `timeout(1)` coreutil (not present on macOS runners).
// Framing matches the SDK's stdio transport: newline-delimited JSON, one
// message per line (see @modelcontextprotocol/sdk shared/stdio.js).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, '..', 'dist', 'index.js');
const pkgVersion = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
).version;
const TIMEOUT_MS = 20_000;
const MIN_TOOLS = 26; // current count is exactly 26; assert a floor, not the exact number

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
// to have set.
const childEnv = { ...process.env };
delete childEnv.FIGMA_TOKEN;
delete childEnv.MULTI_TENANT;
childEnv.MCP_TRANSPORT = 'stdio';

const child = spawn(process.execPath, [serverEntry], {
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: false,
});

let stdoutBuf = '';
let stderrBuf = '';
let settled = false;
const pending = new Map(); // id -> { resolve, reject }
let nextId = 1;

const timer = setTimeout(() => {
  finish(false, `timed out after ${TIMEOUT_MS}ms waiting on the handshake`);
}, TIMEOUT_MS);

function finish(ok, message) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  for (const { reject } of pending.values()) reject(new Error('smoke script exiting'));
  pending.clear();
  if (!ok) {
    fail(message);
    if (stderrBuf.trim()) {
      console.error('[stdio-smoke] server stderr:\n' + stderrBuf.trim());
    }
  } else {
    log(message);
  }
  try {
    child.kill();
  } catch {
    // already dead
  }
  process.exit(ok ? 0 : 1);
}

child.on('error', (err) => {
  finish(false, `failed to spawn server process: ${err.message}`);
});

child.on('exit', (code, signal) => {
  if (!settled) {
    finish(false, `server exited early (code=${code}, signal=${signal}) before the handshake completed`);
  }
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
    } catch (err) {
      finish(false, `non-JSON line on stdout (expected only MCP protocol frames): ${line.slice(0, 200)}`);
      return;
    }
    if (msg && typeof msg.id !== 'undefined' && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`JSON-RPC error for id ${msg.id}: ${JSON.stringify(msg.error)}`));
      } else {
        resolve(msg.result);
      }
    }
  }
});

function send(payload) {
  child.stdin.write(JSON.stringify(payload) + '\n');
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
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
    // `statusChild`, not `child`: the module-level `child` is the server this script is driving, and
    // shadowing it here is one rename away from finish() killing the wrong process.
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

async function main() {
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
  const walk = (value, path) => {
    if (typeof value === 'string') {
      const chars = [...new Set([...value].filter((c) => c.codePointAt(0) > 0x7f))];
      if (chars.length) {
        const points = chars
          .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
          .join(' ');
        nonAscii.push(`${path}: ${points}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        walk(k, `${path}.${k} <property name>`);
        walk(v, `${path}.${k}`);
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

  finish(true, `handshake ok - serverInfo.name="framefit", ${tools.length} tools (>= ${MIN_TOOLS}), every delivered string ASCII, status --json version="${statusReport.version}", bad LOG_LEVEL reported and survived`);
}

main().catch((err) => {
  finish(false, err.message);
});
