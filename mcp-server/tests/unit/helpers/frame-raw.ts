import type { FigmaApi } from '../../../src/ports/figma-api.js';

/**
 * Wrap a getNodesRaw-only mock so it also answers getFrameRaw (fetch at requestedMaxDepth+1),
 * mirroring FigmaRestAdapter's passthrough. Lets tool harnesses keep asserting on getNodesRaw while
 * the tools call getFrameRaw. If the mock already defines getFrameRaw, that wins.
 */
export function withFrameRaw(api: Partial<FigmaApi>): Partial<FigmaApi> {
  return {
    ...api,
    getFrameRaw: api.getFrameRaw ?? (async (fileKey, ids, requestedMaxDepth) => {
      const raw = await api.getNodesRaw!(fileKey, ids, requestedMaxDepth + 1);
      return { raw, heldDepth: requestedMaxDepth + 1, hydrated: false, effectiveMaxDepth: requestedMaxDepth };
    }),
  };
}
