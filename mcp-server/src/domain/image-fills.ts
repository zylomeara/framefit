import type { RawSceneNode } from './figma-raw.js';

/** Collect the distinct imageRefs of IMAGE-type fills across a node subtree (fills only — strokes
 * are not source images, matching the official download_assets). Used to extract the original
 * uploaded source images referenced by a node. */
export function collectImageRefs(root: RawSceneNode): string[] {
  const refs = new Set<string>();
  const walk = (n: RawSceneNode): void => {
    for (const p of n.fills ?? []) {
      if (p.type === 'IMAGE' && p.imageRef) refs.add(p.imageRef);
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return [...refs];
}
