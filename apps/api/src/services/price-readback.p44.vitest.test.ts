/**
 * P4.4e — price read-back.
 *
 * Two propositions:
 *   A. the DRIFT verdict, in cents, keeping "not told" apart from "told zero";
 *   B. the Amazon arm, over the report rows the quantity arm already holds —
 *      so the read-back costs no additional API call.
 */
import { describe, expect, it, vi } from 'vitest'
import { priceDrift, priceDriftMessage, priceHealEnabled } from './price-readback.service.js'
import { diffPriceReadback } from '../jobs/amazon-qty-readback.job.js'

// ── A. the verdict ──────────────────────────────────────────────────────────
describe('P4.4e priceDrift', () => {
  it.each([
    ['agreement', 49.9, 49.9],
    ['agreement across float representations', 0.1 + 0.2, 0.3],
    ['a sub-cent difference is not a drift', 49.901, 49.9],
  ])('%s → nothing to report', (_n, channelPrice, intendedPrice) => {
    expect(priceDrift({ channelPrice, intendedPrice })).toBeNull()
  })

  it('the channel being HIGHER is a positive difference', () => {
    expect(priceDrift({ channelPrice: 59.9, intendedPrice: 49.9 }))
      .toEqual({ channelPrice: 59.9, intendedPrice: 49.9, difference: 10 })
  })

  it('the channel being LOWER is a negative difference', () => {
    expect(priceDrift({ channelPrice: 39.9, intendedPrice: 49.9 })?.difference).toBe(-10)
  })

  it('compares in CENTS, not in floats', () => {
    // 1.005 − 1.00 in floats is 0.004999999999999893. In cents it is 1.
    expect(priceDrift({ channelPrice: 1.01, intendedPrice: 1.0 })?.difference).toBe(0.01)
  })

  it.each([
    ['the channel did not tell us', null, 49.9],
    ['the channel sent nonsense', Number.NaN, 49.9],
    ['we have no intended price', 49.9, null],
    ['neither side has one', null, null],
  ])('🔴 %s is NOT a drift of that amount', (_n, channelPrice, intendedPrice) => {
    // "did not tell us" and "says 0" are different facts, and conflating them
    // turns every unpriced listing into a false conflict.
    expect(priceDrift({ channelPrice, intendedPrice })).toBeNull()
  })

  it('🔴 a channel price of ZERO on a listing we intend to sell IS reported', () => {
    // The price equivalent of the scoped Zero. Zero is a value, not a gap.
    expect(priceDrift({ channelPrice: 0, intendedPrice: 49.9 })?.difference).toBe(-49.9)
  })

  it('an intended price of zero is compared like any other', () => {
    expect(priceDrift({ channelPrice: 10, intendedPrice: 0 })?.difference).toBe(10)
    expect(priceDrift({ channelPrice: 0, intendedPrice: 0 })).toBeNull()
  })

  it('the sentence carries both numbers, to the cent', () => {
    const drift = priceDrift({ channelPrice: 59.9, intendedPrice: 49.9 })!
    expect(priceDriftMessage({ channel: 'Amazon', sku: 'SKU-1', drift, currency: 'EUR' }))
      .toBe('Amazon shows EUR 59.90 for SKU-1 but the listing intends EUR 49.90.')
    expect(priceDriftMessage({ channel: 'Shopify', sku: 'S', drift }))
      .toBe('Shopify shows 59.90 for S but the listing intends 49.90.')
  })

  it('🔴 healing is OFF unless the switch is exactly "true"', () => {
    // A scheduled money write is not a default anybody inherits by accident.
    const before = process.env.NEXUS_ENABLE_PRICE_READBACK_HEAL
    try {
      delete process.env.NEXUS_ENABLE_PRICE_READBACK_HEAL
      expect(priceHealEnabled()).toBe(false)
      process.env.NEXUS_ENABLE_PRICE_READBACK_HEAL = '1'
      expect(priceHealEnabled()).toBe(false)
      process.env.NEXUS_ENABLE_PRICE_READBACK_HEAL = 'true'
      expect(priceHealEnabled()).toBe(true)
    } finally {
      if (before === undefined) delete process.env.NEXUS_ENABLE_PRICE_READBACK_HEAL
      else process.env.NEXUS_ENABLE_PRICE_READBACK_HEAL = before
    }
  })
})

