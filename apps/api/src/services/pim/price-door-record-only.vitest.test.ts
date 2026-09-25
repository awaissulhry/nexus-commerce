/**
 * CFI-6 (R-CFI-1 Q2, BUILD.md D2) — the one price door's RECORD-ONLY mode: a channel's own price read from its file is
 * stored exactly like any price write (columns, compare-and-set, audit, timeline) but NOTHING is sent. Real PostgreSQL
 * in-process (PGlite), the pattern of `price-door-reset.vitest.test.ts`. The control arm proves the queue assertion can fail.
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

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let account = ''
beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'record-only', isActive: true } })).id
}))
async function seed(id: string) {
  const product = await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 10 } })
  const listing = await prisma.channelListing.create({ data: { productId: id, channel: 'EBAY', channelConnectionId: account, channelMarket: 'EBAY_IT', marketplace: 'IT', region: 'EU',
    price: null, priceOverride: null, followMasterPrice: true, syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS' } })
  return { product, listing }
}
const record = (listingId: string, version: number, extra: Record<string, unknown> = {}) => writeChannelPrices({ targets: [{ listingId, price: 99.9, expectedVersion: version }],
  actor: 'channel file', source: 'CHANNEL_FILE_IMPORT', reason: 'Channel file import (job test)', ...extra })

it('control: an ordinary price write queues a PRICE_UPDATE push', () => scoped(async () => {
  const { listing } = await seed('record-only-control')
  expect((await record(listing.id, listing.version, { source: 'MANUAL_OVERRIDE' })).results[0]).toMatchObject({ outcome: 'applied' })
  expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: listing.id, syncType: 'PRICE_UPDATE' } })).toBe(1)
}))

it('records the channel price with its audit and timeline, and sends nothing', () => scoped(async () => {
  const { product, listing } = await seed('record-only-applied')
  const result = await record(listing.id, listing.version, { recordOnly: 'channel-file-import' })
  expect(result.results[0]).toMatchObject({ outcome: 'applied', guarded: true, version: listing.version + 1, queueId: null })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ followMasterPrice: false, syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS' })
  expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).price)).toBe(99.9)
  expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: listing.id } })).toBe(0)
  expect(await prisma.channelListingOverride.count({ where: { channelListingId: listing.id, fieldName: 'price' } })).toBe(1)
  expect((await prisma.priceChangeEvent.findFirstOrThrow({ where: { productId: product.id } })).source).toBe('CHANNEL_FILE_IMPORT')
}))

it('never overtakes an operator\'s unsent price change', () => scoped(async () => {
  const { listing } = await seed('record-only-pending')
  await prisma.outboundSyncQueue.create({ data: { productId: listing.productId, channelListingId: listing.id, targetChannel: 'EBAY', syncStatus: 'PENDING', syncType: 'PRICE_UPDATE', payload: { price: 55 } } })
  const result = await record(listing.id, listing.version, { recordOnly: 'channel-file-import' })
  expect(result.results[0]).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('A price change is waiting to be sent to EBAY') })
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ price: null, followMasterPrice: true, version: listing.version })
  expect(await prisma.outboundSyncQueue.findFirstOrThrow({ where: { channelListingId: listing.id } })).toMatchObject({ syncStatus: 'PENDING' })
}))

it('writes inside the caller\'s transaction, so the caller\'s rollback undoes it', () => scoped(async () => {
  const { listing } = await seed('record-only-tx')
  await expect(prisma.$transaction(async tx => {
    const inside = await record(listing.id, listing.version, { recordOnly: 'channel-file-import', tx })
    expect(inside.results[0].outcome).toBe('applied')
    throw new Error('caller rolls back')
  })).rejects.toThrow('caller rolls back')
  expect(await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ price: null, followMasterPrice: true, version: listing.version })
  expect(await prisma.channelListingOverride.count({ where: { channelListingId: listing.id } })).toBe(0)
}))
