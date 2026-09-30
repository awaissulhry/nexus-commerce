/**
 * 2026-09-30 — an Etsy PRICE through the inventory transform: which offerings a price may change, and in which
 * currency.
 *
 * Etsy's inventory PUT is a full replace, so a price write sends every product, offering and quantity of the listing.
 * The arms below hold the claim "only the target offering's price changes" as a set claim: the whole body is compared,
 * not one field of it. The fixtures are the GET shape of Etsy's OpenAPI document (as in `inventory.p46`), with the four
 * keys the PUT refuses (`product_id`, `is_deleted`, `offering_id`, `scale_name`) present on purpose.
 */
import { describe, expect, it } from 'vitest'
import {
  applyOfferingChanges, EtsyInventoryShapeError, EtsyOfferingNotFound, EtsyPriceRefusal, etsyPriceCurrencyRefusal,
  isEtsyInventoryRefusal, toInventoryWrite, type EtsyReadInventory,
} from './inventory.js'

const money = (amount: number, currency_code = 'EUR') => ({ amount, divisor: 100, currency_code })
const colour = (id: number, name: string) => ({ property_id: 200, property_name: 'Colour', scale_id: null, scale_name: null, value_ids: [id], values: [name] })
const size = (id: number, name: string) => ({ property_id: 100, property_name: 'Size', scale_id: 5, scale_name: 'Letter', value_ids: [id], values: [name] })

/** Three colours, the price varying by colour, one of them disabled and one with no processing profile. */
const byColour = (): EtsyReadInventory => ({
  products: [
    { product_id: 11, sku: 'RED-S', is_deleted: false, property_values: [colour(1, 'Red')],
      offerings: [{ offering_id: 91, quantity: 4, is_enabled: true, is_deleted: false, price: money(1999), readiness_state_id: 7 }] },
    { product_id: 12, sku: 'BLU-S', is_deleted: false, property_values: [colour(2, 'Blue')],
      offerings: [{ offering_id: 92, quantity: 0, is_enabled: false, is_deleted: false, price: money(2450), readiness_state_id: null }] },
    { product_id: 13, sku: 'GRN-S', is_deleted: false, property_values: [colour(3, 'Green')],
      offerings: [{ offering_id: 93, quantity: 17, is_enabled: true, is_deleted: false, price: money(2100), readiness_state_id: 7 }] },
  ],
  price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [],
})

/** Everything except one offering's price, as JSON: the part of the body a price change must not move. */
const withoutPrice = (body: ReturnType<typeof toInventoryWrite>, sku: string) =>
  JSON.stringify({ ...body, products: body.products.map((p) => p.sku === sku ? { ...p, offerings: p.offerings.map(({ price: _price, ...rest }) => rest) } : p) })

describe('a price changes that offering\'s price and nothing else', () => {
  it('🔴 every other product, offering, quantity, flag and property is byte-identical', () => {
    const current = toInventoryWrite(byColour())
    const next = applyOfferingChanges(current, [{ sku: 'GRN-S', price: 26 }])
    expect(next.products[2].offerings[0].price).toBe(26)
    // The set claim: take the one changed price out of both, and the rest is the same bytes.
    expect(withoutPrice(next, 'GRN-S')).toBe(withoutPrice(current, 'GRN-S'))
    // And spelled out for the fields the Owner named: no quantity moved, on any offering.
    expect(next.products.flatMap((p) => p.offerings.map((o) => o.quantity))).toEqual([4, 0, 17])
    expect(next.products.map((p) => p.offerings[0].price)).toEqual([19.99, 24.5, 26])
  })

  it('a single-product listing (no variations, the common Etsy case) changes its one price', () => {
    const read: EtsyReadInventory = { products: [{ product_id: 1, sku: 'MUG-1', is_deleted: false, property_values: [],
      offerings: [{ offering_id: 2, quantity: 9, is_enabled: true, is_deleted: false, price: money(1200) }] }], price_on_property: [], quantity_on_property: [], sku_on_property: [] }
    const current = toInventoryWrite(read)
    const next = applyOfferingChanges(current, [{ sku: 'MUG-1', price: 13.5 }])
    expect(next.products[0].offerings[0]).toEqual({ price: 13.5, quantity: 9, is_enabled: true })
    expect(withoutPrice(next, 'MUG-1')).toBe(withoutPrice(current, 'MUG-1'))
  })
})

