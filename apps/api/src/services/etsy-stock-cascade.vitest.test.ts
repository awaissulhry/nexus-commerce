/**
 * 2026-10-01 (Owner) — Etsy stock joins the stock cascade.
 *
 * Etsy was missing from the four lists of channels that get a quantity row (the cascade, the stock import, follow /
 * pin / buffer, listing activation): an Etsy listing's quantity moved in Nexus, the listing said PENDING, and no row
 * was ever written. They now share ONE set (`QUANTITY_PUSH_CHANNELS`). This file runs the real producers on PostgreSQL
 * (PGlite) and reads what was STORED:
 *
 * - a live Etsy listing gets a row with the routed stock less its buffer, beside Amazon, eBay and Shopify, whose rows
 *   are pinned field by field (they must not move);
 * - the precedence is the other channels': a paused, policy-paused, pinned or uncounted Etsy listing gets no row, and
 *   every arm has a live Amazon listing on the same product as its control;
 * - a newer cascade cancels the older PENDING Etsy row (coalescing);
 * - the stock import, follow / buffer and listing activation queue Etsy too.
 *
 * Nothing is sent anywhere: the queue module is a stand-in and no channel is called.
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
import { applyImport, type PreviewRow } from './stock-import.service.js'
import { setFollowMasterQuantity, setStockBuffer } from './follow-master.service.js'
import { syncActivatedListings } from './listing-activation-sync.service.js'
import { etsyStockWriteRefusal } from './etsy/order-ingest-switch.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

type Channel = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY' | 'WOOCOMMERCE'
const MARKET: Record<Channel, string> = { AMAZON: 'IT', EBAY: 'IT', SHOPIFY: 'GLOBAL', ETSY: 'GLOBAL', WOOCOMMERCE: 'GLOBAL' }
const account: Partial<Record<Channel, string>> = {}
let warehouse = ''
let amazonOnly = ''

beforeAll(() => scoped(async () => {
  for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY', 'WOOCOMMERCE'] as const) {
    account[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `etsy-cascade-${channel.toLowerCase()}`, isActive: true, isPrimary: true } as never })).id
  }
  warehouse = (await prisma.stockLocation.create({ data: { code: 'ETSY-CASCADE-WH', name: 'Etsy cascade warehouse', type: 'WAREHOUSE' } })).id
  // A warehouse routed to Amazon only: for an Etsy listing its stock is not counted at all (UNCOUNTED).
  amazonOnly = (await prisma.stockLocation.create({ data: { code: 'ETSY-CASCADE-AMZ', name: 'Amazon-only warehouse', type: 'WAREHOUSE', syncRoutes: ['AMAZON'] } as never })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

type ListingSeed = { channel: Channel; quantity?: number | null; stockBuffer?: number; paused?: boolean; follow?: boolean }
async function seed(sku: string, listings: ListingSeed[], stock: { quantity: number; locationId?: string }) {
  const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, status: 'ACTIVE', fulfillmentMethod: 'FBM', totalStock: stock.quantity } })
  await prisma.stockLevel.create({ data: { productId: product.id, locationId: stock.locationId ?? warehouse, quantity: stock.quantity, available: stock.quantity } })
  const rows: Partial<Record<Channel, any>> = {}
  for (const l of listings) {
    const marketplace = MARKET[l.channel]
    rows[l.channel] = await prisma.channelListing.create({ data: {
      productId: product.id, channel: l.channel, marketplace, region: marketplace, channelMarket: `${l.channel}_${marketplace}`,
      channelConnectionId: account[l.channel], aliasKey: '', fulfillmentMethod: 'FBM',
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `FIXTURE-${sku}-${l.channel}`,
      syncPaused: l.paused ?? false, followMasterQuantity: l.follow ?? true, followMasterPrice: true,
      quantity: l.quantity === undefined ? stock.quantity : l.quantity, stockBuffer: l.stockBuffer ?? 0, price: 10,
    } as never })
  }
  return { product, rows: rows as Record<Channel, any> }
}
const quantityRows = (listingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId: listingId, syncType: 'QUANTITY_UPDATE' }, orderBy: { createdAt: 'asc' } })
const stored = (id: string) => prisma.channelListing.findUniqueOrThrow({ where: { id } })
/** A queue row as the channel will receive it: everything but the ids and clocks the database makes. */
const shape = (row: any) => {
  const { id: _id, createdAt: _c, updatedAt: _u, holdUntil: _h, traceId: _t, workspaceId: _w, ...rest } = row
  return rest
}

