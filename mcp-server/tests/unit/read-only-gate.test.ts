import { describe, it, expect } from 'vitest';
import { assertWritable, type ReadOnlyGate } from '../../src/adapters/driving/tools/shared-error-handler.js';

describe('assertWritable', () => {
  it('returns a refusal ToolResult when read_only=true (gate present)', async () => {
    const gate: ReadOnlyGate = { isReadOnly: async () => true };
    const result = await assertWritable(gate);
    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content[0].type).toBe('text');
    const text = (result!.content[0] as { type: 'text'; text: string }).text;
    expect(text).toMatch(/read-only/i);
    expect(text).toMatch(/portal/i);
  });

  it('returns null when read_only=false (gate present)', async () => {
    const gate: ReadOnlyGate = { isReadOnly: async () => false };
    const result = await assertWritable(gate);
    expect(result).toBeNull();
  });

  it('returns null when gate is undefined (single-tenant/stdio — writes always allowed)', async () => {
    const result = await assertWritable(undefined);
    expect(result).toBeNull();
  });
});
