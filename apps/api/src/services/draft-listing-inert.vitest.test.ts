/**
 * Draft listing safety, step 1 (docs/product-sheet-create-path/RESEARCH-2026-09-27.md §3, build plan step 1).
 *
 * A draft listing is inert because it is paused (`syncPaused: true`): no cascade may queue a channel update for it,
 * and a product status change may not turn it ACTIVE. Every arm has a control on the same product — a live listing
 * that IS queued or updated — so a cascade that queued nothing at all cannot pass.
 *
 * Runs the real services on PostgreSQL (PGlite) and reads what was STORED.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('./product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('./pim/readiness-index.service.js', async () => (await import('../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { applyStockMovement } from './stock-movement.service.js'
import { MasterPriceService } from './master-price.service.js'
import { MasterContentService } from './master-content.service.js'
import { MasterStatusService } from './master-status.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

let amazon = ''
let ebay = ''
let warehouse = ''

beforeAll(() => scoped(async () => {
  for (const [channel, code, currency, language] of [['AMAZON', 'IT', 'EUR', 'it'], ['AMAZON', 'DE', 'EUR', 'de'], ['AMAZON', 'FR', 'EUR', 'fr'], ['AMAZON', 'SE', 'SEK', 'sv'], ['EBAY', 'IT', 'EUR', 'it']] as const) {
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region: 'EU', language, languages: [language] } as never })
  }
  amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'draft-safety-amazon', isActive: true, isPrimary: true } as never })).id
  ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'draft-safety-ebay', isActive: true, isPrimary: true } as never })).id
  warehouse = (await prisma.stockLocation.create({ data: { code: 'DRAFT-SAFETY-WH', name: 'Draft safety warehouse', type: 'WAREHOUSE' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

type ListingSeed = { channel?: 'AMAZON' | 'EBAY'; marketplace: string; live: boolean; paused: boolean; status?: string; published?: boolean; quantity?: number | null; price?: number | null }
/** A live listing has a channel id and is published; a draft has neither (the Variants tick's recipe when paused). */
async function seed(sku: string, listings: ListingSeed[], product: { stock?: number; status?: 'DRAFT' | 'ACTIVE' | 'INACTIVE' } = {}) {
  const created = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, status: product.status ?? 'ACTIVE', fulfillmentMethod: 'FBM', totalStock: product.stock ?? 0 } })
  if (product.stock !== undefined) await prisma.stockLevel.create({ data: { productId: created.id, locationId: warehouse, quantity: product.stock, available: product.stock } })
  const rows: Record<string, any> = {}
  for (const l of listings) {
    const channel = l.channel ?? 'AMAZON'
    rows[`${channel}_${l.marketplace}`] = await prisma.channelListing.create({ data: {
      productId: created.id, channel, marketplace: l.marketplace, region: l.marketplace, channelMarket: `${channel}_${l.marketplace}`,
      channelConnectionId: channel === 'AMAZON' ? amazon : ebay, aliasKey: '', fulfillmentMethod: 'FBM',
      listingStatus: l.status ?? (l.live ? 'ACTIVE' : 'DRAFT'), isPublished: l.published ?? l.live, externalListingId: l.live ? `FIXTURE-${sku}-${l.marketplace}` : null,
      syncPaused: l.paused, followMasterQuantity: true, followMasterPrice: true,
      quantity: l.quantity === undefined ? (l.live ? 5 : null) : l.quantity, price: l.price === undefined ? (l.live ? 10 : null) : l.price,
    } as never })
  }
  return { product: created, rows }
}
const queueFor = (listingId: string, syncType: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId: listingId, syncType } })
const stored = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })

