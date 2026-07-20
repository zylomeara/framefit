import { describe, it, expect } from 'vitest';
import { parseFigmaNodeUrl, normalizeDocs } from '../../src/domain/code-connect.js';

describe('parseFigmaNodeUrl', () => {
  it('extracts file_key + node_id (normalized) from a figmaNode URL', () => {
    expect(parseFigmaNodeUrl('https://www.figma.com/file/ABC123/Lib?node-id=1-5')).toEqual({ file_key: 'ABC123', node_id: '1:5' });
    expect(parseFigmaNodeUrl('https://figma.com/design/XYZ/Lib?node-id=10%3A20&t=x')).toEqual({ file_key: 'XYZ', node_id: '10:20' });
    expect(parseFigmaNodeUrl('figma.com/file/ABC123/Lib?node-id=1-5')).toEqual({ file_key: 'ABC123', node_id: '1:5' });
  });
  it('returns null for a URL without node-id or file key', () => {
    expect(parseFigmaNodeUrl('https://figma.com/file/ABC/Lib')).toBeNull();
    expect(parseFigmaNodeUrl('not a url')).toBeNull();
  });
});

describe('normalizeDocs', () => {
  it('maps CodeConnectJSON docs to stored mappings, dropping unparseable nodes', () => {
    const docs = [
      { figmaNode: 'https://figma.com/file/F/Lib?node-id=1-5', label: 'React', component: 'Button',
        source: 'https://gh/Button.tsx', template: 'tmpl', templateData: { props: { variant: { kind: 'enum' } }, imports: ['import X'] } },
      { figmaNode: 'no-node-id', label: 'React', component: 'Broken', source: '', template: '', templateData: {} },
    ];
    const out = normalizeDocs(docs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      component_file_key: 'F', component_node_id: '1:5', label: 'React',
      component_name: 'Button', source: 'https://gh/Button.tsx', template: 'tmpl',
    });
    expect(out[0].template_data).toMatchObject({ props: { variant: { kind: 'enum' } }, imports: ['import X'] });
  });

  it('skips non-object items and non-string figmaNode without throwing', () => {
    const docs = [
      null, 'str', 42,
      { figmaNode: 123 },
      { figmaNode: 'https://figma.com/file/F/Lib?node-id=1-5', component: 'Button' },
    ] as any;
    const out = normalizeDocs(docs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ component_file_key: 'F', component_node_id: '1:5', component_name: 'Button' });
  });
});
