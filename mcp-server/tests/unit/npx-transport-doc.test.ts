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

  // Scoped to the COMMAND, not the line. A registration written across several lines with trailing
  // backslashes sets the flag on one line and names npx on another, and a line-scoped check calls
  // that an offence -- it was doing exactly that when the README moved to the multi-line form.
  // Subcommands are exempt on purpose: `npx -y framefit status` runs the CLI, prints and exits. It
  // never opens a transport, so demanding the flag there would document a flag that does nothing.
  const SUBCOMMANDS = ['status', 'users', 'teams', 'sync', 'graph'];

  /** Logical commands: lines joined across trailing-backslash continuations. */
  const commandsIn = (text: string): { text: string; line: number }[] => {
    const out: { text: string; line: number }[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let joined = lines[i];
      const start = i;
      while (/\\\s*$/.test(joined) && i + 1 < lines.length) joined = joined.replace(/\\\s*$/, ' ') + lines[++i];
      out.push({ text: joined, line: start + 1 });
    }
    return out;
  };

  it('every documented `npx -y framefit` command that STARTS THE SERVER also sets MCP_TRANSPORT=stdio', () => {
    const offenders: string[] = [];
    let servers = 0;
    let subcommands = 0;
    for (const f of FILES) {
      for (const c of commandsIn(readFileSync(join(repoRoot, f), 'utf8'))) {
        const m = /npx -y framefit(?:\s+(\S+))?/.exec(c.text);
        if (!m) continue;
        if (m[1] !== undefined && SUBCOMMANDS.includes(m[1])) { subcommands++; continue; }
        servers++;
        if (!c.text.includes('MCP_TRANSPORT=stdio')) offenders.push(`${f}:${c.line}: ${c.text.trim()}`);
      }
    }
    // Both co-locks matter. Without the first, moving every npx line out of the docs turns this row
    // green while proving nothing. Without the second, widening SUBCOMMANDS until it swallows the
    // server form does the same, quietly.
    expect(servers, 'no server-form `npx -y framefit` command found - did the docs move?').toBeGreaterThan(0);
    expect(subcommands, 'no subcommand form found, so the exemption above is covering nothing and '
      + 'should be deleted rather than carried').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
