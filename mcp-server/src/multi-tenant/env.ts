// Multi-tenant env lives apart from AppConfig: these vars are required only when
// MULTI_TENANT=true, so zod-required fields in the main schema would break
// single-tenant/stdio installs.

export interface MultiTenantEnv {
  databaseUrl: string;
  encryptionKey: string;
  keycloakJwksUrl: string;
  oauthAuthorizationServer: string;
  mcpHost: string;
  /** PUBLIC_BASE_URL (optional, e.g. 'http://localhost:3846' in the local full-profile, no
   * trailing slash). When set it overrides the historical `https://${mcpHost}` form for every
   * externally-visible URL the MT server emits (OAuth PRM resource identity, WWW-Authenticate
   * resource_metadata, portal hint, dom-snapshot upload base) — it MUST match what the Keycloak
   * realm/audience was provisioned with. Unset (prod): fallback stays byte-for-byte. */
  publicBaseUrl?: string;
  expectedAudience: string;   // EXPECTED_AUDIENCE; default ${PUBLIC_BASE_URL ?? https://${MCP_HOST}}/mcp
  expectedAzp: string;        // EXPECTED_AZP (default 'figma-portal')
  enforceAudience: boolean;   // ENFORCE_AUDIENCE (default false) — rollout flag
}

export function isMultiTenant(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MULTI_TENANT?.toLowerCase() === 'true';
}

/**
 * The ONE canonical ENCRYPTION_KEY shape check (AES-256-GCM for stored PATs and HS256 for
 * bridge-tokens both want exactly 32 bytes of hex). Exported so the operator CLI — which
 * deliberately bypasses loadMultiTenantEnv (see cli.ts) — validates with the SAME predicate and the
 * two can never drift: a mangled/short/non-hex key otherwise mints a bridge-token that can never
 * verify against the running server (403 with no clue) or throws a raw DOMException out of the signer.
 */
export function isEncryptionKeyHex(v: string | undefined): boolean {
  return typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v);
}

/** The single wording for a bad ENCRYPTION_KEY, shared by loadMultiTenantEnv and the CLI. */
export const ENCRYPTION_KEY_HINT = 'ENCRYPTION_KEY must be a 64-char hex string (openssl rand -hex 32)';

export function loadMultiTenantEnv(env: NodeJS.ProcessEnv = process.env): MultiTenantEnv {
  const required = [
    'DATABASE_URL',
    'ENCRYPTION_KEY',
    'KEYCLOAK_JWKS_URL',
    'OAUTH_AUTHORIZATION_SERVER',
    'MCP_HOST',
  ];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required multi-tenant env vars: ${missing.join(', ')}`);
  }
  if (!isEncryptionKeyHex(env.ENCRYPTION_KEY)) {
    throw new Error(ENCRYPTION_KEY_HINT);
  }
  // `|| undefined` (not ??): compose env-substitution passes '' when the var is unset, and an
  // empty base URL must mean "not configured", never an empty-string base.
  const publicBaseUrl = env.PUBLIC_BASE_URL || undefined;
  return {
    databaseUrl: env.DATABASE_URL!,
    encryptionKey: env.ENCRYPTION_KEY!,
    keycloakJwksUrl: env.KEYCLOAK_JWKS_URL!,
    oauthAuthorizationServer: env.OAUTH_AUTHORIZATION_SERVER!,
    mcpHost: env.MCP_HOST!,
    publicBaseUrl,
    // The audience DEFAULT follows the public base URL so the OAuth resource identity the server
    // advertises (PRM `resource`) and the audience it expects stay ONE identity by default
    // (explicit EXPECTED_AUDIENCE still wins). Without PUBLIC_BASE_URL this is the historical
    // https://${MCP_HOST}/mcp, byte-for-byte.
    expectedAudience: env.EXPECTED_AUDIENCE || `${publicBaseUrl ?? `https://${env.MCP_HOST}`}/mcp`,
    expectedAzp: env.EXPECTED_AZP || 'figma-portal',
    enforceAudience: env.ENFORCE_AUDIENCE?.toLowerCase() === 'true',
  };
}