describe('🔴 a price Etsy keeps as ONE is refused for one SKU alone', () => {
  it('the price does not vary by variation (price_on_property empty): refused, nothing changed', () => {
    const read = byColour(); read.price_on_property = []
    for (const p of read.products!) p.offerings![0].price = money(2000)
    const current = toInventoryWrite(read)
    expect(() => applyOfferingChanges(current, [{ sku: 'RED-S', price: 22 }]))
      .toThrow('On Etsy this listing has one price for all its 3 variations, so a price for "RED-S" alone cannot be sent without changing the other 2; nothing was sent.')
    expect(() => applyOfferingChanges(current, [{ sku: 'RED-S', price: 22 }])).toThrow(EtsyPriceRefusal)
    // POSITIVE CONTROL: the same listing, the price it already holds — nothing splits, nothing is refused.
    expect(applyOfferingChanges(current, [{ sku: 'RED-S', price: 20 }])).toEqual(current)
  })

  it('the price varies by SIZE only: one colour of a size cannot be priced apart from the other colours of that size', () => {
    const read: EtsyReadInventory = {
      products: [
        { product_id: 1, sku: 'RED-S', property_values: [colour(1, 'Red'), size(10, 'S')], offerings: [{ quantity: 1, is_enabled: true, price: money(2000) }] },
        { product_id: 2, sku: 'BLU-S', property_values: [colour(2, 'Blue'), size(10, 'S')], offerings: [{ quantity: 2, is_enabled: true, price: money(2000) }] },
        { product_id: 3, sku: 'RED-L', property_values: [colour(1, 'Red'), size(11, 'L')], offerings: [{ quantity: 3, is_enabled: true, price: money(2500) }] },
      ],
      price_on_property: [100], quantity_on_property: [100, 200], sku_on_property: [100, 200],
    }
    expect(() => applyOfferingChanges(toInventoryWrite(read), [{ sku: 'RED-S', price: 21 }]))
      .toThrow('On Etsy "RED-S" shares its price with 1 other variation(s) (the price varies only by property 100)')
    // POSITIVE CONTROL: RED-L is the only product of size L, so its price is its own.
    expect(applyOfferingChanges(toInventoryWrite(read), [{ sku: 'RED-L', price: 26 }]).products.map((p) => p.offerings[0].price)).toEqual([20, 20, 26])
  })

  it('one SKU on two Etsy products at DIFFERENT prices: Nexus does not choose, nor flatten them', () => {
    const read = byColour(); read.products![2].sku = 'RED-S'   // Etsy allows it when the SKU does not vary by colour
    expect(() => applyOfferingChanges(toInventoryWrite(read), [{ sku: 'RED-S', price: 30 }]))
      .toThrow('Etsy has 2 products with SKU "RED-S" at different prices; Nexus holds one price for that SKU and will not choose between them, so nothing was sent.')
  })

  it('one SKU on two Etsy products at the SAME price: both are that SKU\'s price, and both change', () => {
    const read = byColour(); read.products![2].sku = 'RED-S'; read.products![2].offerings![0].price = money(1999)
    const next = applyOfferingChanges(toInventoryWrite(read), [{ sku: 'RED-S', price: 30 }])
    expect(next.products.map((p) => p.offerings[0].price)).toEqual([30, 24.5, 30])
    expect(next.products.map((p) => p.offerings[0].quantity)).toEqual([4, 0, 17])
  })

  it('a quantity change is not held to the price rule (it never moves a price)', () => {
    const read = byColour(); read.price_on_property = []
    expect(() => applyOfferingChanges(toInventoryWrite(read), [{ sku: 'RED-S', quantity: 5 }])).not.toThrow()
  })
})

describe('🔴 the currency Etsy states must be the one Nexus priced in', () => {
  it('the same currency passes', () => {
    expect(etsyPriceCurrencyRefusal(byColour(), 'EUR')).toBeNull()
    expect(etsyPriceCurrencyRefusal(byColour(), 'eur')).toBeNull()
  })
  it('another currency is refused — a price is never converted', () => {
    const read = byColour(); for (const p of read.products!) p.offerings![0].price = money(1999, 'USD')
    expect(etsyPriceCurrencyRefusal(read, 'EUR')).toBe('Etsy prices this listing in USD, and Nexus holds this price in EUR. A price is never converted, so nothing was sent.')
  })
  it('a listing where Etsy states no currency cannot be checked, so it is refused', () => {
    const read = byColour(); read.products![1].offerings![0].price = { amount: 2450, divisor: 100 }
    expect(etsyPriceCurrencyRefusal(read, 'EUR')).toContain('Etsy did not state the currency')
    const bare = byColour(); bare.products![0].offerings![0].price = 19.99
    expect(etsyPriceCurrencyRefusal(bare, 'EUR')).toContain('Etsy did not state the currency')
  })
  it('a price with no currency named is refused before anything else', () => {
    expect(etsyPriceCurrencyRefusal(byColour(), undefined)).toBe('A price for Etsy must say which currency it is in; nothing was sent.')
    expect(etsyPriceCurrencyRefusal(byColour(), 'euro')).toBe('A price for Etsy must say which currency it is in; nothing was sent.')
  })
  it('a deleted offering in another currency is not part of the listing any more', () => {
    const read = byColour(); read.products![1].is_deleted = true; read.products![1].offerings![0].price = money(1, 'USD')
    expect(etsyPriceCurrencyRefusal(read, 'EUR')).toBeNull()
  })
})

describe('which failures are Etsy refusing, and which are worth a retry', () => {
  it('the three refusals are not retried; anything else (a failed read) is', () => {
    expect(isEtsyInventoryRefusal(new EtsyPriceRefusal('x'))).toBe(true)
    expect(isEtsyInventoryRefusal(new EtsyOfferingNotFound('x'))).toBe(true)
    expect(isEtsyInventoryRefusal(new EtsyInventoryShapeError('x'))).toBe(true)
    expect(isEtsyInventoryRefusal(new Error('Etsy could not read this resource (HTTP 503).'))).toBe(false)
  })
})
