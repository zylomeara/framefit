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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, '..', 'dist', 'index.js');
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
  fail(`${serverEntry} not found — run "pnpm build" first`);
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

  notify('notifications/initialized', {});

  const listResult = await request('tools/list', {});
  const tools = (listResult && listResult.tools) || [];
  if (!Array.isArray(tools) || tools.length < MIN_TOOLS) {
    throw new Error(`tools/list returned ${tools.length} tools, expected >= ${MIN_TOOLS}`);
  }

  finish(true, `handshake ok — serverInfo.name="framefit", ${tools.length} tools (>= ${MIN_TOOLS})`);
}

main().catch((err) => {
  finish(false, err.message);
});
