/**
 * Reviews eBay REST (PR G) — eBay's REST Feedback API read and written through a mocked sender (no network, never eBay):
 * a feedback's photos, eBay's AI topics, eBay's state (revision), no market from eBay, what is skipped; the sales waiting
 * for the seller's feedback; the fallback to the Trading read; leaving feedback (POSITIVE only, ≤ 500, off = nothing sent).
 */
import { describe, expect, it } from 'vitest'
import {
  AWAITING_PAGE_SIZE, FEEDBACK_API, applyTopics, awaitingUrl, feedbackUrl, leaveEbayBuyerFeedback, leaveFeedbackBody, mediaOf,
  parseAwaitingPage, parseFeedbackPage, readItemsAwaitingFeedback, readRestFeedback, readRestTopics, respondToEbayFeedbackRest,
  restFeedbackToReview, topicsOf, type EbaySender,
} from './ebay-feedback-rest.adapter.js'

const NOW = new Date('2026-10-27T10:00:00Z')

const entry = (over: Record<string, unknown> = {}) => ({
  feedbackId: '1234567890',
  commentType: 'NEGATIVE',
  feedbackComment: { commentText: 'Zu klein, leider.', state: 'ENTERED' },
  feedbackEnteredDate: '2026-10-20T08:00:00.000Z',
  feedbackState: 'REVISION_OPEN',
  eligibleForRevision: false,
  hasImages: true,
  images: [{ url: 'https://i.ebayimg.example/a.jpg' }, { url: 'https://i.ebayimg.example/b.jpg' }, { url: 'http://insecure.example/c.jpg' }],
  providerUserDetail: { userId: 'buyer_one', role: 'BUYER', feedbackScore: 12 },
  orderLineItemSummary: { orderLineItemId: '110012345678-2000111222', listingId: '110012345678', listingTitle: 'Test jacket' },
  topics: [
    { coarseTopic: 'fit', sentiment: 'Negative', highlightedTexts: ['Zu klein'] },
    { coarseTopic: 'fit', sentiment: 'Negative', highlightedTexts: ['again'] },
  ],
  ...over,
})

const page = (entries: unknown[], next: string | null = null) => JSON.stringify({ feedbackEntries: entries, pagination: { count: entries.length, total: 999, ...(next ? { next } : {}) } })
const answer = (status: number, body: string) => new Response(body, { status })

function recorder(answers: Response[]): { send: EbaySender; calls: Array<{ connectionId: string | null; url: string; init?: RequestInit }> } {
  const calls: Array<{ connectionId: string | null; url: string; init?: RequestInit }> = []
  const send: EbaySender = async (connectionId, url, init) => {
    calls.push({ connectionId, url, init })
    return answers.shift() ?? answer(500, '{}')
  }
  return { send, calls }
}

describe('one feedback from eBay’s REST API', () => {
  it('keeps the buyer’s photos (https only, in order), eBay’s topics, eBay’s state and the order line — and names no market', () => {
    const review = restFeedbackToReview(entry(), NOW)!
    expect(review).toMatchObject({
      externalReviewId: '1234567890', channel: 'EBAY', body: 'Zu klein, leider.', authorName: 'buyer_one', rating: 1,
      postedAt: '2026-10-20T08:00:00.000Z', feedbackState: 'REVISION_OPEN', revisionEligible: false,
      sameAs: { orderLineItemId: '110012345678-2000111222', buyer: 'buyer_one' },
    })
    expect(review.marketplace).toBeUndefined()
    expect(review.media).toEqual([
      { url: 'https://i.ebayimg.example/a.jpg', type: 'image', width: null, height: null, position: 0 },
      { url: 'https://i.ebayimg.example/b.jpg', type: 'image', width: null, height: null, position: 1 },
    ])
    // Topics are put on by the topic pass (applyTopics), never guessed from a list read.
    expect(review.channelTopics).toBeUndefined()
    expect(topicsOf(entry())).toEqual([{ topic: 'fit', sentiment: 'NEGATIVE', texts: ['Zu klein'] }])
  })

  it('maps eBay’s types to the stars the Inbox uses, and skips what is not a buyer’s words', () => {
    expect(restFeedbackToReview(entry({ commentType: 'POSITIVE' }), NOW)!.rating).toBe(5)
    expect(restFeedbackToReview(entry({ commentType: 'NEUTRAL' }), NOW)!.rating).toBe(3)
    expect(restFeedbackToReview(entry({ automatedFeedback: true }), NOW)).toBeNull()
    expect(restFeedbackToReview(entry({ providerUserDetail: { userId: 'x', role: 'SELLER' } }), NOW)).toBeNull()
    expect(restFeedbackToReview(entry({ feedbackComment: {} }), NOW)).toBeNull()
    expect(restFeedbackToReview(entry({ feedbackId: '' }), NOW)).toBeNull()
    expect(mediaOf({ images: 'nope' })).toEqual([])
  })

  it('sees a seller reply already on eBay (REST `replyComment`), as the reply rules do', async () => {
    const { repliedOnChannel } = await import('../review-reply-send.service.js')
    expect(repliedOnChannel('EBAY', entry({ replyComment: { commentText: 'Danke!' } }))).toBe(true)
    expect(repliedOnChannel('EBAY', entry())).toBe(false)
  })

  it('reads a page and refuses what is not eBay’s answer', () => {
    expect(parseFeedbackPage(page([entry()], '/feedback?offset=200'))).toMatchObject({ next: '/feedback?offset=200', total: 999 })
    expect(parseFeedbackPage('<html>')).toBeNull()
    expect(parseFeedbackPage('{"other":1}')).toBeNull()
  })

  it('asks for feedback buyers left the seller, newest first, 200 a page', () => {
    const url = new URL(feedbackUrl('seller_name', { offset: 400 }))
    expect(`${url.origin}${url.pathname}`).toBe(`${FEEDBACK_API}/feedback`)
    expect(Object.fromEntries(url.searchParams)).toEqual({ user_id: 'seller_name', feedback_type: 'FEEDBACK_RECEIVED', filter: 'role:BUYER', sort: 'TIME', limit: '200', offset: '400' })
    expect(new URL(feedbackUrl('s', { topic: 'fit', periodDays: 30 })).searchParams.get('filter')).toBe('role:BUYER,topics:fit,period:30')
  })
})

