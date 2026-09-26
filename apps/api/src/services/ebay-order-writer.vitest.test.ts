/**
 * normalizeEbayOrder — the pure contract the transactional writer relies on. Strict where a wrong
 * value would corrupt identity or stock (order id, line ids, quantities); the buyer's eBay
 * username is kept exactly, because customerName may later be replaced. Only an unusable order id
 * refuses the order; every other unreadable part is a problem the writer records (R5, 2026-09-26).
 */
import { describe, expect, it } from 'vitest'
import * as writer from './ebay-order-writer.js'
import { EbayOrderInvalid, normalizeEbayOrder } from './ebay-order-writer.js'

const line = (overrides: Record<string, unknown> = {}) => ({ lineItemId: '10001', sku: 'SKU-1', title: 'Jacket', quantity: 1, lineItemCost: { value: '10.00', currency: 'EUR' }, ...overrides })
const order = (overrides: Record<string, unknown> = {}) => ({
  orderId: '12-34567-89012', creationDate: '2026-09-23T10:00:00.000Z', orderPaymentStatus: 'PAID', orderFulfillmentStatus: 'NOT_STARTED',
  buyer: { username: 'Buyer.Name_01' }, pricingSummary: { total: { value: '20.00', currency: 'EUR' } }, lineItems: [line()], ...overrides,
})
const reason = (raw: unknown) => { try { normalizeEbayOrder(raw); return null } catch (error) { return error instanceof EbayOrderInvalid ? error.reason : String(error) } }
const problems = (raw: unknown) => normalizeEbayOrder(raw).problems
const lineIds = (raw: unknown) => normalizeEbayOrder(raw).lines.map(l => l.lineItemId)

describe('normalizeEbayOrder', () => {
  it('accepts the live Fulfillment API shape and maps its statuses', () => {
    const normalized = normalizeEbayOrder(order())
    expect(normalized).toMatchObject({ orderId: '12-34567-89012', totalPrice: 20, currencyCode: 'EUR', status: 'PROCESSING', customerName: 'Buyer.Name_01' })
    expect(normalized.lines).toEqual([expect.objectContaining({ lineItemId: '10001', sku: 'SKU-1', quantity: 1, price: 10 })])
    expect(normalizeEbayOrder(order({ cancelStatus: { cancelState: 'CANCELED' } })).status).toBe('CANCELLED')
    expect(normalizeEbayOrder(order({ cancelStatus: { cancelState: 'NONE_REQUESTED' } })).status).toBe('PROCESSING')
    expect(normalizeEbayOrder(order({ orderFulfillmentStatus: 'FULFILLED' })).status).toBe('DELIVERED')
  })

  it.each([undefined, '', ' 12-3', '12-3 ', '12\u00003', 12345, 'x'.repeat(1025)])('refuses order id %j', orderId => {
    expect(reason(order({ orderId }))).toBe('order_id')
  })

  // Behaviour change (review C2): these refused the whole order; the order is now recorded and the
  // unreadable line is left out as a problem, the other lines kept.
  it('leaves out a line with a missing, empty or padded id, and a repeat of an id, as problems; keeps the rest', () => {
    for (const lineItemId of [undefined, '', ' 10001']) {
      const raw = order({ lineItems: [line({ lineItemId, sku: 'SKU-BAD' }), line({ lineItemId: '10002' })] })
      expect(reason(raw)).toBeNull()
      expect(lineIds(raw)).toEqual(['10002'])
      expect(problems(raw)).toEqual([{ field: 'line_item_id', index: 0, lineItemId: null, sku: 'SKU-BAD' }])
    }
    const repeated = order({ lineItems: [line(), line({ sku: 'SKU-2', quantity: 3 })] })
    expect(lineIds(repeated)).toEqual(['10001'])
    expect(normalizeEbayOrder(repeated).lines[0]).toMatchObject({ sku: 'SKU-1', quantity: 1 })
    expect(problems(repeated)).toEqual([{ field: 'duplicate_line_item', index: 1, lineItemId: '10001', sku: 'SKU-2' }])
    expect(lineIds(order({ lineItems: 'nope' }))).toEqual([])
    expect(problems(order({ lineItems: 'nope' }))).toEqual([{ field: 'line_items' }])
  })

  it.each([0, -1, 1.5, '2', Number.NaN, 2 ** 53, null])('leaves out a line with quantity %j as a problem', quantity => {
    const raw = order({ lineItems: [line({ quantity })] })
    expect(reason(raw)).toBeNull()
    expect(lineIds(raw)).toEqual([])
    expect(problems(raw)).toEqual([{ field: 'quantity', index: 0, lineItemId: '10001', sku: 'SKU-1' }])
  })

  it('returns an unreadable creation date or total as null with a problem, never a guessed value', () => {
    expect(normalizeEbayOrder(order({ creationDate: 'yesterday' }))).toMatchObject({ purchaseDate: null, problems: [{ field: 'creation_date' }] })
    expect(normalizeEbayOrder(order({ pricingSummary: { total: { value: 'abc' } } }))).toMatchObject({ totalPrice: null, problems: [{ field: 'total' }] })
    expect(problems(order())).toEqual([])
  })

  it('keeps the buyer username exactly, even where the customer name falls back', () => {
    expect(normalizeEbayOrder(order({ buyer: { username: ' Mixed.Case user ' } })).metadata.buyer).toEqual({ username: ' Mixed.Case user ' })
    const guest = normalizeEbayOrder(order({ buyer: {}, fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: 'Ship To', email: 'ship@example.test' } } }] }))
    expect(guest.metadata.buyer).toEqual({ username: null })
    expect(guest).toMatchObject({ customerName: 'Ship To', customerEmail: 'ship@example.test' })
  })

  it('keeps a line whose cost is not a number, for the writer to record as a problem', () => {
    expect(normalizeEbayOrder(order({ lineItems: [line({ lineItemCost: { value: 'x' } })] })).lines[0].price).toBeNull()
  })
})

describe('poolTakeOrder', () => {
  it('takes pool stock in lender source-product order, so two borrowers never lock the same sources in opposite orders', () => {
    const order = (writer as unknown as { poolTakeOrder?: (ids: string[], sources: Map<string, string>) => string[] }).poolTakeOrder
    expect(typeof order).toBe('function')
    // Borrower products p1 < p2 map to lender sources s-b > s-a; p3 is not pooled and sorts by its own id.
    expect(order!(['p1', 'p2', 'p3'], new Map([['p1', 's-b'], ['p2', 's-a']]))).toEqual(['p3', 'p2', 'p1'])
    // A second borrower whose products sort the other way reaches the SAME source order.
    expect(order!(['q2', 'q1'], new Map([['q1', 's-b'], ['q2', 's-a']]))).toEqual(['q2', 'q1'])
  })
})
