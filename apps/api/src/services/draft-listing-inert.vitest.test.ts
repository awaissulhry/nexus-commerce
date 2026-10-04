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
import { applyImport } from './stock-import.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

let amazon = ''
let ebay = ''
let etsy = ''
let warehouse = ''

beforeAll(() => scoped(async () => {
  for (const [channel, code, currency, language] of [['AMAZON', 'IT', 'EUR', 'it'], ['AMAZON', 'DE', 'EUR', 'de'], ['AMAZON', 'FR', 'EUR', 'fr'], ['AMAZON', 'SE', 'SEK', 'sv'], ['EBAY', 'IT', 'EUR', 'it']] as const) {
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region: 'EU', language, languages: [language] } as never })
  }
  amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'draft-safety-amazon', isActive: true, isPrimary: true } as never })).id
  ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'draft-safety-ebay', isActive: true, isPrimary: true } as never })).id
  etsy = (await prisma.channelConnection.create({ data: { channelType: 'ETSY', accountLabel: 'draft-safety-etsy', isActive: true, isPrimary: true } as never })).id
  warehouse = (await prisma.stockLocation.create({ data: { code: 'DRAFT-SAFETY-WH', name: 'Draft safety warehouse', type: 'WAREHOUSE' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

type ListingSeed = { channel?: 'AMAZON' | 'EBAY' | 'ETSY'; marketplace: string; live: boolean; paused: boolean; status?: string; published?: boolean; quantity?: number | null; price?: number | null }
/** A live listing has a channel id and is published; a draft has neither (the Variants tick's recipe when paused). */
async function seed(sku: string, listings: ListingSeed[], product: { stock?: number; status?: 'DRAFT' | 'ACTIVE' | 'INACTIVE' } = {}) {
  const created = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, status: product.status ?? 'ACTIVE', fulfillmentMethod: 'FBM', totalStock: product.stock ?? 0 } })
  if (product.stock !== undefined) await prisma.stockLevel.create({ data: { productId: created.id, locationId: warehouse, quantity: product.stock, available: product.stock } })
  const rows: Record<string, any> = {}
  for (const l of listings) {
    const channel = l.channel ?? 'AMAZON'
    rows[`${channel}_${l.marketplace}`] = await prisma.channelListing.create({ data: {
      productId: created.id, channel, marketplace: l.marketplace, region: l.marketplace, channelMarket: `${channel}_${l.marketplace}`,
      channelConnectionId: channel === 'AMAZON' ? amazon : channel === 'ETSY' ? etsy : ebay, aliasKey: '', fulfillmentMethod: 'FBM',
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
      expect((await queueFor(paused.id, 'PRICE_UPDATE')).filter((row) => row.syncStatus !== 'SKIPPED')).toEqual([])
      // Unchanged from before: the stored price still follows the master; only the queue row is gone.
      expect(Number((await stored(paused.id)).price)).toBe(12.5)
      expect(await stored(paused.id)).toMatchObject({ syncPaused: true })
    }
    // Round 5 — the paused LIVE row keeps the price as ONE held row (SKIPPED, never dispatched), sent once on resume; the
    // paused draft follows the master at the master price, which its Publish carries, so nothing is held for it.
    expect((await queueFor(rows.AMAZON_FR.id, 'PRICE_UPDATE')).map((row) => [row.syncStatus, row.errorCode])).toEqual([['SKIPPED', 'PUSH_SYNC_PAUSED']])
    expect(await queueFor(rows.AMAZON_DE.id, 'PRICE_UPDATE')).toEqual([])
  }))

  it('a master price change queues nothing for an UNPAUSED still-draft either, and still queues a DRAFT row with a channel id', () => scoped(async () => {
    // eBay IT: a still-draft started before drafts were born paused (DRAFT, unpublished, no ItemID, not paused).
    // Amazon DE: a row whose status says DRAFT but which has a channel id and is published — it reached the channel.
    const { product, rows } = await seed('DRAFT-SAFETY-PRICE-UNPAUSED', [
      { marketplace: 'IT', live: true, paused: false },
      { channel: 'EBAY', marketplace: 'IT', live: false, paused: false },
      { marketplace: 'DE', live: true, paused: false, status: 'DRAFT' },
    ])
    const result = await new MasterPriceService(prisma as never).update(product.id, 13.5, { reason: 'draft-safety' })
    expect(result.currencyRefused).toEqual([])
    expect(result.cascadedListingIds.sort()).toEqual([rows.AMAZON_IT.id, rows.EBAY_IT.id, rows.AMAZON_DE.id].sort())
    expect(await queueFor(rows.EBAY_IT.id, 'PRICE_UPDATE')).toEqual([])
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: rows.EBAY_IT.id } })).toBe(0)
    // The draft keeps following the master, so Publish sends the current price.
    expect(await stored(rows.EBAY_IT.id)).toMatchObject({ listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: false })
    expect(Number((await stored(rows.EBAY_IT.id)).price)).toBe(13.5)
    const queued = [...await queueFor(rows.AMAZON_IT.id, 'PRICE_UPDATE'), ...await queueFor(rows.AMAZON_DE.id, 'PRICE_UPDATE')]
    expect(queued).toEqual([
      expect.objectContaining({ channelListingId: rows.AMAZON_IT.id, payload: expect.objectContaining({ price: 13.5 }) }),
      expect.objectContaining({ channelListingId: rows.AMAZON_DE.id, payload: expect.objectContaining({ price: 13.5 }) }),
    ])
    expect(result.queuedSyncIds.sort()).toEqual(queued.map((row) => row.id).sort())
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

describe('a product status change is Nexus-only (sheet publish parity step 7, D4): no listing is touched, nothing is queued', () => {
  // Before step 7 the master Status flipped every live listing's status and queued STATUS_UPDATE rows no dispatcher
  // could send. Now it changes the product only, for drafts and live listings alike.
  it('keeps a still-draft row DRAFT and a live row as it was, with nothing queued', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-SAFETY-STATUS', [
      { marketplace: 'IT', live: true, paused: false, status: 'INACTIVE' },
      { marketplace: 'SE', live: false, paused: true },
      { marketplace: 'DE', live: false, paused: false },
    ], { status: 'INACTIVE' })
    const result = await new MasterStatusService(prisma as never).update(product.id, 'ACTIVE', { reason: 'draft-safety' })
    expect(result).toMatchObject({ changed: true, cascadedListingIds: [], queuedSyncIds: [] })
    expect(result.skippedListingIds.sort()).toEqual([rows.AMAZON_IT.id, rows.AMAZON_SE.id, rows.AMAZON_DE.id].sort())
    expect(await prisma.product.findUnique({ where: { id: product.id }, select: { status: true } })).toEqual({ status: 'ACTIVE' })
    expect(await stored(rows.AMAZON_IT.id)).toMatchObject({ listingStatus: 'INACTIVE', version: rows.AMAZON_IT.version })
    for (const row of [rows.AMAZON_IT, rows.AMAZON_SE, rows.AMAZON_DE]) expect(await queueFor(row.id, 'STATUS_UPDATE')).toEqual([])
    for (const draft of [rows.AMAZON_SE, rows.AMAZON_DE]) expect(await stored(draft.id)).toMatchObject({ listingStatus: 'DRAFT', version: draft.version })
  }))

  it('going INACTIVE leaves a live listing ACTIVE: the channel still sells, so the listing must not say otherwise', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-SAFETY-STATUS-OFF', [
      { marketplace: 'IT', live: true, paused: false },
      { marketplace: 'SE', live: false, paused: true },
    ])
    const result = await new MasterStatusService(prisma as never).update(product.id, 'INACTIVE', { reason: 'draft-safety' })
    expect(result.cascadedListingIds).toEqual([])
    expect(await stored(rows.AMAZON_IT.id)).toMatchObject({ listingStatus: rows.AMAZON_IT.listingStatus, version: rows.AMAZON_IT.version })
    expect(await queueFor(rows.AMAZON_IT.id, 'STATUS_UPDATE')).toEqual([])
    expect(await stored(rows.AMAZON_SE.id)).toMatchObject({ listingStatus: 'DRAFT', version: rows.AMAZON_SE.version })
  }))

  it('still writes one audit row with the status diff, and none for a no-op', () => scoped(async () => {
    const { product } = await seed('DRAFT-SAFETY-STATUS-AUDIT', [{ marketplace: 'IT', live: true, paused: false }])
    const service = new MasterStatusService(prisma as never)
    const changed = await service.update(product.id, 'INACTIVE', { reason: 'draft-safety' })
    expect(await prisma.auditLog.findUnique({ where: { id: changed.auditLogId! }, select: { before: true, after: true } }))
      .toEqual({ before: { status: 'ACTIVE' }, after: { status: 'INACTIVE' } })
    expect(await service.update(product.id, 'INACTIVE')).toMatchObject({ changed: false, auditLogId: null })
  }))
})

