/**
 * P5.1 — Orders v0 → 2026-01-01: the conversion back to the v0 shape.
 *
 * FIXTURE LABEL: **SHAPE, Amazon-authored.** `test-support/amazon-orders-2026-example.json`
 * is copied verbatim from the `200` examples in Amazon's own published model
 * (`amzn/selling-partner-api-models`, `models/orders-api-model/orders_2026-01-01.json`).
 * It is NOT a hand-written fixture and NOT observed traffic. No live 2026-01-01
 * call has been made — that needs the Owner. A fixture written by hand can
 * agree with the bug (P2.2), so the rules here are read off Amazon's numbers,
 * not off our own idea of them.
 *
 * The four propositions, each with its own arm:
 *   1. money  — `ItemPrice` is the LINE total, never the per-unit price.
 *   2. status — the new vocabulary is converted, never passed through.
 *   3. channel — `AMAZON`/`MERCHANT` become `AFN`/`MFN` (P2.2's fact renamed).
 *   4. absence — a section left out of `includedData` yields no value, not a
 *      made-up one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import example from '../../test-support/amazon-orders-2026-example.json'
import {
  FULFILLED_BY_TO_V0,
  FULFILLMENT_STATUS_TO_V0,
  clearOrderItemsCache,
  lineTotalOf,
  orderOf,
  takeOrderItems,
  toV0Order,
  toV0OrderItems,
  toV0Page,
  type Order2026,
  type SearchOrdersResponse2026,
} from './amazon-orders-2026.js'

const SEARCH = example.searchOrders as SearchOrdersResponse2026
const AMAZON_ORDER = SEARCH.orders![0] as Order2026

beforeEach(() => clearOrderItemsCache())
afterEach(() => clearOrderItemsCache())

/** Positive control: the fixture really is Amazon's, and carries the numbers the rules are about. */
describe('the fixture', () => {
  it('is Amazon’s own example and holds a multi-unit line', () => {
    expect(AMAZON_ORDER.orderId).toBe('123-4567890-1234567')
    const item = AMAZON_ORDER.orderItems![0]
    expect(item.quantityOrdered).toBe(2)
    expect(item.product!.price!.unitPrice!.amount).toBe('49.99')
    const itemBreakdown = item.proceeds!.breakdowns!.find((b) => b.type === 'ITEM')
    expect(itemBreakdown!.subtotal!.amount).toBe('99.98')
    // The two differ, so a test that confuses them CAN fail. Without this the
    // money arm below would pass on a single-unit order by coincidence.
    expect(itemBreakdown!.subtotal!.amount).not.toBe(item.product!.price!.unitPrice!.amount)

    // And the SECOND line is the coincidence arm: quantity 1, where the unit
    // price and the line total are the same number. A rule proven only on that
    // line would look right while being wrong. The arms are kept apart.
    const single = AMAZON_ORDER.orderItems![1]
    expect(single.quantityOrdered).toBe(1)
    expect(single.proceeds!.breakdowns!.find((b) => b.type === 'ITEM')!.subtotal!.amount)
      .toBe(single.product!.price!.unitPrice!.amount)
  })
})

describe('1. money — ItemPrice is the LINE total', () => {
  it('takes the ITEM proceeds breakdown, not product.price.unitPrice', () => {
    const [item] = toV0OrderItems(AMAZON_ORDER)
    // 99.98 = 49.99 x 2. upsertOrderItem divides by QuantityOrdered (DA-RT.15),
    // so this is the only value that survives that division as 49.99.
    expect(item.ItemPrice).toEqual({ Amount: '99.98', CurrencyCode: 'USD' })
    expect(item.ItemPrice!.Amount).not.toBe('49.99')
  })

  it('survives the ingest’s divide-by-quantity as the real unit price', () => {
    const [item] = toV0OrderItems(AMAZON_ORDER)
    // The arithmetic upsertOrderItem performs, asserted here so the two cannot
    // drift apart silently.
    const storedUnitPrice = Number(item.ItemPrice!.Amount) / item.QuantityOrdered
    expect(storedUnitPrice).toBeCloseTo(49.99, 2)
  })

  it('falls back to unitPrice x quantity when Amazon sends no ITEM breakdown', () => {
    const item = lineTotalOf({
      quantityOrdered: 3,
      product: { price: { unitPrice: { amount: '10.00', currencyCode: 'EUR' } } },
    })
    expect(item).toEqual({ Amount: '30.00', CurrencyCode: 'EUR' })
  })

  it('gives no price at all rather than a bare unit price', () => {
    // No breakdowns AND no quantity: there is no line total to state. Saying
    // nothing is correct; saying "49.99" would be a quarter of the truth on a
    // quantity-4 line.
    expect(lineTotalOf({ product: { price: { unitPrice: { amount: '49.99' } } } })).toBeUndefined()
    expect(lineTotalOf({ quantityOrdered: 2 })).toBeUndefined()
  })

  it('reads the order total from proceeds.grandTotal', () => {
    expect(toV0Order(AMAZON_ORDER).OrderTotal).toEqual({ Amount: '154.99', CurrencyCode: 'USD' })
  })
})

