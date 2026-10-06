/**
 * CM-34 — after Save, the campaign detail page shows what was saved.
 *
 * The detail endpoint is cached for 300 s, with an in-process copy (L1) on every API instance. The flush after a write
 * runs on the instance that took the write, after its answer was sent, so the page's immediate re-read could get the
 * copy from before the save and the form snapped back. The page now re-reads with `fresh=1`, which skips both cache
 * reads and stores the fresh answer.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Redis unreachable: only the in-process copy is in play, as on an instance whose L1 holds the old answer.
vi.mock('../../lib/queue.js', () => ({
  redis: { connection: { get: async () => { throw new Error('down') }, set: async () => { throw new Error('down') }, scan: async () => ['0', []], del: async () => 0 } },
}))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { cached as cachedOutside } from './ads-cache.js'

// The cache is per business profile: every call runs inside one, as a request does.
const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const cached = <T>(key: string, ttl: number, fn: () => Promise<T>, opts?: { refresh?: boolean }) =>
  withWorkspace(business, () => cachedOutside(key, ttl, fn, opts))

describe('CM-34 — a fresh read skips the cached copy', () => {
  it('a normal read returns the copy from before the save; a fresh read returns the saved values and keeps them', async () => {
    const key = `detail:test-${Date.now()}`
    expect(await cached(key, 300, async () => ({ name: 'Old' }))).toEqual({ name: 'Old' })
    // The save changed the row, but this instance's copy is still the old one.
    expect(await cached(key, 300, async () => ({ name: 'Saved' }))).toEqual({ name: 'Old' })
    expect(await cached(key, 300, async () => ({ name: 'Saved' }), { refresh: true })).toEqual({ name: 'Saved' })
    // …and the fresh answer is what later reads get.
    expect(await cached(key, 300, async () => ({ name: 'Other' }))).toEqual({ name: 'Saved' })
  })

  it('the detail route reads fresh on `fresh=1` and is not cached by the browser then', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'routes', 'advertising.routes.ts'), 'utf8')
    expect(src).toMatch(/const fresh = q\.fresh === '1'/)
    expect(src).toMatch(/\}, \{ refresh: fresh \}\)/)
    expect(src).toMatch(/reply\.header\('Cache-Control', fresh \? 'no-store' : 'private, max-age=20'\)/)
  })
})
