/**
 * MCP full control 07 O13 — `request-review` and `reply-to-review` through the one door (call-tool.ts), on a real
 * PostgreSQL with the production schema and policies (PGlite). Amazon's Solicitations call and eBay's RespondToFeedback
 * are MOCKED: nothing leaves the machine.
 *
 *   request-review  — through the ONE sender (audit E5): Amazon 5–30 days after its delivery date (Nexus tries from
 *                     day 4 of its own), never with an open return, once per order; dry run or live as the switch
 *                     says; Shopify buyers get our review e-mail (no longer refused); an eBay order is held — Nexus
 *                     e-mails no eBay buyer, eBay asks itself (Owner, 2026-10-27), nothing written; held while sending is
 *                     paused; a return opened after the approval refuses the run and Amazon is not called; needs
 *                     reviews.manage only; never confirm or auto; cannot be undone. A timing test's holdout (PR J) is
 *                     never asked: its not-asked row, and an order a running test holds out, are refused in words.
 *   reply-to-review — eBay only, at most 500 characters, one reply per feedback, refused while eBay replies are off;
 *                     the copy checks shown; a reply posted meanwhile refuses the run.
 *   leave-buyer-feedback (PR G) — positive feedback for the buyer of one eBay sale eBay lists as waiting; at most 500
 *                     characters, within 90 days of the sale, never with an open return; a dry run while eBay posting
 *                     is off; the sale left (or gone) meanwhile refuses the run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
const channel = vi.hoisted(() => ({ solicitations: [] as string[], replies: [] as string[], left: [] as Array<{ connectionId: string; orderLineItemId: string; text: string }> }))
vi.mock('../../reviews/amazon-solicitations.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendAmazonSolicitation: vi.fn(async (args: { amazonOrderId: string }) => {
    if (process.env.NEXUS_ENABLE_AMAZON_SOLICITATIONS !== 'true') return { ok: false, errorCode: 'NOT_IMPLEMENTED', errorMessage: 'gated' }
    channel.solicitations.push(args.amazonOrderId)
    return { ok: true, errorCode: 'OK' }
  }),
}))
vi.mock('../../reviews/adapters/ebay-feedback.adapter.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  respondToEbayFeedback: vi.fn(async (feedbackId: string) => {
    channel.replies.push(feedbackId)
    return { ok: true, code: 'Success' }
  }),
}))

vi.mock('../../reviews/adapters/ebay-feedback-rest.adapter.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  leaveEbayBuyerFeedback: vi.fn(async (connectionId: string, input: { orderLineItemId: string; text: string }) => {
    if (process.env.NEXUS_EBAY_REAL_API !== 'true') return { ok: false, code: 'OPT_IN_OFF', error: 'Nexus does not post to eBay in this setup. Nothing was sent.' }
    channel.left.push({ connectionId, orderLineItemId: input.orderLineItemId, text: input.text })
    return { ok: true, code: 'Success', feedbackId: `fb-${channel.left.length}` }
  }),
}))

import { callTool, executeTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'
import { assignArm } from '../../reviews/review-timing-test-math.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const person = (permissions: string[]): UserPrincipal => ({
  kind: 'user', userId: 'u-o13', label: '07 O13 test', permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: business, via: 'claude',
})
const everything = person([...Object.values(FEATURES), ...Object.values(FIELDS)])
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
type Out = { ok: boolean; error?: string; preview?: any; data?: any }
const dryRun = async (tool: string, args: Record<string, unknown>) => (await callTool(everything, tool, args)).raw as Out
const run = async (tool: string, args: Record<string, unknown>, approvedPreview: unknown) => (await executeTool(everything, tool, args, { approvedPreview })).raw as Out
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
let seq = 0
const order = (data: Record<string, unknown> = {}) => inside(async () => (await database.client.order.create({
  data: {
    channel: 'AMAZON', channelOrderId: `TEST-O13-${++seq}`, marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '20.00',
    customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, fulfillmentMethod: 'MFN', deliveredAt: daysAgo(10), ...data,
  } as never,
})).id)
const review = (data: Record<string, unknown> = {}) => inside(async () => (await database.client.review.create({
  data: { channel: 'EBAY', marketplace: 'IT', externalReviewId: `TEST-FB-${++seq}`, rating: 2, body: 'Arrived late', authorName: 'Secret Buyer', postedAt: daysAgo(2), ...data } as never,
})).id)
const requestsOf = (orderId: string) => inside(() => database.client.reviewRequest.findMany({ where: { orderId }, select: { status: true } }))

beforeAll(async () => {
  database = await formulaDatabase()
}, 180_000)
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('request-review (07 O13, audit E5)', () => {
  it('a dry run records it not sent; live, Amazon is asked once; again, it is refused', async () => {
    const dry = await order()
    const asked = await dryRun('request-review', { orderId: dry })
    expect(asked.preview).toMatchObject({ deliveredDaysAgo: 10, earlier: null, mode: expect.stringMatching(/^dry run: sending to Amazon is switched off on this server/) })
    expect(JSON.stringify(asked.preview)).not.toMatch(/NEXUS_/)
    expect((await run('request-review', { orderId: dry }, asked.preview)).data).toMatchObject({ outcome: 'not_sent', status: 'SKIPPED' })
    vi.stubEnv('NEXUS_ENABLE_AMAZON_SOLICITATIONS', 'true')
    const live = await order()
    const askedLive = await dryRun('request-review', { orderId: live })
    expect(askedLive.preview.mode).toBe('live: Amazon sends it to the buyer')
    channel.solicitations.length = 0
    const done = await run('request-review', { orderId: live }, askedLive.preview)
    expect(done.ok, done.error).toBe(true)
    expect(done.data).toMatchObject({ outcome: 'sent', words: 'Amazon accepted — it sends its own email' })
    expect(await requestsOf(live)).toEqual([{ status: 'SENT' }])
    expect(channel.solicitations).toHaveLength(1)
    expect((await dryRun('request-review', { orderId: live })).error).toMatch(/Already sent on .*Amazon allows one request per order/)
    vi.unstubAllEnvs()
  })

  it('Amazon\'s 5–30 days, an open return, Shopify buyers get our review e-mail, eBay buyers none', async () => {
    expect((await dryRun('request-review', { orderId: await order({ deliveredAt: daysAgo(2) }) })).error).toMatch(/Too early: Amazon allows a request 5–30 days after its delivery date/)
    expect((await dryRun('request-review', { orderId: await order({ deliveredAt: daysAgo(40) }) })).error).toMatch(/Past Amazon’s day 30/)
    expect((await dryRun('request-review', { orderId: await order({ deliveredAt: null }) })).error).toMatch(/Not delivered yet/)
    const returning = await order()
    await inside(() => database.client.return.create({ data: { orderId: returning, channel: 'AMAZON', rmaNumber: `TEST-O13-RMA-${++seq}`, status: 'AUTHORIZED' } as never }))
    expect((await dryRun('request-review', { orderId: returning })).error).toMatch(/A return is open/)
    // Nexus e-mails no eBay buyer (Owner, 2026-10-27): held in the queue's words, nothing written.
    const ebayId = await order({ channel: 'EBAY' })
    const ebay = await dryRun('request-review', { orderId: ebayId })
    expect(ebay.ok).toBe(false)
    expect(ebay.error).toMatch(/^Order .*: Not sent — eBay asks the buyer for feedback itself\. Nothing was queued\.$/)
    expect(await requestsOf(ebayId)).toEqual([])
    const shopifyId = await order({ channel: 'SHOPIFY' })
    const shopify = await dryRun('request-review', { orderId: shopifyId })
    expect(shopify.preview.request).toMatch(/honest review/)
    // E-mail switched off here: the request is recorded as not sent, never as "wire a third-party app first".
    expect((await run('request-review', { orderId: shopifyId }, shopify.preview)).data).toMatchObject({ outcome: 'not_sent', words: 'Not sent — our email sending is switched off on this server' })
    expect((await dryRun('request-review', { orderId: await order({ channel: 'SHOPIFY', customerEmail: '' }) })).error).toMatch(/no buyer e-mail/)
    expect(getTool('request-review')?.description).toMatch(/eBay orders are not asked: eBay asks its buyers for feedback itself/)
  })

  it('held while sending is paused on Reviews › Requests: nothing is queued (audit B12)', async () => {
    const id = await order()
    await inside(() => database.client.reviewMailerState.upsert({ where: { id: 'default' }, update: { isPaused: true }, create: { id: 'default', isPaused: true } as never }))
    const asked = await dryRun('request-review', { orderId: id })
    await inside(() => database.client.reviewMailerState.update({ where: { id: 'default' }, data: { isPaused: false } }))
    expect(asked.error).toMatch(/Sending is paused on Reviews › Requests/)
    expect(await requestsOf(id)).toEqual([])
  })

  it('a return opened after the approval refuses the run; Amazon is not asked', async () => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_SOLICITATIONS', 'true')
    const id = await order()
    const asked = await dryRun('request-review', { orderId: id })
    await inside(() => database.client.return.create({ data: { orderId: id, channel: 'AMAZON', rmaNumber: `TEST-O13-RMA-${++seq}`, status: 'REQUESTED' } as never }))
    channel.solicitations.length = 0
    expect((await run('request-review', { orderId: id }, asked.preview)).error).toMatch(/A return is open/)
    expect(channel.solicitations).toEqual([])
    vi.unstubAllEnvs()
  })

  it('PR J — a timing test’s holdout is refused: its not-asked row, and an order a running test holds out; Amazon is not asked', async () => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_SOLICITATIONS', 'true')
    channel.solicitations.length = 0
    const words = /Held out by a timing test on purpose — it stays not asked, so the test’s result holds\. Nothing was queued\.$/
    // The scheduler's holdout row: never put back by hand.
    const heldRow = await order()
    await inside(() => database.client.reviewRequest.create({ data: { orderId: heldRow, channel: 'AMAZON', marketplace: 'IT', status: 'SKIPPED', scheduledFor: daysAgo(6), suppressedReason: 'timing_test_holdout', providerResponseCode: 'TIMING_TEST_HOLDOUT' } as never }))
    expect((await dryRun('request-review', { orderId: heldRow })).error).toMatch(words)
    expect(await requestsOf(heldRow)).toEqual([{ status: 'SKIPPED' }])

    // An order a RUNNING test puts in its holdout, before the scheduler made its row: held, nothing written — also when
    // the request was previewed before the test started and approved after.
    const arms = [
      { id: 'tt-o13-d4', label: 'Day 4 (now)', position: 0, delayDays: 4, holdout: false },
      { id: 'tt-o13-d7', label: 'Day 7', position: 1, delayDays: 7, holdout: false },
      { id: 'tt-o13-hold', label: 'Not asked (holdout)', position: 2, holdout: true },
    ]
    let n = 0
    let number = ''
    do number = `TEST-O13-HOLD-${++n}`
    while (assignArm({ id: 'tt-o13', holdoutPct: 20, arms }, number)?.holdout !== true)
    const heldOut = await order({ channelOrderId: number })
    const before = await dryRun('request-review', { orderId: heldOut })
    expect(before.ok).toBe(true)
    await inside(() => database.client.reviewTimingTest.create({ data: {
      id: 'tt-o13', kind: 'TIMING', channel: 'AMAZON', market: 'IT', holdoutPct: 20, status: 'RUNNING', startedAt: daysAgo(3), endsWhen: { ordersPerArm: 300, maxDays: 56 },
      arms: { create: arms },
    } as never }))
    try {
      expect((await dryRun('request-review', { orderId: heldOut })).error).toMatch(words)
      expect((await run('request-review', { orderId: heldOut }, before.preview)).ok).toBe(false)
      expect(await requestsOf(heldOut)).toEqual([])
    } finally {
      // The other tests of this file ask Italian Amazon orders: the test ends here.
      await inside(() => database.client.reviewTimingTest.update({ where: { id: 'tt-o13' }, data: { status: 'STOPPED', endedAt: new Date() } }))
    }
    expect(channel.solicitations).toEqual([])
    vi.unstubAllEnvs()
  })

  it('lane N6 — a Shopify test’s holdout is refused the same way: its not-asked row, and an order a running Shopify test holds out; no e-mail', async () => {
    const words = /Held out by a timing test on purpose — it stays not asked, so the test’s result holds\. Nothing was queued\.$/
    const heldRow = await order({ channel: 'SHOPIFY', marketplace: null })
    await inside(() => database.client.reviewRequest.create({ data: { orderId: heldRow, channel: 'SHOPIFY', status: 'SKIPPED', scheduledFor: daysAgo(6), suppressedReason: 'timing_test_holdout', providerResponseCode: 'TIMING_TEST_HOLDOUT' } as never }))
    expect((await dryRun('request-review', { orderId: heldRow })).error).toMatch(words)
    expect(await requestsOf(heldRow)).toEqual([{ status: 'SKIPPED' }])

    // A running Shopify test covers the whole store (market "*"): an order it puts in its holdout is held before the
    // scheduler made its row — also when the request was previewed before the test started and approved after.
    const arms = [
      { id: 'tt-o13-shop-d7', label: 'Day 7 (now)', position: 0, delayDays: 7, holdout: false },
      { id: 'tt-o13-shop-d4', label: 'Day 4', position: 1, delayDays: 4, holdout: false },
      { id: 'tt-o13-shop-hold', label: 'Not asked (holdout)', position: 2, holdout: true },
    ]
    let n = 0
    let number = ''
    do number = `TEST-O13-SHOP-HOLD-${++n}`
    while (assignArm({ id: 'tt-o13-shop', holdoutPct: 20, arms }, number)?.holdout !== true)
    const heldOut = await order({ channel: 'SHOPIFY', marketplace: null, channelOrderId: number })
    const before = await dryRun('request-review', { orderId: heldOut })
    expect(before.ok, before.error).toBe(true)
    await inside(() => database.client.reviewTimingTest.create({ data: {
      id: 'tt-o13-shop', kind: 'TIMING', channel: 'SHOPIFY', market: '*', holdoutPct: 20, status: 'RUNNING', startedAt: daysAgo(3), endsWhen: { ordersPerArm: 300, maxDays: 56 },
      arms: { create: arms },
    } as never }))
    try {
      expect((await dryRun('request-review', { orderId: heldOut })).error).toMatch(words)
      expect((await run('request-review', { orderId: heldOut }, before.preview)).ok).toBe(false)
      expect(await requestsOf(heldOut)).toEqual([])
      // An order the test puts in an asked group is still asked (our review e-mail; switched off on this server).
      let m = 0
      let asked = ''
      do asked = `TEST-O13-SHOP-ASK-${++m}`
      while (assignArm({ id: 'tt-o13-shop', holdoutPct: 20, arms }, asked)?.holdout !== false)
      const askedId = await order({ channel: 'SHOPIFY', marketplace: null, channelOrderId: asked })
      const ask = await dryRun('request-review', { orderId: askedId })
      expect(ask.ok, ask.error).toBe(true)
      expect((await run('request-review', { orderId: askedId }, ask.preview)).data).toMatchObject({ outcome: 'not_sent', words: 'Not sent — our email sending is switched off on this server' })
    } finally {
      await inside(() => database.client.reviewTimingTest.update({ where: { id: 'tt-o13-shop' }, data: { status: 'STOPPED', endedAt: new Date() } }))
    }
  })

  it('needs reviews.manage (a review action); never confirmed in Claude or auto; cannot be undone', async () => {
    const id = await order()
    await expect(callTool(person(Object.values(FEATURES).filter((f) => f !== FEATURES.reviewsManage)), 'request-review', { orderId: id })).rejects.toBeInstanceOf(ToolAccessError)
    expect(getTool('request-review')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', reversibility: 'none', openWorld: true, requires: [FEATURES.reviewsManage] })
  })
})

describe('reply-to-review (07 O13)', () => {
  it('posts an eBay reply (mocked), marks the review responded; a second one is refused', async () => {
    vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
    const id = await review()
    const asked = await dryRun('reply-to-review', { reviewId: id, body: 'Sorry for the delay, thanks!' })
    expect(asked.preview).toMatchObject({ reply: 'Sorry for the delay, thanks!', lint: [], mode: expect.stringMatching(/^live: eBay publishes it/) })
    expect(JSON.stringify(asked.preview)).not.toMatch(/Secret Buyer/)
    channel.replies.length = 0
    const done = await run('reply-to-review', { reviewId: id, body: 'Sorry for the delay, thanks!' }, asked.preview)
    expect(done.ok, done.error).toBe(true)
    expect(channel.replies).toHaveLength(1)
    expect(await inside(() => database.client.review.findUnique({ where: { id }, select: { triageStatus: true } }))).toEqual({ triageStatus: 'RESPONDED' })
    expect((await dryRun('reply-to-review', { reviewId: id, body: 'Again' })).error).toMatch(/it was answered already .*one reply per feedback/)
    vi.unstubAllEnvs()
  })

  it('refused for Amazon, while eBay replies are off, and over 500 characters; the copy checks are shown', async () => {
    vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
    expect((await dryRun('reply-to-review', { reviewId: await review({ channel: 'AMAZON' }), body: 'Thanks' })).error).toMatch(/AMAZON has no public reply call/)
    expect((await dryRun('reply-to-review', { reviewId: await review(), body: 'See www.example.test' })).preview.lint).toEqual([expect.objectContaining({ severity: 'warn', message: expect.stringMatching(/External link/) })])
    vi.unstubAllEnvs()
    expect((await dryRun('reply-to-review', { reviewId: await review(), body: 'Thanks' })).error).toMatch(/replies to eBay are switched off on this server, so eBay would not be called/)
    expect(getTool('reply-to-review')!.input.safeParse({ reviewId: 'x', body: 'x'.repeat(500) }).success).toBe(true)
    expect(getTool('reply-to-review')!.input.safeParse({ reviewId: 'x', body: 'x'.repeat(501) }).success).toBe(false)
  })

  it('a reply posted after the approval refuses the run; eBay is not called again', async () => {
    vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
    const id = await review()
    const asked = await dryRun('reply-to-review', { reviewId: id, body: 'Thanks for the feedback' })
    await inside(() => database.client.reviewResponse.create({ data: { reviewId: id, channel: 'EBAY', body: 'Posted from the desk', status: 'SENT', sentAt: new Date() } as never }))
    channel.replies.length = 0
    expect((await run('reply-to-review', { reviewId: id, body: 'Thanks for the feedback' }, asked.preview)).error).toMatch(/it was answered already/)
    expect(channel.replies).toEqual([])
    vi.unstubAllEnvs()
  })
})

describe('leave-buyer-feedback (PR G)', () => {
  const inNexus: UserPrincipal = { ...everything, via: 'app' }
  const dryRunApp = async (args: Record<string, unknown>) => (await callTool(inNexus, 'leave-buyer-feedback', args)).raw as Out
  const runApp = async (args: Record<string, unknown>, approvedPreview: unknown) => (await executeTool(inNexus, 'leave-buyer-feedback', args, { approvedPreview })).raw as Out
  const line = (data: Record<string, unknown> = {}) => inside(async () => (await database.client.ebayBuyerFeedback.create({
    data: { connectionId: 'conn-ebay', orderLineItemId: `11000${++seq}-22000${seq}`, listingId: `11000${seq}`, transactionId: `22000${seq}`, title: 'Test gloves', ...data } as never,
  })).id)

  it('live: eBay is asked once, POSITIVE, and the sale is left; a second run is refused', async () => {
    vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
    const sold = await order({ channel: 'EBAY', purchaseDate: daysAgo(10) })
    const id = await line({ orderId: sold })
    const asked = await dryRunApp({ lineId: id, text: 'Great buyer, quick payment.' })
    expect(asked.ok, asked.error).toBe(true)
    expect(asked.preview).toMatchObject({ rating: expect.stringMatching(/^Positive/), window: '80 of 90 days left to leave it', mode: expect.stringMatching(/^live/) })
    channel.left.length = 0
    const done = await runApp({ lineId: id, text: 'Great buyer, quick payment.' }, asked.preview)
    expect(done.ok, done.error).toBe(true)
    expect(channel.left).toEqual([{ connectionId: 'conn-ebay', orderLineItemId: expect.stringMatching(/^11000/), text: 'Great buyer, quick payment.' }])
    expect(await inside(() => database.client.ebayBuyerFeedback.findUnique({ where: { id }, select: { state: true, feedbackId: true, commentText: true } }))).toEqual({ state: 'LEFT', feedbackId: 'fb-1', commentText: 'Great buyer, quick payment.' })
    expect((await dryRunApp({ lineId: id, text: 'Again' })).error).toMatch(/already left .*Nothing was queued/)
    vi.unstubAllEnvs()
  })

  it('holds a sale older than 90 days, one with an open return, and text over 500 characters', async () => {
    const old = await line({ orderId: await order({ channel: 'EBAY', purchaseDate: daysAgo(100) }) })
    expect((await dryRunApp({ lineId: old, text: 'Thanks!' })).error).toMatch(/only within 90 days of the sale\. Nothing was queued/)
    const returning = await order({ channel: 'EBAY', purchaseDate: daysAgo(5) })
    await inside(() => database.client.return.create({ data: { orderId: returning, channel: 'EBAY', rmaNumber: `TEST-G-RMA-${++seq}`, status: 'REQUESTED' } as never }))
    expect((await dryRunApp({ lineId: await line({ orderId: returning }), text: 'Thanks!' })).error).toMatch(/open return or case/)
    expect(getTool('leave-buyer-feedback')!.input.safeParse({ lineId: 'x', text: 'x'.repeat(500) }).success).toBe(true)
    expect(getTool('leave-buyer-feedback')!.input.safeParse({ lineId: 'x', text: 'x'.repeat(501) }).success).toBe(false)
  })

  it('a dry run while eBay posting is off: nothing is left and the sale keeps waiting, with why', async () => {
    const id = await line()
    const asked = await dryRunApp({ lineId: id, text: 'Thank you!' })
    expect(asked.preview).toMatchObject({ mode: expect.stringMatching(/^dry run: eBay is not called/), window: expect.stringMatching(/cannot count the 90 days/) })
    channel.left.length = 0
    expect((await runApp({ lineId: id, text: 'Thank you!' }, asked.preview)).error).toMatch(/Nothing was sent/)
    expect(channel.left).toEqual([])
    expect(await inside(() => database.client.ebayBuyerFeedback.findUnique({ where: { id }, select: { state: true, lastWords: true } }))).toEqual({ state: 'AWAITING', lastWords: expect.stringMatching(/Nothing was sent/) })
  })

  it('a sale eBay no longer lists refuses the run (stale); needs reviews.manage; never confirmed in Claude or auto; cannot be undone', async () => {
    vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
    const id = await line()
    const asked = await dryRunApp({ lineId: id, text: 'Thank you!' })
    await inside(() => database.client.ebayBuyerFeedback.update({ where: { id }, data: { state: 'GONE' } }))
    channel.left.length = 0
    expect((await runApp({ lineId: id, text: 'Thank you!' }, asked.preview)).error).toMatch(/no longer lists this sale/)
    expect(channel.left).toEqual([])
    vi.unstubAllEnvs()
    expect(getTool('leave-buyer-feedback')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', reversibility: 'none', openWorld: true, requires: [FEATURES.reviewsManage] })
    await expect(callTool(person(Object.values(FEATURES).filter((f) => f !== FEATURES.reviewsManage)), 'leave-buyer-feedback', { lineId: id, text: 'Thanks' })).rejects.toBeInstanceOf(ToolAccessError)
  })
})