describe('a paused draft is inert to every cascade', () => {
  it('a stock movement queues nothing for a paused SE draft, and still queues the live IT listing', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-SAFETY-STOCK', [
      { marketplace: 'IT', live: true, paused: false },
      { marketplace: 'SE', live: false, paused: true },
    ], { stock: 5 })
    await applyStockMovement({ productId: product.id, locationId: warehouse, change: 3, reason: 'MANUAL_ADJUSTMENT', actor: 'draft-safety' })
    expect(await queueFor(rows.AMAZON_IT.id, 'QUANTITY_UPDATE')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 8 }) })])
    expect(await queueFor(rows.AMAZON_SE.id, 'QUANTITY_UPDATE')).toEqual([])
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: rows.AMAZON_SE.id } })).toBe(0)
    expect(await stored(rows.AMAZON_SE.id)).toMatchObject({ quantity: null, syncPaused: true, listingStatus: 'DRAFT', version: rows.AMAZON_SE.version })
  }))

  it('a master price change queues nothing for a paused row, keeps its price following the master, and queues the live row', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-SAFETY-PRICE', [
      { marketplace: 'IT', live: true, paused: false },
      // Both paused shapes, in euro markets so the currency refusal cannot be what holds them back.
      { marketplace: 'DE', live: false, paused: true },
      { marketplace: 'FR', live: true, paused: true },
    ])
    const result = await new MasterPriceService(prisma as never).update(product.id, 12.5, { reason: 'draft-safety' })
    expect(result.cascadedListingIds.sort()).toEqual([rows.AMAZON_IT.id, rows.AMAZON_DE.id, rows.AMAZON_FR.id].sort())
    expect(result.currencyRefused).toEqual([])
    const live = await queueFor(rows.AMAZON_IT.id, 'PRICE_UPDATE')
    expect(live).toEqual([expect.objectContaining({ payload: expect.objectContaining({ price: 12.5 }) })])
    expect(result.queuedSyncIds).toEqual([live[0].id])
    for (const paused of [rows.AMAZON_DE, rows.AMAZON_FR]) {
      expect(await queueFor(paused.id, 'PRICE_UPDATE')).toEqual([])
      // Unchanged from before: the stored price still follows the master; only the queue row is gone.
      expect(Number((await stored(paused.id)).price)).toBe(12.5)
      expect(await stored(paused.id)).toMatchObject({ syncPaused: true })
    }
  }))

  it('a master content change queues nothing for a paused row, and queues the live row', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-SAFETY-CONTENT', [
      { channel: 'AMAZON', marketplace: 'IT', live: true, paused: false },
      { channel: 'EBAY', marketplace: 'IT', live: false, paused: true },
    ])
    await prisma.product.update({ where: { id: product.id }, data: { name: 'Nuovo titolo' } })
    const result = await new MasterContentService(prisma as never).update(product.id, { title: 'Nuovo titolo' },
      { address: { tier: 'language', language: 'it' }, masterAlreadyWritten: true, reason: 'draft-safety' })
    expect(result.cascadedListingIds.sort()).toEqual([rows.AMAZON_IT.id, rows.EBAY_IT.id].sort())
    const live = await queueFor(rows.AMAZON_IT.id, 'CONTENT_UPDATE')
    expect(live).toEqual([expect.objectContaining({ payload: expect.objectContaining({ title: 'Nuovo titolo', language: 'it' }) })])
    expect(result.queuedSyncIds).toEqual([live[0].id])
    expect(await queueFor(rows.EBAY_IT.id, 'CONTENT_UPDATE')).toEqual([])
    // The paused draft still follows the shared text; nothing was sent for it.
    expect(await prisma.channelListingTranslation.findFirst({ where: { channelListingId: rows.EBAY_IT.id, language: 'it' } })).toMatchObject({ follows: ['title'] })
  }))
})

describe('a product status change leaves a still-draft listing alone', () => {
  it('keeps a still-draft row DRAFT with nothing queued, and still updates the live row', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-SAFETY-STATUS', [
      { marketplace: 'IT', live: true, paused: false, status: 'INACTIVE' },
      { marketplace: 'SE', live: false, paused: true },
      { marketplace: 'DE', live: false, paused: false },
    ], { status: 'INACTIVE' })
    const result = await new MasterStatusService(prisma as never).update(product.id, 'ACTIVE', { reason: 'draft-safety' })
    expect(result.cascadedListingIds).toEqual([rows.AMAZON_IT.id])
    expect(result.skippedListingIds.sort()).toEqual([rows.AMAZON_SE.id, rows.AMAZON_DE.id].sort())
    expect(await stored(rows.AMAZON_IT.id)).toMatchObject({ listingStatus: 'ACTIVE', version: rows.AMAZON_IT.version + 1 })
    expect(await queueFor(rows.AMAZON_IT.id, 'STATUS_UPDATE')).toHaveLength(1)
    for (const draft of [rows.AMAZON_SE, rows.AMAZON_DE]) {
      expect(await stored(draft.id)).toMatchObject({ listingStatus: 'DRAFT', version: draft.version })
      expect(await queueFor(draft.id, 'STATUS_UPDATE')).toEqual([])
    }
  }))

  it('also leaves a still-draft row alone when the product goes INACTIVE', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-SAFETY-STATUS-OFF', [
      { marketplace: 'IT', live: true, paused: false },
      { marketplace: 'SE', live: false, paused: true },
    ])
    const result = await new MasterStatusService(prisma as never).update(product.id, 'INACTIVE', { reason: 'draft-safety' })
    expect(result.cascadedListingIds).toEqual([rows.AMAZON_IT.id])
    expect(await stored(rows.AMAZON_IT.id)).toMatchObject({ listingStatus: 'INACTIVE' })
    expect(await stored(rows.AMAZON_SE.id)).toMatchObject({ listingStatus: 'DRAFT', version: rows.AMAZON_SE.version })
  }))

  it('also skips a DRAFT row a creator left isPublished: true — it has not reached the channel either (broader than the Publish rule)', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-SAFETY-STATUS-PUB', [
      { marketplace: 'IT', live: true, paused: false, status: 'INACTIVE' },
      { marketplace: 'SE', live: false, paused: false, published: true },
    ], { status: 'INACTIVE' })
    const result = await new MasterStatusService(prisma as never).update(product.id, 'ACTIVE', { reason: 'draft-safety' })
    expect(result.cascadedListingIds).toEqual([rows.AMAZON_IT.id])
    expect(await stored(rows.AMAZON_SE.id)).toMatchObject({ listingStatus: 'DRAFT', isPublished: true, version: rows.AMAZON_SE.version })
  }))

  it('keeps flipping a DRAFT row that has a channel id — it has reached the channel, so it is not a still-draft', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-SAFETY-STATUS-ID', [{ marketplace: 'IT', live: true, paused: false, status: 'DRAFT' }], { status: 'INACTIVE' })
    const result = await new MasterStatusService(prisma as never).update(product.id, 'ACTIVE', { reason: 'draft-safety' })
    expect(result.cascadedListingIds).toEqual([rows.AMAZON_IT.id])
    expect(await stored(rows.AMAZON_IT.id)).toMatchObject({ listingStatus: 'ACTIVE' })
  }))
})
