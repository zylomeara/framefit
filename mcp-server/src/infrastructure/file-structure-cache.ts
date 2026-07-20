import type { FileStructure } from '../domain/file-structure.js';

type Entry = { structure: FileStructure; expiresAt: number };

export class FileStructureCache {
  private map = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    // This cache had NO size bound (the only fully-unbounded read cache). Its entries are small built
    // depth-2 skeletons (untagged → the byte-budget can't weigh them), so bound it by COUNT like TtlCache.
    // NOT budget-wired: a 0-byte budget entry would be mock coverage, not a real bound.
    private readonly maxEntries = 1000,
  ) {}

  get(fileKey: string): FileStructure | null {
    const e = this.map.get(fileKey);
    if (!e) return null;
    if (e.expiresAt < this.now()) {
      this.map.delete(fileKey);
      return null;
    }
    return e.structure;
  }

  set(fileKey: string, structure: FileStructure): void {
    this.map.delete(fileKey); // refresh insertion recency on replace
    this.map.set(fileKey, { structure, expiresAt: this.now() + this.ttlMs });
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}
