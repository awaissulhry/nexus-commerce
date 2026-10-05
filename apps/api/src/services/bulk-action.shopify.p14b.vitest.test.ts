/**
 * P1.4b part 2 — the bulk price / stock action on Shopify sends each listing through its OWN account on
 * the 2026-07 GraphQL client (the outbound queue's code), not the env-credential bulk operation that
 * set one env inventory item for every product (deleted in P1.6). More than one Shopify account for the product →
 * refused (D7); the push lock holds; a native family goes to offer-sync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  listings: [] as any[],
  active: [{ id: 'shop-A' }] as Array<{ id: string }>,
  linked: [] as Array<{ row: any; accountId: string; work: any }>,
  native: [] as any[],
}))
vi.mock('./shopify/listing-write.service.js', () => ({
  syncShopifyLinkedListing: vi.fn(async (row: any, accountId: string, work: any) => { h.linked.push({ row, accountId, work }); return 'ok' }),
}))
vi.mock('./shopify/offer-sync.service.js', () => ({ syncNativeShopifyOffer: vi.fn(async (row: any) => { h.native.push(row); return 'ok' }) }))
vi.mock('./connection-resolver.service.js', async (original) => ({
  ...(await original<object>()),
  listActiveConnections: vi.fn(async () => h.active),
}))

import { BulkActionService } from './bulk-action.service.js'

const db = {
  channelListing: {
    findFirst: vi.fn(async () => h.listings[0] ?? null),
    findMany: vi.fn(async () => h.listings),
  },
  // Round 7 — a price push reads its market's currency and the product's floor/ceiling (none here).
  marketplace: { findMany: vi.fn(async () => [{ channel: 'SHOPIFY', code: 'GLOBAL', currency: 'EUR' }]) },
  product: { findUnique: vi.fn(async () => null) },
}
const service = new BulkActionService(db as any) as unknown as { processChannelBatch: (item: any, payload: any, channel: string | null) => Promise<{ status: string }> }
const product = { id: 'p1', sku: 'SKU-1', basePrice: 10, totalStock: 4 }
const listing = (extra: Record<string, unknown> = {}) => ({ id: 'L1', productId: 'p1', channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: 'shop-B', followMasterPrice: false, priceOverride: 12.5, price: 12.5, quantity: 7, platformAttributes: { variantId: '11', inventoryItemId: '22', shopifyProductId: '33', inventoryLocationId: 'gid://shopify/Location/9' }, syncPaused: false, ...extra })
const run = (operation: string) => service.processChannelBatch(product, { channel: 'SHOPIFY', operation }, null)

beforeEach(() => {
  h.listings = [listing()]; h.active = [{ id: 'shop-A' }]; h.linked = []; h.native = []
  vi.stubEnv('SHOPIFY_DEFAULT_INVENTORY_ITEM_GID', 'gid://shopify/InventoryItem/999')
  vi.stubEnv('SHOPIFY_DEFAULT_LOCATION_GID', 'gid://shopify/Location/1')
})
afterEach(() => vi.unstubAllEnvs())

describe('P1.4b — bulk price / stock on Shopify', () => {
  it('stock: the listing\'s own account and its quantity — not one env inventory item for every product', async () => {
    expect(await run('stock')).toEqual({ status: 'processed' })
    expect(h.linked).toHaveLength(1)
    expect(h.linked[0].accountId).toBe('shop-B')
    expect(h.linked[0].work).toEqual({ quantity: 7 })
    expect(h.linked[0].row).toMatchObject({ syncType: 'QUANTITY_UPDATE', product: { sku: 'SKU-1' }, channelListing: { id: 'L1' } })
  })
  it('price: the listing\'s price through its account', async () => {
    await run('price')
    expect(h.linked[0]).toMatchObject({ accountId: 'shop-B', work: { price: 12.5 }, row: { syncType: 'PRICE_UPDATE' } })
  })
  it('a listing that records no account: the only connected Shopify account; two connected → refused', async () => {
    h.listings = [listing({ channelConnectionId: null })]
    await run('stock')
    expect(h.linked[0].accountId).toBe('shop-A')
    h.active = [{ id: 'shop-A' }, { id: 'shop-B' }]
    await expect(run('stock')).rejects.toThrow(/cannot tell which one/)
    expect(h.linked).toHaveLength(1)
  })
  it('the product on two Shopify accounts: refused, nothing sent (D7)', async () => {
    h.listings = [listing(), listing({ id: 'L2', channelConnectionId: 'shop-C' })]
    await expect(run('stock')).rejects.toThrow(/more than one Shopify account/)
    expect(h.linked).toHaveLength(0)
  })
  it('a paused listing: refused by the push lock, nothing sent', async () => {
    h.listings = [listing({ syncPaused: true })]
    await expect(run('price')).rejects.toThrow()
    expect(h.linked).toHaveLength(0)
  })
  it('a native family listing goes to offer-sync', async () => {
    h.listings = [listing({ platformAttributes: { nexusFamilyId: 'fam-1', variantId: '11' } })]
    await run('stock')
    expect(h.native).toHaveLength(1)
    expect(h.linked).toHaveLength(0)
  })
})

/**
 * S5 (per-channel SKU) — a linked listing is written under the SKU Shopify holds for IT (`row.sku` to the writer): its
 * confirmed `liveChannelSku`, else the product SKU (as before). A Shopify sheet SKU not yet sent (the native SKU column, an
 * edit in the override bag) and an extra listing's own SKU are never named.
 */
describe('S5 — bulk price / stock names the listing\'s own Shopify SKU', () => {
  const pa = { variantId: '11', inventoryItemId: '22', shopifyProductId: '33', inventoryLocationId: 'gid://shopify/Location/9' }
  it('parity: no SKU of its own, an unsent edit, or an unsent native SKU → the product SKU', async () => {
    h.listings = [listing({ overrideData: { listing_sku: 'SKU-1-NEXT' } })]
    await run('stock')
    h.listings = [listing({ platformAttributes: { ...pa, sku: 'SKU-1-NEXT' } })]
    await run('price')
    expect(h.linked.map(l => [l.row.sku, l.work])).toEqual([['SKU-1', { quantity: 7 }], ['SKU-1', { price: 12.5 }]])
  })
  it('own SKU confirmed (liveChannelSku) → that SKU', async () => {
    h.listings = [listing({ liveChannelSku: 'SKU-1-LIVE', channelSku: 'SKU-1-WANT' })]
    await run('price')
    expect(h.linked.map(l => [l.row.sku, l.work])).toEqual([['SKU-1-LIVE', { price: 12.5 }]])
  })
  it('an extra listing whose own SKU disagrees with the native one is no conflict: the product SKU', async () => {
    h.listings = [listing({ aliasKey: 'alias-1', aliasId: 'alias-1', platformAttributes: { ...pa, sku: 'SKU-1-SHOP' } })]
    expect(await run('stock')).toEqual({ status: 'processed' })
    expect(h.linked[0].row.sku).toBe('SKU-1')
  })
})