describe('a stock movement queues Etsy beside the other channels, and theirs do not move', () => {
  it('Etsy gets the routed stock less its buffer; Amazon, eBay and Shopify get exactly the rows they always got', () => scoped(async () => {
    const { product, rows } = await seed('ETSY-CASCADE-ALL', [
      { channel: 'AMAZON' }, { channel: 'EBAY' }, { channel: 'SHOPIFY' }, { channel: 'ETSY', stockBuffer: 2 },
    ], { quantity: 5 })
    await applyStockMovement({ productId: product.id, locationId: warehouse, change: 3, reason: 'MANUAL_ADJUSTMENT', actor: 'etsy-cascade' })

    const expected = (channel: Channel, quantity: number, stockBuffer = 0) => ({
      productId: product.id, channelListingId: rows[channel].id, offerId: null, channelConnectionId: account[channel],
      targetChannel: channel, targetRegion: MARKET[channel], syncStatus: 'PENDING', syncType: 'QUANTITY_UPDATE',
      externalListingId: `FIXTURE-ETSY-CASCADE-ALL-${channel}`, errorMessage: null, errorCode: null, retryCount: 0, maxRetries: 3,
      syncedAt: null, nextRetryAt: null, isDead: false, diedAt: null,
      payload: {
        source: 'STOCK_MOVEMENT', productId: product.id, channel, marketplace: MARKET[channel], quantity, oldQuantity: 5,
        masterQuantity: 8, stockBuffer, reason: 'MANUAL_ADJUSTMENT', change: 3, referenceType: null, referenceId: null,
      },
    })
    // Every column of every row, exactly (only ids and database clocks are left out); the hold is the manual grace.
    for (const channel of ['AMAZON', 'EBAY', 'SHOPIFY'] as const) {
      const queued = await quantityRows(rows[channel].id)
      expect(queued.map(shape), channel).toEqual([expected(channel, 8)])
      expect(queued[0].holdUntil!.getTime() - queued[0].createdAt.getTime(), channel).toBeGreaterThan(25_000)
      expect(await stored(rows[channel].id)).toMatchObject({ quantity: 8, masterQuantity: 8, lastSyncStatus: 'PENDING' })
    }
    // 🔴 Etsy: 8 in the warehouse − 2 held back. Before 2026-10-01 its quantity moved here and no row was written.
    const etsy = await quantityRows(rows.ETSY.id)
    expect(etsy.map(shape)).toEqual([expected('ETSY', 6, 2)])
    expect(await stored(rows.ETSY.id)).toMatchObject({ quantity: 6, masterQuantity: 8, lastSyncStatus: 'PENDING' })
  }))
})

