import { describe, it, expect } from 'vitest';
import { collectInstanceKeys, indexSnippetsByNodeId, buildComponentDocs } from '../../src/domain/code-connect-enrich.js';
import type { RawSceneNode, ComponentRefMeta, PublishedComponentMeta } from '../../src/domain/figma-raw.js';

const doc: RawSceneNode = {
  id: '1:0', name: 'Card', type: 'FRAME', children: [
    { id: '1:1', name: 'Btn', type: 'INSTANCE', componentId: 'C:1' },
    { id: '1:2', name: 'Txt', type: 'TEXT' },
    { id: '1:3', name: 'Inner', type: 'FRAME', children: [{ id: '1:4', name: 'Btn2', type: 'INSTANCE', componentId: 'C:2' }] },
  ],
};
const components: Record<string, ComponentRefMeta> = { 'C:1': { key: 'KEY1' }, 'C:2': { key: 'KEY2' } };

describe('collectInstanceKeys', () => {
  it('collects nodeId→componentKey for all instances (recursive)', () => {
    expect(collectInstanceKeys(doc, components)).toEqual([
      { nodeId: '1:1', componentKey: 'KEY1' },
      { nodeId: '1:4', componentKey: 'KEY2' },
    ]);
  });
  it('skips instances whose componentId is absent from the components map', () => {
    expect(collectInstanceKeys({ id: '0', name: 'x', type: 'INSTANCE', componentId: 'C:9' }, components)).toEqual([]);
  });
});

describe('indexSnippetsByNodeId', () => {
  it('joins nodeId→key→ref→mapping into a per-node snippet record', () => {
    const pairs = [{ nodeId: '1:1', componentKey: 'KEY1' }];
    const keyToRef = new Map([['KEY1', { file_key: 'LIB', node_id: '7:7' }]]);
    const mappingByRef = new Map([['LIB|7:7', { component_name: 'Button', source: 's', template: 't', template_data: { imports: ['i'] }, label: 'React' }]]);
    const out = indexSnippetsByNodeId(pairs, keyToRef, mappingByRef);
    expect(out['1:1']).toMatchObject({ component: 'Button', source: 's', imports: ['i'] });
  });
  it('omits nodes whose key/ref/mapping is missing', () => {
    const out = indexSnippetsByNodeId([{ nodeId: '1:1', componentKey: 'KEYX' }], new Map(), new Map());
    expect(out).toEqual({});
  });
});

describe('buildComponentDocs', () => {
  const meta = (over: Partial<PublishedComponentMeta>): PublishedComponentMeta => ({ key: 'KEY1', file_key: 'LIB', node_id: '7:7', name: 'Button', ...over });

  it('maps componentId → ComponentDoc, resolving the component-set name+description (object, not bare id)', () => {
    const out = buildComponentDocs(
      { 'C:1': { key: 'KEY1', componentSetId: 'CS:1' } },
      new Map([['KEY1', meta({ description: 'Primary CTA', documentationLinks: [{ uri: 'http://x' }] })]]),
      new Map([['CS:1', { name: 'Button', description: 'navbar, topbar, навигация' }]]),
    );
    expect(out['C:1']).toMatchObject({ name: 'Button', description: 'Primary CTA', componentSet: { name: 'Button', description: 'navbar, topbar, навигация' }, docs: ['http://x'] });
  });

  it('keeps a variant with empty own-description when its component SET has a description', () => {
    const out = buildComponentDocs(
      { 'C:1': { key: 'KEY1', componentSetId: 'CS:1' } },
      new Map([['KEY1', meta({ description: '' })]]),
      new Map([['CS:1', { name: 'navbar', description: 'navbar, topbar' }]]),
    );
    expect(out['C:1']).toBeDefined();
    expect(out['C:1'].description).toBeUndefined();
    expect(out['C:1'].componentSet).toEqual({ name: 'navbar', description: 'navbar, topbar' });
  });

  it('skips a variant with empty own-description when the set map has no match', () => {
    const out = buildComponentDocs({ 'C:1': { key: 'KEY1', componentSetId: 'CS:1' } }, new Map([['KEY1', meta({ description: '' })]]), new Map());
    expect(out).toEqual({});
  });

  it('trims the set description and drops it when blank (keeps set name)', () => {
    const out = buildComponentDocs(
      { 'C:1': { key: 'KEY1', componentSetId: 'CS:1' } },
      new Map([['KEY1', meta({ description: 'D' })]]),
      new Map([['CS:1', { name: 'S', description: '   ' }]]),
    );
    expect(out['C:1'].componentSet).toEqual({ name: 'S' });
  });

  it('skips components with blank description and no docs and no set', () => {
    const out = buildComponentDocs({ 'C:1': { key: 'KEY1' } }, new Map([['KEY1', meta({ description: '   ' })]]));
    expect(out).toEqual({});
  });

  it('skips componentIds whose key has no resolved meta', () => {
    expect(buildComponentDocs({ 'C:1': { key: 'KEY1' } }, new Map())).toEqual({});
  });
});
