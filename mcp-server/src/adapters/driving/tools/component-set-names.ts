// componentSetId → set name ("listItem"). META-FIRST path: the /nodes response already carries
// componentSets {id → {name}} for both local and remote — zero REST. The fallback cascade
// (getComponent(key) → file_key → getFileComponentSets) remains ONLY for setIds not covered by
// the meta: the published-only endpoint 404s on unpublished components, and before allSettled a
// single such 404 muted the names of the WHOLE file (root of the perennial component-warn). Errors never crash the tool.
import type { FigmaApi } from '../../../ports/figma-api.js';
import type { ComponentRefMeta } from '../../../domain/figma-raw.js';
import type { Logger } from '../../../infrastructure/logger.js';

interface NodesEntryMeta {
  components?: Record<string, ComponentRefMeta>;
  componentSets?: Record<string, ComponentRefMeta>;
}

export async function buildSetNames(
  api: FigmaApi,
  entry: NodesEntryMeta | null | undefined,
  logger: Logger,
): Promise<Map<string, string>> {
  const setNames = new Map<string, string>();
  for (const [id, m] of Object.entries(entry?.componentSets ?? {})) {
    if (m?.name) setNames.set(id, m.name); // a set without a name is NOT covered — its setId falls through to the fallback scope
  }
  const uncovered = Object.fromEntries(
    Object.entries(entry?.components ?? {}).filter(([, r]) => r?.componentSetId && !setNames.has(r.componentSetId)),
  );
  const fromApi = await resolveSetNames(api, uncovered, logger);
  for (const [id, name] of fromApi) if (!setNames.has(id)) setNames.set(id, name); // meta takes priority
  return setNames;
}

export async function resolveSetNames(
  api: FigmaApi,
  componentRefs: Record<string, ComponentRefMeta> | undefined,
  logger: Logger,
): Promise<Map<string, string>> {
  const setNames = new Map<string, string>();
  const withSet = Object.values(componentRefs ?? {}).filter((r) => r?.componentSetId && r.key);
  if (!withSet.length) return setNames;
  try {
    const fileKeys = new Set<string>();
    const keyResults = await Promise.allSettled([...new Set(withSet.map((r) => r.key))].map(async (key) => {
      const meta = await api.getComponent(key);
      if (meta.file_key) fileKeys.add(meta.file_key);
    }));
    const setResults = await Promise.allSettled([...fileKeys].map(async (fk) => {
      for (const s of await api.getFileComponentSets(fk)) setNames.set(s.node_id, s.name);
    }));
    const failed = [...keyResults, ...setResults].filter((r) => r.status === 'rejected').length;
    if (failed) logger.info({ failed }, 'layout_spec.set_names_partial');
  } catch (err) {
    logger.info({ err: (err as Error).message }, 'layout_spec.set_names_unavailable');
  }
  return setNames;
}