describe('2. status — the new vocabulary is converted, not passed through', () => {
  // mapStatus in amazon-orders.service.ts switches on the v0 spelling and has a
  // `default: PENDING`. Every new value must land on a v0 word it knows.
  const CASES: Array<[string, string]> = [
    ['PENDING_AVAILABILITY', 'PendingAvailability'],
    ['PENDING', 'Pending'],
    ['UNSHIPPED', 'Unshipped'],
    ['PARTIALLY_SHIPPED', 'PartiallyShipped'],
    ['SHIPPED', 'Shipped'],
    ['CANCELLED', 'Canceled'],
    ['UNFULFILLABLE', 'Unfulfillable'],
  ]

  it.each(CASES)('%s becomes the v0 word %s', (incoming, expected) => {
    expect(toV0Order({ orderId: 'x', fulfillment: { fulfillmentStatus: incoming } }).OrderStatus).toBe(expected)
  })

  it('covers every status the model declares', () => {
    // A set claim: derived from the map itself so a new Amazon status added to
    // the map without a case here fails loudly.
    expect(Object.keys(FULFILLMENT_STATUS_TO_V0).sort()).toEqual(CASES.map(([k]) => k).sort())
  })

  it('spells cancelled with ONE l, because that is what mapStatus matches', () => {
    // v0 says `Canceled`; 2026-01-01 says `CANCELLED`. The reconciliation walk
    // and mapStatus both key on the v0 spelling.
    expect(toV0Order({ orderId: 'x', fulfillment: { fulfillmentStatus: 'CANCELLED' } }).OrderStatus).toBe('Canceled')
  })

  it('reads the fixture’s own status', () => {
    expect(toV0Order(AMAZON_ORDER).OrderStatus).toBe('Shipped')
  })
})

describe('3. channel — AFN / MFN, which is P2.2’s fact under a new name', () => {
  it('maps AMAZON to AFN and MERCHANT to MFN', () => {
    expect(toV0Order({ orderId: 'x', fulfillment: { fulfilledBy: 'AMAZON' } }).FulfillmentChannel).toBe('AFN')
    expect(toV0Order({ orderId: 'x', fulfillment: { fulfilledBy: 'MERCHANT' } }).FulfillmentChannel).toBe('MFN')
    expect(Object.keys(FULFILLED_BY_TO_V0).sort()).toEqual(['AMAZON', 'MERCHANT'])
  })

  it('does not report MFN for an order Amazon fulfils', () => {
    // P2.2: `fulfillmentType` read 'MFN' on 1413/1413 real payloads while the
    // truth was AFN on 1071. The same mistake in this version is the literal
    // string 'AMAZON' reaching a reader that compares against 'MFN'.
    expect(toV0Order({ orderId: 'x', fulfillment: { fulfilledBy: 'AMAZON' } }).FulfillmentChannel).not.toBe('MFN')
  })

  it('reads the fixture’s own channel', () => {
    expect(toV0Order(AMAZON_ORDER).FulfillmentChannel).toBe('MFN')
  })
})

