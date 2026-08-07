# Security Policy

## Reporting a vulnerability

Use GitHub's **[private vulnerability reporting](https://github.com/zylomeara/framefit/security/advisories/new)** — the Security tab of this repository. It reaches the maintainer privately and keeps the report out of public issues until there is a fix.

Please do not open a public issue for anything that would expose someone's Figma token, a self-hoster's data, or a way past the auth described below.

There is no bounty. There is a single maintainer, so expect a first reply within a few days rather than hours.

## Supported versions

The latest `0.x` minor only. This is pre-1.0 software: fixes land on the newest minor and there are no backports.

## What handles secrets

Worth knowing before you look, and worth knowing if you self-host:

- **Single-tenant / stdio** takes one `FIGMA_TOKEN` from the environment and stores nothing. There is no database and no user identity.
- **Multi-tenant** stores a per-user Figma personal access token in Postgres, encrypted with AES-256-GCM under `ENCRYPTION_KEY` (`mcp-server/src/multi-tenant/crypto.ts`). Losing that key makes the stored tokens unreadable; leaking it makes them readable. It belongs in the deployment's environment, never in the repository.
- **`/mcp` is gated by a JWT** validated against a Keycloak realm you configure.
- **The DOM-snapshot upload route** (`POST /api/dom-snapshots/:capToken`) is reached by the browser, not by the agent, and is gated by a short-lived capability token minted per call rather than by the JWT.

## Known and deliberate, please do not report as a bug

Both are documented in the source at the line that implements them.

- **The audience check on `/mcp` is soft: a mismatch is logged, never rejected.** Claude's dynamically-registered clients present a token whose `azp` is a UUID and which carries no per-service `aud`, because the connector omits the `resource` parameter — so there is no audience to match. Hard-enforcing it would break every legitimate connector. The path that *is* hard-enforced is `/accounts`, which carries portal tokens. See `mcp-server/src/infrastructure/server.ts`, `makeRequireJwt`.
- **A shared Keycloak realm means a token minted for one service validates on another** if you deploy several MCP servers against one realm. That is a property of the deployment topology, not of this code; give each service its own audience mapper if it matters to you.

If you think either decision is wrong, that is a design discussion — open an issue.

## Out of scope

- The admin portal and the Figma plugin are not part of this repository.
- The deployment guide's suggestion of Caddy `basic_auth` in front of an HTTP deployment is a convenience for a single operator, not a security boundary. Do not treat it as one.
- Findings that require an attacker who already holds `ENCRYPTION_KEY`, the database, or the host.
