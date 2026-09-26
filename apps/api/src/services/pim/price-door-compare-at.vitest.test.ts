/**
 * NCF D2 A — Shopify's compare-at price through the ONE price door, record-only (it comes from Shopify's own file).
 * Real PostgreSQL in-process (PGlite), the pattern of `price-door-record-only.vitest.test.ts`.
 */
import { beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn() } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeChannelPrices } from './channel-price-write.service.js'
import { storedCompareAt } from './compare-at-price.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let store = '', ebay = ''
beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  store = (await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', accountLabel: 'compare-at', isActive: true } })).id
  ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'compare-at ebay', isActive: true } })).id
}))
async function seed(id: string, channel: 'SHOPIFY' | 'EBAY' = 'SHOPIFY') {
  await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 10 } })
  return prisma.channelListing.create({ data: { productId: id, channel, channelConnectionId: channel === 'SHOPIFY' ? store : ebay, channelMarket: channel === 'SHOPIFY' ? 'SHOPIFY_GLOBAL' : 'EBAY_IT',
    marketplace: channel === 'SHOPIFY' ? 'GLOBAL' : 'IT', region: 'EU', price: null, priceOverride: null, followMasterPrice: true, syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS',
    platformAttributes: { shopifyCompareAtPrice: 50, vendor: 'ACME' } } })
}
const write = (listingId: string, version: number, target: Record<string, unknown>, extra: Record<string, unknown> = { recordOnly: 'channel-file-import' }) =>
  writeChannelPrices({ targets: [{ listingId, expectedVersion: version, ...target }], actor: 'channel file', source: 'CHANNEL_FILE_IMPORT', reason: 'Channel file import (job test)', ...extra } as never)

it('records the compare-at price where the Shopify spec reads it, with its audit, and sends nothing', () => scoped(async () => {
  const listing = await seed('compare-at-applied')
  expect(storedCompareAt(listing.platformAttributes)).toEqual({ state: 'stored', value: 50 })
  const result = await write(listing.id, listing.version, { compareAt: 129.9 })
  expect(result.results[0]).toMatchObject({ outcome: 'applied', guarded: true, version: listing.version + 1, queueId: null })
  const after = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  // The legacy key is retired, every other platform fact is kept.
  expect(after.platformAttributes).toEqual({ compareAtPrice: 129.9, vendor: 'ACME' })
  expect(after).toMatchObject({ price: null, followMasterPrice: true, syncStatus: 'IN_SYNC' })
  expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: listing.id } })).toBe(0)
  expect(await prisma.channelListingOverride.findFirstOrThrow({ where: { channelListingId: listing.id } })).toMatchObject({ fieldName: 'compareAtPrice', previousValue: '50', newValue: '129.9' })
  // The selling-price timeline is the selling price's: a compare-at change is not a price change.
  expect(await prisma.priceChangeEvent.count({ where: { productId: listing.productId } })).toBe(0)
  // The same value again is nothing.
  expect((await write(listing.id, after.version, { compareAt: 129.9 })).results[0]).toMatchObject({ outcome: 'noop', version: after.version })
}))

it('records a price and a compare-at price together in one compare-and-set', () => scoped(async () => {
  const listing = await seed('compare-at-with-price')
  expect((await write(listing.id, listing.version, { price: 99, compareAt: 149 })).results[0]).toMatchObject({ outcome: 'applied', version: listing.version + 1 })
  const after = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
  expect(Number(after.price)).toBe(99)
  expect(storedCompareAt(after.platformAttributes)).toEqual({ state: 'stored', value: 149 })
  expect((await prisma.channelListingOverride.findMany({ where: { channelListingId: listing.id } })).map(o => o.fieldName).sort()).toEqual(['compareAtPrice', 'price'])
}))

it('refuses a compare-at price that would be SENT, one on another channel, and a stale version', () => scoped(async () => {
  const listing = await seed('compare-at-refused')
  expect((await write(listing.id, listing.version, { compareAt: 10 }, {})).results[0]).toMatchObject({ outcome: 'refused', reason: 'A compare-at price is recorded from Shopify’s own file only; change it in the Shopify tab.' })
  const other = await seed('compare-at-ebay', 'EBAY')
  expect((await write(other.id, other.version, { compareAt: 10 })).results[0]).toMatchObject({ outcome: 'refused', reason: 'Only a Shopify listing has a compare-at price' })
  expect((await write(listing.id, listing.version + 5, { compareAt: 10 })).results[0]).toMatchObject({ outcome: 'conflict' })
  expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).platformAttributes).toEqual({ shopifyCompareAtPrice: 50, vendor: 'ACME' })
}))
