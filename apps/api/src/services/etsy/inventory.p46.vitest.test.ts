/**
 * P4.6c — the Etsy inventory transform.
 *
 * The fixture is the shape Etsy's own OpenAPI document defines for `getListingInventory`
 * (`etsy.com/openapi/generated/oas/3.0.0.json`, read 2026-09-21), not a shape invented here: a
 * product with `product_id` and `is_deleted`, offerings with `offering_id` and a Money `price`,
 * and property values carrying `scale_name`. Those four keys are the ones Etsy's PUT refuses by
 * name — *"Array contains invalid keys: product_id,is_deleted"* — so a fixture without them
 * would pin a dimension the claim does not hold constant.
 */
import { describe, expect, it } from 'vitest'
import {
  applyOfferingChanges, ETSY_MAX_OFFERING_QUANTITY, EtsyInventoryShapeError, EtsyOfferingNotFound, EtsyQuantityRefusal, inventoryDrift,
  isEtsyInventoryRefusal, moneyToNumber, toInventoryWrite, type EtsyQuantityClamp, type EtsyReadInventory,
} from './inventory.js'

const money = (amount: number, divisor = 100) => ({ amount, divisor, currency_code: 'EUR' })

const read = (): EtsyReadInventory => ({
  products: [
    {
      product_id: 111, sku: 'RED-S', is_deleted: false,
      offerings: [{ offering_id: 901, quantity: 4, is_enabled: true, is_deleted: false, price: money(1999), readiness_state_id: 7 }],
      property_values: [{ property_id: 200, property_name: 'Colour', scale_id: null, scale_name: null, value_ids: [1], values: ['Red'] }],
    },
    {
      product_id: 112, sku: 'BLU-S', is_deleted: false,
      offerings: [{ offering_id: 902, quantity: 0, is_enabled: false, is_deleted: false, price: money(2450), readiness_state_id: null }],
      property_values: [{ property_id: 200, property_name: 'Colour', scale_id: 3, scale_name: 'Inches', value_ids: [2], values: ['Blue'] }],
    },
  ],
  price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [],
})

/** Every key at every depth — a set claim needs a derived answer, not a spot check. */
function deepKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { for (const v of value) deepKeys(v, into); return into }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { into.add(k); deepKeys(v, into) }
  }
  return into
}

describe('P4.6c — moneyToNumber', () => {
  it('converts by the divisor, not by the amount', () => {
    expect(moneyToNumber(money(1999), 'x')).toBe(19.99)
    expect(moneyToNumber(money(2450), 'x')).toBe(24.5)
    expect(moneyToNumber({ amount: 12345, divisor: 1000 }, 'x')).toBe(12.345)
    expect(moneyToNumber({ amount: 500, divisor: 1 }, 'x')).toBe(500)
  })
  it('🔴 never returns the raw amount — that is a hundredfold overcharge', () => {
    expect(moneyToNumber(money(1999), 'x')).not.toBe(1999)
  })
  it('rounds to the divisor\'s own precision, so no float artefact leaves', () => {
    // 0.1 + 0.2 arithmetic is how a money value acquires a seventeenth decimal place.
    expect(String(moneyToNumber({ amount: 1010, divisor: 100 }, 'x'))).toBe('10.1')
    expect(String(moneyToNumber({ amount: 1, divisor: 100 }, 'x'))).toBe('0.01')
    // A divisor that is NOT a power of ten is not Etsy's shape, and the code does not assume one:
    // it falls back to six decimals rather than rounding 1/3 to a whole 0.
    expect(moneyToNumber({ amount: 1, divisor: 3 }, 'x')).toBe(0.333333)
  })
  it('a number is passed through (Etsy echoes one on some paths)', () => {
    expect(moneyToNumber(19.99, 'x')).toBe(19.99)
  })
  it.each([undefined, null, {}, { amount: 1 }, { divisor: 100 }, { amount: NaN, divisor: 100 }, { amount: 100, divisor: 0 }, { amount: 100, divisor: -1 }, { amount: 100, divisor: 1.5 }, -5])
  ('%p is refused rather than guessed', (bad) => {
    expect(() => moneyToNumber(bad as never, 'offering #1')).toThrow(EtsyInventoryShapeError)
  })
})