describe('4. absence — a section not asked for is not an empty one', () => {
  it('states no status, total or channel when fulfillment and proceeds are absent', () => {
    const raw = toV0Order({ orderId: '111-2222222-3333333', createdTime: '2026-09-20T00:00:00Z' })
    expect(raw.AmazonOrderId).toBe('111-2222222-3333333')
    expect(raw.OrderStatus).toBe('')
    expect(raw.OrderTotal).toBeUndefined()
    expect(raw.FulfillmentChannel).toBeUndefined()
    expect(raw.ShippingAddress).toBeUndefined()
    expect(raw.BuyerInfo).toBeUndefined()
  })

  it('leaves IsPrime unset when Amazon sent no programs list', () => {
    // `false` would read as "Amazon says this is not a Prime order". It did not
    // say that; it said nothing.
    expect(toV0Order({ orderId: 'x' }).IsPrime).toBeUndefined()
    expect(toV0Order({ orderId: 'x', programs: [] }).IsPrime).toBe(false)
  })

  it('treats a money object with no amount as no value', () => {
    // Array.isArray([]) is TRUE and {} is truthy: the guard must be on the
    // VALUE. An empty Money would otherwise become Amount: 'undefined'.
    expect(toV0Order({ orderId: 'x', proceeds: { grandTotal: {} } }).OrderTotal).toBeUndefined()
    expect(lineTotalOf({ quantityOrdered: 1, proceeds: { breakdowns: [] } })).toBeUndefined()
  })

  it('reads the fixture’s buyer, address and programs when they ARE present', () => {
    const raw = toV0Order(AMAZON_ORDER)
    expect(raw.BuyerInfo).toEqual({ BuyerName: 'John Smith', BuyerEmail: 'buyer-email@marketplace.amazon.com' })
    expect(raw.ShippingAddress!.City).toBe('Seattle')
    expect(raw.ShippingAddress!.CountryCode).toBe('US')
    expect(raw.MarketplaceId).toBe('ATVPDKIKX0DER')
    expect(raw.IsPrime).toBe(true)
    expect(raw.IsBusinessOrder).toBe(true)
  })
})

describe('the envelopes — three of them in one migration', () => {
  it('searchOrders puts the cursor under pagination.nextToken', () => {
    const page = toV0Page(SEARCH)
    expect(page.orders).toHaveLength(1)
    expect(page.nextToken).toBe('2YgYW55IGNhcm5hbCBwbGVhc3VyZS4')
  })

  it('getOrder wraps its order in `order`', () => {
    // Amazon's getOrder example is a different order from the searchOrders one,
    // so this cannot pass by reading the search fixture by accident.
    const got = orderOf(example.getOrder as { order?: Order2026 })
    expect(got!.orderId).toBe('202-1234567-8901234')
    expect(got!.orderId).not.toBe(AMAZON_ORDER.orderId)
    expect(toV0Order(got!).AmazonOrderId).toBe('202-1234567-8901234')
  })

  it('a wrong envelope reads as nothing, not as an order with no fields', () => {
    // v0's shape arriving on the 2026 path must not become an order whose every
    // field is undefined — that is the P3.1 double-encoding failure in a new place.
    expect(orderOf({ payload: { AmazonOrderId: '1' } } as never)).toBeNull()
    expect(orderOf(null)).toBeNull()
    expect(orderOf({} as never)).toBeNull()
  })
})

describe('the item hand-off — there is no getOrderItems any more', () => {
  it('a page keeps its items so the ingest’s second call costs nothing', () => {
    toV0Page(SEARCH)
    const items = takeOrderItems(AMAZON_ORDER.orderId!)
    expect(items).toHaveLength(2)
    expect(items![0].SellerSKU).toBe('ECHO-DOT-4-CHARCOAL')
    expect(items![0].ASIN).toBe('B08N5WRWNW')
    expect(items![0].QuantityOrdered).toBe(2)
    expect(items![0].QuantityShipped).toBe(2)
  })

  it('an order is taken once, so a later order cannot read a stale page', () => {
    toV0Page(SEARCH)
    expect(takeOrderItems(AMAZON_ORDER.orderId!)).not.toBeNull()
    expect(takeOrderItems(AMAZON_ORDER.orderId!)).toBeNull()
  })

  it('toV0Order on its own remembers NOTHING', () => {
    // The reconciliation walk maps orders to count and sum them. It must not
    // fill a cache the ingest then reads as if it were fresh.
    toV0Order(AMAZON_ORDER)
    expect(takeOrderItems(AMAZON_ORDER.orderId!)).toBeNull()
  })

  it('counts shipped and unshipped units from the items', () => {
    const raw = toV0Order(AMAZON_ORDER)
    // Two lines: 2 units of the speaker and 1 of the stick.
    expect(raw.NumberOfItemsShipped).toBe(3)
    expect(raw.NumberOfItemsUnshipped).toBe(0)
  })
})
