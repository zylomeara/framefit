// mcp-server/src/infrastructure/response-size.ts
// WeakMap side-channel carrying each cached Figma response's wire-byte size from where it's known
// (figma-rest.ts, at parse time — the byte count readCapped already produced) to where the cache
// decides whether to hold it (caching-figma-api.ts .set sites). WeakMap (not a field on the value) keeps
// the port/domain types untouched and is GC-safe: when the response object is evicted and unreferenced,
// its size entry is collected too. Object identity is preserved from request() through dedup (one shared
// promise → one object) to the .set site.
const sizes = new WeakMap<object, number>();

export function tagBytes(v: unknown, n: number): void {
  if (v !== null && typeof v === 'object') sizes.set(v, n);
}

export function sizeOf(v: unknown): number {
  if (v === null || typeof v !== 'object') return 0;
  return sizes.get(v) ?? 0;
}