describe('an UNPAUSED still-draft is inert too (a draft started before drafts were born paused)', () => {
  // DRAFT, never published, no channel id, NOT paused. The live listing on the same product is the control: it is still
  // queued with the quantity or text it always got.
  const stillDraft = (listing: { channel?: 'AMAZON' | 'EBAY'; marketplace: string }): ListingSeed => ({ ...listing, live: false, paused: false })

  it('a stock movement queues nothing for it and leaves its quantity alone; the live listing is queued as before', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-UNPAUSED-STOCK', [
      { marketplace: 'IT', live: true, paused: false },
      stillDraft({ marketplace: 'DE' }),
    ], { stock: 5 })
    await applyStockMovement({ productId: product.id, locationId: warehouse, change: 3, reason: 'MANUAL_ADJUSTMENT', actor: 'draft-safety' })
    expect(await queueFor(rows.AMAZON_IT.id, 'QUANTITY_UPDATE')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 8 }) })])
    expect(await stored(rows.AMAZON_IT.id)).toMatchObject({ quantity: 8 })
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: rows.AMAZON_DE.id } })).toBe(0)
    expect(await stored(rows.AMAZON_DE.id)).toMatchObject({ quantity: null, syncPaused: false, listingStatus: 'DRAFT', isPublished: false, version: rows.AMAZON_DE.version })
  }))

  it('a stock import queues nothing for it either (cascade parity); the live listing is queued as before', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-UNPAUSED-IMPORT', [
      { marketplace: 'IT', live: true, paused: false },
      stillDraft({ marketplace: 'DE' }),
    ], { stock: 5 })
    const importRows = [{
      rowIndex: 0, raw: `${product.sku},9`, sku: product.sku, quantity: 9, productId: product.id, resolvedSku: product.sku,
      matchType: 'EXACT', confidence: 1, candidates: [], channel: null, marketplace: null, notes: null,
      currentWarehouseQty: 5, wouldBeWarehouseQty: 9, currentChannelQty: null, wouldBeChannelQty: null,
      channelListings: [], warnings: [], error: null,
    }] as unknown as import('./stock-import.service.js').PreviewRow[]
    const result = await applyImport({ rows: importRows, locationCode: 'DRAFT-SAFETY-WH', mode: 'SET', target: 'WAREHOUSE' })
    expect(result.failed).toBe(0)
    expect(await queueFor(rows.AMAZON_IT.id, 'QUANTITY_UPDATE')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 9 }) })])
    expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: rows.AMAZON_DE.id } })).toBe(0)
    expect(await stored(rows.AMAZON_DE.id)).toMatchObject({ quantity: null, listingStatus: 'DRAFT', version: rows.AMAZON_DE.version })
  }))

  it('a master content change queues nothing for it, while it still follows the text; the live listing is queued', () => scoped(async () => {
    const { product, rows } = await seed('DRAFT-UNPAUSED-CONTENT', [
      { channel: 'AMAZON', marketplace: 'IT', live: true, paused: false },
      stillDraft({ channel: 'EBAY', marketplace: 'IT' }),
    ])
    await prisma.product.update({ where: { id: product.id }, data: { name: 'Titolo nuovo' } })
    const result = await new MasterContentService(prisma as never).update(product.id, { title: 'Titolo nuovo' },
      { address: { tier: 'language', language: 'it' }, masterAlreadyWritten: true, reason: 'draft-safety' })
    expect(result.cascadedListingIds.sort()).toEqual([rows.AMAZON_IT.id, rows.EBAY_IT.id].sort())
    const live = await queueFor(rows.AMAZON_IT.id, 'CONTENT_UPDATE')
    expect(live).toEqual([expect.objectContaining({ payload: expect.objectContaining({ title: 'Titolo nuovo', language: 'it' }) })])
    expect(result.queuedSyncIds).toEqual([live[0].id])
    expect(await queueFor(rows.EBAY_IT.id, 'CONTENT_UPDATE')).toEqual([])
    expect(await prisma.channelListingTranslation.findFirst({ where: { channelListingId: rows.EBAY_IT.id, language: 'it' } })).toMatchObject({ follows: ['title'] })
  }))
})

