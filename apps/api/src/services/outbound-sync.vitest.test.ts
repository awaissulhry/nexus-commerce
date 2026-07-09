/**
 * Phase 0 — outbound-sync correctness helpers.
 *
 * 0.1: master→eBay sync sent a malformed inventory_item body (price on the item,
 * wrong qty key, hardcoded USD) → silent oversell/mispricing. These lock the
 * corrected shapes: qty under shipToLocationAvailability, price on the OFFER,
 * EUR/GBP currency, and a GET-merge-PUT that never wipes existing content.
 * 0.2: the Amazon price PATCH was scoped to the US marketplace for an IT seller.
 */
import { describe, it, expect, vi } from 'vitest'

// outbound-sync.service imports prisma + clients at module load; mock the DB so
// importing the pure helpers under test never spins up a real PrismaClient.
vi.mock('../db.js', () => ({ default: {} }))

import {
  ebayCurrencyForMarket,
  mergeEbayInventoryItem,
  buildEbayOfferUpdate,
  resolveAmazonMarketplaceId,
  buildAmazonListingPatch,
  isFbaListing,
  buildShopifyProductUpdate,
  withTimeout,
  resolveDispatchQuantity,
  applyOversellClamp,
} from './outbound-sync.service.js'
import { computeAvailableToPublish } from './available-to-publish.service.js'

describe('Phase 0.1 — eBay sync payload helpers', () => {
  it('currency is EUR for EU sites, GBP for GB — never USD', () => {
    expect(ebayCurrencyForMarket('EBAY_IT')).toBe('EUR')
    expect(ebayCurrencyForMarket('EBAY_DE')).toBe('EUR')
    expect(ebayCurrencyForMarket('EBAY_GB')).toBe('GBP')
    expect(ebayCurrencyForMarket(undefined)).toBe('EUR')
  })

  it('qty merges under shipToLocationAvailability and preserves existing content (no wipe)', () => {
    const existing = { product: { title: 'Keep me', aspects: { Color: ['Black'] } }, condition: 'NEW' }
    const merged = mergeEbayInventoryItem(existing, { quantity: 7 })
    expect(merged.availability.shipToLocationAvailability.quantity).toBe(7)
    expect(merged.availability.availableQuantity).toBeUndefined() // not the wrong (ignored) key
    expect(merged.product.title).toBe('Keep me') // existing content preserved
    expect(merged.condition).toBe('NEW')
  })

  it('content updates land under product.* when provided', () => {
    const merged = mergeEbayInventoryItem({}, { title: 'New', description: 'Desc', images: ['u1', 'u2'] })
    expect(merged.product.title).toBe('New')
    expect(merged.product.description).toBe('Desc')
    expect(merged.product.imageUrls).toEqual(['u1', 'u2'])
  })

  it('price goes on the OFFER (pricingSummary) with the right currency, preserving offer fields', () => {
    const offer = { offerId: 'O1', categoryId: '123', listingPolicies: { x: 1 } }
    const updated = buildEbayOfferUpdate(offer, 189.9, 'EUR')
    expect(updated.pricingSummary.price).toEqual({ value: '189.90', currency: 'EUR' })
    expect(updated.offerId).toBe('O1')
    expect(updated.categoryId).toBe('123')
    expect(updated.listingPolicies).toEqual({ x: 1 })
  })
})

describe('Phase 0.2 — Amazon marketplace resolution (never US by default)', () => {
  it('resolves EU market codes to their marketplace IDs', () => {
    expect(resolveAmazonMarketplaceId('IT')).toBe('APJ6JRA9NG5V4')
    expect(resolveAmazonMarketplaceId('DE')).toBe('A1PA6795UKMFR9')
    expect(resolveAmazonMarketplaceId('FR')).toBe('A13V1IB3VIYZZH')
  })
  it('defaults to IT (not US) for missing/unknown markets', () => {
    expect(resolveAmazonMarketplaceId(undefined)).toBe('APJ6JRA9NG5V4')
    expect(resolveAmazonMarketplaceId('zz')).toBe('APJ6JRA9NG5V4')
  })
  it('passes a full Amazon marketplace id through unchanged', () => {
    expect(resolveAmazonMarketplaceId('A1PA6795UKMFR9')).toBe('A1PA6795UKMFR9')
  })
})