describe('P4.6c — toInventoryWrite', () => {
  it('🔴 THE 400: none of the four keys Etsy refuses survives, at any depth', () => {
    const keys = deepKeys(toInventoryWrite(read()))
    for (const banned of ['product_id', 'offering_id', 'is_deleted', 'scale_name']) {
      expect([...keys]).not.toContain(banned)
    }
    // POSITIVE CONTROL: the scanner really does see these keys in the INPUT.
    const inputKeys = deepKeys(read())
    for (const banned of ['product_id', 'offering_id', 'is_deleted', 'scale_name']) {
      expect([...inputKeys]).toContain(banned)
    }
  })

  it('produces exactly what the PUT documents, and nothing else', () => {
    expect(toInventoryWrite(read())).toEqual({
      products: [
        {
          sku: 'RED-S',
          offerings: [{ price: 19.99, quantity: 4, is_enabled: true, readiness_state_id: 7 }],
          property_values: [{ property_id: 200, value_ids: [1], values: ['Red'], scale_id: null, property_name: 'Colour' }],
        },
        {
          sku: 'BLU-S',
          offerings: [{ price: 24.5, quantity: 0, is_enabled: false, readiness_state_id: null }],
          property_values: [{ property_id: 200, value_ids: [2], values: ['Blue'], scale_id: 3, property_name: 'Colour' }],
        },
      ],
      price_on_property: [200], quantity_on_property: [200], sku_on_property: [200], readiness_state_on_property: [],
    })
  })

  it('the four *_on_property arrays are echoed — dropping one flattens a variation listing', () => {
    const out = toInventoryWrite(read())
    expect(out.price_on_property).toEqual([200])
    expect(out.quantity_on_property).toEqual([200])
    expect(out.sku_on_property).toEqual([200])
    expect(out.readiness_state_on_property).toEqual([])
  })

  it('a deleted product is dropped, not echoed', () => {
    const input = read()
    input.products![1].is_deleted = true
    const out = toInventoryWrite(input)
    expect(out.products).toHaveLength(1)
    expect(out.products[0].sku).toBe('RED-S')
  })

  it('a deleted OFFERING is dropped too', () => {
    const input = read()
    input.products![0].offerings = [
      { offering_id: 1, quantity: 9, is_enabled: true, is_deleted: true, price: money(100) },
      { offering_id: 2, quantity: 4, is_enabled: true, is_deleted: false, price: money(1999) },
    ]
    expect(toInventoryWrite(input).products[0].offerings).toEqual([{ price: 19.99, quantity: 4, is_enabled: true }])
  })

  it('🔴 a missing is_enabled is REFUSED, not defaulted — false would hide the offering from buyers', () => {
    const input = read()
    delete input.products![0].offerings![0].is_enabled
    expect(() => toInventoryWrite(input)).toThrow('Etsy returned no is_enabled flag')
  })

  it.each([
    ['no products at all', (i: EtsyReadInventory) => { i.products = [] }],
    ['every product deleted', (i: EtsyReadInventory) => { i.products!.forEach((p) => { p.is_deleted = true }) }],
    ['a product with no live offering', (i: EtsyReadInventory) => { i.products![0].offerings = [] }],
    ['a fractional quantity', (i: EtsyReadInventory) => { i.products![0].offerings![0].quantity = 1.5 }],
    ['a negative quantity', (i: EtsyReadInventory) => { i.products![0].offerings![0].quantity = -1 }],
  ])('%s is refused, and the sentence says nothing was sent', (_name, mutate) => {
    const input = read(); mutate(input)
    expect(() => toInventoryWrite(input)).toThrow(/nothing was sent/)
  })

  it('a listing with no variations and no SKU still converts', () => {
    const out = toInventoryWrite({ products: [{ product_id: 1, offerings: [{ offering_id: 2, quantity: 3, is_enabled: true, price: money(500) }] }] })
    expect(out.products).toEqual([{ offerings: [{ price: 5, quantity: 3, is_enabled: true }] }])
  })
})

