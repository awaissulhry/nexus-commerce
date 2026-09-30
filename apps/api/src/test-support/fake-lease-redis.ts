/**
 * An in-memory stand-in for the Redis commands a lease uses (`services/etsy/listing-lock.ts`): `SET key value PX ttl NX`
 * and the two compare-and-act scripts, with expiry on the real clock. Only those scripts are understood; any other
 * `eval` throws, so a test cannot pass by the fake quietly agreeing to something Redis would do differently.
 */
import { RELEASE_SCRIPT, RENEW_SCRIPT, type ListingLockStore } from '../services/etsy/listing-lock.js'

export class FakeLeaseRedis implements ListingLockStore {
  status = 'ready'
  private readonly entries = new Map<string, { value: string; expiresAt: number }>()
  /** Every command, in order, for assertions. */
  readonly log: string[] = []

  private live(key: string) {
    const entry = this.entries.get(key)
    if (entry && entry.expiresAt <= Date.now()) { this.entries.delete(key); return undefined }
    return entry
  }

  get(key: string): string | null { return this.live(key)?.value ?? null }

  /** Put a lease in place as another (possibly dead) holder would have. */
  hold(key: string, value: string, ttlMs: number) { this.entries.set(key, { value, expiresAt: Date.now() + ttlMs }) }

  async set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null> {
    if (px !== 'PX' || nx !== 'NX') throw new Error('FakeLeaseRedis understands SET key value PX ttl NX only')
    this.log.push(`SET ${key}`)
    if (this.live(key)) return null
    this.entries.set(key, { value, expiresAt: Date.now() + Number(ttlMs) })
    return 'OK'
  }

  async eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<number> {
    const [key, token, ttl] = args.map(String)
    if (numberOfKeys !== 1) throw new Error('FakeLeaseRedis: one key only')
    const entry = this.live(key)
    if (script === RENEW_SCRIPT) {
      this.log.push(`RENEW ${key}`)
      if (entry?.value !== token) return 0
      entry.expiresAt = Date.now() + Number(ttl)
      return 1
    }
    if (script === RELEASE_SCRIPT) {
      this.log.push(`RELEASE ${key}`)
      if (entry?.value !== token) return 0
      this.entries.delete(key)
      return 1
    }
    throw new Error('FakeLeaseRedis: unknown script')
  }
}
