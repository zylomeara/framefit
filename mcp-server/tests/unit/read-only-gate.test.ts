import { describe, it, expect } from 'vitest';
import {
  assertWritable, PORTAL_READ_ONLY_REMEDIATION, SINGLE_TENANT_READ_ONLY_REMEDIATION,
  type ReadOnlyGate,
} from '../../src/adapters/driving/tools/shared-error-handler.js';

const textOfResult = (r: { content: { type: string }[] } | null): string => {
  const block = r!.content[0];
  if (block.type !== 'text') throw new Error(`refusal block is "${block.type}", not text`);
  return (block as { type: 'text'; text: string }).text;
};

describe('assertWritable', () => {
  it('returns a refusal ToolResult when read_only=true (gate present)', async () => {
    const gate: ReadOnlyGate = { isReadOnly: async () => true, remediation: PORTAL_READ_ONLY_REMEDIATION };
    const result = await assertWritable(gate);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].type).toBe('text');
    expect(textOfResult(result)).toMatch(/read-only/i);
  });

  it('the refusal carries the gate\'s own remediation, so it is right in BOTH modes', async () => {
    const mt: ReadOnlyGate = { isReadOnly: async () => true, remediation: PORTAL_READ_ONLY_REMEDIATION };
    const st: ReadOnlyGate = { isReadOnly: async () => true, remediation: SINGLE_TENANT_READ_ONLY_REMEDIATION };

    const mtText = textOfResult(await assertWritable(mt));
    expect(mtText).toMatch(/read-only/i);
    expect(mtText).toMatch(/portal/i);

    const stText = textOfResult(await assertWritable(st));
    expect(stText).toMatch(/read-only/i);
    expect(stText).toMatch(/FRAMEFIT_READ_ONLY/);
    expect(stText).not.toMatch(/portal/i);
  });

  it('returns null when read_only=false (gate present)', async () => {
    const gate: ReadOnlyGate = { isReadOnly: async () => false, remediation: SINGLE_TENANT_READ_ONLY_REMEDIATION };
    const result = await assertWritable(gate);
    expect(result).toBeNull();
  });

  // Reworded: the old parenthetical said "single-tenant/stdio - writes always allowed", which this
  // change makes false. Single-tenant sets a gate when FRAMEFIT_READ_ONLY=true.
  it('returns null when NO gate was configured (writes allowed)', async () => {
    expect(await assertWritable(undefined)).toBeNull();
  });
});
