import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from '../../src/infrastructure/server.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { ServerHandle } from '../../src/infrastructure/server.js';

const enabled =
  Boolean(process.env.FIGMA_TOKEN_E2E) && Boolean(process.env.E2E_FILE_URL);

describe.skipIf(!enabled)('e2e: get_comments against real Figma file', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await startServer(
      {
        PORT: 0,
        FIGMA_TOKEN: process.env.FIGMA_TOKEN_E2E,
        LOG_LEVEL: 'silent',
        NODE_ENV: 'test',
      } as unknown as Parameters<typeof startServer>[0],
      createLogger({ level: 'silent' }),
    );
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('returns markdown output with at least one thread', async () => {
    const base = `http://127.0.0.1:${handle.port}/mcp`;

    // 1. initialize (stateless mode: no mcp-session-id returned)
    const initRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0' },
        },
      }),
    });
    expect(initRes.ok).toBe(true);

    // 2. call get_comments (no session header — stateless mode)
    const callRes = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'get_comments',
          arguments: {
            file: process.env.E2E_FILE_URL,
            include_resolved: true,
            as_markdown: true,
          },
        },
      }),
    });
    const body = await callRes.json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).not.toBe(true);
    const text = body.result.content[0].text;
    expect(typeof text).toBe('string');
    expect(text).toMatch(/## Thread/);
  }, 60_000);

  it('summarize_comments returns aggregates with consistent anchor sum', async () => {
    const base = `http://127.0.0.1:${handle.port}/mcp`;

    // 1. initialize
    const initRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0' },
        },
      }),
    });
    expect(initRes.ok).toBe(true);

    // 2. call summarize_comments
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 12, method: 'tools/call',
        params: { name: 'summarize_comments', arguments: { file: process.env.E2E_FILE_URL } },
      }),
    });
    const body = await res.json();
    expect(body.result.isError).not.toBe(true);
    const summary = JSON.parse(body.result.content[0].text);
    expect(summary.total).toBeGreaterThan(0);
    const sum =
      (summary.by_anchor.canvas_point ?? 0) +
      (summary.by_anchor.canvas_region ?? 0) +
      (summary.by_anchor.node ?? 0) +
      (summary.by_anchor.node_region ?? 0);
    expect(sum).toBe(summary.total);
  }, 60_000);

  it('find_threads returns scored matches', async () => {
    const base = `http://127.0.0.1:${handle.port}/mcp`;

    // 1. initialize
    const initRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0' },
        },
      }),
    });
    expect(initRes.ok).toBe(true);

    // 2. call find_threads
    const query = process.env.E2E_QUERY ?? 'а';
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 13, method: 'tools/call',
        params: { name: 'find_threads', arguments: { file: process.env.E2E_FILE_URL, query } },
      }),
    });
    const body = await res.json();
    expect(body.result.isError).not.toBe(true);
    const out = JSON.parse(body.result.content[0].text);
    expect(Array.isArray(out.matches)).toBe(true);
  }, 60_000);
});
