// tests/unit/status-fixtures.ts   (not *.test.ts, so vitest does not collect it as a suite)
import type { StatusCtx } from '../../src/infrastructure/status.js';

export const baseCtx = (over: Partial<StatusCtx> = {}): StatusCtx => ({
  env: {}, now: () => 1_700_000_000_000, multiTenant: false, transport: undefined, probe: false,
  signBridgeToken: async () => 'tok',
  verifyBridgeToken: async () => 'status-selftest',
  validatePat: async () => ({ ok: true, handle: 'h' }),
  hostname: 'box', pid: 7, secrets: new Set<string>(), ...over,
});
