import { describe, it, expect } from 'vitest';
import { isMultiTenant, loadMultiTenantEnv } from '../../src/multi-tenant/env.js';

const VALID = {
  DATABASE_URL: 'postgresql://mcp:x@db:5432/figma_mcp',
  ENCRYPTION_KEY: 'a'.repeat(64),
  KEYCLOAK_JWKS_URL: 'https://auth.test/realms/mcp/protocol/openid-connect/certs',
  OAUTH_AUTHORIZATION_SERVER: 'https://auth.test/realms/mcp',
  MCP_HOST: 'figma.mcp.example.com',
};

describe('isMultiTenant', () => {
  it('true only for MULTI_TENANT=true (case-insensitive)', () => {
    expect(isMultiTenant({ MULTI_TENANT: 'true' })).toBe(true);
    expect(isMultiTenant({ MULTI_TENANT: 'TRUE' })).toBe(true);
    expect(isMultiTenant({ MULTI_TENANT: 'false' })).toBe(false);
    expect(isMultiTenant({})).toBe(false);
  });
});

describe('loadMultiTenantEnv', () => {
  it('loads all fields', () => {
    const env = loadMultiTenantEnv(VALID);
    expect(env.mcpHost).toBe('figma.mcp.example.com');
    expect(env.encryptionKey).toHaveLength(64);
  });

  it('lists ALL missing vars in one error', () => {
    expect(() => loadMultiTenantEnv({ DATABASE_URL: 'x' })).toThrow(
      /ENCRYPTION_KEY.*KEYCLOAK_JWKS_URL.*OAUTH_AUTHORIZATION_SERVER.*MCP_HOST/s,
    );
  });

  it('rejects non-64-hex ENCRYPTION_KEY', () => {
    expect(() => loadMultiTenantEnv({ ...VALID, ENCRYPTION_KEY: 'short' })).toThrow(/64/);
  });
});

describe('loadMultiTenantEnv audience fields', () => {
  it('derives expectedAudience from MCP_HOST when EXPECTED_AUDIENCE unset', () => {
    const env = loadMultiTenantEnv(VALID);
    expect(env.expectedAudience).toBe('https://figma.mcp.example.com/mcp');
  });
  it('defaults expectedAzp=figma-portal and enforceAudience=false', () => {
    const env = loadMultiTenantEnv(VALID);
    expect(env.expectedAzp).toBe('figma-portal');
    expect(env.enforceAudience).toBe(false);
  });
  it('honors EXPECTED_AUDIENCE / EXPECTED_AZP overrides and ENFORCE_AUDIENCE=TRUE', () => {
    const env = loadMultiTenantEnv({
      ...VALID,
      EXPECTED_AUDIENCE: 'https://figma.mcp.example.com/mcp',
      EXPECTED_AZP: 'custom-portal',
      ENFORCE_AUDIENCE: 'TRUE',
    });
    expect(env.expectedAudience).toBe('https://figma.mcp.example.com/mcp');
    expect(env.expectedAzp).toBe('custom-portal');
    expect(env.enforceAudience).toBe(true);
  });
});
