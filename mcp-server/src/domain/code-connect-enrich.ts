// mcp-server/src/domain/code-connect-enrich.ts
// Pure join helpers for Code Connect enrichment. Async resolution (getComponent,
// DB lookup) is done by the tool; these stay pure and fixture-testable.
import type { RawSceneNode, ComponentRefMeta, PublishedComponentMeta } from './figma-raw.js';
import type { MappingHit } from './code-connect.js';
import type { ComponentDoc } from './design-context/types.js';

export interface InstanceKey { nodeId: string; componentKey: string }

export function collectInstanceKeys(
  node: RawSceneNode,
  components: Record<string, ComponentRefMeta> | undefined,
): InstanceKey[] {
  const out: InstanceKey[] = [];
  const walk = (n: RawSceneNode): void => {
    if (n.type === 'INSTANCE' && n.componentId) {
      const ref = components?.[n.componentId];
      if (ref?.key) out.push({ nodeId: n.id, componentKey: ref.key });
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

/** Join the per-file components map (componentId → published key) with resolved component
 * meta to a deduped {componentId → ComponentDoc}. Entries without a description or docs are
 * skipped to avoid bloat. Pure + fixture-testable. */
export function buildComponentDocs(
  components: Record<string, ComponentRefMeta> | undefined,
  metaByKey: Map<string, PublishedComponentMeta>,
  setByNodeId?: Map<string, { name?: string; description?: string }>,
): Record<string, ComponentDoc> {
  const out: Record<string, ComponentDoc> = {};
  if (!components) return out;
  for (const [componentId, ref] of Object.entries(components)) {
    if (!ref?.key) continue;
    const meta = metaByKey.get(ref.key);
    if (!meta) continue;
    const description = meta.description?.trim();
    const docs = meta.documentationLinks?.map((d) => d.uri).filter(Boolean);
    // Resolve the component-SET's name/description (rich docs + search tags often live on the
    // set, while variants carry an empty own-description). componentSetId lives on the per-node
    // components ref (Figma's Component object), not on GET /v1/components/:key's meta.
    const set = ref.componentSetId ? setByNodeId?.get(ref.componentSetId) : undefined;
    const setDesc = set?.description?.trim();
    const componentSet = (set?.name || setDesc)
      ? { ...(set?.name ? { name: set.name } : {}), ...(setDesc ? { description: setDesc } : {}) }
      : undefined;
    // Keep the entry if the component itself, its docs, OR its set carries information.
    if (!description && !(docs && docs.length) && !componentSet) continue;
    out[componentId] = {
      ...(meta.name ? { name: meta.name } : {}),
      ...(description ? { description } : {}),
      ...(componentSet ? { componentSet } : {}),
      ...(docs && docs.length ? { docs } : {}),
    };
  }
  return out;
}

export interface CodeConnectSnippet {
  component: string;
  source: string;
  label: string;
  imports?: string[];
  props?: Record<string, unknown>;
  template: string;
}

export function indexSnippetsByNodeId(
  pairs: InstanceKey[],
  keyToRef: Map<string, { file_key: string; node_id: string }>,
  mappingByRef: Map<string, MappingHit>,
): Record<string, CodeConnectSnippet> {
  const out: Record<string, CodeConnectSnippet> = {};
  for (const { nodeId, componentKey } of pairs) {
    const ref = keyToRef.get(componentKey);
    if (!ref) continue;
    const hit = mappingByRef.get(`${ref.file_key}|${ref.node_id}`);
    if (!hit) continue;
    out[nodeId] = {
      component: hit.component_name, source: hit.source, label: hit.label,
      imports: hit.template_data.imports, props: hit.template_data.props, template: hit.template,
    };
  }
  return out;
}
