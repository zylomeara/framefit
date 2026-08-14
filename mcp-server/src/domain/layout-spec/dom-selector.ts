const CHILD_PATH = /^> :nth-child\([1-9]\d*\)(?: > :nth-child\([1-9]\d*\))*$/;
const MAX_SELECTOR_LENGTH = 2_048;

// A DOM child path is relative to the captured root. Compose it only with the root selector
// the extractor already proved unique. :is() keeps selector-list roots grouped: a bare
// `.a, .b > ...` would address `.a` itself or a descendant of `.b`. Transparent
// display:contents wrappers can extend a canonical path without consuming capture depth; the output
// cap bounds that path and keeps pre-clamp blockers within the response budget.
export const domSelector = (root: string | undefined, path: string): string | undefined => {
  const scopedRoot = root?.trim();
  const childPath = path.trim();
  if (!scopedRoot || !CHILD_PATH.test(childPath)) return undefined;
  const selector = `:is(${scopedRoot}) ${childPath}`;
  return selector.length <= MAX_SELECTOR_LENGTH ? selector : undefined;
};