describe('P4.6c — applyOfferingChanges', () => {
  it('changes only the offering it names', () => {
    const body = toInventoryWrite(read())
    const next = applyOfferingChanges(body, [{ sku: 'RED-S', quantity: 12 }])
    expect(next.products[0].offerings[0]).toEqual({ price: 19.99, quantity: 12, is_enabled: true, readiness_state_id: 7 })
    // 🔴 The price of the offering we did not touch is Etsy's OWN value, echoed back unchanged.
    expect(next.products[1].offerings[0]).toEqual({ price: 24.5, quantity: 0, is_enabled: false, readiness_state_id: null })
  })

  it('does not mutate the body it was given — the original is the record of what Etsy held', () => {
    const body = toInventoryWrite(read())
    applyOfferingChanges(body, [{ sku: 'RED-S', quantity: 99, price: 1 }])
    expect(body.products[0].offerings[0]).toEqual({ price: 19.99, quantity: 4, is_enabled: true, readiness_state_id: 7 })
  })

  it('🔴 a SKU that matches nothing is an ERROR, never a quiet no-op', () => {
    const body = toInventoryWrite(read())
    expect(() => applyOfferingChanges(body, [{ sku: 'GREEN-XL', quantity: 1 }]))
      .toThrow('Etsy has no product with SKU "GREEN-XL" on this listing; nothing was sent.')
  })

  it('a change with no SKU on a multi-product listing is refused rather than applied to all', () => {
    const body = toInventoryWrite(read())
    expect(() => applyOfferingChanges(body, [{ quantity: 1 }])).toThrow('must name its SKU')
  })

  it('a change with no SKU on a single-product listing is fine', () => {
    const body = toInventoryWrite({ products: [{ offerings: [{ quantity: 1, is_enabled: true, price: money(100) }] }] })
    expect(applyOfferingChanges(body, [{ quantity: 8 }]).products[0].offerings[0].quantity).toBe(8)
  })

  it.each([[-1], [2.5], [Number.NaN]])('a quantity of %p is refused', (q) => {
    const body = toInventoryWrite(read())
    expect(() => applyOfferingChanges(body, [{ sku: 'RED-S', quantity: q }])).toThrow(EtsyOfferingNotFound)
  })

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])('a price of %p is refused', (p) => {
    const body = toInventoryWrite(read())
    expect(() => applyOfferingChanges(body, [{ sku: 'RED-S', price: p }])).toThrow(EtsyOfferingNotFound)
  })

  it('an offering index past the end is refused', () => {
    const body = toInventoryWrite(read())
    expect(() => applyOfferingChanges(body, [{ sku: 'RED-S', offeringIndex: 3, quantity: 1 }])).toThrow('has no offering #4')
  })
})

/**
 * 2026-10-01 (Owner) — the guards a STOCK number meets before it may leave for Etsy. Each refusal is raised before the
 * PUT and is not retried (`isEtsyInventoryRefusal`), because the same inventory gives the same answer.
 */