// A4.0 — the queue's Amazon push was malformed: non-schema names (title/price)
// in a bare {attributes} body. The Listings PATCH needs {productType, patches:[]}
// with real schema names + value shapes.
describe('A4.0 — buildAmazonListingPatch (correct Listings PATCH)', () => {
  it('emits { productType, patches } — NOT a bare { attributes }', () => {
    const body = buildAmazonListingPatch({ price: 19.99 }, 'IT', 'OUTERWEAR')
    expect(body.productType).toBe('OUTERWEAR')
    expect(Array.isArray(body.patches)).toBe(true)
    expect((body as any).attributes).toBeUndefined()
    expect(body.patches[0].op).toBe('replace')
  })
  it('price → purchasable_offer (not "price") with our_price schedule + currency + marketplace', () => {
    const body = buildAmazonListingPatch({ price: 19.99 }, 'IT', 'OUTERWEAR')
    const p = body.patches.find((x: any) => x.path === '/attributes/purchasable_offer')
    expect(p.value[0].our_price[0].schedule[0].value_with_tax).toBe(19.99)
    expect(p.value[0].currency).toBe('EUR')
    expect(p.value[0].marketplace_id).toBe('APJ6JRA9NG5V4')
    expect(body.patches.find((x: any) => x.path === '/attributes/price')).toBeUndefined()
  })
  it('title → item_name with marketplace_id + language_tag', () => {
    const p = buildAmazonListingPatch({ title: 'X' } as any, 'DE', 'OUTERWEAR').patches[0]
    expect(p.path).toBe('/attributes/item_name')
    expect(p.value[0]).toMatchObject({ value: 'X', marketplace_id: 'A1PA6795UKMFR9', language_tag: 'de_DE' })
  })
  it('description → product_description; bulletPoints → bullet_point[]; quantity → fulfillment_availability', () => {
    const body = buildAmazonListingPatch({ description: 'd', bulletPoints: ['a', 'b'], quantity: 5 } as any, 'IT', 'OUTERWEAR')
    const paths = body.patches.map((x: any) => x.path)
    expect(paths).toContain('/attributes/product_description')
    expect(paths).toContain('/attributes/fulfillment_availability')
    const bp = body.patches.find((x: any) => x.path === '/attributes/bullet_point')
    expect(bp.value.length).toBe(2)
    const fa = body.patches.find((x: any) => x.path === '/attributes/fulfillment_availability')
    expect(fa.value[0]).toMatchObject({ fulfillment_channel_code: 'DEFAULT', quantity: 5 })
  })
  it('GB market → GBP currency', () => {
    expect(buildAmazonListingPatch({ price: 10 }, 'UK', 'OUTERWEAR').patches[0].value[0].currency).toBe('GBP')
  })
})

describe('B2 — FBM/FBA-aware quantity push', () => {
  const hasFa = (body: any) => body.patches.some((x: any) => x.path === '/attributes/fulfillment_availability')

  it('FBM → emits fulfillment_availability with DEFAULT channel', () => {
    const body = buildAmazonListingPatch({ quantity: 5 } as any, 'IT', 'OUTERWEAR', 'FBM')
    const fa = body.patches.find((x: any) => x.path === '/attributes/fulfillment_availability')
    expect(fa.value[0]).toMatchObject({ fulfillment_channel_code: 'DEFAULT', quantity: 5 })
  })
  it('unknown method → still emits (safe FBM default; preserves prior behavior)', () => {
    expect(hasFa(buildAmazonListingPatch({ quantity: 5 } as any, 'IT', 'OUTERWEAR'))).toBe(true)
  })
  it('FBA → OMITS fulfillment_availability (Amazon owns the stock)', () => {
    expect(hasFa(buildAmazonListingPatch({ quantity: 5 } as any, 'IT', 'OUTERWEAR', 'FBA'))).toBe(false)
  })
  it('FBA is case-insensitive', () => {
    expect(hasFa(buildAmazonListingPatch({ quantity: 5 } as any, 'IT', 'OUTERWEAR', 'fba'))).toBe(false)
  })
  it('FBA + quantity-only → EMPTY patch set (caller skips the submit)', () => {
    expect(buildAmazonListingPatch({ quantity: 5 } as any, 'IT', 'OUTERWEAR', 'FBA').patches.length).toBe(0)
  })
  it('FBA + price → still emits price; only the qty attribute is dropped', () => {
    const body = buildAmazonListingPatch({ price: 19.99, quantity: 5 } as any, 'IT', 'OUTERWEAR', 'FBA')
    const paths = body.patches.map((x: any) => x.path)
    expect(paths).toContain('/attributes/purchasable_offer')
    expect(paths).not.toContain('/attributes/fulfillment_availability')
    expect(body.patches.length).toBe(1)
  })
})

