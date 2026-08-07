// `pnpm dev` on Node 22 with no .env: --env-file-if-exists puts the MISSING path into the watch
// set and fs.watch throws ENOENT (measured per-runtime: node 20 and 24 tolerate the pair, node 22
// exits non-zero). The documented sequence copies .env first, so no page lies — but the natural
// "does it even start?" run before that step greets a contributor with a stack trace on exactly
// one Node major. The dev script therefore ensures the file exists BEFORE the watching node starts.
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
