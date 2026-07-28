// status must report the bind it would boot with, derived the SAME way config.ts derives it -
// a hand-copied '127.0.0.1' over here would be free to drift from the schema default over there,
// which is exactly the failure effectiveTransport() exists to prevent for the transport.
import { describe, it, expect } from 'vitest';
import { effectiveBindHost, collectStatus, configCheck, renderText } from '../../src/infrastructure/status.js';
import { DEFAULT_BIND_HOST } from '../../src/infrastructure/config.js';
// The shape the brief calls `makeCtx`: the one StatusCtx factory this suite already owns
// (status.test.ts imports the same symbol). A second, locally-declared stub context would be a
// second shape free to drift from the real StatusCtx interface.
import { baseCtx } from './status-fixtures.js';

describe('effectiveBindHost', () => {
  it('unset -> the schema default, not a copy of it', () => {
    expect(effectiveBindHost({})).toBe(DEFAULT_BIND_HOST);
  });
  it('empty assignment is NOT a wide bind (mirrors the config preprocess)', () => {
    expect(effectiveBindHost({ BIND_HOST: '' })).toBe(DEFAULT_BIND_HOST);
  });
  it('set -> the set value', () => {
    expect(effectiveBindHost({ BIND_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});

describe('StatusReport.mode carries the bind', () => {
  it('reports bind_host and its source so a green verdict names the interface it is green about', async () => {
    const report = await collectStatus(baseCtx({ env: {} }), [configCheck]);
    expect(report.mode.bind_host).toBe('127.0.0.1');
    expect(report.mode.bind_host_source).toBe('default');

    const wide = await collectStatus(baseCtx({ env: { BIND_HOST: '0.0.0.0' } }), [configCheck]);
    expect(wide.mode.bind_host).toBe('0.0.0.0');
    expect(wide.mode.bind_host_source).toBe('env');
  });

  it('an empty assignment is reported as the default it actually becomes, not as ""', async () => {
    // `BIND_HOST=` in a copied .env reaches the process as '' and the schema preprocess turns it
    // back into loopback. A report that echoed the raw '' would say the box binds nothing, and a
    // `bind_host_source: 'env'` on it would credit an assignment that had no effect.
    const report = await collectStatus(baseCtx({ env: { BIND_HOST: '' } }), [configCheck]);
    expect(report.mode.bind_host).toBe(DEFAULT_BIND_HOST);
    expect(report.mode.bind_host_source).toBe('default');
  });
});

describe('the human header names the interface too', () => {
  // The JSON contract is what a script reads; the header line is what gets pasted into a ticket.
  // A bind reported only in --json leaves the human surface unable to disagree with the boot.
  it('prints the bind, and marks the default as a default', async () => {
    const text = renderText(await collectStatus(baseCtx({ env: {} }), [configCheck]));
    expect(text).toMatch(/^framefit \S+ {2}single-tenant {2}.*bind: 127\.0\.0\.1 \(default\)/m);
  });

  it('an explicit bind is printed WITHOUT the "(default)" marker', async () => {
    const text = renderText(await collectStatus(baseCtx({ env: { BIND_HOST: '0.0.0.0' } }), [configCheck]));
    expect(text).toMatch(/bind: 0\.0\.0\.0(?!.*\(default\))/);
  });
});

describe('configCheck names a bad bind instead of letting it become a restart loop', () => {
  it('a hostname in BIND_HOST fails config with a reason that names MCP_HOST', async () => {
    // NOT a gate for a new branch in configCheck: step 2 (loadConfig) already rejects this value
    // and its zod message already names both variables, so this is reachable only through
    // loadConfig. It is kept as the lock on THAT: the day someone shortens the schema message to
    // "invalid host", the operator loses the one sentence that tells BIND_HOST from MCP_HOST, and
    // this row is what says so.
    const r = await configCheck.run(baseCtx({ env: { BIND_HOST: 'figma.mcp.example.com' } }));
    expect(r.state).toBe('fail');
    expect((r as { reason: string }).reason).toMatch(/BIND_HOST/);
    expect((r as { reason: string }).reason).toMatch(/MCP_HOST/);
  });

  it('a wide bind in single-tenant is surfaced, not hidden, in the check detail', async () => {
    const r = await configCheck.run(baseCtx({ env: { BIND_HOST: '0.0.0.0' } }));
    expect(r.state).toBe('ok');
    expect((r as { detail: Record<string, unknown> }).detail).toMatchObject({ bind_host: '0.0.0.0' });
  });
});
