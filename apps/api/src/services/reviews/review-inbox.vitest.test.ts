/**
 * Reviews Inbox — the services against real SQL (PGlite with the production schema and policies): the list and its
 * counts never show fixture rows, the filters reach the right rows, the pop-up's order/return/history, the bulk bar,
 * the person's mood, "Undo this import", and reply/send refusing what the reply rules refuse (eBay is mocked; the AI
 * service is off, so drafts use the built-in fallback and nothing leaves this machine).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    redis: { connection: null },
  }
})
const ebay = vi.hoisted(() => ({ replies: [] as string[] }))
vi.mock('./adapters/ebay-feedback.adapter.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  respondToEbayFeedback: vi.fn(async (feedbackId: string) => { ebay.replies.push(feedbackId); return { ok: true, code: 'Success' } }),
}))
vi.mock('../review-events.service.js', () => ({
  publishReviewEvent: vi.fn(),
  subscribeReviewEvents: vi.fn(() => () => {}),
  getReviewListenerCount: vi.fn(() => 0),
  replayReviewEventsSince: vi.fn(() => []),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date()
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

describe('Reviews Inbox services (real SQL)', () => {
  let familyId = ''

  beforeAll(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    database = await formulaDatabase()
    await inside(async () => {
      const c = database.client
      const family = await c.productFamily.create({ data: { code: 'test_trousers', label: 'Test trousers' } as never })
      familyId = family.id
      await c.product.create({ data: { id: 'test-parent', sku: 'TEST-PARENT', name: 'Test over-trousers', basePrice: 10, isParent: true, familyId } as never })
      await c.product.create({ data: { id: 'test-child', sku: 'TEST-CHILD-XL', name: 'Test over-trousers XL', basePrice: 10, parentId: 'test-parent', variantAttributes: { Size: 'XL' } } as never })
      await c.order.create({
        data: {
          id: 'test-order-1', channel: 'EBAY', channelOrderId: '12-00000-00001', marketplace: 'DE', status: 'DELIVERED', currencyCode: 'EUR',
          totalPrice: '89.90', customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' },
          fulfillmentMethod: 'MFN', purchaseDate: daysAgo(8), deliveredAt: daysAgo(5),
        } as never,
      })
      await c.return.create({ data: { orderId: 'test-order-1', channel: 'EBAY', rmaNumber: 'TEST-RMA-1', status: 'REQUESTED', reason: 'too small' } as never })
      const review = (id: string, data: Record<string, unknown>) => c.review.create({
        data: { id, marketplace: 'IT', externalReviewId: `TEST-${id}`, body: 'Fine', rating: 4, ...data } as never,
      })
      await review('ebay-1', {
        channel: 'EBAY', marketplace: 'DE', rating: 3, body: 'Fällt sehr klein aus', postedAt: daysAgo(3), orderId: 'test-order-1',
        productId: 'test-child', ingestSource: 'EBAY_API', authorName: 'buyer-one', language: 'de', bodyEnglish: 'Runs very small',
      })
      await review('ebay-2', { channel: 'EBAY', marketplace: 'DE', rating: 5, postedAt: daysAgo(40), authorName: 'buyer-one', ingestSource: 'EBAY_API', triageStatus: 'RESOLVED' })
      await review('amz-1', { channel: 'AMAZON', rating: 1, postedAt: new Date(NOW.getTime() - 60 * 60 * 1000), ingestSource: 'IMPORT_CSV', importBatchId: 'import_b1' })
      await review('amz-2', { channel: 'AMAZON', rating: 5, postedAt: daysAgo(10), ingestSource: 'IMPORT_CSV', importBatchId: 'import_b1', triageStatus: 'IN_PROGRESS' })
      await review('fixture-1', { channel: 'AMAZON', rating: 2, postedAt: daysAgo(5), ingestSource: 'FIXTURE' })
      await review('etsy-old', { channel: 'ETSY', marketplace: null, rating: null, postedAt: daysAgo(120) })
      await review('amz-3', { channel: 'AMAZON', postedAt: daysAgo(1), ingestSource: 'IMPORT_CSV', importBatchId: 'import_b2' })
      await review('amz-4', { channel: 'AMAZON', postedAt: daysAgo(1), ingestSource: 'IMPORT_CSV', importBatchId: 'import_b2', assignee: 'owner-a', triageUpdatedAt: NOW })
      await c.reviewSentiment.create({ data: { reviewId: 'ebay-1', label: 'NEUTRAL', score: 0, categories: ['FIT_SIZING', 'QUALITY'], model: 'test' } as never })
    })
  }, 180_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await database?.close()
  })

  it('the list: fixture rows never show or count; tabs and tiles count with the other filters kept', async () => {
    const { listInbox } = await import('./review-inbox.service.js')
    const page = await inside(() => listInbox({}))
    const ids = page.rows.map((r) => r.id)
    expect(ids).not.toContain('fixture-1')
    expect(page.total).toBe(7)
    expect(page.tabCounts).toEqual({ all: 7, product: 5, seller: 2 })
    // Overdue = needs a reply (answerable, not imported) and older than 48 h: ebay-1 (3 days) only — amz-2 is an
    // imported Amazon product review (nobody can reply), etsy-old is past Etsy's 100-day window (audit B3).
    expect(page.statusCounts).toEqual({ NEW: 5, IN_PROGRESS: 1, RESPONDED: 0, RESOLVED: 1, IGNORED: 0, OVERDUE: 1 })
    // The badges' number, every channel and date: the one needs-a-reply rule.
    expect(page.needsReply).toBe(1)
    expect(ids[0]).toBe('amz-1') // newest first
    const row = page.rows.find((r) => r.id === 'ebay-1')!
    expect(row).toMatchObject({
      channel: 'EBAY', market: 'DE', kind: 'seller', rating: 3, english: 'Runs very small', language: 'de', buyer: 'buyer-one',
      product: { id: 'test-child', sku: 'TEST-CHILD-XL', variant: 'XL' }, order: { id: 'test-order-1', label: '12-00000-00001' },
      mood: 'NEUTRAL', themes: ['FIT_SIZING', 'QUALITY'], status: 'NEW', overdue: true, imported: false, responses: { sent: 0, draft: 0 },
    })
    expect(page.rows.find((r) => r.id === 'amz-1')).toMatchObject({ imported: true, overdue: false, kind: 'product', dueAt: null })
    expect(page.rows.find((r) => r.id === 'ebay-2')).toMatchObject({ status: 'RESOLVED', dueAt: null, overdue: false })
    expect(page.facets.families).toEqual([{ id: familyId, label: 'Test trousers' }])
    expect(page.facets.owners).toEqual(['owner-a'])
    // The read state is the review sources' answer (one source with the Overview), in words: eBay Germany has
    // feedback but no eBay account, so it is not read and Settings › Channels fixes it; Amazon Italy reads fine.
    expect(page.readState.find((r) => r.channel === 'EBAY' && r.market === 'DE')).toMatchObject({
      ok: false, reason: 'No eBay account is connected', reconnectHref: '/settings/channels/ebay',
    })
    expect(page.readState.find((r) => r.channel === 'AMAZON' && r.market === 'IT')).toMatchObject({ ok: true, reason: null })
    for (const r of page.readState) expect(r.reason ?? '').not.toMatch(/NEXUS_|[A-Z]{3,}_[A-Z]{3,}/)
  })

  it('the read state maps each review source: ok, reason, since and where to fix it', async () => {
    const { readStateFromSources } = await import('./review-inbox.service.js')
    expect(readStateFromSources([
      { channel: 'EBAY', market: 'DE', state: 'not_updating', reason: 'Sign-in expired', since: '2026-10-23T09:00:00.000Z', reconnectHref: '/settings/channels/ebay', what: 'Seller feedback', lastNote: null, lastReviewAt: null, reviews: 3 },
      { channel: 'AMAZON', market: 'IT', state: 'ok', reason: null, since: null, reconnectHref: null, what: 'Topics', lastNote: null, lastReviewAt: null, reviews: 0 },
    ])).toEqual([
      { channel: 'EBAY', market: 'DE', ok: false, since: '2026-10-23T09:00:00.000Z', reason: 'Sign-in expired', reconnectHref: '/settings/channels/ebay' },
      { channel: 'AMAZON', market: 'IT', ok: true, since: null, reason: null, reconnectHref: null },
    ])
  })

  it('filters reach the right rows', async () => {
    const { listInbox } = await import('./review-inbox.service.js')
    const ids = async (query: Record<string, unknown>) => (await inside(() => listInbox(query))).rows.map((r) => r.id).sort()
    expect(await ids({ kind: 'seller' })).toEqual(['ebay-1', 'ebay-2'])
    expect(await ids({ status: 'OVERDUE' })).toEqual(['ebay-1'])
    // "Needs a reply" (the badges' link): the same rule, every date (audit A4, C1).
    expect(await ids({ reply: 'needed' })).toEqual(['ebay-1'])
    expect(await ids({ product: 'test-parent' })).toEqual(['ebay-1'])
    expect(await ids({ mood: 'NEUTRAL', theme: 'FIT_SIZING' })).toEqual(['ebay-1'])
    expect(await ids({ family: familyId })).toEqual(['ebay-1'])
    expect(await ids({ owner: 'owner-a' })).toEqual(['amz-4'])
    expect(await ids({ q: 'very small' })).toEqual(['ebay-1'])
    expect(await ids({ stars: '1,2' })).toEqual(['amz-1'])
    expect(await ids({ period: '7d', channel: 'AMAZON' })).toEqual(['amz-1', 'amz-3', 'amz-4'])
    const byStars = (await inside(() => listInbox({ sort: 'rating:asc' }))).rows.map((r) => r.rating)
    expect(byStars[byStars.length - 1]).toBeNull()
    const paged = await inside(() => listInbox({ pageSize: '2', page: '2' }))
    expect(paged).toMatchObject({ total: 7, page: 2, pageSize: 2 })
    expect(paged.rows).toHaveLength(2)
  })

  it('the pop-up: order, return, the same buyer\'s other feedback, the timeline and the reply rules; never a fixture row', async () => {
    const { getInboxReview } = await import('./review-detail.service.js')
    const d = await inside(() => getInboxReview('ebay-1'))
    expect(d).toMatchObject({
      english: 'Runs very small', language: 'de', languageWords: 'German',
      product: { id: 'test-parent', name: 'Test over-trousers' }, variant: { id: 'test-child', words: 'XL' },
      order: { id: 'test-order-1', label: '12-00000-00001', market: 'DE', total: '89.9' },
      return: { status: 'REQUESTED', reasonWords: 'too small' },
      reply: { mode: 'send', limit: 500, held: null },
      sentiment: { label: 'NEUTRAL', edited: false },
    })
    expect(JSON.stringify(d)).not.toContain('buyer@example.test')
    expect(d!.buyerHistory.map((h) => h.id)).toEqual(['ebay-2'])
    expect(d!.timeline.map((t) => t.words)).toEqual(expect.arrayContaining(['Order placed on eBay Germany', 'Return requested — too small', 'Received from eBay Germany']))
    expect(await inside(() => getInboxReview('fixture-1'))).toBeNull()
  })

  it('bulk: changes what it can, skips the rest with words; a fixture row is not found', async () => {
    const { runInboxBulk } = await import('./review-inbox.service.js')
    const assign = await inside(() => runInboxBulk({ ids: ['amz-1', 'amz-4', 'fixture-1'], action: 'assign', value: 'owner-a' }, 'user-1'))
    expect(assign).toEqual({ changed: 1, skipped: [{ id: 'amz-4', reason: 'Already assigned to owner-a.' }, { id: 'fixture-1', reason: 'Not found in this business’s Inbox.' }] })
    const tag = await inside(() => runInboxBulk({ ids: ['amz-1', 'etsy-old'], action: 'tag', value: 'size chart' }, 'user-1'))
    expect(tag.changed).toBe(2)
    const status = await inside(() => runInboxBulk({ ids: ['amz-1', 'ebay-2'], action: 'status', value: 'RESOLVED' }, 'user-1'))
    expect(status).toEqual({ changed: 1, skipped: [{ id: 'ebay-2', reason: 'Already Resolved.' }] })
    const rows = await inside(() => database.client.review.findMany({ where: { id: { in: ['amz-1', 'etsy-old'] } }, orderBy: { id: 'asc' }, select: { id: true, assignee: true, triageTags: true, triageStatus: true } }))
    expect(rows).toEqual([
      { id: 'amz-1', assignee: 'owner-a', triageTags: ['size chart'], triageStatus: 'RESOLVED' },
      { id: 'etsy-old', assignee: null, triageTags: ['size chart'], triageStatus: null },
    ])
    const draft = await inside(() => runInboxBulk({ ids: ['amz-2', 'etsy-old', 'ebay-2'], action: 'draft', value: null }, 'user-1'))
    expect(draft.changed).toBe(1)
    expect(draft.skipped).toEqual([
      // Amazon lets nobody reply to a product review (audit B3): nothing to draft.
      { id: 'amz-2', reason: 'Amazon lets nobody reply to a product review. Read it, act on what it says, then resolve it.' },
      { id: 'etsy-old', reason: expect.stringMatching(/^The reply window on Etsy closed on /) },
    ])
    const drafts = await inside(() => database.client.reviewResponse.findMany({ where: { reviewId: 'ebay-2' }, select: { status: true, createdBy: true } }))
    expect(drafts).toEqual([{ status: 'DRAFT', createdBy: 'user-1' }])
  })

  it('the person\'s mood and themes are stored and survive a later AI re-read', async () => {
    const { editReviewSentiment } = await import('./review-detail.service.js')
    const { persistSentiment } = await import('./sentiment-extraction.service.js')
    expect(await inside(() => editReviewSentiment('ebay-1', { label: 'Banana' }, 'user-1'))).toMatchObject({ error: 'invalid_label' })
    const out = await inside(() => editReviewSentiment('ebay-1', { label: 'negative', categories: ['fit_sizing'] }, 'user-1'))
    expect(out).toMatchObject({ sentiment: { label: 'NEGATIVE', categories: ['FIT_SIZING'], edited: true } })
    await inside(() => persistSentiment({
      reviewId: 'ebay-1', label: 'POSITIVE', score: 0.9, categories: ['VALUE'], topPhrases: ['x'], model: 'rule-based-fallback',
      inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheWriteTokens: 0, costUSD: 0, rawText: '', language: null, english: null,
    }))
    const row = await inside(() => database.client.reviewSentiment.findUnique({ where: { reviewId: 'ebay-1' }, select: { label: true, categories: true, editedBy: true } }))
    expect(row).toEqual({ label: 'NEGATIVE', categories: ['FIT_SIZING'], editedBy: 'user-1' })
    const created = await inside(() => editReviewSentiment('amz-3', { categories: ['SHIPPING'] }, 'user-1'))
    expect(created).toMatchObject({ sentiment: { label: 'NEUTRAL', categories: ['SHIPPING'] } })
    expect(await inside(() => editReviewSentiment('fixture-1', { label: 'NEUTRAL' }, 'user-1'))).toMatchObject({ error: 'not_found' })
  })

  it('Undo this import removes untouched rows and keeps the ones a person worked on', async () => {
    const { undoReviewImport } = await import('./review-import.service.js')
    // amz-3's mood was set by a person in the test above; amz-4 has an owner.
    await inside(() => database.client.review.create({ data: { id: 'amz-5', channel: 'AMAZON', marketplace: 'IT', externalReviewId: 'TEST-amz-5', body: 'Ok', postedAt: daysAgo(1), ingestSource: 'IMPORT_CSV', importBatchId: 'import_b2' } as never }))
    const undo = await inside(() => undoReviewImport('import_b2'))
    expect(undo).toEqual({
      removed: 1,
      kept: [
        { id: expect.any(String), reason: expect.any(String) },
        { id: expect.any(String), reason: expect.any(String) },
      ],
    })
    const left = await inside(() => database.client.review.findMany({ where: { importBatchId: 'import_b2' }, select: { id: true }, orderBy: { id: 'asc' } }))
    expect(left.map((r) => r.id)).toEqual(['amz-3', 'amz-4'])
    expect(await inside(() => undoReviewImport('import_none'))).toEqual({ error: 'not_found' })
  })

  it('the routes: /reviews/inbox is the list (not a review id), fixture rows 404, refusals in words', async () => {
    const Fastify = (await import('fastify')).default
    const app = Fastify()
    app.addHook('preHandler', (request, _reply, done) => {
      ;(request as unknown as { authUser: { id: string } }).authUser = { id: 'user-1' }
      withWorkspace(business, done)
    })
    const { default: reviewsRoutes } = await import('../../routes/reviews.routes.js')
    await app.register(reviewsRoutes, { prefix: '/api' })
    await app.ready()
    try {
      const list = await app.inject({ method: 'GET', url: '/api/reviews/inbox?kind=seller' })
      expect(list.statusCode, list.body).toBe(200)
      expect(list.json()).toMatchObject({ total: 2, tabCounts: { all: 7, product: 5, seller: 2 } })
      expect((await app.inject({ method: 'GET', url: '/api/reviews/inbox/ebay-1' })).json()).toMatchObject({ review: { id: 'ebay-1' } })
      expect((await app.inject({ method: 'GET', url: '/api/reviews/inbox/fixture-1' })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: '/api/reviews/fixture-1' })).statusCode).toBe(404)
      const bad = await app.inject({ method: 'POST', url: '/api/reviews/inbox/bulk', payload: { ids: [], action: 'assign' } })
      expect(bad.statusCode).toBe(400)
      expect(bad.json()).toEqual({ error: 'no_ids', message: 'Tick at least one review.' })
      const mood = await app.inject({ method: 'PATCH', url: '/api/reviews/etsy-old/sentiment', payload: { label: 'POSITIVE' } })
      expect(mood.statusCode, mood.body).toBe(200)
      expect((await app.inject({ method: 'POST', url: '/api/reviews/import/import_none/undo' })).statusCode).toBe(404)
      const translate = await app.inject({ method: 'POST', url: '/api/reviews/ebay-1/translate' })
      expect(translate.json()).toEqual({ language: 'de', english: 'Runs very small', cached: true })
      // No AI service here: an untranslated review is refused in words, nothing stored.
      const untranslated = await app.inject({ method: 'POST', url: '/api/reviews/etsy-old/translate' })
      expect(untranslated.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('reply/send refuses what the reply rules refuse, before eBay is called', async () => {
    const { sendReviewReply } = await import('./review-reply-send.service.js')
    const tooLong = await inside(() => sendReviewReply('ebay-1', { body: 'x'.repeat(501) }))
    expect(tooLong.status).toBe(400)
    expect(tooLong.body).toEqual({ error: 'too_long', message: 'Cut 1 character to send it (the limit is 500).' })
    expect(ebay.replies).toEqual([])
    const ok = await inside(() => sendReviewReply('ebay-1', { body: 'x'.repeat(500) }))
    expect(ok.status).toBe(200)
    expect(ebay.replies).toEqual(['TEST-ebay-1'])
    const again = await inside(() => sendReviewReply('ebay-1', { body: 'Thanks again' }))
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ error: 'already_replied' })
    const late = await inside(() => sendReviewReply('etsy-old', { body: 'Thank you' }))
    expect(late.status).toBe(409)
    expect(late.body).toMatchObject({ error: 'window_closed' })
    // An Amazon product review: Amazon lets nobody reply, so nothing is sent or recorded (audit B3).
    const amazon = await inside(() => sendReviewReply('amz-2', { body: 'Thank you' }))
    expect(amazon.status).toBe(409)
    expect(amazon.body).toMatchObject({ error: 'no_reply' })
    expect(ebay.replies).toEqual(['TEST-ebay-1'])
  })
})
