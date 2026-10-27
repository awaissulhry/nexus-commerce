/**
 * Reviews PR J — timing tests and A/B splits against real SQL (PGlite with the production schema and policies; the
 * approval door is a fake that stores a waiting approval as the real one does — nothing is approved by a test, nothing
 * is sent anywhere):
 *   - "Start test" makes the test and asks for approval: it waits, the scheduler does not see it, nothing changes before
 *     a person approves; only the approved tool's run starts it; a stale approval changes nothing;
 *   - a declined start goes back to "not started", with who declined it; a second test on the same orders is held;
 *   - "Stop test" ends it at once (no approval) and withdraws a request still waiting;
 *   - the counts per group (orders, sent, counted, reviews — the holdout's review found by product, market and window);
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
      'it-hold': { orders: 12, sent: 0, counted: 12, reviews: 1 },
    })
    expect(view.result).toMatchObject({ tooEarly: false, leaderId: 'it-d7', controlId: 'it-d4', liftPct: 200 })
    expect(view.result.sure).toBeGreaterThanOrEqual(95)
    expect(view.result.words).toBe(`Day 7 gets 200% more reviews in Italy — ${view.result.sure}% sure`)
    expect(view.held).toMatchObject({ apply: null, keep: null, start: 'This test has ended. Make a new one to test again.' })
    // The counters are kept on the groups.
    const arms = await inside(() => database.client.reviewTimingTestArm.findMany({ where: { testId }, orderBy: { position: 'asc' } }))
    expect(arms.map((a) => [a.orders, a.sent, a.reviews])).toEqual([[120, 120, 6], [123, 123, 18], [12, 0, 1]])
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