// 2026-10-01 — Etsy joins the stock cascade (etsy-stock-cascade.vitest.test.ts). An Etsy draft is as inert as any other:
// the live Etsy listing on the same product is the control that IS queued.
describe('an Etsy still-draft is inert to the stock cascade; a live Etsy listing is queued', () => {
  it('a stock movement queues the live Etsy listing and nothing for an unpaused or a paused Etsy draft', () => scoped(async () => {
    const live = await seed('DRAFT-ETSY-LIVE', [{ channel: 'ETSY', marketplace: 'GLOBAL', live: true, paused: false }], { stock: 5 })
    const unpausedDraft = await seed('DRAFT-ETSY-UNPAUSED', [{ channel: 'ETSY', marketplace: 'GLOBAL', live: false, paused: false }], { stock: 5 })
    const pausedDraft = await seed('DRAFT-ETSY-PAUSED', [{ channel: 'ETSY', marketplace: 'GLOBAL', live: false, paused: true }], { stock: 5 })
    for (const seeded of [live, unpausedDraft, pausedDraft]) {
      await applyStockMovement({ productId: seeded.product.id, locationId: warehouse, change: 3, reason: 'MANUAL_ADJUSTMENT', actor: 'draft-safety' })
    }
    expect(await queueFor(live.rows.ETSY_GLOBAL.id, 'QUANTITY_UPDATE')).toEqual([expect.objectContaining({ targetChannel: 'ETSY', payload: expect.objectContaining({ quantity: 8 }) })])
    for (const draft of [unpausedDraft.rows.ETSY_GLOBAL, pausedDraft.rows.ETSY_GLOBAL]) {
      expect(await prisma.outboundSyncQueue.count({ where: { channelListingId: draft.id } })).toBe(0)
      expect(await stored(draft.id)).toMatchObject({ quantity: null, listingStatus: 'DRAFT', isPublished: false, externalListingId: null, version: draft.version })
    }
  }))
})
