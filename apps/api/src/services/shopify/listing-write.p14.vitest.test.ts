/**
 * P1.4 — a queued change to a LINKED Shopify listing, on the 2026-07 GraphQL client with the row's
 * account: identity (stored ids, or exactly one SKU match — never "the first"), content, price, and the
 * stock round-trip with compare-and-set (`changeFromQuantity`) and `@idempotent(key)`, read back. The
 * shop is a fake that keeps state and records every operation; the account the client is opened for is
 * recorded too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const shop = vi.hoisted(() => ({
  accounts: [] as string[],
  ops: [] as Array<{ query: string; variables: any }>,
  variants: [] as Array<{ id: string; sku: string; price: string; product: { id: string }; inventoryItem: { id: string } }>,
  stock: new Map<string, number>(),
  concurrent: null as number | null, // a stock change by someone else between our read and our write
  priceIgnored: false, // the shop answers the price write without applying it
  stockAfterWrite: null as number | null, // someone else changes the stock right after our write
  locations: [] as Array<{ id: string; name: string; isActive: boolean }>, // the shop's own locations
}))
vi.mock('./admin-client.js', async (original) => ({
  ...(await original<object>()),
  shopifyAdmin: vi.fn(async (accountId: string) => {
    shop.accounts.push(accountId)
    const graphql = async (query: string, variables: any = {}) => {
      shop.ops.push({ query, variables })
      const byId = (id: string) => shop.variants.find((v) => v.id === id)
      if (query.includes('NexusShopLocations')) return { locations: { nodes: shop.locations } }
      if (query.includes('NexusVariantBySku')) return { productVariants: { nodes: shop.variants.filter((v) => `sku:${JSON.stringify(v.sku)}` === variables.q) } }
      if (query.includes('NexusVariantPrice(')) { const v = byId(variables.id); return { productVariant: v ?? null } }
      if (query.includes('query NexusVariant(')) {
        const v = byId(variables.id)
        const quantity = shop.stock.get(`${v?.inventoryItem.id}@${variables.location}`)
        return { productVariant: v ? { ...v, inventoryItem: { ...v.inventoryItem, inventoryLevel: quantity === undefined ? null : { quantities: [{ name: 'available', quantity }] } } } : null }
      }
      if (query.includes('productUpdate')) return { productUpdate: { product: variables.product, userErrors: [] } }
      if (query.includes('metafieldsSet')) return { metafieldsSet: { metafields: variables.metafields, userErrors: [] } }
      if (query.includes('productVariantsBulkUpdate')) { if (!shop.priceIgnored) for (const u of variables.variants) byId(u.id)!.price = u.price; return { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } }
      if (query.includes('inventorySetQuantities')) {
        const q = variables.input.quantities[0]
        const key = `${q.inventoryItemId}@${q.locationId}`
        if (shop.concurrent !== null) shop.stock.set(key, shop.concurrent)
        if (shop.stock.get(key) !== q.changeFromQuantity) return { inventorySetQuantities: { userErrors: [{ field: ['changeFromQuantity'], message: 'The quantity changed.', code: 'CHANGE_FROM_QUANTITY_STALE' }] } }
        shop.stock.set(key, shop.stockAfterWrite ?? q.quantity)
        return { inventorySetQuantities: { inventoryAdjustmentGroup: { reason: 'correction' }, userErrors: [] } }
      }
      throw new Error(`unexpected operation: ${query.slice(0, 60)}`)
    }
    return { graphql, domain: 'x.myshopify.com' }
  }),
}))

import { syncShopifyLinkedListing } from './listing-write.service.js'
import { __resetShopifyPublishGateForTests, recordShopifyOutcome } from '../shopify-publish-gate.service.js'

const LOC = 'gid://shopify/Location/9'
const stored = { variantId: '11', inventoryItemId: '22', shopifyProductId: '33', inventoryLocationId: LOC }
const row = (syncType: string, attrs: Record<string, string> = stored) => ({ id: 'q1', syncType, payload: {}, product: { id: 'p1', sku: 'SKU-1' }, channelListing: { id: 'L1', platformAttributes: attrs } })
const mutations = () => shop.ops.filter((o) => /^\s*mutation/.test(o.query))

beforeEach(() => {
  shop.accounts = []; shop.ops = []; shop.concurrent = null; shop.priceIgnored = false; shop.stockAfterWrite = null
  shop.locations = [{ id: LOC, name: 'Main', isActive: true }]
  __resetShopifyPublishGateForTests()
  shop.variants = [{ id: 'gid://shopify/ProductVariant/11', sku: 'SKU-1', price: '10.00', product: { id: 'gid://shopify/Product/33' }, inventoryItem: { id: 'gid://shopify/InventoryItem/22' } }]
  shop.stock = new Map([[`gid://shopify/InventoryItem/22@${LOC}`, 3]])
})

describe('P1.4 — whose shop, which variant', () => {
  it('the row\'s own account is the one opened', async () => {
    await syncShopifyLinkedListing(row('QUANTITY_UPDATE'), 'shop-B', { quantity: 5 })
    expect(shop.accounts).toEqual(['shop-B'])
  })
  it('no stored ids: exactly one variant with the SKU is used', async () => {
    await syncShopifyLinkedListing(row('PRICE_UPDATE', { inventoryLocationId: LOC }), 'shop-A', { price: 12 })
    expect(shop.variants[0].price).toBe('12.00')
  })
  it('two variants with the SKU (or none): refused, nothing written — never "the first"', async () => {
    shop.variants.push({ ...shop.variants[0], id: 'gid://shopify/ProductVariant/12' })
    await expect(syncShopifyLinkedListing(row('PRICE_UPDATE', {}), 'shop-A', { price: 12 })).rejects.toThrow(/More than one Shopify variant has the SKU SKU-1/)
    shop.variants = []
    await expect(syncShopifyLinkedListing(row('PRICE_UPDATE', {}), 'shop-A', { price: 12 })).rejects.toThrow(/No Shopify variant has the SKU/)
    expect(mutations()).toHaveLength(0)
  })
  it('the shop\'s circuit is open after repeated failures: refused, no call at all', async () => {
    for (let i = 0; i < 3; i++) recordShopifyOutcome('x.myshopify.com', false, 'HTTP 500')
    await expect(syncShopifyLinkedListing(row('QUANTITY_UPDATE'), 'shop-A', { quantity: 5 })).rejects.toThrow(/circuit open/)
    expect(shop.ops).toHaveLength(0)
  })
  it('a paused listing (push lock): refused before the shop is even opened', async () => {
    const paused = { ...row('QUANTITY_UPDATE'), channelListing: { ...row('QUANTITY_UPDATE').channelListing, syncPaused: true } }
    await expect(syncShopifyLinkedListing(paused, 'shop-A', { quantity: 5 })).rejects.toThrow(/paused/i)
    expect(shop.accounts).toHaveLength(0)
    expect(shop.ops).toHaveLength(0)
  })
  it('the stored variant now carries another SKU: refused, nothing written', async () => {
    shop.variants[0].sku = 'OTHER'
    await expect(syncShopifyLinkedListing(row('QUANTITY_UPDATE'), 'shop-A', { quantity: 5 })).rejects.toThrow(/changed/)
    expect(mutations()).toHaveLength(0)
  })
})

describe('P1.4 — the stock round-trip with compare-and-set', () => {
  it('DONE-WHEN: reads 3, writes 5 with changeFromQuantity 3 and an idempotency key, reads 5 back', async () => {
    expect(await syncShopifyLinkedListing(row('QUANTITY_UPDATE'), 'shop-A', { quantity: 5 })).toMatch(/3 → 5/)
    const [write] = mutations()
    expect(write.query).toMatch(/@idempotent\(key: \$key\)/)
    expect(write.variables.input.quantities).toEqual([{ inventoryItemId: 'gid://shopify/InventoryItem/22', locationId: LOC, quantity: 5, changeFromQuantity: 3 }])
    expect(write.variables.key).toMatch(/^[0-9a-f]{40}$/)
    expect(shop.stock.get(`gid://shopify/InventoryItem/22@${LOC}`)).toBe(5)
  })
  it('the same row and values give the same key (a retry is deduplicated by Shopify)', async () => {
    await syncShopifyLinkedListing(row('QUANTITY_UPDATE'), 'shop-A', { quantity: 5 })
    shop.stock.set(`gid://shopify/InventoryItem/22@${LOC}`, 3)
    await syncShopifyLinkedListing(row('QUANTITY_UPDATE'), 'shop-A', { quantity: 5 })
    const keys = mutations().map((m) => m.variables.key)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })
  it('someone else changed the stock between our read and our write: Shopify refuses, we report it', async () => {
    shop.concurrent = 4
    await expect(syncShopifyLinkedListing(row('QUANTITY_UPDATE'), 'shop-A', { quantity: 5 })).rejects.toThrow(/The quantity changed/)
    expect(shop.stock.get(`gid://shopify/InventoryItem/22@${LOC}`)).toBe(4)
  })
  it('the stock read back after the write differs: an error, not a success', async () => {
    shop.stockAfterWrite = 2
    await expect(syncShopifyLinkedListing(row('QUANTITY_UPDATE'), 'shop-A', { quantity: 5 })).rejects.toThrow(/changed during the read-back \(2 ≠ 5\)/)
  })
  it('already at the target: nothing written', async () => {
    expect(await syncShopifyLinkedListing(row('QUANTITY_UPDATE'), 'shop-A', { quantity: 3 })).toMatch(/nothing sent/)
    expect(mutations()).toHaveLength(0)
  })
  it('a reviewed location: the shop is never asked for its locations', async () => {
    await syncShopifyLinkedListing(row('QUANTITY_UPDATE'), 'shop-A', { quantity: 5 })
    expect(shop.ops.filter((o) => o.query.includes('NexusShopLocations'))).toHaveLength(0)
  })
  it('no reviewed location and the shop has exactly ONE active location: that one is used', async () => {
    const noLocation = row('QUANTITY_UPDATE', { variantId: '11', inventoryItemId: '22', shopifyProductId: '33' })
    expect(await syncShopifyLinkedListing(noLocation, 'shop-A', { quantity: 5 })).toMatch(/3 → 5/)
    expect(mutations()[0].variables.input.quantities[0].locationId).toBe(LOC)
  })
  it('no reviewed location and the shop has two (or no) active locations: refused, nothing written', async () => {
    const noLocation = row('QUANTITY_UPDATE', { variantId: '11', inventoryItemId: '22', shopifyProductId: '33' })
    shop.locations = [{ id: LOC, name: 'Main', isActive: true }, { id: 'gid://shopify/Location/10', name: 'Shop', isActive: true }]
    await expect(syncShopifyLinkedListing(noLocation, 'shop-A', { quantity: 5 })).rejects.toThrow(/the shop has 2 active locations/)
    shop.locations = [{ id: 'gid://shopify/Location/10', name: 'Closed', isActive: false }]
    await expect(syncShopifyLinkedListing(noLocation, 'shop-A', { quantity: 5 })).rejects.toThrow(/no active location/)
    expect(mutations()).toHaveLength(0)
  })
})

describe('P1.4 — content and price', () => {
  it('content: productUpdate for title / description, metafieldsSet for compliance on the product', async () => {
    await syncShopifyLinkedListing(row('CONTENT_UPDATE'), 'shop-A', { content: { title: 'New', description: null, metafields: [{ namespace: 'compliance', key: 'manufacturer', type: 'single_line_text_field', value: 'X' }] } })
    const [update, fields] = mutations()
    expect(update.variables.product).toEqual({ id: 'gid://shopify/Product/33', title: 'New', descriptionHtml: '' })
    expect(fields.variables.metafields).toEqual([expect.objectContaining({ ownerId: 'gid://shopify/Product/33', key: 'manufacturer' })])
  })
  it('content with nothing to push: skipped, nothing written', async () => {
    expect(await syncShopifyLinkedListing(row('CONTENT_UPDATE'), 'shop-A', { content: { metafields: [] } })).toMatch(/skipped/)
    expect(mutations()).toHaveLength(0)
  })
  it('price: written and read back; a price that does not read back is an error', async () => {
    await syncShopifyLinkedListing(row('PRICE_UPDATE'), 'shop-A', { price: 19.5 })
    expect(shop.variants[0].price).toBe('19.50')
    shop.priceIgnored = true
    await expect(syncShopifyLinkedListing(row('PRICE_UPDATE'), 'shop-A', { price: 21 })).rejects.toThrow(/price read-back for SKU-1 differs from 21.00/)
  })
  it('an invalid price: refused, nothing written', async () => {
    await expect(syncShopifyLinkedListing(row('PRICE_UPDATE'), 'shop-A', { price: -1 })).rejects.toThrow(/valid price/)
    expect(mutations()).toHaveLength(0)
  })
})

/**
 * S5 (per-channel SKU) — the caller names the SKU Shopify holds for the listing (`row.sku`, from `listingSendSku`). The
 * variant is still found by its stored ids first; only the SKU it must carry, and the SKU it is looked up by when no ids
 * are stored, change. Without `row.sku`: the product SKU, exactly as before.
 */
