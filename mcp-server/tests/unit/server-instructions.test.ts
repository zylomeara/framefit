// The MCP `initialize` instructions are the only design-QA guidance that reaches agents on
// hosts without a skills mechanism. Lock the contract: the done-gate must be stated, the tool
// cycle named, and the referenced skill path must actually exist in the repo — a moved or
// renamed skill file must go RED here, not silently 404 for every adopter.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SERVER_INSTRUCTIONS } from '../../src/infrastructure/server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('SERVER_INSTRUCTIONS (initialize contract for skill-less hosts)', () => {
  it('states the verification done-gate', () => {
    expect(SERVER_INSTRUCTIONS).toContain('verification.complete');
    expect(SERVER_INSTRUCTIONS).toContain('blocking');
    expect(SERVER_INSTRUCTIONS).toContain('never claim');
  });

  it('states the inherent-only escape hatch (batch-2 item 4: without it, the skill-less channel reads the gate as an unconditional conjunction)', () => {
    expect(SERVER_INSTRUCTIONS).toContain('EMPTY');
    expect(SERVER_INSTRUCTIONS).toContain('you may proceed');
    expect(SERVER_INSTRUCTIONS).toContain('verify those by eye');
  });

  it('the hatch is conditioned on zero fail rows, not blocking emptiness alone (wave: a plain FAIL row mints no blocking item)', () => {
    expect(SERVER_INSTRUCTIONS).toContain('ZERO ❌ rows');
    expect(SERVER_INSTRUCTIONS).toContain('FAILing rows');
    expect(SERVER_INSTRUCTIONS).toContain('red only');
  });

  it('distinguishes failing omissions from clean omissions and gives a duplicate-safe replay address', () => {
    expect(SERVER_INSTRUCTIONS).toContain('omitted_pair_indices');
    expect(SERVER_INSTRUCTIONS).toContain('originalArgs.pairs[i]');
    expect(SERVER_INSTRUCTIONS).toContain('FAIL');
    expect(SERVER_INSTRUCTIONS).toContain('Clean');
    expect(SERVER_INSTRUCTIONS).toContain('included in the aggregate verdict');
    expect(SERVER_INSTRUCTIONS).not.toContain('already measured');
  });

  it('separates the always-incomplete no-detail fallback from ordinary pair omission', () => {
    expect(SERVER_INSTRUCTIONS).toContain('code:"response_budget"');
    expect(SERVER_INSTRUCTIONS).toContain('pairs:[]');
    expect(SERVER_INSTRUCTIONS).toContain('always incomplete');
    expect(SERVER_INSTRUCTIONS).toContain('smaller DOM roots');
  });

  it('does not claim that every submitted pair is individually too large', () => {
    for (const body of [
      SERVER_INSTRUCTIONS,
      ...[
        'docs/tools/design-qa.md',
        'docs/design-qa-tutorial.md',
        'docs/agents/design-qa-skill.md',
        'docs/tools/README.md',
      ].map((path) => readFileSync(join(repoRoot, path), 'utf8')),
    ]) {
      expect(body).toContain('a later pair may still fit unchanged');
      expect(body).not.toContain('no complete pair detail fit');
    }
  });

  it('public omission guidance does not call every omitted pair measured', () => {
    for (const path of [
      'docs/tools/design-qa.md',
      'docs/design-qa-tutorial.md',
      'docs/agents/design-qa-skill.md',
    ]) {
      const body = readFileSync(join(repoRoot, path), 'utf8');
      expect(body).toMatch(/included in the\s+aggregate verdict/);
      expect(body).not.toMatch(/same\s+measurement rule holds for\s+whole pairs dropped/);
      expect(body).not.toMatch(/omitted pairs (?:were|are) already measured/);
    }
  });

  it('names the design-QA tool cycle', () => {
    expect(SERVER_INSTRUCTIONS).toContain('get_layout_spec');
    expect(SERVER_INSTRUCTIONS).toContain('suggest_pairs');
    expect(SERVER_INSTRUCTIONS).toContain('compare_node_to_dom');
  });

  it('points at a skill file that exists in the repo', () => {
    const m = SERVER_INSTRUCTIONS.match(/docs\/agents\/[\w-]+\.md/);
    expect(m).not.toBeNull();
    expect(existsSync(join(repoRoot, m![0]))).toBe(true);
  });
});
