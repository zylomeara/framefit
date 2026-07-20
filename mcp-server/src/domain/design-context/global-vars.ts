// mcp-server/src/domain/design-context/global-vars.ts
// Interns repeated style values (fills, text styles, effects) into short refs so
// the simplified tree carries `fill_0` instead of the same hex 50 times. The
// agent reads the value once from the globalVars dictionary.
export class GlobalVarStore {
  private byPrefix = new Map<string, { keys: Map<string, string>; next: number }>();
  private values: Record<string, unknown> = {};

  intern(prefix: string, value: unknown): string {
    let bucket = this.byPrefix.get(prefix);
    if (!bucket) {
      bucket = { keys: new Map(), next: 0 };
      this.byPrefix.set(prefix, bucket);
    }
    const canonical = JSON.stringify(value);
    const existing = bucket.keys.get(canonical);
    if (existing) return existing;
    const ref = `${prefix}_${bucket.next++}`;
    bucket.keys.set(canonical, ref);
    this.values[ref] = value;
    return ref;
  }

  dump(): Record<string, unknown> {
    return this.values;
  }
}
