/**
 * Reviews eBay REST (PR G) — what eBay's REST Feedback API brings, against real SQL (PGlite with the production schema and
 * policies; eBay, the AI and the approval door are mocked — nothing leaves this machine):
 *   - the review pass stores the buyer's photos (ReviewMedia), eBay's AI topics and eBay's state of the feedback, keeps a
 *     feedback without an order market-less (never a default market), finds the row the older Trading read stored, and
 *     replaces the photos / records a new state on the next pass;
 *   - the Inbox's "Has photos" filter and the pop-up's photos, topics and revision words;
 *   - "Leave feedback for buyers": eBay's lines stored and matched to their order, held words (90 days, open return,
 *     waiting for approval), ONE approval (a request for one sale, a change plan for several), a declined approval
 *     waits again with why.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import type { UserPrincipal } from '../agents/call-tool.js'

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
vi.mock('../review-events.service.js', () => ({
  publishReviewEvent: vi.fn(),
  subscribeReviewEvents: vi.fn(() => () => {}),
  getReviewListenerCount: vi.fn(() => 0),
  replayReviewEventsSince: vi.fn(() => []),
}))
vi.mock('./review-alert-notify.service.js', () => ({ notifyReviewAlert: vi.fn(async () => undefined) }))
vi.mock('./sentiment-extraction.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractSentiment: vi.fn(async ({ reviewId }: { reviewId: string }) => ({
    reviewId, label: 'NEUTRAL', score: 0, categories: [], topPhrases: [], model: 'test', inputTokens: 0, outputTokens: 0,
    cacheHitTokens: 0, cacheWriteTokens: 0, costUSD: 0, rawText: '', language: null, english: null,
  })),
  persistSentiment: vi.fn(async () => undefined),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date()
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)
const person = { kind: 'user', userId: 'test-user', label: 'Test person', permissions: {}, via: 'app' } as unknown as UserPrincipal

const restEntry = (id: string, over: Record<string, unknown> = {}) => ({
  feedbackId: id,
  commentType: 'NEGATIVE',
  feedbackComment: { commentText: `Feedback ${id}` },
  feedbackEnteredDate: daysAgo(3).toISOString(),
  feedbackState: 'ENTERED',
  eligibleForRevision: true,
  images: [{ url: `https://i.ebayimg.example/${id}-1.jpg` }, { url: `https://i.ebayimg.example/${id}-2.jpg` }],
  providerUserDetail: { userId: `buyer-${id}`, role: 'BUYER' },
  orderLineItemSummary: { orderLineItemId: `55500${id.length}-7770${id.length}`, listingId: `55500${id.length}` },
  ...over,
})

describe('eBay REST feedback, stored (real SQL)', () => {
  beforeAll(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('NEXUS_EBAY_REAL_API', 'false')
    database = await formulaDatabase()
    await inside(async () => {
      const c = database.client
      await c.order.create({
        data: {
          id: 'test-order-de', channel: 'EBAY', channelOrderId: '11001-20001', marketplace: 'DE', status: 'DELIVERED', currencyCode: 'EUR',
          totalPrice: '49.90', customerName: 'Test Buyer DE', customerEmail: 'de@example.test', shippingAddress: { city: 'Testville' },
          fulfillmentMethod: 'MFN', purchaseDate: daysAgo(12), deliveredAt: daysAgo(8),
        } as never,
      })
      await c.order.create({
        data: {
          id: 'test-order-old', channel: 'EBAY', channelOrderId: '11002-20002', marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR',
          totalPrice: '19.90', customerName: 'Test Buyer Old', customerEmail: 'old@example.test', shippingAddress: { city: 'Testville' },
          fulfillmentMethod: 'MFN', purchaseDate: daysAgo(95), deliveredAt: daysAgo(90),
        } as never,
      })
      await c.order.create({
        data: {
          id: 'test-order-return', channel: 'EBAY', channelOrderId: '11003-20003', marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR',
          totalPrice: '29.90', customerName: 'Test Buyer Return', customerEmail: 'ret@example.test', shippingAddress: { city: 'Testville' },
          fulfillmentMethod: 'MFN', purchaseDate: daysAgo(6), deliveredAt: daysAgo(3),
        } as never,
      })
      await c.return.create({ data: { orderId: 'test-order-return', channel: 'EBAY', rmaNumber: 'TEST-RMA-G1', status: 'REQUESTED', reason: 'too small' } as never })
      // A feedback the older Trading read stored under its own id, for the order line 99901-88801.
      await c.review.create({
        data: {
          id: 'trading-row', channel: 'EBAY', marketplace: 'IT', externalReviewId: 'TRADING-1', body: 'Old read', rating: 1, postedAt: daysAgo(4),
          authorName: 'buyer-same', ingestSource: 'EBAY_API', rawPayload: { FeedbackID: 'TRADING-1', OrderLineItemID: '99901-88801', ItemID: '99901' },
        } as never,
      })
    })
  }, 180_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await database?.close()
  })

  it('the review pass stores photos, eBay’s topics and state; no market from eBay; the Trading row is found, not doubled', async () => {
    const { ingestRawReviews } = await import('./review-ingest.service.js')
    const { restFeedbackToReview } = await import('./adapters/ebay-feedback-rest.adapter.js')
    const a = restFeedbackToReview(restEntry('rest-a'))!
    a.channelTopics = [{ topic: 'fit', sentiment: 'NEGATIVE', texts: ['too small'] }]
    const b = restFeedbackToReview(restEntry('rest-b', { images: [], feedbackState: 'REVISION_OPEN', eligibleForRevision: false }))!
    const same = restFeedbackToReview(restEntry('rest-same', { providerUserDetail: { userId: 'buyer-same', role: 'BUYER' }, orderLineItemSummary: { orderLineItemId: '99901-88801' } }))!
    const summary = await inside(() => ingestRawReviews([a, b, same], { ingestSource: 'EBAY_REST' }))
    expect(summary).toMatchObject({ reviewsInserted: 2, reviewsSkippedExisting: 1, errors: [] })

    await inside(async () => {
      const c = database.client
      const rowA = await c.review.findFirst({ where: { externalReviewId: 'rest-a' }, include: { media: { orderBy: { position: 'asc' } } } })
      expect(rowA).toMatchObject({ marketplace: null, ingestSource: 'EBAY_REST', feedbackState: 'ENTERED', revisionEligible: true, channelTopics: [{ topic: 'fit', sentiment: 'NEGATIVE', texts: ['too small'] }] })
      expect(rowA!.media.map((m) => [m.url, m.type, m.position])).toEqual([
        ['https://i.ebayimg.example/rest-a-1.jpg', 'image', 0], ['https://i.ebayimg.example/rest-a-2.jpg', 'image', 1],
      ])
      expect(await c.review.findFirst({ where: { externalReviewId: 'rest-same' } })).toBeNull()
      expect(await c.review.findUnique({ where: { id: 'trading-row' }, select: { feedbackState: true, revisionEligible: true } })).toEqual({ feedbackState: 'ENTERED', revisionEligible: true })
      expect(await c.reviewMedia.count({ where: { reviewId: 'trading-row' } })).toBe(2)
    })

    // Next pass: the buyer removed a photo, eBay opened a revision request; unchanged rows write nothing new.
    const a2 = restFeedbackToReview(restEntry('rest-a', { images: [{ url: 'https://i.ebayimg.example/rest-a-2.jpg' }], feedbackState: 'REVISION_OPEN', eligibleForRevision: false }))!
    await inside(() => ingestRawReviews([a2], { ingestSource: 'EBAY_REST' }))
    await inside(async () => {
      const rowA = await database.client.review.findFirst({ where: { externalReviewId: 'rest-a' }, include: { media: true } })
      expect(rowA!.media.map((m) => [m.url, m.position])).toEqual([['https://i.ebayimg.example/rest-a-2.jpg', 0]])
      expect(rowA).toMatchObject({ feedbackState: 'REVISION_OPEN', revisionEligible: false })
      expect(rowA!.feedbackStateAt).toBeInstanceOf(Date)
      // Topics not read this pass: the stored ones are kept.
      expect(rowA!.channelTopics).toEqual([{ topic: 'fit', sentiment: 'NEGATIVE', texts: ['too small'] }])
    })
  })

  it('the Inbox: "Has photos" keeps only reviews with photos; the pop-up shows them, eBay’s topics and the revision words', async () => {
    const { listInbox } = await import('./review-inbox.service.js')
    const { getInboxReview } = await import('./review-detail.service.js')
    const page = await inside(() => listInbox({ photos: '1' }))
    expect(page.rows.map((r) => r.id).sort()).toEqual(['trading-row', (await inside(() => database.client.review.findFirst({ where: { externalReviewId: 'rest-a' } })))!.id].sort())
    const all = await inside(() => listInbox({}))
    // Topics never read for this feedback: null (the list says "Not read"), not [] (read, none).
    expect(all.rows.find((r) => r.buyer === 'buyer-rest-b')).toMatchObject({ photos: 0, aiTopics: null })
    const withTopics = all.rows.find((r) => r.buyer === 'buyer-rest-a')!
    expect(withTopics).toMatchObject({ photos: 1, aiTopics: [{ topic: 'fit', label: 'Fit & sizing', sentiment: 'NEGATIVE' }], market: null })

    const detail = await inside(() => getInboxReview(withTopics.id))
    expect(detail!.media).toEqual([{ url: 'https://i.ebayimg.example/rest-a-2.jpg', type: 'image', width: null, height: null, position: 0 }])
    expect(detail!.aiTopics).toEqual([{ topic: 'fit', label: 'Fit & sizing', sentiment: 'NEGATIVE', texts: ['too small'] }])
    expect(detail!.revision).toMatchObject({ state: 'REVISION_OPEN', words: 'Waiting for the buyer', tone: 'info', eligible: false })
    expect(detail!.listingHref).toBe('https://www.ebay.com/itm/555006')
    expect(detail!.timeline.some((t) => t.words.startsWith('Revision request: waiting for the buyer'))).toBe(true)
    const plain = await inside(() => getInboxReview('trading-row'))
    expect(plain!.aiTopics).toBeNull()
  })

  it('leave feedback for buyers: lines stored and matched, held words, ONE approval, a declined one waits again', async () => {
    const svc = await import('./ebay-buyer-feedback.service.js')
    const line = (n: number, extra: Partial<{ title: string }> = {}) => ({ orderLineItemId: `1100${n}-2000${n}`, listingId: `1100${n}`, transactionId: `2000${n}`, title: `Item ${n}`, price: 49.9, currency: 'EUR', positiveAllowed: true, ...extra })
    await inside(() => svc.storeAwaitingLines('conn-ebay', [line(1), line(2), line(3), line(4)], true, NOW))
    const page = await inside(() => svc.listEbayBuyerFeedback({ now: NOW }))
    const byLine = new Map(page.rows.map((r) => [r.orderLineItemId, r]))
    expect(byLine.get('11001-20001')).toMatchObject({ buyer: 'Test Buyer DE', market: 'DE', order: { label: '11001-20001' }, daysLeft: 78, held: null, state: 'AWAITING' })
    expect(byLine.get('11002-20002')!.held).toMatch(/only within 90 days of the sale/)
    expect(byLine.get('11003-20003')!.held).toBe('This order has an open return or case: leave feedback once it is closed.')
    // No Nexus order: eBay names no buyer and no date; eBay still lists it, so it may go.
    expect(byLine.get('11004-20004')).toMatchObject({ buyer: null, market: null, soldAt: null, daysLeft: null, held: null })
    expect(page.counts).toMatchObject({ awaiting: 4, ready: 2, held: 2, waitingApproval: 0 })
    expect((await inside(() => svc.listEbayBuyerFeedback({ market: 'DE', now: NOW }))).rows.map((r) => r.orderLineItemId)).toEqual(['11001-20001'])
    // No Nexus order, but Nexus's own listing is on eBay Italy: the sale counts on eBay Italy's page (live audit B09).
    await inside(async () => {
      await database.client.product.create({ data: { id: 'test-b09', sku: 'TEST-B09', name: 'Test knee slider', basePrice: 10 } as never })
      await database.client.channelListing.create({ data: { productId: 'test-b09', channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: 'IT', listingStatus: 'ACTIVE', externalListingId: '11004' } as never })
    })
    expect((await inside(() => svc.listEbayBuyerFeedback({ now: NOW }))).rows.find((r) => r.orderLineItemId === '11004-20004')).toMatchObject({ market: 'IT', order: null })
    expect((await inside(() => svc.listEbayBuyerFeedback({ market: 'IT', now: NOW }))).rows.map((r) => r.orderLineItemId)).toContain('11004-20004')
    expect((await inside(() => svc.listEbayBuyerFeedback({ market: 'DE', now: NOW }))).rows.map((r) => r.orderLineItemId)).toEqual(['11001-20001'])

    // The text is checked before anything is asked.
    await expect(inside(() => svc.sendEbayBuyerFeedback({ ids: [byLine.get('11001-20001')!.id], text: 'x'.repeat(501) }, person))).rejects.toThrow('Cut 1 character (eBay allows 500).')

    const asks: Array<{ tool: string; args: Record<string, unknown> }> = []
    let next = 1
    const requester = {
      planTool: 'submit-change-plan',
      // As the real door does: a waiting approval row (the Approvals page's), then its id.
      ask: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        asks.push({ tool, args })
        const id = `approval-${next++}`
        const run = await database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done', ok: true } as never })
        await database.client.agentApproval.create({ data: { id, agentRunId: run.id, toolName: tool, args, status: 'pending', riskTier: 'high' } as never })
        return { ok: true, mode: 'queued', approvalId: id, expiresAt: new Date(NOW.getTime() + 86_400_000) }
      }),
    }
    const ids = ['11001-20001', '11002-20002', '11004-20004'].map((l) => byLine.get(l)!.id)
    const out = await inside(() => svc.sendEbayBuyerFeedback({ ids, text: 'Great buyer, thank you!' }, person, { requester, now: NOW }))
    expect(out.sent).toMatchObject({ approvalId: 'approval-1', kind: 'plan', lines: 2 })
    expect(out.held).toEqual([{ id: byLine.get('11002-20002')!.id, words: expect.stringMatching(/only within 90 days/) }])
    expect(asks).toEqual([{ tool: 'submit-change-plan', args: { title: 'eBay: positive feedback for 2 buyers', steps: [
      { tool: 'leave-buyer-feedback', args: { lineId: byLine.get('11001-20001')!.id, text: 'Great buyer, thank you!' } },
      { tool: 'leave-buyer-feedback', args: { lineId: byLine.get('11004-20004')!.id, text: 'Great buyer, thank you!' } },
    ] } }])

    // Asked again while it waits: held, nothing new asked.
    const again = await inside(() => svc.sendEbayBuyerFeedback({ ids: [byLine.get('11001-20001')!.id], text: 'Again' }, person, { requester, now: NOW }))
    expect(again).toEqual({ changed: 0, held: [{ id: byLine.get('11001-20001')!.id, words: 'Already sent for approval: it waits on the Approvals page.' }], sent: null })
    expect(asks).toHaveLength(1)

    // Declined on the Approvals page: the lines wait again, with why.
    await inside(() => database.client.agentApproval.update({ where: { id: 'approval-1' }, data: { status: 'rejected', decidedBy: 'Test approver' } }))
    const after = await inside(() => svc.listEbayBuyerFeedback({ now: NOW }))
    expect(after.rows.find((r) => r.orderLineItemId === '11001-20001')).toMatchObject({ approval: null, held: null, lastWords: 'Declined on the Approvals page by Test approver.' })

    // One sale = one request of the tool (not a plan).
    const single = await inside(() => svc.sendEbayBuyerFeedback({ ids: [byLine.get('11004-20004')!.id], text: 'Thanks!' }, person, { requester, now: NOW }))
    expect(single.sent).toMatchObject({ kind: 'request', lines: 1 })
    expect(asks[1]).toEqual({ tool: 'leave-buyer-feedback', args: { lineId: byLine.get('11004-20004')!.id, text: 'Thanks!' } })

    // eBay no longer lists a line after a full read: it is gone (not shown); a line left from Nexus stays left.
    await inside(() => svc.markBuyerFeedbackLeft(byLine.get('11001-20001')!.id, { text: 'Great buyer', feedbackId: 'fb-1', by: 'app:test-user' }, NOW))
    await inside(() => svc.storeAwaitingLines('conn-ebay', [line(4)], true, new Date(NOW.getTime() + 1000)))
    const last = await inside(() => svc.listEbayBuyerFeedback({ now: NOW }))
    expect(last.rows.map((r) => [r.orderLineItemId, r.state])).toEqual(expect.arrayContaining([['11001-20001', 'LEFT'], ['11004-20004', 'AWAITING']]))
    expect(last.rows.some((r) => r.orderLineItemId === '11002-20002')).toBe(false)
    expect(last.rows.find((r) => r.state === 'LEFT')!.held).toMatch(/already left/)
  })

  it("eBay feedback reaches its product: the listing's family, else its order's (live audit B13)", async () => {
    const { linkEbayFeedbackProducts } = await import('./adapters/ebay-feedback.adapter.js')
    await inside(async () => {
      const c = database.client
      await c.product.create({ data: { id: 'test-b13-fam', sku: 'TEST-B13', name: 'Test slider family', basePrice: 10, isParent: true } as never })
      await c.product.create({ data: { id: 'test-b13-s', sku: 'TEST-B13-S', name: 'Test slider S', basePrice: 10, parentId: 'test-b13-fam' } as never })
      await c.product.create({ data: { id: 'test-b13-m', sku: 'TEST-B13-M', name: 'Test slider M', basePrice: 10, parentId: 'test-b13-fam' } as never })
      for (const id of ['test-b13-s', 'test-b13-m']) {
        await c.channelListing.create({ data: { productId: id, channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: 'IT', listingStatus: 'ACTIVE', externalListingId: '777001' } as never })
      }
    })
    const reviews = [
      { externalReviewId: 'b13-a', channel: 'EBAY', body: 'Ottimi slider', postedAt: NOW.toISOString(), rawPayload: { ItemID: '777001', TransactionID: '1' } },
      { externalReviewId: 'b13-b', channel: 'EBAY', body: 'Unknown item', postedAt: NOW.toISOString(), rawPayload: { ItemID: '999999', TransactionID: '2' } },
    ] as Array<{ externalReviewId: string; channel: string; body: string; postedAt: string; rawPayload: unknown; productId?: string }>
    await inside(() => linkEbayFeedbackProducts(reviews))
    expect(reviews.map((r) => r.productId ?? null)).toEqual(['test-b13-fam', null])
  })
})