describe('the precedence is the other channels\': these Etsy listings get NO row (each with a live Amazon control)', () => {
  const control = async (rows: Record<Channel, any>, quantity: number) =>
    expect(await quantityRows(rows.AMAZON.id)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity }) })])

  it('a paused Etsy listing keeps its number', () => scoped(async () => {
    const { product, rows } = await seed('ETSY-CASCADE-PAUSED', [{ channel: 'AMAZON' }, { channel: 'ETSY', paused: true }], { quantity: 5 })
    await applyStockMovement({ productId: product.id, locationId: warehouse, change: 2, reason: 'MANUAL_ADJUSTMENT', actor: 'etsy-cascade' })
    await control(rows, 7)
    expect(await quantityRows(rows.ETSY.id)).toEqual([])
    expect(await stored(rows.ETSY.id)).toMatchObject({ quantity: 5, syncPaused: true })
  }))

  it('a pinned Etsy listing keeps its fixed number', () => scoped(async () => {
    const { product, rows } = await seed('ETSY-CASCADE-PINNED', [{ channel: 'AMAZON' }, { channel: 'ETSY', follow: false, quantity: 4 }], { quantity: 5 })
    await applyStockMovement({ productId: product.id, locationId: warehouse, change: 2, reason: 'MANUAL_ADJUSTMENT', actor: 'etsy-cascade' })
    await control(rows, 7)
    expect(await quantityRows(rows.ETSY.id)).toEqual([])
    expect(await stored(rows.ETSY.id)).toMatchObject({ quantity: 4, followMasterQuantity: false })
  }))

  it('a Sync Control policy pausing Etsy holds every Etsy listing, and only Etsy', () => scoped(async () => {
    const policy = await prisma.syncChannelPolicy.create({ data: { channel: 'ETSY', marketplace: '*', pushesPaused: true } })
    try {
      const { product, rows } = await seed('ETSY-CASCADE-POLICY', [{ channel: 'AMAZON' }, { channel: 'ETSY' }], { quantity: 5 })
      await applyStockMovement({ productId: product.id, locationId: warehouse, change: 2, reason: 'MANUAL_ADJUSTMENT', actor: 'etsy-cascade' })
      await control(rows, 7)
      expect(await quantityRows(rows.ETSY.id)).toEqual([])
      expect(await stored(rows.ETSY.id)).toMatchObject({ quantity: 5 })
    } finally {
      await prisma.syncChannelPolicy.delete({ where: { id: policy.id } })
    }
  }))

  it('stock counted only where it is not routed to Etsy is UNCOUNTED: a live Etsy number is never pushed to 0', () => scoped(async () => {
    const { product, rows } = await seed('ETSY-CASCADE-UNCOUNTED', [{ channel: 'AMAZON' }, { channel: 'ETSY', quantity: 3 }], { quantity: 5, locationId: amazonOnly })
    await applyStockMovement({ productId: product.id, locationId: amazonOnly, change: 2, reason: 'MANUAL_ADJUSTMENT', actor: 'etsy-cascade' })
    await control(rows, 7)
    expect(await quantityRows(rows.ETSY.id)).toEqual([])
    expect(await stored(rows.ETSY.id)).toMatchObject({ quantity: 3 })
  }))
})

describe('a newer cascade cancels the older PENDING Etsy row', () => {
  it('two movements: the first Etsy row is CANCELLED, the newest carries the latest number', () => scoped(async () => {
    const { product, rows } = await seed('ETSY-CASCADE-COALESCE', [{ channel: 'ETSY' }], { quantity: 5 })
    await applyStockMovement({ productId: product.id, locationId: warehouse, change: -1, reason: 'MANUAL_ADJUSTMENT', actor: 'etsy-cascade' })
    await applyStockMovement({ productId: product.id, locationId: warehouse, change: -2, reason: 'MANUAL_ADJUSTMENT', actor: 'etsy-cascade' })
    expect((await quantityRows(rows.ETSY.id)).map((row) => [row.syncStatus, (row.payload as { quantity: number }).quantity])).toEqual([['CANCELLED', 4], ['PENDING', 2]])
  }))
})