describe('reading by REST (mocked eBay)', () => {
  const account = { connectionId: 'conn-1', sellerId: 'seller_name' }

  it('reads page after page until eBay says there is no next', async () => {
    const full = Array.from({ length: 200 }, (_, i) => entry({ feedbackId: `f${i}` }))
    const { send, calls } = recorder([answer(200, page(full, '/next')), answer(200, page([entry({ feedbackId: 'last' })]))])
    const read = await readRestFeedback(account, { maxPages: 5 }, { send, enabled: () => true, now: () => NOW })
    expect(read.ok).toBe(true)
    expect((read as { reviews: unknown[] }).reviews).toHaveLength(201)
    expect(calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '200'])
    expect(calls.every((c) => c.connectionId === 'conn-1')).toBe(true)
  })

  it('falls back to the Trading read when eBay refuses the scope, or the account has no eBay user name', async () => {
    const { send } = recorder([answer(403, JSON.stringify({ errors: [{ errorId: 1100, message: 'Insufficient permissions to fulfill the request.' }] }))])
    expect(await readRestFeedback(account, {}, { send, enabled: () => true })).toEqual({ ok: false, fallback: true, words: 'eBay refused the feedback read (403): Insufficient permissions to fulfill the request..' })
    const none = await readRestFeedback({ connectionId: 'conn-1', sellerId: null }, {}, { send, enabled: () => true })
    expect(none).toMatchObject({ ok: false, fallback: true })
    expect((none as { words: string }).words).toMatch(/reconnect eBay/)
  })

  it('does nothing when eBay reading is off', async () => {
    const { send, calls } = recorder([])
    expect(await readRestFeedback(account, {}, { send, enabled: () => false })).toMatchObject({ ok: false, fallback: false })
    expect(calls).toHaveLength(0)
  })

  it('reads eBay’s topics once per topic, at most every 6 hours, and gives a recent feedback no topic [] (none)', async () => {
    const answers = [answer(200, page([entry({ feedbackId: 'f1', topics: [{ coarseTopic: 'shipping', sentiment: 'Positive', highlightedTexts: ['fast'] }] })]))]
    for (let i = 1; i < 20; i++) answers.push(answer(200, page([])))
    const { send, calls } = recorder(answers)
    const lastRun = new Map<string, number>()
    const pass = await readRestTopics(account, { send, enabled: () => true, now: () => NOW, lastRun })
    expect(calls).toHaveLength(20)
    expect(new URL(calls[0].url).searchParams.get('filter')).toBe('role:BUYER,topics:shipping,period:30')
    expect(pass!.topics.get('f1')).toEqual([{ topic: 'shipping', sentiment: 'POSITIVE', texts: ['fast'] }])
    expect(await readRestTopics(account, { send, enabled: () => true, now: () => new Date(NOW.getTime() + 60_000), lastRun })).toBeNull()

    const reviews = [
      restFeedbackToReview(entry({ feedbackId: 'f1' }), NOW)!,
      restFeedbackToReview(entry({ feedbackId: 'f2', feedbackEnteredDate: '2026-10-25T00:00:00Z' }), NOW)!,
      restFeedbackToReview(entry({ feedbackId: 'old', feedbackEnteredDate: '2026-01-01T00:00:00Z' }), NOW)!,
    ]
    applyTopics(reviews, pass)
    expect(reviews.map((r) => r.channelTopics)).toEqual([[{ topic: 'shipping', sentiment: 'POSITIVE', texts: ['fast'] }], [], undefined])
  })
})

