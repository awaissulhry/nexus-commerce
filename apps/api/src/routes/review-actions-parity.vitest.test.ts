/**
 * MCP full control 07 O13 — the review request (POST /orders/:id/request-review) and the review reply
 * (POST /reviews/:id/reply/send) move into services/reviews/review-request.service.ts and
 * services/reviews/review-reply-send.service.ts with NO change to what the routes do and answer. The snapshots in
 * __snapshots__/review-actions-parity.vitest.test.ts.snap were written by the route code BEFORE the move: every
 * refusal (not delivered, the 4–30 day window, an active return, a refund, already sent, an unknown market), Amazon
 * live / dry run / failure / retry, a channel without a request API; the reply on eBay (sent, failed), on Amazon
 * (recorded MANUAL), into a draft — with the rows they leave and the events they raise.
 *
 * Real SQL (PGlite with the production schema) and the real route plugins; Amazon's Solicitations call and eBay's
 * RespondToFeedback are mocked (nothing leaves the machine). Ids and times are masked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    redis: { connection: null },
  }
})
const channel = vi.hoisted(() => ({ solicitations: [] as unknown[], solicitation: {} as Record<string, unknown>, replies: [] as unknown[], reply: {} as Record<string, unknown>, events: [] as unknown[] }))
vi.mock('../services/reviews/amazon-solicitations.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendAmazonSolicitation: vi.fn(async (args: { amazonOrderId: string }) => {
    channel.solicitations.push(args)
    return channel.solicitation[args.amazonOrderId] ?? { ok: true, errorCode: 'OK' }
  }),
}))
vi.mock('../services/reviews/adapters/ebay-feedback.adapter.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  respondToEbayFeedback: vi.fn(async (feedbackId: string, text: string) => {
    channel.replies.push({ feedbackId, text })
    return channel.reply[feedbackId] ?? { ok: true, code: 'Success' }
  }),
}))
vi.mock('../services/review-events.service.js', () => ({
  publishReviewEvent: vi.fn((event: Record<string, unknown>) => { channel.events.push({ ...event, ts: '<made>' }) }),
  subscribeReviewEvents: vi.fn(() => () => {}),
  getReviewListenerCount: vi.fn(() => 0),
  replayReviewEventsSince: vi.fn(() => []),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const MADE = new Set(['id', 'createdAt', 'updatedAt', 'workspaceId', 'sentAt', 'triageUpdatedAt', 'ingestedAt', 'postedAt', 'deliveredAt', 'lastAttemptAt'])
const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => (MADE.has(key) && v !== null ? '<made>' : v)))
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

describe('07 O13 — review request and reply: the routes answer exactly as before the move', () => {
  let app: FastifyInstance
  const post = async (url: string, payload: unknown = {}) => {
    const response = await app.inject({ method: 'POST', url: `/api${url}`, payload: payload as object })
    return { status: response.statusCode, body: stable(JSON.parse(response.body || '{}')) }
  }
  const requestsOf = async (orderId: string) => stable(await inside(() => database.client.reviewRequest.findMany({
    where: { orderId }, select: { channel: true, marketplace: true, status: true, sentAt: true, providerRequestId: true, providerResponseCode: true, errorMessage: true, suppressedReason: true, ruleId: true },
  })))
  const responsesOf = async (reviewId: string) => stable(await inside(() => database.client.reviewResponse.findMany({
    where: { reviewId }, orderBy: { createdAt: 'asc' }, select: { channel: true, body: true, status: true, providerResponseCode: true, errorMessage: true, sentAt: true, createdBy: true, isAiDrafted: true },
  })))
  const triageOf = async (id: string) => stable(await inside(() => database.client.review.findUnique({ where: { id }, select: { triageStatus: true, triageUpdatedAt: true } })))

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const order = (key: string, data: Record<string, unknown>) => database.client.order.create({
        data: {
          id: `test-order-${key}`, channel: 'AMAZON', channelOrderId: `TEST-AMZ-${key}`, marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '20.00',
          customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, fulfillmentMethod: 'MFN', deliveredAt: daysAgo(10), ...data,
        } as never,
      })
      await order('undelivered', { deliveredAt: null })
      await order('soon', { deliveredAt: daysAgo(2) })
      await order('late', { deliveredAt: daysAgo(40) })
      await order('returning', {})
      await database.client.return.create({ data: { orderId: 'test-order-returning', channel: 'AMAZON', rmaNumber: 'TEST-RMA-R1', status: 'RECEIVED' } as never })
      await order('refunded', {})
      await database.client.financialTransaction.create({ data: { orderId: 'test-order-refunded', transactionType: 'Refund', transactionDate: daysAgo(3), amount: '-20.00', currencyCode: 'EUR', grossRevenue: '-20.00', netRevenue: '-20.00', status: 'Completed' } as never })
      await order('sent', {})
      await database.client.reviewRequest.create({ data: { orderId: 'test-order-sent', channel: 'AMAZON', marketplace: 'IT', status: 'SENT', sentAt: daysAgo(1) } as never })
      await order('nomarket', { marketplace: 'ZZ' })
      await order('live', {})
      await order('dry', {})
      await order('fail', {})
      await order('retry', {})
      await database.client.reviewRequest.create({ data: { orderId: 'test-order-retry', channel: 'AMAZON', marketplace: 'IT', status: 'FAILED', errorMessage: 'old failure' } as never })
      await order('shopify', { channel: 'SHOPIFY', channelOrderId: 'TEST-SHOP-1', marketplace: 'IT' })
      const review = (key: string, channelName: string) => database.client.review.create({
        data: { id: `test-review-${key}`, channel: channelName, marketplace: 'IT', externalReviewId: `TEST-FB-${key}`, rating: 2, body: 'Too small', postedAt: daysAgo(3) } as never,
      })
      await review('ebay', 'EBAY')
      await review('ebay-fail', 'EBAY')
      await review('amazon', 'AMAZON')
      await review('draft', 'EBAY')
      await database.client.reviewResponse.create({ data: { id: 'test-response-draft', reviewId: 'test-review-draft', channel: 'EBAY', body: 'Draft text', status: 'DRAFT', isAiDrafted: true } as never })
    })
    channel.solicitation['TEST-AMZ-dry'] = { ok: false, errorCode: 'NOT_IMPLEMENTED', errorMessage: 'SP-API Solicitations gated by env (NEXUS_ENABLE_AMAZON_SOLICITATIONS=true)' }
    channel.solicitation['TEST-AMZ-fail'] = { ok: false, errorCode: 'HTTP_500', errorMessage: 'HTTP 500 test failure' }
    channel.reply['TEST-FB-ebay-fail'] = { ok: false, code: 'FAILURE', error: 'Test eBay refused' }
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: ordersReviewsRoutes } = await import('./orders-reviews.routes.js')
    const { default: reviewsRoutes } = await import('./reviews.routes.js')
    await app.register(ordersReviewsRoutes, { prefix: '/api' })
    await app.register(reviewsRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it('request-review: every refusal', async () => {
    expect([
      await post('/orders/test-order-none/request-review'),
      await post('/orders/test-order-undelivered/request-review'),
      await post('/orders/test-order-soon/request-review'),
      await post('/orders/test-order-late/request-review'),
      await post('/orders/test-order-returning/request-review'),
      await post('/orders/test-order-refunded/request-review'),
      await post('/orders/test-order-sent/request-review'),
      await post('/orders/test-order-nomarket/request-review'),
      channel.solicitations,
    ]).toMatchSnapshot()
  })

  it('request-review: Amazon live, dry run, failure, a retry of a failed one; a channel without a request API', async () => {
    expect([
      await post('/orders/test-order-live/request-review'),
      await requestsOf('test-order-live'),
      await post('/orders/test-order-dry/request-review'),
      await requestsOf('test-order-dry'),
      await post('/orders/test-order-fail/request-review'),
      await requestsOf('test-order-fail'),
      await post('/orders/test-order-retry/request-review'),
      await requestsOf('test-order-retry'),
      await post('/orders/test-order-shopify/request-review'),
      await requestsOf('test-order-shopify'),
      channel.solicitations,
    ]).toMatchSnapshot()
  })

  it('reply: refusals; eBay sent and failed; Amazon recorded; a draft sent', async () => {
    expect([
      await post('/reviews/test-review-none/reply/send', { body: 'Thanks' }),
      await post('/reviews/test-review-ebay/reply/send', { body: '   ' }),
      await post('/reviews/test-review-ebay/reply/send', { body: ' Thank you for your feedback ', actor: 'user:test' }),
      await responsesOf('test-review-ebay'),
      await triageOf('test-review-ebay'),
      await post('/reviews/test-review-ebay-fail/reply/send', { body: 'Sorry about that' }),
      await responsesOf('test-review-ebay-fail'),
      await triageOf('test-review-ebay-fail'),
      await post('/reviews/test-review-amazon/reply/send', { body: 'Posted on Amazon' }),
      await responsesOf('test-review-amazon'),
      await post('/reviews/test-review-draft/reply/send', { body: 'Draft text, edited', responseId: 'test-response-draft' }),
      await responsesOf('test-review-draft'),
      channel.replies,
      channel.events,
    ]).toMatchSnapshot()
  })
})