// ── B. the Amazon arm ───────────────────────────────────────────────────────
const ours = (price: number | null) => [{ sku: 'A', price, channelListingId: 'cl-1', productId: 'p-1' }]

describe('P4.4e diffPriceReadback', () => {
  it('reports a drifted SKU with its coordinate', () => {
    const out = diffPriceReadback([{ sku: 'A', price: 59.9 }], ours(49.9), 'IT')
    expect(out).toEqual([{ sku: 'A', marketplace: 'IT', channelListingId: 'cl-1', productId: 'p-1', drift: { channelPrice: 59.9, intendedPrice: 49.9, difference: 10 } }])
  })

  it('an agreeing SKU produces nothing', () => {
    expect(diffPriceReadback([{ sku: 'A', price: 49.9 }], ours(49.9), 'IT')).toEqual([])
  })

  it('a SKU Amazon has and we do not is skipped, not reported', () => {
    expect(diffPriceReadback([{ sku: 'ZZ', price: 1 }], ours(49.9), 'IT')).toEqual([])
  })

  it('a listing with no intended price is skipped, not read as 0', () => {
    expect(diffPriceReadback([{ sku: 'A', price: 59.9 }], ours(null), 'IT')).toEqual([])
  })

  it('🔴 FBA rows ARE compared, unlike the quantity arm', () => {
    // Amazon owns FBA stock. It does not own the price — a merchant sets that
    // either way, so excluding FBA here would blind the check on exactly the
    // listings that sell most.
    const out = diffPriceReadback(
      [{ sku: 'A', price: 59.9, fulfillmentChannel: 'AMAZON_EU' } as never],
      ours(49.9),
      'IT',
    )
    expect(out).toHaveLength(1)
  })
})

// ── C. the Shopify reader really returns the price ──────────────────────────
/**
 * 🔴 The read-back's own test MOCKS `listing-write.service.js`, so it can never
 * convict a reader that stops returning the price — the arm that would fail is
 * the one never run. A mutation proved exactly that. This exercises the real
 * `readShopifyAvailable` against a stubbed GraphQL, and its point is that ONE
 * query answers both arms: the price read costs no additional call.
 */
describe('P4.4e readShopifyAvailable returns the price from the same query', () => {
  const row = {
    id: 'cl-1',
    syncType: 'QUANTITY_UPDATE',
    product: { id: 'p-1', sku: 'SKU-1' },
    channelListing: {
      id: 'cl-1',
      // Stored ids so `identify` needs no lookup, and a reviewed location so
      // `stockLocation` needs none either — one query in total.
      platformAttributes: {
        variantId: '1', inventoryItemId: '2', shopifyProductId: '3',
        inventoryLocationId: 'gid://shopify/Location/9',
      },
    },
  }
  const variant = (price: unknown, quantity: unknown) => ({
    productVariant: {
      id: 'gid://shopify/ProductVariant/1', sku: 'SKU-1', price,
      product: { id: 'gid://shopify/Product/3' },
      inventoryItem: { id: 'gid://shopify/InventoryItem/2', inventoryLevel: { quantities: [{ name: 'available', quantity }] } },
    },
  })

  it('one query answers both arms', async () => {
    const { readShopifyAvailable } = await import('./shopify/listing-write.service.js')
    const gql = vi.fn(async () => variant('49.90', 5))
    const result = await readShopifyAvailable(gql as never, row as never)
    expect(gql).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ available: 5, price: 49.9, locationId: 'gid://shopify/Location/9' })
  })

  it('a price Shopify omits comes back null, not 0', async () => {
    const { readShopifyAvailable } = await import('./shopify/listing-write.service.js')
    const gql = vi.fn(async () => variant(undefined, 5))
    expect((await readShopifyAvailable(gql as never, row as never)).price).toBeNull()
  })

  it('a price of "0.00" comes back as 0, which is a value', async () => {
    const { readShopifyAvailable } = await import('./shopify/listing-write.service.js')
    const gql = vi.fn(async () => variant('0.00', 5))
    expect((await readShopifyAvailable(gql as never, row as never)).price).toBe(0)
  })
})
