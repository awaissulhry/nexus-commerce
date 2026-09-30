/**
 * The one price door names an Amazon sale REMOVAL on its queue row (2026-09-30).
 *
 * An Amazon price push now leaves the sale Amazon holds alone (a merge on the live offer, `amazon/purchasable-offer.ts`),
 * so "Nexus holds no sale" no longer clears Amazon's. A person removing Nexus's OWN sale — a value with both dates, the
 * only sale Nexus ever sends — must therefore say so: the row carries `saleRemoved: true`, and a later write in the grace
 * window that cancels that row for a fresh one carries it on. Real PostgreSQL in-process (PGlite), the pattern of
 * `price-door-reset.vitest.test.ts`: the carry-over reads the pending row by a JSON path, which a stub cannot prove.
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
import { resetSaleWindowColumnCache, writeSaleWindow } from './sale-window.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const accounts: Record<string, string> = {}
beforeAll(async () => {
  // The two MX.1 window columns are raw SQL, not in schema.prisma; the deployed databases carry them
  // (migration 20260913_mx1_sale_price_window), this disposable one gets the same two statements.
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  resetSaleWindowColumnCache()
  await scoped(async () => {
    for (const channel of ['AMAZON', 'EBAY']) {
      await prisma.marketplace.create({ data: { channel, code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
      accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `sale-removal-${channel}`, isActive: true } })).id
    }
  })
})

/** A listing on IT with a price of its own and, optionally, a sale (a window only when both dates are given). */
async function seed(id: string, channel: 'AMAZON' | 'EBAY', sale: { value: number; start: string | null; end: string | null } | null) {
  await prisma.product.create({ data: { id, sku: id, name: id, basePrice: 10 } })
  const listing = await prisma.channelListing.create({ data: { productId: id, channel, channelConnectionId: accounts[channel], channelMarket: `${channel}_IT`, marketplace: 'IT', region: 'EU',
    price: 120, priceOverride: 120, followMasterPrice: false, salePrice: sale?.value ?? null } })
  if (sale) await prisma.$transaction((tx) => writeSaleWindow(tx, listing.id, { start: sale.start, end: sale.end }))
  return listing
}
const version = async (id: string) => (await prisma.channelListing.findUniqueOrThrow({ where: { id } })).version
const write = async (listingId: string, change: { price?: number; sale?: { value: number | null; start: string | null; end: string | null } }) => {
  const r = await writeChannelPrices({ targets: [{ listingId, ...change, expectedVersion: await version(listingId) }], actor: 'test', source: 'MANUAL_OVERRIDE' })
  expect(r.results[0].outcome).toBe('applied')
  return r.results[0].queueId!
}
const rows = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId }, orderBy: { createdAt: 'asc' } })
const payloadOf = async (id: string) => (await prisma.outboundSyncQueue.findUniqueOrThrow({ where: { id } })).payload as Record<string, unknown>
const NO_SALE = { value: null, start: null, end: null }

it('removing Nexus\'s own Amazon sale (value + window) marks the row saleRemoved', () => scoped(async () => {
  const listing = await seed('removal-amazon', 'AMAZON', { value: 95, start: '2026-10-01', end: '2026-10-15' })
  const queueId = await write(listing.id, { sale: NO_SALE })
  expect(await payloadOf(queueId)).toMatchObject({ source: 'CHANNEL_PRICE_WRITE', price: 120, salePrice: null, salePriceStart: null, salePriceEnd: null, saleRemoved: true })
}))

it('control: a price change on an Amazon listing that never had a sale carries no removal', () => scoped(async () => {
  const listing = await seed('removal-none', 'AMAZON', null)
  const payload = await payloadOf(await write(listing.id, { price: 115 }))
  expect(payload).toMatchObject({ price: 115, salePrice: null })
  expect('saleRemoved' in payload).toBe(false)
}))

it('the removal survives a later price write that cancels its row in the grace window', () => scoped(async () => {
  const listing = await seed('removal-carried', 'AMAZON', { value: 95, start: '2026-10-01', end: '2026-10-15' })
  await write(listing.id, { sale: NO_SALE })
  const fresh = await write(listing.id, { price: 115 })
  const [first, second] = await rows(listing.id)
  expect(first).toMatchObject({ syncStatus: 'CANCELLED', payload: { saleRemoved: true } })
  expect(second).toMatchObject({ id: fresh, syncStatus: 'PENDING', payload: { price: 115, salePrice: null, saleRemoved: true } })
}))

it('a new sale after the removal is sent as that sale, not as a removal', () => scoped(async () => {
  const listing = await seed('removal-then-sale', 'AMAZON', { value: 95, start: '2026-10-01', end: '2026-10-15' })
  await write(listing.id, { sale: NO_SALE })
  const payload = await payloadOf(await write(listing.id, { sale: { value: 90, start: '2026-11-01', end: '2026-11-05' } }))
  expect(payload).toMatchObject({ salePrice: 90, salePriceStart: '2026-11-01', salePriceEnd: '2026-11-05' })
  expect('saleRemoved' in payload).toBe(false)
}))

it('clearing a sale Nexus never sent (no window) is not a removal to send', () => scoped(async () => {
  const listing = await seed('removal-no-window', 'AMAZON', { value: 89, start: null, end: null })
  const payload = await payloadOf(await write(listing.id, { sale: NO_SALE }))
  expect(payload).toMatchObject({ salePrice: null })
  expect('saleRemoved' in payload).toBe(false)
}))

it('eBay: removal includes the product SKU but no Amazon saleRemoved key', () => scoped(async () => {
  const listing = await seed('removal-ebay', 'EBAY', { value: 95, start: '2026-10-01', end: '2026-10-15' })
  const payload = await payloadOf(await write(listing.id, { sale: NO_SALE }))
  expect(Object.keys(payload).sort()).toEqual(['actor', 'marketplace', 'price', 'productSku', 'salePrice', 'salePriceEnd', 'salePriceStart', 'source'])
  expect(payload.productSku).toBe('removal-ebay')
}))
