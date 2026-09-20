/**
 * P5.1 — the wiring. The mapper is proven elsewhere; this proves the SWITCH.
 *
 * Three things can be true separately, and only the third is what ships:
 *   - the conversion is right (amazon-orders-2026.p51),
 *   - the version reaches the library (amazon-orders-version.p51),
 *   - the service actually calls the new operation when the switch is on, and
 *     still calls the old one when it is off.
 *
 * Every assertion here is on the params the service HANDED the client — the
 * request, captured — not on what came back. A write's response is not what it
 * wrote, and a call's answer is not the call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const calls: Array<Record<string, any>> = []

vi.mock('../../lib/amazon-sp-client.js', () => ({
  amazonCredsConfigured: async () => true,
  getAmazonSellerId: async () => 'A1SELLER',
  amazonSpClient: () => ({
    callAPI: async (params: Record<string, any>) => {
      calls.push(params)
      if (params.operation === 'searchOrders') {
        return {
          orders: [
            {
              orderId: '111-2222222-3333333',
              createdTime: '2026-09-19T10:00:00Z',
              salesChannel: { marketplaceId: 'APJ6JRA9NG5V4' },
              proceeds: { grandTotal: { amount: '31.98', currencyCode: 'EUR' } },
              fulfillment: { fulfillmentStatus: 'SHIPPED', fulfilledBy: 'AMAZON' },
              orderItems: [
                {
                  orderItemId: 'L1',
                  quantityOrdered: 2,
                  product: {
                    asin: 'B0TEST0001',
                    sellerSku: 'SKU-1',
                    price: { unitPrice: { amount: '15.99', currencyCode: 'EUR' } },
                  },
                  proceeds: { breakdowns: [{ type: 'ITEM', subtotal: { amount: '31.98', currencyCode: 'EUR' } }] },
                  fulfillment: { quantityFulfilled: 2, quantityUnfulfilled: 0 },
                },
              ],
            },
          ],
        }
      }
      if (params.operation === 'getOrders') {
        return {
          payload: {
            Orders: [
              {
                AmazonOrderId: '111-2222222-3333333',
                PurchaseDate: '2026-09-19T10:00:00Z',
                OrderStatus: 'Shipped',
                FulfillmentChannel: 'AFN',
                OrderTotal: { Amount: '31.98', CurrencyCode: 'EUR' },
              },
            ],
          },
        }
      }
      if (params.operation === 'getOrderItems') {
        return { payload: { OrderItems: [{ ASIN: 'B0TEST0001', OrderItemId: 'L1', QuantityOrdered: 2 }] } }
      }
      return {}
    },
  }),
}))

vi.mock('amazon-sp-api', () => ({ SellingPartner: class {} }))

const { AmazonService } = await import('./amazon.service.js')
const { clearOrderItemsCache } = await import('./amazon-orders-2026.js')

const FLAG = 'NEXUS_ENABLE_AMAZON_ORDERS_2026'
const original = process.env[FLAG]

beforeEach(() => {
  calls.length = 0
  clearOrderItemsCache()
})
afterEach(() => {
  if (original === undefined) delete process.env[FLAG]
  else process.env[FLAG] = original
  clearOrderItemsCache()
})

describe('the switch is OFF by default', () => {
  it('still calls Orders v0 getOrders', async () => {
    delete process.env[FLAG]
    const orders = await new AmazonService().fetchOrders({ daysBack: 1, limit: 10 })
    expect(calls.map((c) => c.operation)).toEqual(['getOrders'])
    expect(calls[0].options?.version).toBeUndefined()
    expect(calls[0].query.MarketplaceIds).toEqual(['APJ6JRA9NG5V4'])
    expect(orders[0].AmazonOrderId).toBe('111-2222222-3333333')
  })

  it('a value other than the exact string "true" does not turn it on', async () => {
    // The dangerous near-miss: '1', 'TRUE', 'yes'. Named here so the rule is
    // the literal string and not "anything truthy". Each value makes a REAL
    // call — asserting on a counter nobody incremented proves nothing.
    for (const value of ['1', 'TRUE', 'yes', 'false', '']) {
      process.env[FLAG] = value
      calls.length = 0
      await new AmazonService().fetchOrders({ daysBack: 1, limit: 10 })
      expect(calls.map((c) => c.operation), `flag=${JSON.stringify(value)}`).toEqual(['getOrders'])
    }
    // Positive control in the same run: the exact string DOES switch it.
    process.env[FLAG] = 'true'
    calls.length = 0
    await new AmazonService().fetchOrders({ daysBack: 1, limit: 10 })
    expect(calls.map((c) => c.operation)).toEqual(['searchOrders'])
  })
})

describe('the switch ON moves the call to 2026-01-01', () => {
  beforeEach(() => {
    process.env[FLAG] = 'true'
  })

  it('fetchOrders calls searchOrders, with the version inside options', async () => {
    const orders = await new AmazonService().fetchOrders({ daysBack: 1, limit: 10 })
    expect(calls.map((c) => c.operation)).toEqual(['searchOrders'])
    expect(calls[0].options).toEqual({ version: '2026-01-01' })
    expect(calls[0].endpoint).toBe('orders')
    // The window survives the rename: lower-cased keys, same values.
    expect(calls[0].query.marketplaceIds).toEqual(['APJ6JRA9NG5V4'])
    expect(typeof calls[0].query.createdAfter).toBe('string')
    expect(calls[0].query.maxResultsPerPage).toBe(100)
    expect(calls[0].query.includedData).toEqual(['PROCEEDS', 'FULFILLMENT', 'RECIPIENT', 'BUYER'])
    // No v0 key survived the rename — a leftover `MarketplaceIds` would be
    // ignored by the new API and the window would silently widen.
    expect(Object.keys(calls[0].query).filter((k) => /^[A-Z]/.test(k))).toEqual([])

    // And the answer arrives in the shape the rest of the code already reads.
    expect(orders).toHaveLength(1)
    expect(orders[0].OrderStatus).toBe('Shipped')
    expect(orders[0].FulfillmentChannel).toBe('AFN')
    expect(orders[0].OrderTotal).toEqual({ Amount: '31.98', CurrencyCode: 'EUR' })
  })

  it('fetchOrderItems costs NO second call after a page that carried the items', async () => {
    await new AmazonService().fetchOrders({ daysBack: 1, limit: 10 })
    calls.length = 0
    const items = await new AmazonService().fetchOrderItems('111-2222222-3333333')
    expect(calls).toEqual([]) // there is no getOrderItems in 2026-01-01
    expect(items).toHaveLength(1)
    // 31.98 is the LINE total for 2 units at 15.99. upsertOrderItem divides it.
    expect(items[0].ItemPrice).toEqual({ Amount: '31.98', CurrencyCode: 'EUR' })
    expect(Number(items[0].ItemPrice!.Amount) / items[0].QuantityOrdered).toBeCloseTo(15.99, 2)
  })

  it('an order we have not seen falls back to getOrder, not getOrderItems', async () => {
    await new AmazonService().fetchOrderItems('999-0000000-0000000')
    expect(calls.map((c) => c.operation)).toEqual(['getOrder'])
    expect(calls[0].options).toEqual({ version: '2026-01-01' })
  })

  it('fetchOrderById names the version, because getOrder exists in BOTH', async () => {
    await new AmazonService().fetchOrderById('111-2222222-3333333')
    expect(calls.map((c) => c.operation)).toEqual(['getOrder'])
    // Without this the library picks the OLDEST version that has getOrder: v0.
    expect(calls[0].options).toEqual({ version: '2026-01-01' })
    expect(calls[0].path).toEqual({ orderId: '111-2222222-3333333' })
  })
})
