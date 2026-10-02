/**
 * MCP full control 07 — the review desk's reply send (POST /reviews/:id/reply/send) with a `responseId` (sending a saved
 * draft) only ever touches a draft of THAT review (lead ruling 2026-10-02).
 *
 * RED before the fix: the route updated whatever ReviewResponse the id named, so a draft of another review was
 * overwritten with this reply (and marked sent) while eBay was told to post it under this review's feedback. Now a
 * responseId that is not one of this review's responses is refused (404 response_not_found) before eBay is called,
 * and nothing changes; this review's own draft is sent as before.
 *
 * Real SQL (PGlite with the production schema) and the real route plugin; eBay's RespondToFeedback is mocked.
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
const ebay = vi.hoisted(() => ({ replies: [] as string[] }))
vi.mock('../services/reviews/adapters/ebay-feedback.adapter.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  respondToEbayFeedback: vi.fn(async (feedbackId: string) => { ebay.replies.push(feedbackId); return { ok: true, code: 'Success' } }),
}))
vi.mock('../services/review-events.service.js', () => ({
  publishReviewEvent: vi.fn(),
  subscribeReviewEvents: vi.fn(() => () => {}),
  getReviewListenerCount: vi.fn(() => 0),
  replayReviewEventsSince: vi.fn(() => []),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

describe('reply send: a responseId must be one of this review\'s drafts', () => {
  let app: FastifyInstance
  const send = (reviewId: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/reviews/${reviewId}/reply/send`, payload })
  const response = (id: string) => inside(() => database.client.reviewResponse.findUnique({ where: { id }, select: { reviewId: true, body: true, status: true } }))

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      for (const key of ['one', 'two']) {
        await database.client.review.create({ data: { id: `test-review-${key}`, channel: 'EBAY', marketplace: 'IT', externalReviewId: `TEST-FB-${key}`, rating: 3, body: 'Fine', postedAt: new Date() } as never })
        await database.client.reviewResponse.create({ data: { id: `test-draft-${key}`, reviewId: `test-review-${key}`, channel: 'EBAY', body: `Draft ${key}`, status: 'DRAFT' } as never })
      }
    })
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
    const { default: reviewsRoutes } = await import('./reviews.routes.js')
    await app.register(reviewsRoutes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    await database?.close()
  })

  it('another review\'s draft (or an unknown id) is refused before eBay is called; nothing changes', async () => {
    for (const responseId of ['test-draft-two', 'test-draft-none']) {
      const refused = await send('test-review-one', { body: 'Thanks!', responseId })
      expect(refused.statusCode, refused.body).toBe(404)
      expect(refused.json()).toEqual({ error: 'response_not_found' })
    }
    expect(ebay.replies).toEqual([])
    expect(await response('test-draft-two')).toEqual({ reviewId: 'test-review-two', body: 'Draft two', status: 'DRAFT' })
  })

  it('this review\'s own draft is sent as before', async () => {
    const sent = await send('test-review-one', { body: 'Thanks!', responseId: 'test-draft-one' })
    expect(sent.statusCode, sent.body).toBe(200)
    expect(await response('test-draft-one')).toEqual({ reviewId: 'test-review-one', body: 'Thanks!', status: 'SENT' })
    expect(ebay.replies).toEqual(['TEST-FB-one'])
  })
})
