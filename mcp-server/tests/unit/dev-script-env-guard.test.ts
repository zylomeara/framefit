// `pnpm dev` on the Node 22 line as measured in early August: --env-file-if-exists put the
// MISSING path into the watch set and fs.watch threw ENOENT (nodes 20 and 24 tolerated the pair).
// Re-measured later on 22.23: no longer reproduces — the upstream regression appears fixed in
// newer 22.x patches. The guard stays regardless: it makes the run order-independent on every
// Node instead of betting on patch levels, and the documented cp-then-dev sequence stays optional
// for a first "does it even start?" run.
// These tests execute the guard AS SHIPPED (extracted from package.json, not a copy), so a rewrite
// of the script that drops or reorders the guard goes red here.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
const dev: string = pkg.scripts.dev;

// The guard must come FIRST (before the watching node), joined by && so a guard failure stops the run.
const [guard, ...rest] = dev.split(' && ');

const runGuard = (cwd: string): void => {
  // node -e "<js>": execute the shipped guard body with the same binary the script names.
  const m = /^node -e "(.+)"$/.exec(guard);
  if (!m) throw new Error(`the dev script does not start with a node -e guard: ${dev}`);
  execFileSync(process.execPath, ['-e', m[1]], { cwd });
};

describe('pnpm dev survives a missing .env on every supported Node', () => {
  it('linkage: the guard precedes the watcher and the watcher half still carries the flag pair', () => {
    expect(guard.startsWith('node -e ')).toBe(true);
    expect(rest.join(' && ')).toContain('--env-file-if-exists=.env');
    expect(rest.join(' && ')).toContain('--watch');
  });

  it('a missing .env is created empty, so the watch set never holds a non-existent path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'framefit-devenv-'));
    try {
      expect(existsSync(join(dir, '.env'))).toBe(false);
      runGuard(dir);
      expect(existsSync(join(dir, '.env'))).toBe(true);
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an existing .env is left byte-for-byte alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'framefit-devenv-'));
    try {
      writeFileSync(join(dir, '.env'), 'FIGMA_TOKEN=test-value\n');
      runGuard(dir);
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('FIGMA_TOKEN=test-value\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
