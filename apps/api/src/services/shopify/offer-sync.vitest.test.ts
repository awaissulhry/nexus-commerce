import { beforeEach, expect, it, vi } from 'vitest'
import { parse } from 'graphql'
const state = vi.hoisted(() => ({ listing: {} as any, quantity: 3, price: '10.00', sku: 'BLUE-M', warehouse: 7, writes: [] as any[], stale: false }))
vi.mock('../../db.js', () => ({ default: { channelListing: { findUnique: async () => state.listing }, stockLevel: { findMany: async () => [{ available: state.warehouse }] } } }))
vi.mock('./content-workspace.service.js', () => ({ object: (v: any) => v, digest: JSON.stringify }))
vi.mock('./content-sync.service.js', () => ({ previewContentSync: vi.fn(), synchronizeContent: vi.fn() }))
vi.mock('./admin-client.js', () => ({ assertShopifyResult: (value: any) => { if (value.userErrors.length) throw new Error(value.userErrors[0].message); return value }, shopifyAdmin: async (id: string) => {
  expect(id).toBe('account')
  return { graphql: async (query: string, variables: any) => {
    parse(query)
    if (query.includes('query NexusOffer')) return { productVariant: { id: 'gid://shopify/ProductVariant/2', sku: state.sku, price: state.price, product: { id: 'gid://shopify/Product/1' }, inventoryItem: { id: 'gid://shopify/InventoryItem/3', inventoryLevel: { quantities: [{ name: 'available', quantity: state.quantity }] } } } }
    state.writes.push(variables)
    if (query.includes('NexusOfferInventory')) {
      expect(variables.input.quantities[0].compareQuantity).toBe(3)
      if (!state.stale) state.quantity = variables.input.quantities[0].quantity
      return { inventorySetQuantities: { userErrors: [] } }
    }
    if (query.includes('NexusOfferPrice')) { state.price = variables.variants[0].price; return { productVariantsBulkUpdate: { userErrors: [] } } }
    throw new Error('Unexpected operation')
  } }
} }))
import { syncNativeShopifyOffer } from './offer-sync.service.js'
const item = { id: 'job', channelListing: { id: 'listing' }, syncType: 'STOCK_UPDATE', product: { id: 'child', sku: 'BLUE-M', totalStock: 12, basePrice: '19.50' }, payload: { quantity: 99 } }
beforeEach(() => {
  vi.stubEnv('NEXUS_OVERSELL_CLAMP', '1')
  state.quantity = 3; state.price = '10.00'; state.sku = 'BLUE-M'; state.warehouse = 7; state.writes = []; state.stale = false
  state.listing = { productId: 'child', channelConnectionId: 'account', isPublished: true, followMasterQuantity: true, followMasterPrice: true, quantityOverride: 99, priceOverride: '99.00', stockBuffer: 2, platformAttributes: { nexusFamilyId: 'family', variantId: '2', inventoryItemId: '3', shopifyProductId: '1', inventoryLocationId: 'gid://shopify/Location/4' } }
})
it('follows canonical stock, applies the buffer and clamps to warehouse availability before a compared write', async () => {
  await syncNativeShopifyOffer(item)
  expect(state.writes[0].input.quantities[0]).toEqual({ inventoryItemId: 'gid://shopify/InventoryItem/3', locationId: 'gid://shopify/Location/4', quantity: 5, compareQuantity: 3 })
})
it('uses the explicit account offer when master following is disabled', async () => {
  state.listing.followMasterQuantity = false; state.listing.quantityOverride = 4
  await syncNativeShopifyOffer(item)
  expect(state.quantity).toBe(2)
})
it('refuses changed Shopify identities before mutating price or stock', async () => {
  state.sku = 'RED-M'
  await expect(syncNativeShopifyOffer(item)).rejects.toThrow('identity changed')
  expect(state.writes).toEqual([])
})
it('does not report stock verification when the remote readback differs', async () => {
  state.stale = true
  await expect(syncNativeShopifyOffer(item)).rejects.toThrow('inventory changed during readback')
})
it('follows the canonical price even when an old override remains stored', async () => {
  await syncNativeShopifyOffer({ ...item, syncType: 'PRICE_UPDATE' })
  expect(state.price).toBe('19.50')
})

it.each([{ syncPaused: true }, { offerClosedAt: new Date() }, ...['HELD', 'WITHDRAWN', 'ENDED', 'DISCONTINUED', 'RELEASED'].map(presenceIntent => ({ presenceIntent }))])('refuses locked native Shopify price and stock pushes %j', async lock => {
  Object.assign(state.listing, lock)
  for (const syncType of ['PRICE_UPDATE', 'QUANTITY_UPDATE', 'CONTENT_UPDATE']) {
    await expect(syncNativeShopifyOffer({ ...item, syncType })).rejects.toMatchObject({ code: expect.stringMatching(/^PUSH_/) })
  }
  expect(state.writes).toEqual([])
})
