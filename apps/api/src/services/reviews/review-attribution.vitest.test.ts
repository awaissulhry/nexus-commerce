/**
 * Review ↔ request matching against real SQL (PGlite, production schema) — audit B2: eBay feedback names no product, so
 * the product match never tied it to our e-mail and eBay's review rate read 0 %. A review that names its order is now
 * linked to that order's request; the ONE rate then counts it (review-rate.service.ts). Fixture rows never count.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const { runReviewAttributionOnce } = await import('./review-attribution.service.js')
const { readRateFacts, readRateRequests, rateOf } = await import('./review-rate.service.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date()
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

describe('review ↔ request matching (real SQL)', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const c = database.client
      const order = (id: string) => c.order.create({
        data: {
          id, channel: 'EBAY', channelOrderId: `TEST-${id}`, marketplace: 'DE', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '20.00',
          customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, fulfillmentMethod: 'MFN', deliveredAt: daysAgo(12),
        } as never,
      })
      for (const id of ['test-o1', 'test-o2', 'test-o3']) {
        await order(id)
        await c.reviewRequest.create({ data: { orderId: id, channel: 'EBAY', marketplace: 'DE', status: 'SENT', sentAt: daysAgo(6) } as never })
      }
      // Feedback for o1 (after the e-mail), a fixture for o2 (never counts), feedback for o3 BEFORE the e-mail (organic).
      await c.review.create({ data: { channel: 'EBAY', marketplace: 'IT', externalReviewId: 'TEST-FB-1', rating: 5, body: 'Great', postedAt: daysAgo(2), orderId: 'test-o1', ingestSource: 'EBAY_API' } as never })
      await c.review.create({ data: { channel: 'EBAY', marketplace: 'IT', externalReviewId: 'TEST-FB-2', rating: 5, body: 'Great', postedAt: daysAgo(2), orderId: 'test-o2', ingestSource: 'FIXTURE' } as never })
      await c.review.create({ data: { channel: 'EBAY', marketplace: 'IT', externalReviewId: 'TEST-FB-3', rating: 5, body: 'Great', postedAt: daysAgo(8), orderId: 'test-o3', ingestSource: 'EBAY_API' } as never })
    })
  }, 180_000)

  afterAll(async () => {
    await database?.close()
  })

  it('eBay feedback is linked by its order (even stamped another market); a fixture or an earlier review never', async () => {
    const run = await inside(() => runReviewAttributionOnce())
    expect(run.attributed).toBe(1)
    const linked = await inside(() => database.client.review.findMany({ where: { attributedRequestId: { not: null } }, select: { externalReviewId: true } }))
    expect(linked).toEqual([{ externalReviewId: 'TEST-FB-1' }])
  })

  it('the one rate then counts it: 1 of 3 eBay requests followed — not 0 %', async () => {
    const [rows, facts] = await inside(() => Promise.all([readRateRequests({ from: daysAgo(30), to: NOW, channel: 'EBAY' }), readRateFacts()]))
    expect(facts.ebayLinked).toBe(true)
    expect(rateOf(rows, facts)).toMatchObject({ sent: 3, measured: 3, followed: 1, words: null })
  })
})
