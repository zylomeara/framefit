import type {
  RawColor,
  RawPaint,
  RawSceneNode,
  RawVariableAlias,
} from './figma-raw.js';
import { rgbaToHex } from './design-context/color.js';

export interface NodeVariableBinding {
  id: string;
  binding_path: string;
  rendered_value?: string | number | boolean;
}

export interface NodeVariableBindingRow {
  id: string;
  name?: string;
  type?: string;
  collection?: string;
  value: string | number | boolean | null;
  rendered_value?: string | number | boolean;
  binding_path: string;
  definition_status: 'resolved' | 'unavailable';
  resolved_via?: 'graph' | 'snapshot';
  source_library?: string;
}

type BindingMap = Record<string, RawVariableAlias | RawVariableAlias[]>;

function isColor(value: unknown): value is RawColor {
  if (typeof value !== 'object' || value === null) return false;
  const color = value as Partial<RawColor>;
  return typeof color.r === 'number' && typeof color.g === 'number' && typeof color.b === 'number';
}

function renderedValue(owner: object, key: string): string | number | boolean | undefined {
  const value = (owner as Record<string, unknown>)[key];
  if (isColor(value)) return rgbaToHex(value);
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;
}

/** Detailed, stable preorder census of every variable binding in a node subtree. */
export function collectNodeVariableBindings(root: RawSceneNode): NodeVariableBinding[] {
  const rows: NodeVariableBinding[] = [];
  const seen = new Set<string>();

  const add = (owner: object, bindings: BindingMap | undefined, path: string) => {
    if (!bindings) return;
    for (const [key, binding] of Object.entries(bindings)) {
      const aliases = Array.isArray(binding) ? binding : [binding];
      for (let index = 0; index < aliases.length; index++) {
        const id = aliases[index]?.id;
        if (!id) continue;
        const bindingPath = `${path}.boundVariables.${key}${Array.isArray(binding) ? `[${index}]` : ''}`;
        const rendered = renderedValue(owner, key);
        const dedupeKey = `${id}\u0000${bindingPath}\u0000${typeof rendered}\u0000${String(rendered)}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        rows.push({ id, binding_path: bindingPath, ...(rendered === undefined ? {} : { rendered_value: rendered }) });
      }
    }
  };

  const walkPaints = (paints: RawPaint[] | undefined, path: string) => {
    for (let paintIndex = 0; paintIndex < (paints?.length ?? 0); paintIndex++) {
      const paint = paints![paintIndex];
      const paintPath = `${path}[${paintIndex}]`;
      add(paint, paint.boundVariables, paintPath);
      for (let stopIndex = 0; stopIndex < (paint.gradientStops?.length ?? 0); stopIndex++) {
        const stop = paint.gradientStops![stopIndex];
        add(stop, stop.boundVariables as BindingMap | undefined, `${paintPath}.gradientStops[${stopIndex}]`);
      }
    }
  };

  const walk = (node: RawSceneNode, path: string) => {
    add(node, node.boundVariables, path);
    walkPaints(node.fills, `${path}.fills`);
    walkPaints(node.strokes, `${path}.strokes`);
    for (let effectIndex = 0; effectIndex < (node.effects?.length ?? 0); effectIndex++) {
      const effect = node.effects![effectIndex];
      add(effect, effect.boundVariables, `${path}.effects[${effectIndex}]`);
    }
    for (let childIndex = 0; childIndex < (node.children?.length ?? 0); childIndex++) {
      walk(node.children![childIndex], `${path}.children[${childIndex}]`);
    }
  };

  walk(root, root.id);
  return rows;
}
