// The MT userGraph -> ToolDeps.variableGraph port, extracted from server.ts's deps assembly so
// the wiring is UNIT-TESTABLE. The wave caught exactly the silent failure this prevents: the
// cssEvidence method was added to the port type and the single-tenant wrapper, imported by
// server.ts - and never wired into the MT branch; tsc stayed green (no noUnusedLocals), every
// test built deps directly, and the feature shipped dead on the primary deployment. A factory
// with its own test makes a half-wired MT port impossible to ship silently.
import {
  resolveKey as resolveKeyFn, resolveKeyModes, resolveKeyInMode, keyIsMultiMode,
  graphCssEvidenceView, type Graph,
} from '../domain/variable-graph.js';
import type { ToolDeps } from '../adapters/driving/tools/get-comments-tool.js';

export function userGraphPort(userGraph: Graph): NonNullable<ToolDeps['variableGraph']> {
  return {
    resolve: (key: string) => {
      const r = resolveKeyFn(userGraph, key);
      if (r.value === undefined) return undefined;
      const m = resolveKeyModes(userGraph, key);
      const multi = m && Object.keys(m.modesByName).length > 1;
      return {
        // byKey is stored lower-cased (buildGraphMaps); normalize the lookup key so a
        // mixed-case published key still finds its source fileKey (raw get was a latent
        // mixed-case miss -> sourceLibrary silently undefined). Mirrors env-graph.ts's resolve.
        value: r.value, name: r.name, sourceLibrary: userGraph.byKey.get(key.toLowerCase())?.fileKey,
        ...(multi ? { modesByName: m!.modesByName } : {}),
      };
    },
    resolveInMode: (key: string, modeByCollection: Map<string, string>, coverageComplete?: boolean) =>
      resolveKeyInMode(userGraph, key, modeByCollection, coverageComplete),
    isMultiMode: (key: string) => keyIsMultiMode(userGraph, key),
    cssEvidence: (referencedKeys: string[], excludeFileKey?: string) =>
      graphCssEvidenceView(userGraph, referencedKeys, excludeFileKey),
  };
}
