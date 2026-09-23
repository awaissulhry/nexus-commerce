import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * A-36 (Step 3.5a) — the product list's "Differs on the channel" filter (`channelDrift=true`), on PGlite.
 * It narrows BOTH list paths (the live table and the read cache) to the products with a drifted listing and their
 * parents; the old `driftOnly` filter still means "has overrides" and is untouched.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
// The list's stats cache writes through Redis: an in-memory stand-in, so a cached count cannot leak between the two calls.
vi.mock('../../lib/queue.js', () => {
  const store = new Map<string, string>()
  const connection = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => { store.set(k, v); return 'OK' },
    del: async (...keys: string[]) => { keys.forEach(k => store.delete(k)); return keys.length } }
  return { outboundSyncQueue: null, redis: { connection }, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { listProducts, resolveProductsScope } from './list-products.service.js'
import { recordChannelReadback } from '../channel-drift.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids = { parent: '', child: '', clean: '' }

beforeAll(() => scoped(async () => {
  ids.parent = (await prisma.product.create({ data: { sku: 'cd-parent', name: 'Parent', basePrice: 10, isParent: true } })).id
  ids.child = (await prisma.product.create({ data: { sku: 'cd-child', name: 'Child', basePrice: 10, parentId: ids.parent } })).id
  ids.clean = (await prisma.product.create({ data: { sku: 'cd-clean', name: 'Clean', basePrice: 10 } })).id
  const drifted = await prisma.channelListing.create({ data: { productId: ids.child, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU' } })
  const matching = await prisma.channelListing.create({ data: { productId: ids.clean, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU' } })
  await recordChannelReadback({ channelListingId: drifted.id, channel: 'AMAZON', marketplace: 'IT', source: 'report', compared: ['quantity'], differing: [{ field: 'quantity', ours: 4, theirs: 0 }] })
  await recordChannelReadback({ channelListingId: matching.id, channel: 'AMAZON', marketplace: 'IT', source: 'report', compared: ['quantity'], differing: [] })
}), 60_000)
afterAll(async () => { await state.db?.close() })

it('🔴 both list paths are narrowed to the drifted listing\'s product and its parent', async () => {
  const scope = await scoped(() => resolveProductsScope({ channelDrift: 'true' } as never))
  const inList = (clauses: any[] | undefined) => (clauses ?? []).find((c: any) => c?.id?.in)?.id.in?.slice().sort()
  expect(inList(scope.where.AND)).toEqual([ids.parent, ids.child].sort())
  if (scope.useCache) expect(inList(scope.cacheWhere.AND)).toEqual([ids.parent, ids.child].sort())
})

it('🔴 the READ-CACHE path too: with the cache filled by its real writer, the list takes it and is still narrowed', async () => {
  await scoped(() => productReadCacheService.refreshMany([ids.parent, ids.child, ids.clean]))
  const scope = await scoped(() => resolveProductsScope({ channelDrift: 'true' } as never))
  // Positive control: this arm is about the cache path, so it must be the path taken.
  expect(scope.useCache).toBe(true)
  expect((scope.cacheWhere.AND ?? []).find((c: any) => c?.id?.in)?.id.in.slice().sort()).toEqual([ids.parent, ids.child].sort())
  const run = (q: Record<string, string>) => scoped(() => listProducts(q as never)).then((r: any) => r.body.products.map((p: any) => p.sku).sort())
  expect(await run({ channelDrift: 'true' })).toEqual(['cd-parent'])
})

it('🔴 end to end: the list shows the parent of the drifted child, not the clean product; without the filter it shows both', async () => {
  const run = (q: Record<string, string>) => scoped(() => listProducts(q as never)).then((r: any) => r.body.products.map((p: any) => p.sku).sort())
  expect(await run({ channelDrift: 'true' })).toEqual(['cd-parent'])
  expect(await run({})).toEqual(['cd-clean', 'cd-parent'])
})
