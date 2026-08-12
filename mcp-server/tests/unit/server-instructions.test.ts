// The MCP `initialize` instructions are the only design-QA guidance that reaches agents on
// hosts without a skills mechanism. Lock the contract: the done-gate must be stated, the tool
// cycle named, and the referenced skill path must actually exist in the repo — a moved or
// renamed skill file must go RED here, not silently 404 for every adopter.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
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
    expect(SERVER_INSTRUCTIONS).toContain('omitted_pair_ids');
    expect(SERVER_INSTRUCTIONS).toContain('discrepancies to fix first');
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