describe('stock numbers for Etsy: what is refused, clamped and left alone', () => {
  const sameSku = (): EtsyReadInventory => {
    const inv = read()
    inv.products![1].sku = 'RED-S'
    return inv
  }

  it('🔴 one SKU on two Etsy products that hold SEPARATE quantities is refused — the number would count twice', () => {
    // Quantity varies by colour (property 200), and the SKU sits on the red AND the blue product.
    const body = toInventoryWrite(sameSku())
    expect(() => applyOfferingChanges(body, [{ sku: 'RED-S', quantity: 3 }]))
      .toThrow(new EtsyQuantityRefusal('Etsy has 2 products with SKU "RED-S" on this listing, and they hold separate quantities; Nexus holds one stock number for that SKU and will not put it on each of them, so nothing was sent.'))
    expect(() => applyOfferingChanges(body, [{ sku: 'RED-S', quantity: 3 }])).toThrow(EtsyQuantityRefusal)
  })

  /**
   * Etsy's own listings tutorial: height (property 100) changes the SKU and the quantity, material (property 300) only
   * the price. So one SKU is on three products (one per material) that share ONE quantity, and Etsy requires that
   * quantity to be the same on all three. Writing the SKU's number to each of them is that one quantity, not three.
   */
  const tutorial = (): EtsyReadInventory => {
    const height = (id: number, name: string) => ({ property_id: 100, property_name: 'Height', scale_id: 5, scale_name: 'Inches', value_ids: [id], values: [name] })
    const material = (id: number, name: string) => ({ property_id: 300, property_name: 'Material', scale_id: null, scale_name: null, value_ids: [id], values: [name] })
    const product = (sku: string, h: [number, string], m: [number, string], quantity: number, amount: number) => ({ sku, is_deleted: false,
      property_values: [height(...h), material(...m)], offerings: [{ quantity, is_enabled: true, is_deleted: false, price: money(amount), readiness_state_id: 7 }] })
    return {
      products: [
        product('TEST-H3', [3, '3'], [1, 'Walnut'], 33, 800), product('TEST-H3', [3, '3'], [2, 'Oak'], 33, 700), product('TEST-H3', [3, '3'], [3, 'Pine'], 33, 600),
        product('TEST-H4', [4, '4'], [1, 'Walnut'], 44, 800), product('TEST-H4', [4, '4'], [2, 'Oak'], 44, 700), product('TEST-H4', [4, '4'], [3, 'Pine'], 44, 600),
      ],
      price_on_property: [300], quantity_on_property: [100], sku_on_property: [100], readiness_state_on_property: [],
    }
  }

  it('🟢 one SKU on several products that share ONE quantity (Etsy\'s tutorial shape): the number goes to each of them', () => {
    const before = toInventoryWrite(tutorial())
    const next = applyOfferingChanges(before, [{ sku: 'TEST-H3', quantity: 12 }])
    expect(next.products.map((p) => [p.sku, p.offerings[0].quantity, p.offerings[0].price])).toEqual([
      ['TEST-H3', 12, 8], ['TEST-H3', 12, 7], ['TEST-H3', 12, 6], ['TEST-H4', 44, 8], ['TEST-H4', 44, 7], ['TEST-H4', 44, 6],
    ])
    // Everything else as Etsy stated it.
    expect(JSON.stringify({ ...next, products: next.products.slice(3) })).toBe(JSON.stringify({ ...before, products: before.products.slice(3) }))
  })

  it('the same shape with one product of the SKU stating no height cannot be shown to share: refused', () => {
    const inv = tutorial(); inv.products![1].property_values = inv.products![1].property_values!.filter((pv) => pv.property_id !== 100)
    expect(() => applyOfferingChanges(toInventoryWrite(inv), [{ sku: 'TEST-H3', quantity: 12 }])).toThrow(/they hold separate quantities/)
  })

  it('🟢 a listing with one quantity and ONE SKU on every product: the number is that one quantity, on each product', () => {
    const inv = read(); inv.quantity_on_property = []; inv.products![1].sku = 'RED-S'; inv.products![1].offerings![0].quantity = 4
    const next = applyOfferingChanges(toInventoryWrite(inv), [{ sku: 'RED-S', quantity: 9 }])
    expect(next.products.map((p) => p.offerings[0].quantity)).toEqual([9, 9])
  })

  it('a listing whose quantity does not vary by variation (quantity_on_property empty) refuses a per-SKU number', () => {
    const inv = read(); inv.quantity_on_property = []
    const body = toInventoryWrite(inv)
    expect(() => applyOfferingChanges(body, [{ sku: 'RED-S', quantity: 3 }]))
      .toThrow('On Etsy this listing has one quantity for all its 2 variations, so a stock number for "RED-S" alone cannot be sent without changing the other 1; nothing was sent.')
    // Even a number Etsy already holds: the listing cannot hold a per-SKU number at all.
    expect(() => applyOfferingChanges(body, [{ sku: 'RED-S', quantity: 4 }])).toThrow(EtsyQuantityRefusal)
  })

  it('a listing with ONE product and no quantity property takes the number (the common Etsy listing)', () => {
    const body = toInventoryWrite({ products: [{ sku: 'MUG', offerings: [{ quantity: 1, is_enabled: true, price: money(100) }] }], quantity_on_property: [] })
    expect(applyOfferingChanges(body, [{ sku: 'MUG', quantity: 8 }]).products[0].offerings[0].quantity).toBe(8)
  })

  it('a quantity that varies by SIZE only: one colour of a size cannot get its own number', () => {
    const size = (id: number, name: string) => ({ property_id: 100, property_name: 'Size', scale_id: 5, scale_name: 'Letter', value_ids: [id], values: [name] })
    const colour = (id: number, name: string) => ({ property_id: 200, property_name: 'Colour', scale_id: null, scale_name: null, value_ids: [id], values: [name] })
    const product = (sku: string, s: [number, string], c: [number, string], quantity: number) => ({ sku, is_deleted: false, property_values: [size(...s), colour(...c)],
      offerings: [{ quantity, is_enabled: true, is_deleted: false, price: money(1000) }] })
    const inv: EtsyReadInventory = {
      products: [product('S-RED', [1, 'S'], [1, 'Red'], 5), product('S-BLU', [1, 'S'], [2, 'Blue'], 5), product('M-RED', [2, 'M'], [1, 'Red'], 2)],
      price_on_property: [], quantity_on_property: [100], sku_on_property: [100, 200],
    }
    expect(() => applyOfferingChanges(toInventoryWrite(inv), [{ sku: 'S-RED', quantity: 3 }]))
      .toThrow('On Etsy "S-RED" shares its quantity with 1 other variation(s) (the quantity varies only by property 100), so a stock number for it alone cannot be sent; nothing was sent.')
    // M has a size of its own, so it may move.
    expect(applyOfferingChanges(toInventoryWrite(inv), [{ sku: 'M-RED', quantity: 7 }]).products.map((p) => p.offerings[0].quantity)).toEqual([5, 5, 7])
  })

  it(`a number above Etsy's ${ETSY_MAX_OFFERING_QUANTITY} is sent as ${ETSY_MAX_OFFERING_QUANTITY}, and the clamp is reported`, () => {
    const report = { clamped: [] as EtsyQuantityClamp[] }
    const next = applyOfferingChanges(toInventoryWrite(read()), [{ sku: 'RED-S', quantity: 1500 }], report)
    expect(next.products[0].offerings[0].quantity).toBe(999)
    expect(report.clamped).toEqual([{ sku: 'RED-S', requested: 1500, sent: 999 }])
    // At the ceiling, nothing is clamped.
    const exact = { clamped: [] as EtsyQuantityClamp[] }
    expect(applyOfferingChanges(toInventoryWrite(read()), [{ sku: 'RED-S', quantity: 999 }], exact).products[0].offerings[0].quantity).toBe(999)
    expect(exact.clamped).toEqual([])
  })

  it('0 is sent as 0 and is_enabled is left as Etsy stated it (the documents set no rule for an enabled offering at 0)', () => {
    const next = applyOfferingChanges(toInventoryWrite(read()), [{ sku: 'RED-S', quantity: 0 }])
    expect(next.products[0].offerings[0]).toEqual({ price: 19.99, quantity: 0, is_enabled: true, readiness_state_id: 7 })
    expect(next.products[1].offerings[0]).toEqual({ price: 24.5, quantity: 0, is_enabled: false, readiness_state_id: null })
  })

  it('a refusal can carry its own code (the order-import refusals use it)', () => {
    expect(new EtsyQuantityRefusal('x', 'ETSY_ORDER_IMPORT_NOT_ACTIVATED').code).toBe('ETSY_ORDER_IMPORT_NOT_ACTIVATED')
  })

  it('the stock guards never hold a PRICE (a price re-sends every quantity as Etsy stated it)', () => {
    const inv = sameSku(); inv.quantity_on_property = []
    inv.products![1].offerings![0].price = money(1999)
    expect(applyOfferingChanges(toInventoryWrite(inv), [{ sku: 'RED-S', price: 21 }]).products.map((p) => [p.offerings[0].price, p.offerings[0].quantity]))
      .toEqual([[21, 4], [21, 0]])
  })

  it('a stock refusal is an Etsy refusal: not retried', () => {
    expect(isEtsyInventoryRefusal(new EtsyQuantityRefusal('x'))).toBe(true)
    expect(new EtsyQuantityRefusal('x').code).toBe('ETSY_QUANTITY_REFUSED')
  })
})