describe('S5 — the listing\'s own SKU', () => {
  it('stored ids: a variant carrying the listing\'s own SKU is written (the product SKU alone would refuse it)', async () => {
    shop.variants[0].sku = 'SKU-1-SHOP'
    await expect(syncShopifyLinkedListing(row('QUANTITY_UPDATE'), 'shop-A', { quantity: 5 })).rejects.toThrow(/variant for SKU-1 changed/)
    expect(mutations()).toEqual([])
    const message = await syncShopifyLinkedListing({ ...row('QUANTITY_UPDATE'), sku: 'SKU-1-SHOP' }, 'shop-A', { quantity: 5 })
    expect(message).toBe('Shopify stock set and read back: SKU-1-SHOP 3 → 5.')
    expect(shop.stock.get(`gid://shopify/InventoryItem/22@${LOC}`)).toBe(5)
  })

  it('stored ids: the variant must carry the listing\'s SKU — a variant holding the product SKU is refused for an own-SKU listing', async () => {
    await expect(syncShopifyLinkedListing({ ...row('PRICE_UPDATE'), sku: 'SKU-1-SHOP' }, 'shop-A', { price: 12 })).rejects.toThrow(/variant for SKU-1-SHOP changed/)
    expect(mutations()).toEqual([])
    expect(shop.variants[0].price).toBe('10.00')
  })

  it('no stored ids: looked up by the listing\'s own SKU, never by the product SKU another variant holds', async () => {
    shop.variants.push({ id: 'gid://shopify/ProductVariant/12', sku: 'SKU-1-SHOP', price: '10.00', product: { id: 'gid://shopify/Product/34' }, inventoryItem: { id: 'gid://shopify/InventoryItem/23' } })
    await syncShopifyLinkedListing({ ...row('PRICE_UPDATE', { inventoryLocationId: LOC }), sku: 'SKU-1-SHOP' }, 'shop-A', { price: 12 })
    expect(shop.variants.map(v => [v.sku, v.price])).toEqual([['SKU-1', '10.00'], ['SKU-1-SHOP', '12.00']])
    expect(shop.ops.find(o => o.query.includes('NexusVariantBySku'))?.variables).toEqual({ q: 'sku:"SKU-1-SHOP"' })
  })

  it('an empty `sku` is not a SKU: the product SKU, as before', async () => {
    await syncShopifyLinkedListing({ ...row('QUANTITY_UPDATE'), sku: '' }, 'shop-A', { quantity: 4 })
    expect(shop.stock.get(`gid://shopify/InventoryItem/22@${LOC}`)).toBe(4)
  })
})
