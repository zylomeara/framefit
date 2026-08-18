import { describe, expect, it, vi } from 'vitest';
import { findComponentInstances } from '../../src/application/find-component-instances.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';

type Node = { id: string; name: string; type: string; componentId?: string; children?: Node[] };

const page = (name: string, containers: Node[]): Node => ({ id: `page:${name}`, name, type: 'CANVAS', children: containers });
const skeleton = (...pages: Node[]) => ({
  name: 'F', lastModified: 'X', version: '1',
  document: { id: '0:0', name: 'Doc', type: 'DOCUMENT', children: pages },
});

function apiFor(doc: ReturnType<typeof skeleton>, chunks: Record<string, Node>) {
  const getDocumentRaw = vi.fn(async () => doc);
  const getNodesRaw = vi.fn(async (_file: string, ids: string[]) => ({
    nodes: { [ids[0]]: chunks[ids[0]] ? { document: chunks[ids[0]] } : null },
  }));
  return { api: { getDocumentRaw, getNodesRaw } as unknown as Pick<FigmaApi, 'getDocumentRaw' | 'getNodesRaw'>, getDocumentRaw, getNodesRaw };
}

describe('findComponentInstances', () => {
  it('finds exact component-id instances in document order and caps six matches at five', async () => {
    const first: Node = { id: '1:1', name: 'Screen', type: 'FRAME', children: [
      { id: '1:2', name: 'Card', type: 'INSTANCE', componentId: '1:5', children: [
        { id: '1:2:1', name: 'Nested Card', type: 'INSTANCE', componentId: '1:5' },
      ] },
      { id: '1:3', name: 'Same name, wrong definition', type: 'INSTANCE', componentId: '9:9' },
      { id: '1:4', name: 'Card', type: 'INSTANCE', componentId: '1:5' },
      { id: '1:6', name: 'Nested', type: 'FRAME', children: [
        { id: '1:7', name: 'Card', type: 'INSTANCE', componentId: '1:5' },
      ] },
    ] };
    const second: Node = { id: '2:1', name: 'Checkout', type: 'FRAME', children: [
      { id: '2:2', name: 'Card', type: 'INSTANCE', componentId: '1:5' },
      { id: '2:3', name: 'Card', type: 'INSTANCE', componentId: '1:5' },
    ] };
    const { api, getDocumentRaw, getNodesRaw } = apiFor(skeleton(page('Board', [first, second])), {
      '1:1': first, '2:1': second,
    });

    const result = await findComponentInstances(api, 'abc', '1:5');

    expect(getDocumentRaw).toHaveBeenCalledWith('abc', 2);
    expect(getNodesRaw).toHaveBeenCalledWith('abc', ['1:1'], 8);
    expect(getNodesRaw).toHaveBeenCalledWith('abc', ['2:1'], 8);
    expect(result).toEqual({
      candidates: [
        { node_id: '1:2', name: 'Card', path: ['Board', 'Screen'] },
        { node_id: '1:2:1', name: 'Nested Card', path: ['Board', 'Screen', 'Card'] },
        { node_id: '1:4', name: 'Card', path: ['Board', 'Screen'] },
        { node_id: '1:7', name: 'Card', path: ['Board', 'Screen', 'Nested'] },
        { node_id: '2:2', name: 'Card', path: ['Board', 'Checkout'] },
      ],
    });
  });

  it('returns zero candidates when instances share the name but not the component id', async () => {
    const container: Node = { id: '1:1', name: 'Screen', type: 'FRAME', children: [
      { id: '1:2', name: 'Card', type: 'INSTANCE', componentId: 'other' },
    ] };
    const { api } = apiFor(skeleton(page('Board', [container])), { '1:1': container });

    await expect(findComponentInstances(api, 'abc', '1:5')).resolves.toEqual({ candidates: [] });
  });

  it('returns one exact component-id instance with its document breadcrumb', async () => {
    const container: Node = { id: '1:1', name: 'Screen', type: 'FRAME', children: [
      { id: '1:2', name: 'Card', type: 'INSTANCE', componentId: '1:5' },
    ] };
    const { api } = apiFor(skeleton(page('Board', [container])), { '1:1': container });

    await expect(findComponentInstances(api, 'abc', '1:5')).resolves.toEqual({
      candidates: [{ node_id: '1:2', name: 'Card', path: ['Board', 'Screen'] }],
    });
  });

  it('scans no more than five top-level containers', async () => {
    const containers = Array.from({ length: 7 }, (_, i) => ({ id: `1:${i + 1}`, name: `Screen ${i + 1}`, type: 'FRAME' }));
    const { api, getNodesRaw } = apiFor(skeleton(page('Board', containers)), Object.fromEntries(containers.map((c) => [c.id, c])));

    await expect(findComponentInstances(api, 'abc', '1:5')).resolves.toEqual({ candidates: [] });
    expect(getNodesRaw).toHaveBeenCalledTimes(5);
  });

  it('keeps candidates from successful chunks when a network failure interrupts a later chunk', async () => {
    const first: Node = { id: '1:1', name: 'Screen', type: 'FRAME', children: [{ id: '1:2', name: 'Card', type: 'INSTANCE', componentId: '1:5' }] };
    const second: Node = { id: '2:1', name: 'Other', type: 'FRAME' };
    const { api, getNodesRaw } = apiFor(skeleton(page('Board', [first, second])), { '1:1': first, '2:1': second });
    getNodesRaw.mockImplementation(async (_file: string, ids: string[]) => {
      if (ids[0] === '2:1') throw new FigmaApiError('network', 0, 'timed out');
      return { nodes: { '1:1': { document: first } } };
    });

    await expect(findComponentInstances(api, 'abc', '1:5')).resolves.toEqual({
      candidates: [{ node_id: '1:2', name: 'Card', path: ['Board', 'Screen'] }], partial: true,
    });
  });
});
