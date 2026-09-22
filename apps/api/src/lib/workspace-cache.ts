import { workspaceContext } from './workspace-context.js'

/** Bounded per-profile buckets. A cached resource ID never bypasses profile ownership. */
export class WorkspaceCache<K, V> implements Map<K, V> {
  readonly [Symbol.toStringTag] = 'WorkspaceCache'
  private readonly buckets = new Map<string, Map<K, V>>()
  /**
   * The bucket COUNT is bounded below; each bucket's contents were not. A cache whose key carries
   * per-user or per-product parts therefore grew without limit for the life of the process.
   *
   * `maxEntriesPerWorkspace` bounds ONE workspace's bucket, and it is opt-in: the default keeps
   * every existing caller byte-identical. It is opt-in on purpose — `idempotency.service.ts`
   * already carries its own, much larger bound, and for that caller a dropped entry is a repeated
   * write, not a slower read. A cap must be chosen by the caller that knows the cost of a miss.
   */
  constructor(readonly maxEntriesPerWorkspace: number = Number.POSITIVE_INFINITY) {}
  private bucket(): Map<K, V> {
    const key = workspaceContext()?.workspaceId ?? 'global'
    let bucket = this.buckets.get(key)
    if (bucket) this.buckets.delete(key)
    else bucket = new Map<K, V>()
    if (this.buckets.size >= 64) this.buckets.delete(this.buckets.keys().next().value!)
    this.buckets.set(key, bucket)
    return bucket
  }
  get size() { return this.bucket().size }
  get(key: K) { return this.bucket().get(key) }
  has(key: K) { return this.bucket().has(key) }
  set(key: K, value: V): this {
    const bucket = this.bucket()
    if (Number.isFinite(this.maxEntriesPerWorkspace)) {
      // Re-inserting moves a refreshed key to the newest slot; a plain `set` would leave it at its
      // original position and evict it early. `size > 0` keeps a cap of 0 from spinning on an
      // empty bucket.
      bucket.delete(key)
      while (bucket.size >= this.maxEntriesPerWorkspace && bucket.size > 0) bucket.delete(bucket.keys().next().value!)
    }
    bucket.set(key, value)
    return this
  }
  delete(key: K) { return this.bucket().delete(key) }
  clear() { if (workspaceContext()) this.bucket().clear(); else this.buckets.clear() }
  entries() { return this.bucket().entries() }
  keys() { return this.bucket().keys() }
  values() { return this.bucket().values() }
  [Symbol.iterator]() { return this.entries() }
  forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void { this.bucket().forEach((value, key) => callback.call(thisArg, value, key, this)) }
}
