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
  it('evicts old business buckets without returning another business’s cached values', () => {
    const cache = new WorkspaceCache<string, number>()
    for (let i = 0; i < 65; i++) inside(`business-${i}`, () => cache.set('same-key', i))
    expect(inside('business-64', () => cache.get('same-key'))).toBe(64)
    expect(inside('business-0', () => cache.get('same-key'))).toBeUndefined()
    expect(inside('business-63', () => cache.get('same-key'))).toBe(63)
  })
})
