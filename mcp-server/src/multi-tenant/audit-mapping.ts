// mcp-server/src/multi-tenant/audit-mapping.ts
// Pure helpers mapping an Express request to an audit row. No I/O — unit-tested.

const ACTIONS: Record<string, string> = {
  'POST /': 'token.add',
  'DELETE /:label': 'token.remove',
  'PUT /:label/default': 'token.default',
  'POST /:label/validate': 'token.validate',
  'PUT /settings': 'settings.read_only',
  'POST /teams': 'team.add',
  'DELETE /teams/:id': 'team.remove',
  'POST /sync': 'sync.start',
  'POST /teams/:id/sync': 'sync.start',
  'POST /ci-keys': 'ci_key.create',
  'DELETE /ci-keys/:id': 'ci_key.revoke',
  'POST /bridge-token': 'bridge.issue',
};

/** The audit action for a matched route, or null for reads/unknown/unmatched. */
export function auditActionFor(method: string, routePath: string | undefined): string | null {
  if (!routePath) return null;
  return ACTIONS[`${method} ${routePath}`] ?? null;
}

export function auditOutcomeFor(status: number): string {
  if (status < 300) return 'success';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return 'error';
}

export function auditTargetFrom(params: Record<string, string>, body: unknown): string | null {
  if (params.label) return params.label;
  if (params.id) return params.id;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.team_id === 'string') return b.team_id;
    if (typeof b.label === 'string') return b.label;
  }
  return null;
}
