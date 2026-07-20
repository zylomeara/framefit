import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb } from '../../src/multi-tenant/db.js';
import {
  ensureCodeConnectSchema, truncateCodeConnectForTests,
  createCiKey, listCiKeys, revokeCiKey, resolveCiKey,
  replaceMappings, lookupMappings,
} from '../../src/multi-tenant/code-connect-db.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('code-connect db', () => {
  beforeAll(async () => { initDb(url!); await ensureCodeConnectSchema(); });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => { await truncateCodeConnectForTests(); });

  it('createCiKey returns a one-time plaintext; resolveCiKey maps it to the owner', async () => {
    const { plaintext } = await createCiKey('u1', 'ci-prod');
    expect(plaintext).toMatch(/^fmcp_ci_/);
    expect(await resolveCiKey(plaintext)).toBe('u1');
    expect(await resolveCiKey('fmcp_ci_wrong')).toBeNull();
  });

  it('listCiKeys hides the secret; revoke removes it', async () => {
    const { id } = await createCiKey('u1', 'a');
    const list = await listCiKeys('u1');
    expect(list[0]).toMatchObject({ label: 'a' });
    expect(JSON.stringify(list)).not.toContain('fmcp_ci_');
    expect(await revokeCiKey('u1', id)).toBe(true);
    expect(await listCiKeys('u1')).toHaveLength(0);
  });

  it('replaceMappings then lookupMappings by (file_key,node_id) for the owner', async () => {
    await replaceMappings('u1', [
      { component_file_key: 'F', component_node_id: '1:5', label: 'React', component_name: 'Button', source: 's', template: 't', template_data: { imports: ['i'] } },
    ]);
    const map = await lookupMappings('u1', [{ file_key: 'F', node_id: '1:5' }, { file_key: 'F', node_id: '9:9' }]);
    expect(map.get('F|1:5')?.component_name).toBe('Button');
    expect(map.has('F|9:9')).toBe(false);
  });

  it('replaceMappings is a full per-user replace (idempotent re-upload)', async () => {
    await replaceMappings('u1', [{ component_file_key: 'F', component_node_id: '1:1', label: 'React', component_name: 'A', source: '', template: '', template_data: {} }]);
    await replaceMappings('u1', [{ component_file_key: 'F', component_node_id: '2:2', label: 'React', component_name: 'B', source: '', template: '', template_data: {} }]);
    const map = await lookupMappings('u1', [{ file_key: 'F', node_id: '1:1' }, { file_key: 'F', node_id: '2:2' }]);
    expect(map.has('F|1:1')).toBe(false);
    expect(map.get('F|2:2')?.component_name).toBe('B');
  });

  it('mappings are per-user isolated', async () => {
    await replaceMappings('u1', [{ component_file_key: 'F', component_node_id: '1:1', label: 'React', component_name: 'A', source: '', template: '', template_data: {} }]);
    const u2 = await lookupMappings('u2', [{ file_key: 'F', node_id: '1:1' }]);
    expect(u2.size).toBe(0);
  });

  it('lookupMappings filters out cross pairs from the ANY×ANY overfetch', async () => {
    await replaceMappings('u1', [
      { component_file_key: 'F', component_node_id: '1:1', label: 'React', component_name: 'A', source: '', template: '', template_data: {} },
      { component_file_key: 'F', component_node_id: '2:2', label: 'React', component_name: 'CROSS', source: '', template: '', template_data: {} },
      { component_file_key: 'G', component_node_id: '2:2', label: 'React', component_name: 'B', source: '', template: '', template_data: {} },
    ]);
    // Ask only for (F,1:1) and (G,2:2). The SQL ANY×ANY also matches the stored
    // (F,2:2), which must be filtered out as a cross pair.
    const map = await lookupMappings('u1', [{ file_key: 'F', node_id: '1:1' }, { file_key: 'G', node_id: '2:2' }]);
    expect(map.get('F|1:1')?.component_name).toBe('A');
    expect(map.get('G|2:2')?.component_name).toBe('B');
    expect(map.has('F|2:2')).toBe(false);
    expect(map.size).toBe(2);
  });

  it('lookupMappings is deterministic for multi-label components (first label by ORDER BY)', async () => {
    await replaceMappings('u1', [
      { component_file_key: 'F', component_node_id: '1:5', label: 'Vue', component_name: 'ButtonVue', source: '', template: '', template_data: {} },
      { component_file_key: 'F', component_node_id: '1:5', label: 'React', component_name: 'ButtonReact', source: '', template: '', template_data: {} },
    ]);
    const map1 = await lookupMappings('u1', [{ file_key: 'F', node_id: '1:5' }]);
    const map2 = await lookupMappings('u1', [{ file_key: 'F', node_id: '1:5' }]);
    // ORDER BY label → 'React' < 'Vue' → React kept deterministically across calls
    expect(map1.get('F|1:5')?.label).toBe('React');
    expect(map2.get('F|1:5')?.label).toBe('React');
  });
});