describe('the read-back when one SKU sits on several products (Etsy\'s tutorial shape)', () => {
  const height = (id: number) => ({ property_id: 100, property_name: 'Height', scale_id: null, scale_name: null, value_ids: [id], values: [String(id)] })
  const material = (id: number) => ({ property_id: 300, property_name: 'Material', scale_id: null, scale_name: null, value_ids: [id], values: [`M${id}`] })
  const shape = (quantity: number): EtsyReadInventory => ({
    products: [1, 2, 3].map((mat) => ({ sku: 'TEST-H3', is_deleted: false, property_values: [height(3), material(mat)],
      offerings: [{ quantity, is_enabled: true, is_deleted: false, price: money(500 + mat * 100) }] })),
    price_on_property: [300], quantity_on_property: [100], sku_on_property: [100],
  })

  it('🟢 each product is compared with ITSELF (by its variation values), so a write that landed shows no drift', () => {
    const sent = applyOfferingChanges(toInventoryWrite(shape(33)), [{ sku: 'TEST-H3', quantity: 12 }])
    expect(inventoryDrift(sent, shape(12))).toEqual([])
  })

  it('a price Etsy really moved on ONE of them is still reported, on that product', () => {
    const sent = applyOfferingChanges(toInventoryWrite(shape(33)), [{ sku: 'TEST-H3', quantity: 12 }])
    const after = shape(12); after.products![2].offerings![0].price = money(100)
    expect(inventoryDrift(sent, after)).toEqual([{ product: 'TEST-H3', offering: 1, field: 'price', sent: 8, found: 1 }])
  })
})

