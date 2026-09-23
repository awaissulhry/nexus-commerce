import { describe, expect, it } from 'vitest'
import { WorkspaceCache } from './workspace-cache.js'
import { withWorkspace } from './workspace-context.js'

const inside = <T>(id: string, fn: () => T) => withWorkspace({ workspaceId: id, actorUserId: null, membershipId: null, roleKeys: [] }, fn)
describe('business cache boundaries', () => {
  it('separates identical keys across interleaved asynchronous requests', async () => {
    const cache = new WorkspaceCache<string, string>()
    await Promise.all(['business-a', 'business-b'].map(id => inside(id, async () => {
      cache.set('shared-sku', id)
      await Promise.resolve()
      expect(cache.get('shared-sku')).toBe(id)
      expect([...cache.values()]).toEqual([id])
    })))
    expect(cache.get('shared-sku')).toBeUndefined()
    inside('business-a', () => cache.clear())
    expect(inside('business-a', () => cache.size)).toBe(0)
    expect(inside('business-b', () => cache.get('shared-sku'))).toBe('business-b')
  })
  it('bounds one business bucket when a cap is asked for, and leaves an uncapped cache unbounded', () => {
    const capped = new WorkspaceCache<string, number>(4)
    inside('business-a', () => {
      for (let i = 0; i < 5; i++) capped.set(`k${i}`, i)
      expect(capped.size).toBe(4)
      expect(capped.get('k0')).toBeUndefined() // the oldest write is the one that goes
      expect([...capped.keys()]).toEqual(['k1', 'k2', 'k3', 'k4'])
    })
    // The cap is per business. One busy business must not evict another's entries.
    inside('business-b', () => { capped.set('k0', 100); expect(capped.size).toBe(1) })
    inside('business-a', () => expect(capped.size).toBe(4))

    // 🔴 The default must stay unbounded: idempotency carries its own, much larger bound, and a
    // silent cap there is a repeated write, not a slower read.
    const uncapped = new WorkspaceCache<string, number>()
    inside('business-a', () => {
      for (let i = 0; i < 200; i++) uncapped.set(`k${i}`, i)
      expect(uncapped.size).toBe(200)
    })
  })
  it('refreshes a key in place instead of evicting a different entry to make room for it', () => {
    const capped = new WorkspaceCache<string, number>(3)
    inside('business-a', () => {
      capped.set('a', 1); capped.set('b', 2); capped.set('c', 3)
      capped.set('b', 9) // a REFRESH: the bucket does not grow, so nothing may be evicted for it
      expect(capped.size).toBe(3)
      expect(capped.get('a')).toBe(1)
      expect([...capped.keys()]).toEqual(['a', 'c', 'b']) // and the refreshed key is now the newest
      capped.set('d', 4) // 'a' is the oldest now, so 'a' is the one that goes
      expect([...capped.keys()]).toEqual(['c', 'b', 'd'])
    })
  })
  it('A-15 — reports its business count without CREATING or reordering a bucket', () => {
    const cache = new WorkspaceCache<string, number>(4)
    // An empty cache asked for its count must still be empty. `bucket()` would have made one.
    expect(cache.businesses).toEqual({ held: 0, max: 64 })
    inside('business-a', () => cache.set('k', 1))
    inside('business-b', () => cache.set('k', 2))
    expect(cache.businesses.held).toBe(2)
    // 🔴 The arm that matters: asking FROM a business that has no bucket must not give it one.
    inside('business-c', () => expect(cache.businesses.held).toBe(2))
    expect(inside('business-a', () => cache.get('k'))).toBe(1)
  })
  it('evicts old business buckets without returning another business’s cached values', () => {
    const cache = new WorkspaceCache<string, number>()
    for (let i = 0; i < 65; i++) inside(`business-${i}`, () => cache.set('same-key', i))
    expect(inside('business-64', () => cache.get('same-key'))).toBe(64)
    expect(inside('business-0', () => cache.get('same-key'))).toBeUndefined()
    expect(inside('business-63', () => cache.get('same-key'))).toBe(63)
  })
})
