/**
 * MCP full control 07 O13 — `request-review` and `reply-to-review` through the one door (call-tool.ts), on a real
 * PostgreSQL with the production schema and policies (PGlite). Amazon's Solicitations call and eBay's RespondToFeedback
 * are MOCKED: nothing leaves the machine.
 *
 *   request-review  — Amazon only, 4–30 days after delivery, never with an open return, once per order; dry run or
 *                     live as the switch says; eBay buyers refused (decision O-2); a return opened after the approval
 *                     refuses the run and Amazon is not called; never confirm or auto; cannot be undone.
 *   reply-to-review — eBay only, at most 80 characters, one reply per feedback, refused while eBay replies are off;
 *                     the copy checks shown; a reply posted meanwhile refuses the run.
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
const channel = vi.hoisted(() => ({ solicitations: [] as string[], replies: [] as string[] }))
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

import { callTool, executeTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

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

describe('request-review (07 O13)', () => {
  it('a dry run records it skipped; live, Amazon is asked once; again, it is refused', async () => {
    const dry = await order()
    const asked = await dryRun('request-review', { orderId: dry })
    expect(asked.preview).toMatchObject({ deliveredDaysAgo: 10, earlier: null, mode: expect.stringMatching(/^dry run: Amazon is not called/) })
    expect((await run('request-review', { orderId: dry }, asked.preview)).data).toMatchObject({ status: 'SKIPPED' })
    vi.stubEnv('NEXUS_ENABLE_AMAZON_SOLICITATIONS', 'true')
    const live = await order()
    const askedLive = await dryRun('request-review', { orderId: live })
    expect(askedLive.preview.mode).toBe('live: Amazon sends it to the buyer')
    channel.solicitations.length = 0
    const done = await run('request-review', { orderId: live }, askedLive.preview)
    expect(done.ok, done.error).toBe(true)
    expect(await requestsOf(live)).toEqual([{ status: 'SENT' }])
    expect(channel.solicitations).toHaveLength(1)
    expect((await dryRun('request-review', { orderId: live })).error).toMatch(/a review was asked for already \(SENT\)/)
    vi.unstubAllEnvs()
  })

  it('the 4–30 day window, an open return, an eBay buyer, a channel without a request call', async () => {
    expect((await dryRun('request-review', { orderId: await order({ deliveredAt: daysAgo(2) }) })).error).toMatch(/delivered less than 4 days ago/)
    expect((await dryRun('request-review', { orderId: await order({ deliveredAt: daysAgo(40) }) })).error).toMatch(/delivered more than 30 days ago/)
    expect((await dryRun('request-review', { orderId: await order({ deliveredAt: null }) })).error).toMatch(/it is not delivered yet/)
    const returning = await order()
    await inside(() => database.client.return.create({ data: { orderId: returning, channel: 'AMAZON', rmaNumber: `TEST-O13-RMA-${++seq}`, status: 'AUTHORIZED' } as never }))
    expect((await dryRun('request-review', { orderId: returning })).error).toMatch(/it has an open return/)
    expect((await dryRun('request-review', { orderId: await order({ channel: 'EBAY' }) })).error).toMatch(/is an eBay order: its buyer is written to only through eBay/)
    expect((await dryRun('request-review', { orderId: await order({ channel: 'SHOPIFY' }) })).error).toMatch(/only through Amazon's Request a Review/)
  })

  it('a return opened after the approval refuses the run; Amazon is not asked', async () => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_SOLICITATIONS', 'true')
    const id = await order()
    const asked = await dryRun('request-review', { orderId: id })
    await inside(() => database.client.return.create({ data: { orderId: id, channel: 'AMAZON', rmaNumber: `TEST-O13-RMA-${++seq}`, status: 'REQUESTED' } as never }))
    channel.solicitations.length = 0
    expect((await run('request-review', { orderId: id }, asked.preview)).error).toMatch(/it has an open return/)
    expect(channel.solicitations).toEqual([])
    vi.unstubAllEnvs()
  })

  it('needs reviews.manage; never confirmed in Claude or auto; cannot be undone', async () => {
    const id = await order()
    await expect(callTool(person(Object.values(FEATURES).filter((f) => f !== FEATURES.reviewsManage)), 'request-review', { orderId: id })).rejects.toBeInstanceOf(ToolAccessError)
    expect(getTool('request-review')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', reversibility: 'none', openWorld: true })
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

  it('refused for Amazon, while eBay replies are off, and over 80 characters; the copy checks are shown', async () => {
    vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
    expect((await dryRun('reply-to-review', { reviewId: await review({ channel: 'AMAZON' }), body: 'Thanks' })).error).toMatch(/AMAZON has no public reply call/)
    expect((await dryRun('reply-to-review', { reviewId: await review(), body: 'See www.example.test' })).preview.lint).toEqual([expect.objectContaining({ severity: 'warn', message: expect.stringMatching(/External link/) })])
    vi.unstubAllEnvs()
    expect((await dryRun('reply-to-review', { reviewId: await review(), body: 'Thanks' })).error).toMatch(/eBay replies are off here \(NEXUS_EBAY_REAL_API not enabled\)/)
    expect(getTool('reply-to-review')!.input.safeParse({ reviewId: 'x', body: 'x'.repeat(81) }).success).toBe(false)
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
