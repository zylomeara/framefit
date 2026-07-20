import { describe, it, expect } from 'vitest';
import { auditActionFor, auditOutcomeFor, auditTargetFrom } from '../../src/multi-tenant/audit-mapping.js';

describe('audit-mapping', () => {
  it('auditActionFor maps known mutating routes', () => {
    expect(auditActionFor('POST', '/')).toBe('token.add');
    expect(auditActionFor('DELETE', '/:label')).toBe('token.remove');
    expect(auditActionFor('PUT', '/:label/default')).toBe('token.default');
    expect(auditActionFor('POST', '/:label/validate')).toBe('token.validate');
    expect(auditActionFor('PUT', '/settings')).toBe('settings.read_only');
    expect(auditActionFor('POST', '/teams')).toBe('team.add');
    expect(auditActionFor('DELETE', '/teams/:id')).toBe('team.remove');
    expect(auditActionFor('POST', '/sync')).toBe('sync.start');
    expect(auditActionFor('POST', '/teams/:id/sync')).toBe('sync.start');
    expect(auditActionFor('POST', '/ci-keys')).toBe('ci_key.create');
    expect(auditActionFor('DELETE', '/ci-keys/:id')).toBe('ci_key.revoke');
    expect(auditActionFor('POST', '/bridge-token')).toBe('bridge.issue');
  });
  it('auditActionFor returns null for reads / unknown / undefined', () => {
    expect(auditActionFor('GET', '/')).toBeNull();
    expect(auditActionFor('GET', '/teams')).toBeNull();
    expect(auditActionFor('POST', undefined)).toBeNull();
    expect(auditActionFor('PATCH', '/whatever')).toBeNull();
  });
  it('auditOutcomeFor buckets status codes', () => {
    expect(auditOutcomeFor(200)).toBe('success');
    expect(auditOutcomeFor(201)).toBe('success');
    expect(auditOutcomeFor(202)).toBe('success');
    expect(auditOutcomeFor(404)).toBe('not_found');
    expect(auditOutcomeFor(409)).toBe('conflict');
    expect(auditOutcomeFor(400)).toBe('error');
    expect(auditOutcomeFor(500)).toBe('error');
  });
  it('auditTargetFrom prefers params, then body team_id/label, else null', () => {
    expect(auditTargetFrom({ label: 'work' }, undefined)).toBe('work');
    expect(auditTargetFrom({ id: '42' }, undefined)).toBe('42');
    expect(auditTargetFrom({}, { team_id: '139' })).toBe('139');
    expect(auditTargetFrom({}, { label: 'ci-prod' })).toBe('ci-prod');
    expect(auditTargetFrom({}, undefined)).toBeNull();
    expect(auditTargetFrom({}, { other: 1 })).toBeNull();
  });
});