describe('P4.6c — inventoryDrift, the read-back', () => {
  const sent = () => applyOfferingChanges(toInventoryWrite(read()), [{ sku: 'RED-S', quantity: 12 }])

  it('🟢 nothing moved: no drift', () => {
    const after = read()
    after.products![0].offerings![0].quantity = 12
    expect(inventoryDrift(sent(), after)).toEqual([])
  })

  it('🔴 TRAP 3: a price we never touched came back BLANK — the one thing the 200 could not tell us', () => {
    const after = read()
    after.products![0].offerings![0].quantity = 12
    after.products![1].offerings![0].price = money(0)   // regional pricing switched off, domestic blanked
    expect(inventoryDrift(sent(), after)).toEqual([
      { product: 'BLU-S', offering: 1, field: 'price', sent: 24.5, found: 0 },
    ])
  })

  it('the quantity we asked for not landing is drift too', () => {
    const after = read()   // quantity still 4, not 12
    expect(inventoryDrift(sent(), after)).toEqual([
      { product: 'RED-S', offering: 1, field: 'quantity', sent: 12, found: 4 },
    ])
  })

  it('an offering that disappeared is drift, not a match', () => {
    const after = read()
    after.products!.splice(1, 1)
    const drift = inventoryDrift(sent(), after)
    expect(drift).toContainEqual({ product: 'BLU-S', offering: 0, field: 'quantity', sent: 0, found: -1 })
  })

  it('🔴 an unreadable read-back THROWS — "could not measure" is not "measured equal"', () => {
    expect(() => inventoryDrift(sent(), { products: [] })).toThrow('could not be confirmed')
    // POSITIVE CONTROL: a readable read-back of the same shape does not throw.
    expect(() => inventoryDrift(sent(), read())).not.toThrow()
  })
})