describe('B2 / FBA-flip fix — isFbaListing resolution (fail-closed)', () => {
  it('listing.fulfillmentMethod=FBA → true', () => {
    expect(isFbaListing({ fulfillmentMethod: 'FBA' }, null)).toBe(true)
  })
  it('product=FBA overrides a stale listing FBM → true (the flip bug: must NOT trust a bare FBM)', () => {
    expect(isFbaListing({ fulfillmentMethod: 'FBM' }, { fulfillmentMethod: 'FBA' })).toBe(true)
  })
  it('persisted AMAZON_EU channel code → true', () => {
    expect(isFbaListing({ platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } }, null)).toBe(true)
  })
  it('persisted DEFAULT channel code, no other FBA signal → false', () => {
    expect(isFbaListing({ platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT' }] } }, null)).toBe(false)
  })
  it('listing method unset → falls back to product method', () => {
    expect(isFbaListing({ fulfillmentMethod: null }, { fulfillmentMethod: 'FBA' })).toBe(true)
    expect(isFbaListing(null, { fulfillmentMethod: 'FBM' })).toBe(false)
  })
  it('FBA stock on hand → true even when both markers say FBM (evidence wins)', () => {
    expect(isFbaListing({ fulfillmentMethod: 'FBM' }, { fulfillmentMethod: 'FBM' }, { fbaStockQty: 8 })).toBe(true)
    expect(isFbaListing({ fulfillmentMethod: 'FBM' }, { fulfillmentMethod: 'FBM' }, { fbaStockQty: 0 })).toBe(false)
  })
  it('active FBA offer → true', () => {
    expect(isFbaListing({ fulfillmentMethod: 'FBM' }, null, { hasActiveFbaOffer: true })).toBe(true)
  })
  it('genuine FBM with no FBA evidence → false (merchant qty push allowed)', () => {
    expect(isFbaListing(null, null)).toBe(false)
    expect(isFbaListing({}, {})).toBe(false)
    expect(isFbaListing({ fulfillmentMethod: 'FBM' }, { fulfillmentMethod: 'FBM' }, { fbaStockQty: 0, hasActiveFbaOffer: false })).toBe(false)
  })
})

describe('PD-Q — withTimeout (anti-deadlock guard)', () => {
  it('resolves when the promise wins the race', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'fast')).resolves.toBe(42)
  })
  it('rejects when the timeout wins (a hung promise)', async () => {
    await expect(withTimeout(new Promise<number>(() => {}), 20, 'hung')).rejects.toThrow(/timed out after 20ms/)
  })
  it('propagates the inner rejection unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom')
  })
})

