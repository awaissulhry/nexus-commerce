import { beforeEach, expect, it, vi } from 'vitest'
import { parse } from 'graphql'
const state = vi.hoisted(() => ({ listing: {} as any, product: {} as any, colour: null as any, remoteIdentity: 'workspace:family:c:colour', policies: [] as any[], policyReadFailed: false, routes: [] as string[], quantity: 3, price: '10.00', sku: 'BLUE-M', warehouse: 7, writes: [] as any[], stale: false }))
// Shared stock — the offer follows the product's ledger (loadSyncLedgers): its own WAREHOUSE rows here
// (12 on the shelf, 7 available), no pool, no link history.
vi.mock('../../db.js', () => ({ default: {
  channelListing: { findUnique: async () => state.listing },
  product: { findUnique: async () => state.product },
  shopifyColourProduct: { findUnique: async () => state.colour },
  stockLevel: { findMany: async () => [{ productId: 'child', quantity: 12, available: state.warehouse, location: { type: 'WAREHOUSE', code: 'IT-MAIN', syncRoutes: state.routes } }] },
  syncChannelPolicy: { findMany: async () => { if (state.policyReadFailed) throw new Error('Policy read failed'); return state.policies } },
  stockPoolLink: { findMany: async () => [] },
  $queryRaw: async () => [],
} }))
vi.mock('./content-workspace.service.js', () => ({ object: (v: any) => v, digest: JSON.stringify }))
vi.mock('./content-sync.service.js', () => ({ previewContentSync: vi.fn(), synchronizeContent: vi.fn() }))
vi.mock('./colour-products/sync-work.js', () => ({ withColourSyncLock: async (_d: unknown, fn: () => Promise<unknown>) => fn(), guardedColourGraphql: (gql: unknown) => gql }))
vi.mock('./admin-client.js', () => ({ assertShopifyResult: (value: any) => { if (value.userErrors.length) throw new Error(value.userErrors[0].message); return value }, shopifyAdmin: async (id: string) => {
  expect(id).toBe('account')
  return { graphql: async (query: string, variables: any) => {
    parse(query)
    if (query.includes('query NexusOffer')) return { productVariant: { id: 'gid://shopify/ProductVariant/2', sku: state.sku, price: state.price, product: { id: 'gid://shopify/Product/1', identity: { value: state.remoteIdentity } }, inventoryItem: { id: 'gid://shopify/InventoryItem/3', inventoryLevel: { quantities: [{ name: 'available', quantity: state.quantity }] } } } }
    state.writes.push(variables)
    if (query.includes('NexusOfferInventory')) {
      // P1.4 — API 2026-04+: compare-and-set is `changeFromQuantity`, and the mutation carries `@idempotent(key)`.
      expect(variables.input.quantities[0].changeFromQuantity).toBe(3)
      expect(variables.input.quantities[0]).not.toHaveProperty('compareQuantity')
      expect(query).toMatch(/@idempotent\(key:\$key\)/)
      expect(variables.key).toMatch(/^[0-9a-f]{40}$/)
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
  state.product = { id: 'child', sku: 'BLUE-M', parentId: 'family', deletedAt: null }
  state.policies = []; state.routes = []; state.policyReadFailed = false
  state.remoteIdentity = 'workspace:family:c:colour'
  state.colour = { id: 'colour', workspaceId: 'workspace', familyId: 'family', channelConnectionId: 'account', marketplace: 'GLOBAL', aliasKey: '', state: 'LINKED', shopifyProductId: 'gid://shopify/Product/1' }
  state.listing = { productId: 'child', channelConnectionId: 'account', isPublished: true, followMasterQuantity: true, followMasterPrice: true, quantityOverride: 99, priceOverride: '99.00', stockBuffer: 2, platformAttributes: { nexusFamilyId: 'family', variantId: '2', inventoryItemId: '3', shopifyProductId: '1', inventoryLocationId: 'gid://shopify/Location/4' } }
})

it('zeros a retired colour size even while hidden, with positive master stock and override', async () => {
  Object.assign(state.listing, { marketplace: 'GLOBAL', aliasKey: '', isPublished: false })
  state.listing.platformAttributes.shopifyColourProductId = 'colour'
  state.product.deletedAt = new Date()
  await syncNativeShopifyOffer(item)
  expect(state.quantity).toBe(0)
  expect(state.writes).toHaveLength(1)
  expect(state.price).toBe('10.00')
})
it('does not let an old stock job restore a size moved out of its colour family', async () => {
  Object.assign(state.listing, { marketplace: 'GLOBAL', aliasKey: '' })
  state.listing.platformAttributes.shopifyColourProductId = 'colour'
  state.product.parentId = 'another-family'
  await syncNativeShopifyOffer(item)
  expect(state.quantity).toBe(0)
})
it('refuses old work after the colour product is forgotten', async () => {
  Object.assign(state.listing, { marketplace: 'GLOBAL', aliasKey: '' })
  state.listing.platformAttributes.shopifyColourProductId = 'colour'
  state.colour.state = 'DELETED'; state.colour.shopifyProductId = null
  await expect(syncNativeShopifyOffer(item)).rejects.toThrow(/colour.*mapping/i)
  expect(state.writes).toEqual([])
})
it('refuses a queued account that no longer owns the listing', async () => {
  await expect(syncNativeShopifyOffer({ ...item, channelConnectionId: 'old-account' })).rejects.toThrow(/destination/i)
  expect(state.writes).toEqual([])
})
it('does not send stock from a warehouse that is not routed to this colour listing', async () => {
  Object.assign(state.listing, { marketplace: 'GLOBAL', aliasKey: '' })
  state.listing.platformAttributes.shopifyColourProductId = 'colour'
  state.routes = ['AMAZON:IT']
  await expect(syncNativeShopifyOffer(item)).rejects.toThrow(/UNCOUNTED/)
  expect(state.writes).toEqual([])
})
it('keeps a channel policy pause even for retired colour stock', async () => {
  Object.assign(state.listing, { marketplace: 'GLOBAL', aliasKey: '' })
  state.listing.platformAttributes.shopifyColourProductId = 'colour'
  state.product.deletedAt = new Date()
  state.policies = [{ channel: 'SHOPIFY', marketplace: '*', pushesPaused: true, newListingDefaultMode: 'FOLLOW' }]
  await expect(syncNativeShopifyOffer(item)).rejects.toThrow(/PAUSED/)
  expect(state.writes).toEqual([])
})
it('sends no colour stock when its policy cannot be read', async () => {
  Object.assign(state.listing, { marketplace: 'GLOBAL', aliasKey: '' })
  state.listing.platformAttributes.shopifyColourProductId = 'colour'; state.policyReadFailed = true
  await expect(syncNativeShopifyOffer(item)).rejects.toThrow('Policy read failed')
  expect(state.writes).toEqual([])
})
it('refuses stock and price when only the remote colour family identity changed', async () => {
  Object.assign(state.listing, { marketplace: 'GLOBAL', aliasKey: '' })
  state.listing.platformAttributes.shopifyColourProductId = 'colour'; state.remoteIdentity = 'another-family'
  for (const syncType of ['PRICE_UPDATE', 'QUANTITY_UPDATE']) await expect(syncNativeShopifyOffer({ ...item, syncType })).rejects.toThrow(/identity changed/)
  expect(state.writes).toEqual([])
})
it('follows canonical stock, applies the buffer and clamps to warehouse availability before a compared write', async () => {
  await syncNativeShopifyOffer(item)
  expect(state.writes[0].input.quantities[0]).toEqual({ inventoryItemId: 'gid://shopify/InventoryItem/3', locationId: 'gid://shopify/Location/4', quantity: 5, changeFromQuantity: 3 })
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
