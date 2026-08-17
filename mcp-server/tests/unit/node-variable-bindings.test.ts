import { describe, expect, it } from 'vitest';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { collectNodeVariableBindings } from '../../src/domain/node-variable-bindings.js';
import { collectNodeVariableIds } from '../../src/domain/variables.js';

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS' as const, id });

describe('collectNodeVariableBindings', () => {
  it('walks node, paint, gradient-stop, effect, array, and child bindings in stable preorder', () => {
    const root = {
      id: '1:1', name: 'root', type: 'FRAME', itemSpacing: 12,
      boundVariables: {
        itemSpacing: alias('VariableID:local/spacing'),
        opacity: [alias('VariableID:local/shared'), alias('VariableID:local/shared')],
      },
      fills: [
        {
          type: 'SOLID', color: { r: 1, g: 0.5, b: 0, a: 0.5 },
          boundVariables: { color: alias('VariableID:published/fill') },
        },
        {
          type: 'GRADIENT_LINEAR', gradientStops: [{
            position: 0, color: { r: 0, g: 0, b: 1, a: 1 },
            boundVariables: { color: alias('VariableID:published/gradient') },
          }],
        },
      ],
      strokes: [{
        type: 'SOLID', color: { r: 0, g: 1, b: 0 },
        boundVariables: { color: alias('VariableID:published/stroke') },
      }],
      effects: [{
        type: 'DROP_SHADOW', radius: 4,
        boundVariables: {
          radius: alias('VariableID:local/effect-radius'),
          offset: alias('VariableID:local/unsupported-object'),
        },
        offset: { x: 1, y: 2 },
      }],
      children: [{
        id: '1:2', name: 'child', type: 'FRAME', paddingLeft: 8,
        boundVariables: { paddingLeft: alias('VariableID:local/shared') },
      }],
    } satisfies RawSceneNode;

    expect(collectNodeVariableBindings(root)).toEqual([
      { id: 'VariableID:local/spacing', binding_path: '1:1.boundVariables.itemSpacing', rendered_value: 12 },
      { id: 'VariableID:local/shared', binding_path: '1:1.boundVariables.opacity[0]' },
      { id: 'VariableID:local/shared', binding_path: '1:1.boundVariables.opacity[1]' },
      { id: 'VariableID:published/fill', binding_path: '1:1.fills[0].boundVariables.color', rendered_value: '#ff800080' },
      { id: 'VariableID:published/gradient', binding_path: '1:1.fills[1].gradientStops[0].boundVariables.color', rendered_value: '#0000ff' },
      { id: 'VariableID:published/stroke', binding_path: '1:1.strokes[0].boundVariables.color', rendered_value: '#00ff00' },
      { id: 'VariableID:local/effect-radius', binding_path: '1:1.effects[0].boundVariables.radius', rendered_value: 4 },
      { id: 'VariableID:local/unsupported-object', binding_path: '1:1.effects[0].boundVariables.offset' },
      { id: 'VariableID:local/shared', binding_path: '1:1.children[0].boundVariables.paddingLeft', rendered_value: 8 },
    ]);
  });

  it('dedupes only an exact id, path, and rendered-value repeat', () => {
    const repeated = alias('VariableID:local/repeated');
    const root = {
      id: '1:1', name: 'root', type: 'FRAME', opacity: 0.75,
      boundVariables: { opacity: [repeated, repeated] },
      children: [{
        id: '1:2', name: 'child', type: 'FRAME', opacity: 0.75,
        boundVariables: { opacity: repeated },
      }],
    } satisfies RawSceneNode;

    expect(collectNodeVariableBindings(root)).toEqual([
      { id: 'VariableID:local/repeated', binding_path: '1:1.boundVariables.opacity[0]', rendered_value: 0.75 },
      { id: 'VariableID:local/repeated', binding_path: '1:1.boundVariables.opacity[1]', rendered_value: 0.75 },
      { id: 'VariableID:local/repeated', binding_path: '1:1.children[0].boundVariables.opacity', rendered_value: 0.75 },
    ]);
  });

  it('keeps the id-only collector equal to a Set projection of the detailed census', () => {
    const root = {
      id: '1:1', name: 'root', type: 'FRAME', cornerRadius: 6,
      boundVariables: { cornerRadius: alias('VariableID:local/shared') },
      effects: [{
        type: 'LAYER_BLUR', radius: 6,
        boundVariables: { radius: alias('VariableID:local/effect') },
      }],
      children: [{
        id: '1:2', name: 'child', type: 'FRAME', paddingLeft: 6,
        boundVariables: { paddingLeft: alias('VariableID:local/shared') },
      }],
    } satisfies RawSceneNode;
    const census = collectNodeVariableBindings(root);

    expect(collectNodeVariableIds(root)).toEqual(new Set(census.map((binding) => binding.id)));
  });
});
