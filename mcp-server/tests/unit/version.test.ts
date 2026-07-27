import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION, SERVER_INFO } from '../../src/infrastructure/version.js';

describe('version leaf', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
    expect(SERVER_INFO).toEqual({ name: 'framefit', version: pkg.version });
  });

  // Without this, skipping the server.ts edit leaves a second literal and every test stays green —
  // the refactor's entire purpose would be unverified.
  it('is the only version literal: server.ts holds none', () => {
    const src = readFileSync(new URL('../../src/infrastructure/server.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/version:\s*['"][0-9]/);
  });
});
