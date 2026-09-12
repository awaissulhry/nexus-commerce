import { workspaceContext } from './workspace-context.js'

/** Bounded per-profile buckets. A cached resource ID never bypasses profile ownership. */
export class WorkspaceCache<K, V> implements Map<K, V> {
  readonly [Symbol.toStringTag] = 'WorkspaceCache'
  private readonly buckets = new Map<string, Map<K, V>>()
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
  set(key: K, value: V): this { this.bucket().set(key, value); return this }
  delete(key: K) { return this.bucket().delete(key) }
  clear() { if (workspaceContext()) this.bucket().clear(); else this.buckets.clear() }
  entries() { return this.bucket().entries() }
  keys() { return this.bucket().keys() }
  values() { return this.bucket().values() }
  [Symbol.iterator]() { return this.entries() }
  forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void { this.bucket().forEach((value, key) => callback.call(thisArg, value, key, this)) }
}
