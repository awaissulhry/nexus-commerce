/**
 * P5.1 — page 2 of `searchOrders`, which no test drove and production never reached.
 *
 * ## 🔴 How this was found: a live probe, 2026-09-21
 *
 * `GET /api/admin/amazon-orders-2026-probe` asked Amazon for a second page exactly the way
 * `amazon.service.ts` did — `{ paginationToken, includedData }` and nothing else — and Amazon
 * answered:
 *
 * > "The input you have submitted is not valid. **One and only one of createdAfter or
 * > lastUpdatedAfter must be provided.**"
 *
 * The window is **not** remembered by the cursor. It has to be repeated on every page.
 *
 * So the old shape fetched page 1 and then **failed on page 2**, and the switch was off, so
 * nothing in production ever hit it. Nothing in the test suite hit it either, for a reason worth
 * naming: **every existing stub returns a single page with no `pagination.nextToken`, so the
 * pagination branch was unreachable in tests.** The arm that would have failed is the one never
 * run — banked, and earned again.
 *
 * This file is that arm.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const calls: Array<Record<string, any>> = []

/** Two pages: the first carries a cursor, the second does not. */
const order = (id: string) => ({
  orderId: id,
  createdTime: '2026-09-19T10:00:00Z',
  salesChannel: { marketplaceId: 'APJ6JRA9NG5V4' },
  proceeds: { grandTotal: { amount: '31.98', currencyCode: 'EUR' } },
  fulfillment: { fulfillmentStatus: 'SHIPPED', fulfilledBy: 'AMAZON' },
  orderItems: [],
})

vi.mock('../../lib/amazon-sp-client.js', () => ({
  amazonCredsConfigured: async () => true,
  getAmazonSellerId: async () => 'A1SELLER',
  amazonSpClient: () => ({
    callAPI: async (params: Record<string, any>) => {
      calls.push(JSON.parse(JSON.stringify(params)))
      if (params.operation !== 'searchOrders') return {}
      // Amazon's own rule, reproduced: a page request must carry exactly one of
      // createdAfter / lastUpdatedAfter, cursor or not.
      const q = params.query ?? {}
      const hasWindow = q.createdAfter !== undefined || q.lastUpdatedAfter !== undefined
      if (!hasWindow) {
        throw new Error('The input you have submitted is not valid. One and only one of createdAfter or lastUpdatedAfter must be provided.')
      }
      return q.paginationToken
        ? { orders: [order('111-2222222-4444444')] }
        : { orders: [order('111-2222222-3333333')], pagination: { nextToken: 'CURSOR-1' } }
    },
  }),
}))
vi.mock('amazon-sp-api', () => ({ SellingPartner: class {} }))

const { AmazonService } = await import('./amazon.service.js')
const { clearOrderItemsCache } = await import('./amazon-orders-2026.js')

const FLAG = 'NEXUS_ENABLE_AMAZON_ORDERS_2026'
const original = process.env[FLAG]

beforeEach(() => { calls.length = 0; clearOrderItemsCache(); process.env[FLAG] = 'true' })
afterEach(() => {
  if (original === undefined) delete process.env[FLAG]
  else process.env[FLAG] = original
  clearOrderItemsCache()
})

describe('P5.1 — searchOrders pagination', () => {
  it('🔴 page 2 carries the WHOLE window, not just the cursor', async () => {
    const orders = await new AmazonService().fetchOrders({ daysBack: 1, limit: 100 })

    const pages = calls.filter((c) => c.operation === 'searchOrders')
    expect(pages).toHaveLength(2)

    // Page 1: the window, no cursor.
    expect(pages[0].query.createdAfter).toBeDefined()
    expect(pages[0].query.paginationToken).toBeUndefined()

    // Page 2: the cursor AND the same window. This is the assertion the defect failed.
    expect(pages[1].query.paginationToken).toBe('CURSOR-1')
    expect(pages[1].query.createdAfter).toBe(pages[0].query.createdAfter)
    expect(pages[1].query.marketplaceIds).toEqual(pages[0].query.marketplaceIds)
    expect(pages[1].query.includedData).toEqual(pages[0].query.includedData)

    // And both pages' orders actually arrived.
    expect(orders.map((o) => o.AmazonOrderId)).toEqual(['111-2222222-3333333', '111-2222222-4444444'])
  })

  it('🟢 POSITIVE CONTROL: the stub really does enforce Amazon\'s rule', async () => {
    // Without this, the test above could pass against a stub that accepts anything.
    const { amazonSpClient } = await import('../../lib/amazon-sp-client.js')
    await expect(
      (amazonSpClient() as any).callAPI({ operation: 'searchOrders', query: { paginationToken: 'X', includedData: [] } }),
    ).rejects.toThrow('One and only one of createdAfter or lastUpdatedAfter must be provided.')
  })

  it('the version travels on every page, not only the first', async () => {
    await new AmazonService().fetchOrders({ daysBack: 1, limit: 100 })
    const pages = calls.filter((c) => c.operation === 'searchOrders')
    for (const page of pages) expect(page.options?.version).toBe('2026-01-01')
  })
})
