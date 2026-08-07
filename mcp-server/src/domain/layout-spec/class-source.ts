// class-source.ts — deterministic parse of CSS-modules classes into a code address.
// ETHOS: a false positive (navigation to a non-existent file) is WORSE than a missing hint —
// a hash with a digit is mandatory; anything uncertain → null. The P1→P2→P3 order is load-bearing
// (P2 without the guard would eat turbopack classes with a garbage parse).
export interface SourceHint { module?: string; local: string; raw: string }

// The hash is base64url — `_` is in the alphabet (a live run produced 6-char hashes with an
// underscore, and the parser answered "not a CSS module" exactly on the code under review).
// LAZY quantifier: the FIRST `__` ends the hash, so a local that itself contains `__` keeps its
// full name instead of donating its head to the hash.
const P1_TURBOPACK = /^(.+?)-module-(s?css|sass|less)-module__[A-Za-z0-9_-]+?__(.+)$/;
// digit-lookahead: the tail must contain a digit, otherwise `grid_col__spacing_lg` parses.
// A conscious FN: fully alphabetic base64 hashes → null (FP worse than FN).
// The P1→P2 ORDER is the only guard against a P2 stub eating turbopack classes
// (the negative-lookahead was removed as mutually-masking redundancy).
// The hash tail is PURE alphanumeric with a digit (no _/-): underscores in the tail give away
// a utility/BEM (`col_span__grid_12`), not a hash. A conscious FP residual:
// a word-with-a-digit (`bold700`) is indistinguishable from a hash by regex — it hedges the
// consumer rule "the resolve is not confirmed until the file is actually found".
const P2_WEBPACK = /^([A-Za-z][\w-]*?)_{1,2}([A-Za-z][\w-]*?)_{2,3}(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{5,}$/;
const P3_VITE = /^_([a-z][\w-]+)_(?=[a-z0-9]*[0-9])[a-z0-9]{5,}$/;

export function parseCssModuleClass(cls: string): SourceHint | null {
  const m1 = P1_TURBOPACK.exec(cls);
  if (m1) return { module: `${m1[1]}.module.${m1[2]}`, local: m1[3], raw: cls };
  const m2 = P2_WEBPACK.exec(cls);
  if (m2) return { module: m2[1], local: m2[2], raw: cls };
  const m3 = P3_VITE.exec(cls);
  if (m3) return { local: m3[1], raw: cls };
  return null;
}

// The first successful parse; with several parses of the SAME module we prefer the local without
// the "--" BEM modifier (variant--x is a valid local, but a useless edit address).
export function hintForNode(classList: string[] | undefined): SourceHint | null {
  if (!classList?.length) return null;
  const hints = classList.map(parseCssModuleClass).filter((h): h is SourceHint => h !== null);
  if (hints.length === 0) return null;
  const first = hints[0];
  if (first.local.includes('--')) {
    const better = hints.find((h) => h.module === first.module && !h.local.includes('--'));
    if (better) return better;
  }
  return first;
}
