/**
 * Reviews PR J — timing tests and A/B splits against real SQL (PGlite with the production schema and policies; the
 * approval door is a fake that stores a waiting approval as the real one does — nothing is approved by a test, nothing
 * is sent anywhere):
 *   - "Start test" makes the test and asks for approval: it waits, the scheduler does not see it, nothing changes before
 *     a person approves; only the approved tool's run starts it; a stale approval changes nothing;
 *   - a declined start goes back to "not started", with who declined it; a second test on the same orders is held;
 *   - "Stop test" ends it at once (no approval) and withdraws a request still waiting;
 *   - the counts per group (orders, sent, counted, reviews — counted as the ONE review rate counts them: the attribution's
 *     link for a sent request; for the holdout a review naming its order, else one by product, market and window, within
 *     the rate's 30 days); "Not measurable" (never 0 %) where no review can follow in the test's market;
 *   - "Apply winner" asks for approval and changes no rule before; the approved tool adds the rule, its undo turns it off.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import type { UserPrincipal } from '../agents/call-tool.js'
import type { ToolContext } from '../agents/tool-types.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date()
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)
const person = { kind: 'user', userId: 'test-user', label: 'Test person', permissions: {}, via: 'app' } as unknown as UserPrincipal

type Svc = typeof import('./review-timing-test.service.js')
let svc: Svc
let tools: typeof import('../agents/tools/review-timing-tests.tools.js')['REVIEW_TIMING_TEST_TOOLS']
const tool = (name: string) => tools.find((t) => t.name === name)!
const ctxFor = (approvalId: string, approvedPreview: unknown): ToolContext => ({ approvalId, approvedPreview, via: 'app', userId: 'approver', can: () => true })

const asks: Array<{ tool: string; args: Record<string, unknown>; id: string }> = []
let next = 1
const requester = vi.fn(async (name: string, args: Record<string, unknown>) => {
  const id = `approval-${next++}`
  const run = await database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done', ok: true } as never })
  await database.client.agentApproval.create({ data: { id, agentRunId: run.id, toolName: name, args, status: 'pending', riskTier: 'high' } as never })
  asks.push({ tool: name, args, id })
  return { ok: true, mode: 'queued', approvalId: id, expiresAt: new Date(NOW.getTime() + DAY) }
})

beforeAll(async () => {
  database = await formulaDatabase()
  svc = await import('./review-timing-test.service.js')
  tools = (await import('../agents/tools/review-timing-tests.tools.js')).REVIEW_TIMING_TEST_TOOLS
  await inside(async () => {
    const c = database.client
    await c.reviewRule.create({ data: { id: 'rule-de', name: 'Germany', scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE', isActive: true, sendDelayDays: 4, minDaysSinceDelivery: 4, maxDaysSinceDelivery: 25, exclusions: ['has_refund'] } })
    await c.product.create({ data: { id: 'prod-glove', sku: 'TEST-GLOVE', name: 'Test glove', basePrice: '30.00', productType: 'Gloves touring' } as never })
  })
}, 180_000)

afterAll(async () => {
  await database?.close()
})

describe('Start test — nothing changes before a person approves', () => {
  let testId = ''

  it('makes the test and asks for approval: it waits, and the scheduler does not see it', async () => {
    const out = await inside(() => svc.createTimingTest({ market: 'DE', productType: 'Glove', days: [7, 4, 10], holdoutPct: 10 }, person, { requester, now: NOW }))
    testId = out.test.id
    expect(asks.at(-1)).toMatchObject({ tool: 'start-review-timing-test', args: { testId } })
    expect(out.approval?.id).toBe(asks.at(-1)!.id)
    expect(out.test).toMatchObject({ status: 'WAITING_APPROVAL', statusWords: 'Waiting for approval', productType: 'glove', holdoutPct: 10, approval: { what: 'start' } })
    // The day in place now (the rule's day 4) is the first group, then the other days, then the holdout.
    expect(out.test.arms.map((a) => a.label)).toEqual(['Day 4 (now)', 'Day 7', 'Day 10', 'Not asked (holdout)'])
    expect(out.test.held.start).toBe('Waits for approval on the Approvals page.')
    expect(await inside(() => svc.runningTimingTests(NOW))).toEqual([])
  })

  it('a second test on the same orders is held', async () => {
    await expect(inside(() => svc.createTimingTest({ market: 'DE', productType: 'gloves', days: [4, 14], holdoutPct: 0 }, person, { requester, now: NOW })))
      .rejects.toThrow(/Amazon Germany · glove is waiting for approval on the same orders/)
    await expect(inside(() => svc.createTimingTest({ market: 'DE', days: [4] }, person, { requester }))).rejects.toThrow('Pick at least 2 days to compare.')
    await expect(inside(() => svc.createTimingTest({ market: 'DE', days: [2, 4] }, person, { requester }))).rejects.toThrow(/between day 4 and day 25/)
    await expect(inside(() => svc.createTimingTest({ market: 'DE', days: [4, 7], holdoutPct: 30 }, person, { requester }))).rejects.toThrow('The holdout is 0–20% of the orders.')
  })

  it('only the approved tool’s run starts it; an approval of another test’s preview changes nothing', async () => {
    const start = tool('start-review-timing-test')
    const preview = await inside(() => start.handler({ testId }, ctxFor('x', undefined)))
    expect(preview.ok).toBe(true)
    expect((preview.preview as { effect: string }).effect).toMatch(/10% of the orders \(the holdout\) get no review request at all/)
    const stale = await inside(() => start.execute!({ testId }, ctxFor(asks.at(-1)!.id, { ...(preview.preview as object), test: { id: 'another' } })))
    expect(stale).toMatchObject({ ok: false })
    expect((await inside(() => svc.listTimingTests())).tests.find((t) => t.id === testId)?.status).toBe('WAITING_APPROVAL')

    const ran = await inside(() => start.execute!({ testId }, ctxFor(asks.at(-1)!.id, preview.preview)))
    expect(ran).toMatchObject({ ok: true, change: { after: { testId, status: 'RUNNING' } } })
    const running = await inside(() => svc.runningTimingTests(NOW))
    expect(running.map((t) => t.id)).toEqual([testId])
    // Started once: a second run of the same approval changes nothing.
    expect(await inside(() => start.execute!({ testId }, ctxFor(asks.at(-1)!.id, preview.preview)))).toMatchObject({ ok: false })
  })

  it('Stop test ends it at once — no approval asked', async () => {
    const before = requester.mock.calls.length
    const stopped = await inside(() => svc.stopTimingTest(testId, 'Test person', NOW))
    expect(stopped).toMatchObject({ status: 'STOPPED', held: { stop: 'This test has ended.' } })
    expect(stopped.statusWords).toMatch(/^Stopped .* by Test person$/)
    expect(requester.mock.calls.length).toBe(before)
    expect(await inside(() => svc.runningTimingTests(NOW))).toEqual([])
    await expect(inside(() => svc.stopTimingTest(testId, 'Test person', NOW))).rejects.toThrow('This test has already ended.')
  })
})

describe('a declined start, and a stop while it waits', () => {
  it('declined on the Approvals page → back to "not started", with who declined it', async () => {
    const out = await inside(() => svc.createTimingTest({ market: 'FR', days: [4, 7], holdoutPct: 0 }, person, { requester, now: NOW }))
    await inside(() => database.client.agentApproval.update({ where: { id: out.approval!.id }, data: { status: 'rejected', decidedBy: 'Test approver' } }))
    const view = (await inside(() => svc.listTimingTests())).tests.find((t) => t.id === out.test.id)!
    expect(view).toMatchObject({ status: 'DRAFT', statusWords: 'Not started', lastWords: 'The request to start it was declined on the Approvals page by Test approver.', approval: null, held: { start: null } })
    // Sent again: a new approval.
    const again = await inside(() => svc.startTimingTest(out.test.id, person, { requester, now: NOW }))
    expect(again.test.status).toBe('WAITING_APPROVAL')
    expect(again.approval?.id).not.toBe(out.approval!.id)
    // Stopped while it waits: its approval is withdrawn.
    await inside(() => svc.stopTimingTest(out.test.id, 'Test person', NOW))
    const approval = await inside(() => database.client.agentApproval.findUnique({ where: { id: again.approval!.id } }))
    expect(approval).toMatchObject({ status: 'rejected', reason: 'withdrawn: the test was stopped before anyone approved it' })
  })
})

describe('counts per group, and Apply winner', () => {
  const testId = 'test-it'
  beforeAll(async () => {
    await inside(async () => {
      const c = database.client
      await c.reviewTimingTest.create({
        data: {
          id: testId, kind: 'TIMING', channel: 'AMAZON', market: 'IT', productType: 'glove', holdoutPct: 10, status: 'DONE',
          startedAt: daysAgo(90), endedAt: daysAgo(2), endsWhen: { ordersPerArm: 120, maxDays: 84 },
          arms: { create: [
            { id: 'it-d4', label: 'Day 4 (now)', position: 0, delayDays: 4 },
            { id: 'it-d7', label: 'Day 7', position: 1, delayDays: 7 },
            { id: 'it-hold', label: 'Not asked (holdout)', position: 2, holdout: true },
          ] },
        },
      })
      // 120 orders per asked group, delivered 60 days ago (their time to answer is over), and 3 recent ones (not counted).
      const groups: Array<[string, number, number]> = [['it-d4', 120, 6], ['it-d7', 120, 18], ['it-hold', 12, 0]]
      let n = 0
      for (const [arm, orders, reviews] of groups) {
        for (let i = 0; i < orders + (arm === 'it-d7' ? 3 : 0); i++) {
          n += 1
          const recent = i >= orders
          const id = `ord-${n}`
          const delivered = recent ? daysAgo(5) : daysAgo(60)
          await c.order.create({ data: { id, channel: 'AMAZON', channelOrderId: `305-${n}`, marketplace: 'IT', status: 'DELIVERED', totalPrice: '30.00', customerName: 'Test', customerEmail: `${id}@example.test`, shippingAddress: {}, deliveredAt: delivered, items: { create: [{ sku: 'TEST-GLOVE', quantity: 1, price: '30.00', productId: 'prod-glove' }] } } as never })
          const holdout = arm === 'it-hold'
          await c.reviewRequest.create({ data: { id: `req-${n}`, orderId: id, channel: 'AMAZON', marketplace: 'IT', status: holdout ? 'SKIPPED' : 'SENT', timingTestArmId: arm, scheduledFor: new Date(delivered.getTime() + 4 * DAY), sentAt: holdout ? null : new Date(delivered.getTime() + 4 * DAY), ...(holdout ? { suppressedReason: 'timing_test_holdout', providerResponseCode: 'TIMING_TEST_HOLDOUT' } : {}) } as never })
          if (!holdout && i < reviews) {
            await c.review.create({ data: { channel: 'AMAZON', marketplace: 'IT', externalReviewId: `rv-${n}`, body: 'Good', rating: 5, postedAt: new Date(delivered.getTime() + 6 * DAY), productId: 'prod-glove', attributedRequestId: `req-${n}` } as never })
          }
        }
      }
      // A review no request explains, within the window of a holdout order: it counts for the holdout once.
      await c.review.create({ data: { channel: 'AMAZON', marketplace: 'IT', externalReviewId: 'rv-free', body: 'Fine', rating: 4, postedAt: daysAgo(60 - 5), productId: 'prod-glove' } as never })
      // Seller feedback naming a holdout order (the attribution links such a review by its order): it counts for that order.
      await c.review.create({ data: { channel: 'AMAZON', marketplace: 'IT', kind: 'SELLER', externalReviewId: 'rv-seller', body: 'Late', rating: 3, postedAt: daysAgo(60 - 20), orderId: 'ord-250' } as never })
      // Seller feedback naming a holdout order more than 30 days after the day it would have been asked: it does not count.
      await c.review.create({ data: { channel: 'AMAZON', marketplace: 'IT', kind: 'SELLER', externalReviewId: 'rv-late', body: 'Late', rating: 3, postedAt: daysAgo(60 - 40), orderId: 'ord-251' } as never })
      // A sample review (FIXTURE) never counts.
      await c.review.create({ data: { channel: 'AMAZON', marketplace: 'IT', externalReviewId: 'rv-fixture', body: 'Sample', rating: 4, postedAt: daysAgo(60 - 5), productId: 'prod-glove', ingestSource: 'FIXTURE' } as never })
    })
  }, 180_000)

  it('orders, sent, counted and reviews per group; the result says how sure', async () => {
    const view = (await inside(() => svc.listTimingTests({ kind: 'TIMING' }, NOW))).tests.find((t) => t.id === testId)!
    const by = Object.fromEntries(view.arms.map((a) => [a.id, { orders: a.orders, sent: a.sent, counted: a.counted, reviews: a.reviews }]))
    expect(by).toEqual({
      'it-d4': { orders: 120, sent: 120, counted: 120, reviews: 6 },
      'it-d7': { orders: 123, sent: 123, counted: 120, reviews: 18 },
      'it-hold': { orders: 12, sent: 0, counted: 12, reviews: 2 },
    })
    expect(view.result).toMatchObject({ tooEarly: false, leaderId: 'it-d7', controlId: 'it-d4', liftPct: 200 })
    expect(view.result.sure).toBeGreaterThanOrEqual(95)
    expect(view.result.words).toBe(`Day 7 gets 200% more reviews in Italy — ${view.result.sure}% sure`)
    expect(view.held).toMatchObject({ apply: null, keep: null, start: 'This test has ended. Make a new one to test again.' })
    // The counters are kept on the groups.
    const arms = await inside(() => database.client.reviewTimingTestArm.findMany({ where: { testId }, orderBy: { position: 'asc' } }))
    expect(arms.map((a) => [a.orders, a.sent, a.reviews])).toEqual([[120, 120, 6], [123, 123, 18], [12, 0, 2]])
  })

  it('Apply winner asks for approval and changes no rule before a person approves', async () => {
    const rulesBefore = await inside(() => database.client.reviewRule.findMany({ orderBy: { name: 'asc' } }))
    const out = await inside(() => svc.applyTimingWinner(testId, person, { requester, now: NOW }))
    expect(asks.at(-1)).toMatchObject({ tool: 'apply-review-timing-winner', args: { testId, armId: 'it-d7' } })
    expect(out.test).toMatchObject({ approval: { what: 'apply' }, held: { apply: 'Waits for approval on the Approvals page.' } })
    expect(await inside(() => database.client.reviewRule.findMany({ orderBy: { name: 'asc' } }))).toEqual(rulesBefore)
    await expect(inside(() => svc.applyTimingWinner(testId, person, { requester, now: NOW }))).rejects.toThrow(/already waits for approval/)
  })

  it('the approved tool adds the rule for Italy gloves on day 7; its undo turns that rule off', async () => {
    const apply = tool('apply-review-timing-winner')
    const approvalId = asks.at(-1)!.id
    const preview = await inside(() => apply.handler({ testId, armId: 'it-d7' }, ctxFor(approvalId, undefined)))
    expect(preview).toMatchObject({ ok: true, preview: { rule: { mode: 'create', name: 'Italy glove' }, to: { delayDays: 7 } } })
    const ran = await inside(() => apply.execute!({ testId, armId: 'it-d7' }, ctxFor(approvalId, preview.preview)))
    expect(ran.ok).toBe(true)
    const made = await inside(() => database.client.reviewRule.findFirst({ where: { name: 'Italy glove' } }))
    expect(made).toMatchObject({ scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'IT', productTypes: ['glove'], sendDelayDays: 7, isActive: true, createdBy: 'timing-test' })
    const undo = apply.undo!.request(ran.change as never)
    expect(undo).toEqual({ tool: 'apply-review-timing-winner', args: { testId, armId: 'before' } })
    const back = await inside(() => apply.handler((undo as { args: Record<string, unknown> }).args, ctxFor('u', undefined)))
    expect(back).toMatchObject({ ok: true, preview: { rule: { mode: 'turn-off', name: 'Italy glove' } } })
    const undone = await inside(() => apply.execute!((undo as { args: Record<string, unknown> }).args, ctxFor('u', back.preview)))
    expect(undone.ok).toBe(true)
    expect(await inside(() => database.client.reviewRule.findFirst({ where: { name: 'Italy glove' } }))).toMatchObject({ isActive: false, sendDelayDays: 7 })
    // And the undo of the undo applies the winner again.
    expect(apply.undo!.request(undone.change as never)).toEqual({ tool: 'apply-review-timing-winner', args: { testId, armId: 'it-d7' } })
  })
})

describe('the ONE review rate decides what can be measured (PR J on main\'s review-rate.service.ts)', () => {
  it('a review counts within the rate\'s own 30 days', async () => {
    const { ANSWER_DAYS } = await import('./review-timing-test-math.js')
    const { ATTRIBUTION_DAYS } = await import('./review-rate.service.js')
    expect(ANSWER_DAYS).toBe(ATTRIBUTION_DAYS)
  })

  it('no review can follow in the test\'s market: "Not measurable" in the rate\'s words, no rate, no leader — never 0 %', async () => {
    await inside(async () => {
      const c = database.client
      await c.reviewTimingTest.create({
        data: {
          id: 'test-fr', kind: 'TIMING', channel: 'AMAZON', market: 'FR', holdoutPct: 0, status: 'DONE', startedAt: daysAgo(90), endedAt: daysAgo(2),
          arms: { create: [{ id: 'fr-d4', label: 'Day 4 (now)', position: 0, delayDays: 4 }, { id: 'fr-d7', label: 'Day 7', position: 1, delayDays: 7 }] },
        },
      })
      for (const [i, arm] of ['fr-d4', 'fr-d7'].entries()) {
        const id = `ord-fr-${i}`
        await c.order.create({ data: { id, channel: 'AMAZON', channelOrderId: `407-${i}`, marketplace: 'FR', status: 'DELIVERED', totalPrice: '30.00', customerName: 'Test', customerEmail: `${id}@example.test`, shippingAddress: {}, deliveredAt: daysAgo(60), items: { create: [{ sku: 'TEST-GLOVE', quantity: 1, price: '30.00', productId: 'prod-glove' }] } } as never })
        await c.reviewRequest.create({ data: { orderId: id, channel: 'AMAZON', marketplace: 'FR', status: 'SENT', timingTestArmId: arm, scheduledFor: daysAgo(56), sentAt: daysAgo(56) } as never })
      }
    })
    const view = (await inside(() => svc.listTimingTests({ kind: 'TIMING' }, NOW))).tests.find((t) => t.id === 'test-fr')!
    expect(view.arms.map((a) => [a.id, a.counted, a.rate])).toEqual([['fr-d4', 1, null], ['fr-d7', 1, null]])
    expect(view.result).toMatchObject({ leaderId: null, sure: null, rates: { 'fr-d4': null, 'fr-d7': null } })
    expect(view.result.words).toBe('Not measurable: Amazon gives no review count — import this market’s reviews to estimate it.')
    expect(view.held.apply).toBe('Too early to call — there is no winner yet.')
  })
})

// ── Lane N6 — Shopify: Nexus's own review e-mail ──────────────────────────────────────────────────────────────────

describe('a Shopify timing test (lane N6): made, sent for approval, nothing changes before', () => {
  beforeAll(async () => {
    await inside(async () => {
      // The Shopify rule counts its first try from shipping: the test's groups count the same way, and the words say so.
      await database.client.reviewRule.create({ data: { id: 'rule-shop', name: 'Shopify', scope: 'SHOPIFY', isActive: true, sendDelayDays: 7, minDaysSinceDelivery: 2, maxDaysSinceDelivery: 25, anchor: 'SHIP', exclusions: ['has_refund'] } })
    })
  })

  it('eBay and Etsy are not offered, with the reason in words; nothing is made', async () => {
    const { NOT_OFFERED_WORDS } = await import('./review-timing-test-math.js')
    const before = await inside(() => database.client.reviewTimingTest.count())
    await expect(inside(() => svc.createTimingTest({ channel: 'EBAY', market: 'IT', days: [4, 7] }, person, { requester }))).rejects.toThrow(NOT_OFFERED_WORDS.EBAY)
    await expect(inside(() => svc.createTimingTest({ channel: 'etsy', days: [4, 7] }, person, { requester }))).rejects.toThrow(NOT_OFFERED_WORDS.ETSY)
    await expect(inside(() => svc.estimateTimingTest({ channel: 'EBAY', market: 'IT' }))).rejects.toThrow('eBay is not offered: Nexus asks no eBay buyer — eBay asks its buyers for feedback itself.')
    await expect(inside(() => svc.createTimingTest({ channel: 'WOOCOMMERCE', days: [4, 7] }, person, { requester }))).rejects.toThrow('Pick an Amazon market or Shopify to test.')
    expect(await inside(() => database.client.reviewTimingTest.count())).toBe(before)
  })

  it('the estimate reads the day in place now from the Shopify rule, and the store’s pace', async () => {
    const est = await inside(() => svc.estimateTimingTest({ channel: 'SHOPIFY', productType: 'glove', days: '4,7', holdout: '10' }, NOW))
    expect(est).toMatchObject({ currentDays: 7, currentWords: 'Day 7 now, from the rule “Shopify” (after shipping, as that rule counts)', ordersPerDay: 0 })
    expect(est.endsWords).toBe('At 300 orders per group, or after 8 weeks — no Shopify orders were delivered in the last 4 weeks, so it would end after 8 weeks')
  })

  it('"Start test — send for approval": waiting for approval, the whole store, the scheduler does not see it; a second one is held', async () => {
    const out = await inside(() => svc.createTimingTest({ channel: 'SHOPIFY', market: 'IT', productType: 'Glove', days: [4, 10, 7], holdoutPct: 10 }, person, { requester, now: NOW }))
    expect(asks.at(-1)).toMatchObject({ tool: 'start-review-timing-test', args: { testId: out.test.id } })
    expect(out.test).toMatchObject({
      channel: 'SHOPIFY', market: '*', productType: 'glove', title: 'Shopify · glove', status: 'WAITING_APPROVAL', statusWords: 'Waiting for approval',
      groupsWords: 'Day 7 vs 4 vs 10 · 10% holdout', approval: { what: 'start' },
    })
    expect(out.test.arms.map((a) => a.label)).toEqual(['Day 7 (now)', 'Day 4', 'Day 10', 'Not asked (holdout)'])
    expect(out.test.countedWords).toMatch(/A Shopify review comes from the store’s review app and names no order, so it is matched by its product: rates are estimates\.$/)
    expect(out.test.countedWords).not.toMatch(/Amazon/)
    expect(await inside(() => svc.runningTimingTests(NOW))).toEqual([])
    // The store is held by it: a second Shopify test on the same orders is refused; an Amazon market is not.
    await expect(inside(() => svc.createTimingTest({ channel: 'SHOPIFY', days: [4, 14] }, person, { requester, now: NOW })))
      .rejects.toThrow(/Shopify · glove is waiting for approval on the same orders/)

    // The approval says what happens to Shopify buyers.
    const preview = await inside(() => tool('start-review-timing-test').handler({ testId: out.test.id }, ctxFor('x', undefined)))
    expect((preview.preview as { effect: string }).effect).toMatch(/^From the next scheduler run, new Shopify orders of glove are split by order number: each group gets Nexus’s review e-mail on its day/)
    expect((preview.preview as { effect: string }).effect).toMatch(/10% of the orders \(the holdout\) get no review e-mail and no “How was it\?” check from Nexus\.$/)
    // Stopped before anyone approved: withdrawn, nothing changed.
    await inside(() => svc.stopTimingTest(out.test.id, 'Test person', NOW))
    expect(await inside(() => svc.runningTimingTests(NOW))).toEqual([])
  })
})

// A Shopify order: no market (Shopify orders carry none), a test order number of its own.
const shopOrder = async (id: string, delivered: Date) => database.client.order.create({ data: { id, channel: 'SHOPIFY', channelOrderId: `TEST-${id}`, status: 'DELIVERED', totalPrice: '30.00', customerName: 'Test', customerEmail: `${id}@example.test`, shippingAddress: {}, deliveredAt: delivered, items: { create: [{ sku: 'TEST-GLOVE', quantity: 1, price: '30.00', productId: 'prod-glove' }] } } as never })

describe('a Shopify test before any Shopify review is in Nexus (lane N6)', () => {
  it('no Shopify review in Nexus: "Not measurable" in the rate’s words for Shopify — never 0 %', async () => {
    await inside(async () => {
      const c = database.client
      await c.reviewTimingTest.create({
        data: {
          id: 'test-shop-nm', kind: 'TIMING', channel: 'SHOPIFY', market: '*', holdoutPct: 0, status: 'DONE', startedAt: daysAgo(90), endedAt: daysAgo(2),
          arms: { create: [{ id: 'nm-d7', label: 'Day 7 (now)', position: 0, delayDays: 7 }, { id: 'nm-d4', label: 'Day 4', position: 1, delayDays: 4 }] },
        },
      })
      for (const [i, arm] of ['nm-d7', 'nm-d4'].entries()) {
        await shopOrder(`ord-nm-${i}`, daysAgo(60))
        await c.reviewRequest.create({ data: { orderId: `ord-nm-${i}`, channel: 'SHOPIFY', status: 'SENT', timingTestArmId: arm, scheduledFor: daysAgo(55), sentAt: daysAgo(55) } as never })
      }
    })
    const view = (await inside(() => svc.listTimingTests({ kind: 'TIMING' }, NOW))).tests.find((t) => t.id === 'test-shop-nm')!
    expect(view.title).toBe('Shopify · every product')
    expect(view.arms.map((a) => [a.id, a.counted, a.rate])).toEqual([['nm-d7', 1, null], ['nm-d4', 1, null]])
    expect(view.result).toMatchObject({ leaderId: null, sure: null, rates: { 'nm-d7': null, 'nm-d4': null } })
    expect(view.result.words).toBe('Not measurable: no Shopify review is in Nexus yet — Shopify keeps none itself; connect the store’s review app to count them.')
  })
})

describe('a Shopify test’s result (lane N6): the ONE review rate and its attribution', () => {
  const testId = 'test-shop'
  beforeAll(async () => {
    await inside(async () => {
      const c = database.client
      await c.reviewTimingTest.create({
        data: {
          id: testId, kind: 'TIMING', channel: 'SHOPIFY', market: '*', productType: 'glove', holdoutPct: 10, status: 'DONE',
          startedAt: daysAgo(90), endedAt: daysAgo(2), endsWhen: { ordersPerArm: 100, maxDays: 84 },
          arms: { create: [
            { id: 'shop-d7', label: 'Day 7 (now)', position: 0, delayDays: 7 },
            { id: 'shop-d4', label: 'Day 4', position: 1, delayDays: 4 },
            { id: 'shop-hold', label: 'Not asked (holdout)', position: 2, holdout: true },
          ] },
        },
      })
      // 100 orders per asked group whose time to answer is over; reviews come from the review app (no market, no order),
      // linked by the attribution to the group's sent e-mail.
      const groups: Array<[string, number, number]> = [['shop-d7', 100, 5], ['shop-d4', 100, 15], ['shop-hold', 10, 0]]
      let n = 0
      for (const [arm, orders, reviews] of groups) {
        for (let i = 0; i < orders; i++) {
          n += 1
          const id = `ord-shop-${n}`
          const delivered = daysAgo(60)
          await shopOrder(id, delivered)
          const holdout = arm === 'shop-hold'
          await c.reviewRequest.create({ data: { id: `req-shop-${n}`, orderId: id, channel: 'SHOPIFY', status: holdout ? 'SKIPPED' : 'SENT', timingTestArmId: arm, scheduledFor: new Date(delivered.getTime() + 7 * DAY), sentAt: holdout ? null : new Date(delivered.getTime() + 7 * DAY), ...(holdout ? { suppressedReason: 'timing_test_holdout', providerResponseCode: 'TIMING_TEST_HOLDOUT' } : {}) } as never })
          if (!holdout && i < reviews) {
            await c.review.create({ data: { channel: 'SHOPIFY', externalReviewId: `jm-${n}`, body: 'Good', rating: 5, postedAt: new Date(delivered.getTime() + 10 * DAY), productId: 'prod-glove', attributedRequestId: `req-shop-${n}` } as never })
          }
        }
      }
      // A review-app review no request explains, for the same product inside a holdout order's window: it counts once.
      await c.review.create({ data: { channel: 'SHOPIFY', externalReviewId: 'jm-free', body: 'Fine', rating: 4, postedAt: daysAgo(60 - 12), productId: 'prod-glove' } as never })
      // An Amazon review of the same product never counts for a Shopify order.
      await c.review.create({ data: { channel: 'AMAZON', marketplace: 'IT', externalReviewId: 'rv-amz-for-shop', body: 'Fine', rating: 4, postedAt: daysAgo(60 - 12), productId: 'prod-glove' } as never })
    })
  }, 180_000)

  it('orders, sent, counted and reviews per group; the result “on Shopify” and how sure', async () => {
    const view = (await inside(() => svc.listTimingTests({ kind: 'TIMING' }, NOW))).tests.find((t) => t.id === testId)!
    const by = Object.fromEntries(view.arms.map((a) => [a.id, { orders: a.orders, sent: a.sent, counted: a.counted, reviews: a.reviews }]))
    expect(by).toEqual({
      'shop-d7': { orders: 100, sent: 100, counted: 100, reviews: 5 },
      'shop-d4': { orders: 100, sent: 100, counted: 100, reviews: 15 },
      'shop-hold': { orders: 10, sent: 0, counted: 10, reviews: 1 },
    })
    expect(view.result).toMatchObject({ tooEarly: false, leaderId: 'shop-d4', controlId: 'shop-d7', liftPct: 200 })
    expect(view.result.sure).toBeGreaterThanOrEqual(95)
    expect(view.result.words).toBe(`Day 4 gets 200% more reviews on Shopify — ${view.result.sure}% sure`)
    expect(view.held).toMatchObject({ apply: null, keep: null })
  })

  it('Apply winner asks for approval; the approved tool adds the Shopify rule (counting from shipping, as the rule did); its undo turns it off', async () => {
    const rulesBefore = await inside(() => database.client.reviewRule.findMany({ orderBy: { name: 'asc' } }))
    const out = await inside(() => svc.applyTimingWinner(testId, person, { requester, now: NOW }))
    expect(asks.at(-1)).toMatchObject({ tool: 'apply-review-timing-winner', args: { testId, armId: 'shop-d4' } })
    expect(out.test).toMatchObject({ approval: { what: 'apply' } })
    expect(await inside(() => database.client.reviewRule.findMany({ orderBy: { name: 'asc' } }))).toEqual(rulesBefore)

    const apply = tool('apply-review-timing-winner')
    const approvalId = asks.at(-1)!.id
    const preview = await inside(() => apply.handler({ testId, armId: 'shop-d4' }, ctxFor(approvalId, undefined)))
    expect(preview).toMatchObject({ ok: true, preview: { summary: 'Add the rule “Shopify glove”: first try on day 4 after shipping', rule: { mode: 'create', name: 'Shopify glove' }, to: { delayDays: 4 } } })
    expect((preview.preview as { note: string }).note).toMatch(/^Adds the rule “Shopify glove” \(Shopify, glove\) with the first try on day 4/)
    const ran = await inside(() => apply.execute!({ testId, armId: 'shop-d4' }, ctxFor(approvalId, preview.preview)))
    expect(ran.ok).toBe(true)
    const made = await inside(() => database.client.reviewRule.findFirst({ where: { name: 'Shopify glove' } }))
    expect(made).toMatchObject({ scope: 'SHOPIFY', marketplace: null, productTypes: ['glove'], sendDelayDays: 4, anchor: 'SHIP', minDaysSinceDelivery: 2, maxDaysSinceDelivery: 25, isActive: true, createdBy: 'timing-test' })
    const view = (await inside(() => svc.listTimingTests({ kind: 'TIMING' }, NOW))).tests.find((t) => t.id === testId)!
    expect(view.applied).toMatchObject({ ruleName: 'Shopify glove', delayDays: 4, countsFrom: 'shipping', created: true })
    const undo = apply.undo!.request(ran.change as never)
    expect(undo).toEqual({ tool: 'apply-review-timing-winner', args: { testId, armId: 'before' } })
    const back = await inside(() => apply.handler((undo as { args: Record<string, unknown> }).args, ctxFor('u', undefined)))
    const undone = await inside(() => apply.execute!((undo as { args: Record<string, unknown> }).args, ctxFor('u', back.preview)))
    expect(undone.ok).toBe(true)
    expect(await inside(() => database.client.reviewRule.findFirst({ where: { name: 'Shopify glove' } }))).toMatchObject({ isActive: false })
  })
})
