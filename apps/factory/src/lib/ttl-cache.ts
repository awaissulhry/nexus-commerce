/**
 * F1 — in-process TTL cache with LRU eviction (EH.4 pattern, reimplemented).
 * Two sanctioned key shapes:
 *   pure TTL          — `${scope}:${id}`
 *   updatedAt-keyed   — `${id}:${updatedAtMs}` (row edits change the key; no
 *                       explicit invalidation ever needed)
 */
export class TtlCache<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // re-insert so Map insertion order becomes true LRU
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.maxEntries && !this.map.has(key)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}
