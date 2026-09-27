import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Product-sheet create path, step 4 — two concurrent FIRST theme saves (version 0, "I saw no listing") on a coordinate
 * where the family has no listing: one starts the draft and saves its theme, the other gets a 409, and nothing is
 * written over the winner.
 *
 * On `concurrent-database.ts`, never PGlite: PGlite is one connection, so it serialises the two saves and the test would
 * pass whether or not the write is safe. The race is FORCED, not hoped for: a third connection holds a SHARE lock on
 * "ChannelListing", so both saves read "no listing here" and then block on the draft insert; the test waits until
 * PostgreSQL reports both of them waiting before it releases the lock. The application client is the restricted runtime
 * login (row security enforced). Every id is invented.
 *
 * Run: node scripts/run-real-postgres-tests.mjs (it starts a throwaway PostgreSQL 17 and sets NEXUS_TEST_CONCURRENT_PG_URL).
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`family-projection-postgres: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
const DEFINITION = vi.hoisted(() => {
  const attribute = () => ({ type: 'array', minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } })
  return { type: 'object', properties: { item_name: attribute(), color: attribute(), size: attribute(),
    variation_theme: { type: 'array', minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', properties: { name: { type: 'string', enum: ['COLOR/SIZE', 'SIZE/COLOR'] } }, required: ['name'] } } } }
})
vi.mock('../categories/seller-schema.service.js', async () => {
  const { amazonSpecFromDefinition } = await import('./channel-specs/amazon.js')
  return { amazonSellerSpec: async (_account: string, marketplace: string, productType: string) => amazonSpecFromDefinition({ marketplace, productType, fetchedAt: new Date(), schemaVersion: 'fixture', schemaDefinition: DEFINITION }) }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeProjectionMapping } from './family-projection.service.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl, raceChannelListingInserts } from '../../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}

describe.skipIf(!concurrentDatabaseUrl())(`the first theme save on a new market — concurrent saves (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => {
    state.db = await concurrentDatabase()
    await scoped(async () => {
      await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'SE', name: 'Sweden', currency: 'SEK', region: 'EU', language: 'sv', languages: ['sv'], marketplaceId: 'FAKE-SE-ID' } as never })
      ids.account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'race', isActive: true, isPrimary: true,
        externalAccountId: 'SELLER-RACE', authStatus: 'connected', managedBy: 'oauth' } as never })).id
      await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'SE', productType: 'OUTERWEAR', schemaVersion: 'fixture', schemaDefinition: DEFINITION as never, expiresAt: new Date('2099-01-01') } })
      ids.parent = (await prisma.product.create({ data: { sku: 'PJ-RACE', name: 'race', basePrice: 10, isParent: true, productType: 'OUTERWEAR', variationAxes: ['Color', 'Size'] } as never })).id
      for (const [variant, color, size] of [['A', 'Red', 'S'], ['B', 'Blue', 'M']]) {
        ids[variant] = (await prisma.product.create({ data: { sku: `PJ-RACE-${variant}`, name: `race ${variant}`, basePrice: 10, parentId: ids.parent,
          productType: 'OUTERWEAR', categoryAttributes: { variations: { Color: color, Size: size } } } as never })).id
      }
    })
  }, 120_000)
  afterAll(async () => { await state.db?.close() }, 60_000)

  it('one save starts the draft and stores its theme; the other is a version conflict, never a write over it', async () => {
    const save = (theme: string) => () => writeProjectionMapping({ productId: ids.parent, channel: 'AMAZON', market: 'SE', accountId: ids.account, includeOrder: false, expectedVersion: 0, theme })
    // Both saves must be blocked on the draft insert before the lock is released (the helper's positive control).
    const settled: Array<{ value?: unknown; error?: any }> = await raceChannelListingInserts(state.db, [save('SIZE/COLOR'), save('COLOR/SIZE')].map(call => () => scoped(call)))
    const won = settled.filter(outcome => !('error' in outcome))
    const lost = settled.filter(outcome => 'error' in outcome)
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0].error).toMatchObject({ code: 'version_conflict', statusCode: 409 })

    const rows = await scoped(() => prisma.channelListing.findMany({ where: { productId: { in: [ids.parent, ids.A, ids.B] } } }))
    expect(rows).toHaveLength(3)   // ONE set
    expect(rows.every(row => row.syncPaused && row.listingStatus === 'DRAFT' && row.channelConnectionId === ids.account)).toBe(true)
    const parent = rows.find(row => row.productId === ids.parent)!
    const winner = (won[0].value as { theme: { value: string | null } | null; version: number })
    expect(parent.variationTheme).toBe(winner.theme?.value)
    expect(parent.version).toBe(winner.version)
    expect(parent.version).toBe(2)   // created at 1, one theme write — the loser wrote nothing
  }, 120_000)
})
