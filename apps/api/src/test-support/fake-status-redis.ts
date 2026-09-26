import type { StatusRedis } from '../lib/runtime-status/process-snapshot.js'

/**
 * The Redis commands lib/runtime-status uses, in memory, with PX expiry on a clock the test controls.
 * The runtime-status suites run against real Redis when NEXUS_TEST_REDIS_URL is set; this keeps them
 * measuring something where it is not (CI's profiles-on pass has no Redis).
 */
export class FakeStatusRedis implements StatusRedis {
  status = 'ready'
  now = () => Date.now()
  private strings = new Map<string, { value: string; expiresAt: number | null }>()
  private sets = new Map<string, Set<string>>()

  private live(key: string) {
    const entry = this.strings.get(key)
    if (entry && entry.expiresAt !== null && entry.expiresAt <= this.now()) this.strings.delete(key)
    return this.strings.get(key)
  }

  async set(key: string, value: string, _mode: 'PX', ttlMs: number) {
    this.strings.set(key, { value, expiresAt: this.now() + ttlMs })
    return 'OK'
  }
  async get(key: string) {
    return this.live(key)?.value ?? null
  }
  async sadd(key: string, ...members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>()
    members.forEach(member => set.add(member))
    this.sets.set(key, set)
    return members.length
  }
  async srem(key: string, ...members: string[]) {
    members.forEach(member => this.sets.get(key)?.delete(member))
    return members.length
  }
  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])]
  }
  async mget(...keys: string[]) {
    return keys.map(key => this.live(key)?.value ?? null)
  }
  async del(...keys: string[]) {
    keys.forEach(key => { this.strings.delete(key); this.sets.delete(key) })
    return keys.length
  }
  async incr(key: string) {
    const next = Number(this.live(key)?.value ?? 0) + 1
    this.strings.set(key, { value: String(next), expiresAt: null })
    return next
  }
}
