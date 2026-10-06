/**
 * AM-34 — a screen's "Refresh view" must not hand back the answer it already had.
 *
 * The ads read cache keeps an answer for up to five minutes (memory first, then Redis). A refresh asks with
 * `refresh: true`: neither tier is read, the answer is computed now, and it is stored so the next ordinary read sees
 * the fresh answer too.
 */
import { describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.mock('../../lib/queue.js', () => ({
  redis: {
    connection: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK' }),
    },
  },
}))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { cached } from './ads-cache.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

describe('ads read cache — refresh', () => {
  it('an ordinary read returns the cached answer; a refresh computes a new one and stores it', async () => {
    const key = `refresh-test:${Math.random()}`
    expect(await inside(() => cached(key, 300, async () => 'first'))).toBe('first')
    // Cached: the second producer never runs.
    const second = vi.fn(async () => 'second')
    expect(await inside(() => cached(key, 300, second))).toBe('first')
    expect(second).not.toHaveBeenCalled()
    // Refresh: skips both tiers and runs the producer.
    const third = vi.fn(async () => 'third')
    expect(await inside(() => cached(key, 300, third, { refresh: true }))).toBe('third')
    expect(third).toHaveBeenCalledOnce()
    // …and what it computed is what the next ordinary read gets.
    expect(await inside(() => cached(key, 300, async () => 'fourth'))).toBe('third')
  })

  it('a refresh also skips an answer held only in Redis', async () => {
    const key = `refresh-redis:${Math.random()}`
    await inside(() => cached(key, 300, async () => 'old'))
    // Put a different value in L2 only; L1 still holds "old". A refresh must read neither.
    for (const k of store.keys()) if (k.endsWith(key)) store.set(k, JSON.stringify('stale-in-redis'))
    expect(await inside(() => cached(key, 300, async () => 'new', { refresh: true }))).toBe('new')
  })
})