describe('the other producers queue Etsy from the same set', () => {
  it('a stock import cascades to Etsy', () => scoped(async () => {
    const { product, rows } = await seed('ETSY-CASCADE-IMPORT', [{ channel: 'AMAZON' }, { channel: 'ETSY', stockBuffer: 1 }], { quantity: 5 })
    const importRows = [{
      rowIndex: 0, raw: `${product.sku},9`, sku: product.sku, quantity: 9, productId: product.id, resolvedSku: product.sku,
      matchType: 'EXACT', confidence: 1, candidates: [], channel: null, marketplace: null, notes: null,
      currentWarehouseQty: 5, wouldBeWarehouseQty: 9, currentChannelQty: null, wouldBeChannelQty: null,
      channelListings: [], warnings: [], error: null,
    }] as unknown as PreviewRow[]
    const result = await applyImport({ rows: importRows, locationCode: 'ETSY-CASCADE-WH', mode: 'SET', target: 'WAREHOUSE' })
    expect(result.failed).toBe(0)
    expect(await quantityRows(rows.AMAZON.id)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 9 }) })])
    expect(await quantityRows(rows.ETSY.id)).toEqual([expect.objectContaining({ targetChannel: 'ETSY', payload: expect.objectContaining({ source: 'STOCK_MOVEMENT', quantity: 8, referenceType: 'BulkImport' }) })])
  }))

  it('a stock buffer set on Etsy (the Matrix Buffer cell, Sync Control) queues the new number', () => scoped(async () => {
    const { product, rows } = await seed('ETSY-CASCADE-BUFFER', [{ channel: 'ETSY' }], { quantity: 5 })
    const result = await setStockBuffer({ productIds: [product.id], channel: 'ETSY' as never, markets: ['GLOBAL'], buffer: 2, actor: 'etsy-cascade' })
    expect(result).toMatchObject({ updated: 1, matched: 1 })
    expect(await quantityRows(rows.ETSY.id)).toEqual([expect.objectContaining({ targetChannel: 'ETSY', channelConnectionId: account.ETSY, payload: expect.objectContaining({ source: 'STOCK_BUFFER', quantity: 3, stockBuffer: 2 }) })])
  }))

  it('Follow on a pinned Etsy listing (the Matrix Mode cell) queues the pool number', () => scoped(async () => {
    const { product, rows } = await seed('ETSY-CASCADE-FOLLOW', [{ channel: 'ETSY', follow: false, quantity: 1 }], { quantity: 5 })
    const result = await setFollowMasterQuantity({ productIds: [product.id], channel: 'ETSY' as never, markets: ['GLOBAL'], follow: true, actor: 'etsy-cascade' })
    expect(result).toMatchObject({ updated: 1 })
    expect(await quantityRows(rows.ETSY.id)).toEqual([expect.objectContaining({ targetChannel: 'ETSY', payload: expect.objectContaining({ source: 'FOLLOW_MASTER', quantity: 5, follow: true }) })])
  }))

  it('an Etsy listing that goes live is sent the stock it should show; activation still queues nothing for WooCommerce', () => scoped(async () => {
    const { rows } = await seed('ETSY-CASCADE-ACTIVATED', [{ channel: 'AMAZON', quantity: 0 }, { channel: 'ETSY', stockBuffer: 1, quantity: 0 }, { channel: 'WOOCOMMERCE', quantity: 0 }], { quantity: 5 })
    await syncActivatedListings([rows.AMAZON.id, rows.ETSY.id, rows.WOOCOMMERCE.id])
    expect(await quantityRows(rows.ETSY.id)).toEqual([expect.objectContaining({ targetChannel: 'ETSY', payload: expect.objectContaining({ source: 'LISTING_ACTIVATED', quantity: 4 }) })])
    expect(await quantityRows(rows.AMAZON.id)).toEqual([expect.objectContaining({ targetChannel: 'AMAZON', payload: expect.objectContaining({ quantity: 5, source: 'LISTING_ACTIVATED' }) })])
    // Activation never queued WooCommerce (it has no stock writer); adding Etsy did not change that.
    expect(await quantityRows(rows.WOOCOMMERCE.id)).toEqual([])
  }))
})

describe('an Etsy stock write needs Etsy order import on AND activated for the account (read from the real table)', () => {
  it('switch off → OFF; switch on, no activation row → NOT ACTIVATED; activated → may send; another account stays not activated', () => scoped(async () => {
    const before = process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST
    try {
      delete process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST
      expect(await etsyStockWriteRefusal(account.ETSY!)).toMatchObject({ code: 'ETSY_ORDER_IMPORT_OFF' })
      process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST = '1'
      expect(await etsyStockWriteRefusal(account.ETSY!)).toMatchObject({ code: 'ETSY_ORDER_IMPORT_NOT_ACTIVATED' })
      await prisma.etsyReceiptIngest.create({ data: { connectionId: account.ETSY! } as never })
      expect(await etsyStockWriteRefusal(account.ETSY!)).toBeNull()
      const other = (await prisma.channelConnection.create({ data: { channelType: 'ETSY', accountLabel: 'etsy-cascade-other', isActive: false, isPrimary: false } as never })).id
      expect(await etsyStockWriteRefusal(other)).toMatchObject({ code: 'ETSY_ORDER_IMPORT_NOT_ACTIVATED' })
    } finally {
      if (before === undefined) delete process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST
      else process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST = before
    }
  }))
})