describe('sales waiting for the seller’s feedback', () => {
  const line = (n: number) => ({
    orderLineItemId: `1100${n}-2000${n}`, listingId: `1100${n}`, transactionId: `2000${n}`, listingTitle: `Item ${n}`, listingPrice: { value: 49.9, currency: 'EUR' },
    ratingTemplates: [{ ratingKey: 'OVERALL_EXPERIENCE', acceptableValues: [{ value: 'POSITIVE', enabled: true }, { value: 'NEGATIVE', enabled: false }] }],
  })

  it('reads eBay’s lines (no buyer, no date — eBay gives none) and the seller’s count', () => {
    const parsed = parseAwaitingPage(JSON.stringify({ lineItems: [line(1), { orderLineItemId: '' }], itemsAwaitingFeedbackCount: { asSeller: 12, asBuyer: 1 }, pagination: { total: 12 } }))
    expect(parsed).toEqual({
      lines: [{ orderLineItemId: '11001-20001', listingId: '11001', transactionId: '20001', title: 'Item 1', price: 49.9, currency: 'EUR', positiveAllowed: true }],
      next: null, total: 12, asSeller: 12,
    })
    expect(Object.fromEntries(new URL(awaitingUrl(25)).searchParams)).toEqual({ filter: 'userRole:SELLER', limit: String(AWAITING_PAGE_SIZE), offset: '25', sort: 'END_TIME_DESC' })
  })

  it('reads every page, and says when eBay refuses', async () => {
    const full = Array.from({ length: 25 }, (_, i) => line(i))
    const { send } = recorder([answer(200, JSON.stringify({ lineItems: full, pagination: { next: '/n' } })), answer(200, JSON.stringify({ lineItems: [line(99)] }))])
    const read = await readItemsAwaitingFeedback('conn-1', { send, enabled: () => true })
    expect(read).toMatchObject({ ok: true, complete: true })
    expect((read as { lines: unknown[] }).lines).toHaveLength(26)
    const refused = await readItemsAwaitingFeedback('conn-1', { send: recorder([answer(500, '{}')]).send, enabled: () => true })
    expect(refused).toEqual({ ok: false, words: 'eBay refused the list of sales waiting for feedback (500).' })
  })
})

describe('leaving feedback for a buyer (only after a person approved it)', () => {
  const input = { orderLineItemId: '11001-20001', listingId: '11001', transactionId: '20001', text: '  Great buyer, fast payment!  ' }

  it('is always POSITIVE, with eBay’s three line ids', () => {
    expect(leaveFeedbackBody(input)).toEqual({ commentType: 'POSITIVE', commentText: 'Great buyer, fast payment!', orderLineItemId: '11001-20001', listingId: '11001', transactionId: '20001' })
  })

  it('posts once through the account and returns eBay’s feedback id', async () => {
    const { send, calls } = recorder([answer(200, JSON.stringify({ feedbackId: 'fb-9' }))])
    expect(await leaveEbayBuyerFeedback('conn-1', input, { send, enabled: () => true })).toEqual({ ok: true, code: 'Success', feedbackId: 'fb-9' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ connectionId: 'conn-1', url: `${FEEDBACK_API}/feedback`, init: { method: 'POST' } })
    expect(JSON.parse(String(calls[0].init!.body)).commentType).toBe('POSITIVE')
  })

  it('sends nothing when eBay posting is off, the text is over 500 or empty; eBay’s refusal comes back in its words', async () => {
    const { send, calls } = recorder([answer(409, JSON.stringify({ errors: [{ message: 'Feedback already left.' }] }))])
    expect(await leaveEbayBuyerFeedback('conn-1', input, { send, enabled: () => false })).toMatchObject({ ok: false, code: 'OPT_IN_OFF' })
    expect(await leaveEbayBuyerFeedback('conn-1', { ...input, text: 'x'.repeat(501) }, { send, enabled: () => true })).toMatchObject({ ok: false, code: 'TOO_LONG' })
    expect(await leaveEbayBuyerFeedback('conn-1', { ...input, text: '  ' }, { send, enabled: () => true })).toMatchObject({ ok: false, code: 'EMPTY' })
    expect(calls).toHaveLength(0)
    expect(await leaveEbayBuyerFeedback('conn-1', input, { send, enabled: () => true })).toEqual({ ok: false, code: 'HTTP_409', error: 'Feedback already left.' })
  })

  it('answers a REST feedback with REST respondToFeedback (REPLY, ≤ 500)', async () => {
    const { send, calls } = recorder([answer(200, '{}')])
    expect(await respondToEbayFeedbackRest('conn-1', 'f1', 'Danke!', 'buyer_one', { send, enabled: () => true })).toEqual({ ok: true, code: 'Success' })
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ feedbackId: 'f1', recipientUserId: 'buyer_one', responseText: 'Danke!', responseType: 'REPLY' })
    expect(await respondToEbayFeedbackRest('conn-1', 'f1', 'x'.repeat(501), 'buyer_one', { send, enabled: () => true })).toMatchObject({ ok: false, code: 'TOO_LONG' })
  })
})