describe('B3 — buildShopifyProductUpdate (Shopify content push)', () => {
  it('title + description → product { id, title, body_html }', () => {
    expect(buildShopifyProductUpdate('123', { title: 'Casco', description: '<p>desc</p>' }))
      .toEqual({ product: { id: 123, title: 'Casco', body_html: '<p>desc</p>' } })
  })
  it('accepts a numeric id', () => {
    expect(buildShopifyProductUpdate(456, { title: 'X' })!.product.id).toBe(456)
  })
  it('empty/whitespace title is NOT pushed (Shopify rejects an empty title)', () => {
    expect(buildShopifyProductUpdate('1', { title: '   ' })).toBeNull()
    const u = buildShopifyProductUpdate('1', { title: '  ', description: 'd' })
    expect(u!.product).not.toHaveProperty('title')
    expect(u!.product.body_html).toBe('d')
  })
  it('description "" clears body_html (master cleared)', () => {
    expect(buildShopifyProductUpdate('1', { description: '' })!.product.body_html).toBe('')
  })
  it('description null → body_html ""', () => {
    expect(buildShopifyProductUpdate('1', { description: null })!.product.body_html).toBe('')
  })
  it('no pushable field (bullets-only / empty) → null', () => {
    expect(buildShopifyProductUpdate('1', {})).toBeNull()
  })
  it('invalid / missing product id → null', () => {
    expect(buildShopifyProductUpdate(null, { title: 'X' })).toBeNull()
    expect(buildShopifyProductUpdate(undefined, { title: 'X' })).toBeNull()
    expect(buildShopifyProductUpdate('abc', { title: 'X' })).toBeNull()
    expect(buildShopifyProductUpdate(0, { title: 'X' })).toBeNull()
  })
})

describe('Phase 1 — resolveDispatchQuantity (re-read latest at dispatch)', () => {
  it('prefers the current listing quantity over the stale payload snapshot', () => {
    expect(resolveDispatchQuantity(45, 50)).toBe(45)
  })
  it('treats 0 as a real current value (not falsy-skipped)', () => {
    expect(resolveDispatchQuantity(0, 50)).toBe(0)
  })
  it('falls back to the payload snapshot when current is null/undefined', () => {
    expect(resolveDispatchQuantity(null, 50)).toBe(50)
    expect(resolveDispatchQuantity(undefined, 50)).toBe(50)
  })
  it('returns undefined when neither is available', () => {
    expect(resolveDispatchQuantity(null, undefined)).toBeUndefined()
    expect(resolveDispatchQuantity(undefined, null)).toBeUndefined()
  })
})

describe('Phase 2 — applyOversellClamp', () => {
  it('clamps a request above available down to available', () => {
    expect(applyOversellClamp(50, 12)).toEqual({ quantity: 12, clamped: true })
  })
  it('passes through when request is within available', () => {
    expect(applyOversellClamp(8, 12)).toEqual({ quantity: 8, clamped: false })
  })
  it('is a no-op at exact equality', () => {
    expect(applyOversellClamp(12, 12)).toEqual({ quantity: 12, clamped: false })
  })
  it('clamps to 0 when nothing is available', () => {
    expect(applyOversellClamp(5, 0)).toEqual({ quantity: 0, clamped: true })
  })
})

// FB-E — the LIVE Amazon-FBM (syncToAmazon ~:751) and eBay-FBM (syncToEbay ~:874)
// push paths cap the outgoing quantity to computeAvailableToPublish(...).available
// — i.e. reserved-adjusted warehouse available MINUS stockBuffer — then run it
// through applyOversellClamp. This locks that exact composition so a refactor
// can't silently drop the buffer subtraction and reintroduce an oversell.
describe('FB-E — live outbound push clamps by warehouse available − stockBuffer', () => {
  const cap = (warehouseAvailable: number, stockBuffer: number) =>
    computeAvailableToPublish({ fulfillmentMethod: 'FBM', warehouseAvailable, fbaSellable: 0, stockBuffer }).available

  it('a request above available − buffer clamps down to available − buffer', () => {
    const c = cap(10, 3) // warehouse 10 − buffer 3 = 7
    expect(c).toBe(7)
    expect(applyOversellClamp(10, c)).toEqual({ quantity: 7, clamped: true })
  })
  it('the buffer is subtracted even when the raw request fits the pool', () => {
    // request 9 ≤ warehouse 10 but > available−buffer 7 → still clamped to 7.
    expect(applyOversellClamp(9, cap(10, 3))).toEqual({ quantity: 7, clamped: true })
  })
  it('a request within available − buffer passes through untouched', () => {
    expect(applyOversellClamp(5, cap(10, 3))).toEqual({ quantity: 5, clamped: false })
  })
  it('a buffer larger than the pool clamps the push to 0', () => {
    expect(cap(2, 5)).toBe(0)
    expect(applyOversellClamp(2, cap(2, 5))).toEqual({ quantity: 0, clamped: true })
  })
})
