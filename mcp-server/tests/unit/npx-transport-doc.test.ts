// DEFAULT_MCP_TRANSPORT is 'http' and stays 'http' (the compose full profile relies on it and
// never sets MCP_TRANSPORT). The npx promise is therefore closed in prose: every documented
// `npx -y framefit` invocation must carry MCP_TRANSPORT=stdio on the same command, or the
// documented one-liner boots an HTTP server the host will never speak to.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MCP_TRANSPORT } from '../../src/infrastructure/config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FILES = ['README.md', 'examples/mcp-config/README.md'];

describe('the npx one-liner names the transport it needs', () => {
  it('the premise still holds: the transport default is not stdio', () => {
    // If this ever flips, the prose below is over-stating a requirement rather than closing a gap,
    // and the sentences that call the flag "not optional" have to be revisited with it.
    expect(DEFAULT_MCP_TRANSPORT).not.toBe('stdio');
  });

  it('every documented `npx -y framefit` line also sets MCP_TRANSPORT=stdio', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const f of FILES) {
      readFileSync(join(repoRoot, f), 'utf8').split('\n').forEach((line, i) => {
        if (!line.includes('npx -y framefit')) return;
        seen++;
        if (!line.includes('MCP_TRANSPORT=stdio')) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(seen, 'no `npx -y framefit` line found - did the docs move?').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
