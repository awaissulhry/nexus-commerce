/**
 * Reviews area PR C (B10) — one rule decides each order, and its "Skip when" boxes hold:
 *   - the most specific active rule that covers the order decides (a market rule over "all markets"; "Shipped by",
 *     product types and the minimum total say what a rule covers);
 *   - cancelled orders and buyers asked in the last 90 days (or twice in one run) are not asked when the deciding rule
 *     says so: they get a SUPPRESSED request with the reason, never another rule's or the default timing;
 *   - an order no rule covers keeps the default timing;
 *   - an eBay order is never asked (Owner, 2026-10-27): eBay asks its buyers itself, so it gets a SKIPPED request with
 *     that reason, whatever rule covers it, and no "How was it?" check.
 *   - PR J: while a timing test runs, the scheduler AND a rule's "Queue these" put each covered order in its group; the
 *     holdout is never asked.
 * The database is a fake: nothing is read or written for real, nothing is sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  reviewRule: { findMany: vi.fn(), findUnique: vi.fn() },
  reviewTimingDefault: { findMany: vi.fn(async () => []) },
  reviewSendWindow: { findMany: vi.fn(async () => []) },
  order: { findMany: vi.fn() },
  reviewRequest: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `rq-${data.orderId}`, ...data })) },
  reviewSentimentCheck: { create: vi.fn() },
}))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
// PR J — the running timing tests the scheduler reads (none unless a test says so); which test covers an order stays real.
const running = vi.hoisted(() => ({ tests: [] as unknown[] }))
vi.mock('./review-timing-test.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runningTimingTests: vi.fn(async () => running.tests),
}))

import { createScheduledRequest, decideRuleForOrder, findOrdersMatchingRule, queueOrdersForRule, schedulePendingOrders, type MatchableOrder } from './review-scheduler.service.js'
import { assignArm } from './review-timing-test-math.js'

const DAY = 86_400_000
const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, scope: 'AMAZON_GLOBAL', marketplace: null, isActive: true, exclusions: [], productTypes: [], minOrderTotalCents: null,
  minDaysSinceDelivery: 4, maxDaysSinceDelivery: 25, sendDelayDays: null, anchor: 'DELIVERY', sendHourLocal: null, skipWeekends: false,
  shiftToBestDay: false, useSentimentDiversion: false, updatedAt: new Date('2026-10-01T00:00:00Z'), ...over,
})
const matchable = (over: Partial<MatchableOrder> = {}): MatchableOrder => ({
  channel: 'AMAZON', marketplace: 'IT', totalPrice: 80, fulfillmentMethod: 'FBM', hasActiveReturn: false, hasRefund: false, productType: 'jacket', ...over,
})

describe('decideRuleForOrder', () => {
  it('a market rule decides over "all markets"; its "Skip when" then decides whether the order is asked', () => {
    const rules = [rule('global'), rule('italy', { scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'IT', exclusions: ['is_cancelled', 'has_refund'] })]
    expect(decideRuleForOrder(rules, matchable())).toMatchObject({ rule: { id: 'italy' }, skip: null })
    expect(decideRuleForOrder(rules, matchable({ isCancelled: true })).skip).toBe('is_cancelled')
    expect(decideRuleForOrder(rules, matchable({ hasRefund: true })).skip).toBe('has_refund')
    // A skipped order no longer falls through to the global rule.
    expect(decideRuleForOrder(rules, matchable({ isCancelled: true })).rule.id).toBe('italy')
    expect(decideRuleForOrder(rules, matchable({ marketplace: 'DE', isCancelled: true }))).toMatchObject({ rule: { id: 'global' }, skip: null })
  })

  it('"Shipped by", product types and the minimum total say what a rule covers (another rule may then decide)', () => {
    const rules = [rule('fba', { exclusions: ['fba_only'] }), rule('fbm', { exclusions: ['fbm_only', 'asked_buyer_90d'], updatedAt: new Date('2026-09-01T00:00:00Z') })]
    expect(decideRuleForOrder(rules, matchable({ fulfillmentMethod: 'FBA' })).rule.id).toBe('fba')
    expect(decideRuleForOrder(rules, matchable({ fulfillmentMethod: 'FBM' })).rule.id).toBe('fbm')
    expect(decideRuleForOrder(rules, matchable({ fulfillmentMethod: 'FBM', askedBuyerRecently: true })).skip).toBe('asked_buyer_90d')
    expect(decideRuleForOrder([rule('big', { minOrderTotalCents: 10000 })], matchable()).rule).toBeNull()
    expect(decideRuleForOrder([rule('helmets', { productTypes: ['casco'] })], matchable()).rule).toBeNull()
    expect(decideRuleForOrder([rule('off', { isActive: false })], matchable()).rule).toBeNull()
  })
})

describe('schedulePendingOrders (B10)', () => {
  const now = Date.now()
  const order = (id: string, over: Record<string, unknown> = {}) => ({
    id, channel: 'AMAZON', channelOrderId: `405-${id}`, marketplace: 'IT', deliveredAt: new Date(now - 2 * DAY), shippedAt: null, purchaseDate: null,
    customerEmail: `${id}@example.com`, customerId: null, totalPrice: 80, fulfillmentMethod: 'FBM', status: 'DELIVERED', cancelledAt: null,
    items: [{ product: { productType: 'jacket' } }], returns: [], financialTransactions: [], ...over,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    db.reviewRequest.findMany.mockResolvedValue([])
    running.tests = []
  })

  it('a cancelled order is not asked when the deciding rule skips cancelled orders: SUPPRESSED with the reason', async () => {
    db.reviewRule.findMany.mockResolvedValue([rule('italy', { scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'IT', exclusions: ['is_cancelled'] })])
    db.order.findMany.mockResolvedValue([order('o1', { status: 'CANCELLED' }), order('o2', { cancelledAt: new Date(now - DAY) }), order('o3')])
    const result = await schedulePendingOrders()
    expect(result).toMatchObject({ examined: 3, scheduled: 1, skipped: 2, excluded: 2 })
    const created = db.reviewRequest.create.mock.calls.map(([arg]) => arg.data)
    expect(created).toEqual([
      expect.objectContaining({ orderId: 'o1', status: 'SUPPRESSED', suppressedReason: 'rule_exclusion:is_cancelled', ruleId: 'italy' }),
      expect.objectContaining({ orderId: 'o2', status: 'SUPPRESSED', suppressedReason: 'rule_exclusion:is_cancelled', ruleId: 'italy' }),
      expect.objectContaining({ orderId: 'o3', status: 'SCHEDULED', ruleId: 'italy' }),
    ])
    // No rule asks about buyers asked lately: their requests are not read.
    expect(db.reviewRequest.findMany).not.toHaveBeenCalled()
  })

  it('asked this buyer in 90 days: an earlier request, or a second order in the same run, is not asked', async () => {
    db.reviewRule.findMany.mockResolvedValue([rule('all', { exclusions: ['asked_buyer_90d'] })])
    db.order.findMany.mockResolvedValue([
      order('o1', { customerEmail: 'Repeat@Example.com' }),
      order('o2', { customerEmail: 'new@example.com' }),
      order('o3', { customerEmail: 'NEW@example.com' }),
      order('o4', { customerId: 'cust-9', customerEmail: 'other@example.com' }),
    ])
    db.reviewRequest.findMany.mockResolvedValue([
      { order: { customerId: null, customerEmail: 'repeat@example.com' } },
      { order: { customerId: 'cust-9', customerEmail: 'old@example.com' } },
    ])
    const result = await schedulePendingOrders()
    expect(result).toMatchObject({ scheduled: 1, excluded: 3 })
    const created = db.reviewRequest.create.mock.calls.map(([arg]) => [arg.data.orderId, arg.data.status, arg.data.suppressedReason ?? null])
    expect(created).toEqual([
      ['o1', 'SUPPRESSED', 'rule_exclusion:asked_buyer_90d'],
      ['o2', 'SCHEDULED', null],
      ['o3', 'SUPPRESSED', 'rule_exclusion:asked_buyer_90d'],
      ['o4', 'SUPPRESSED', 'rule_exclusion:asked_buyer_90d'],
    ])
    // One read for the batch: sent in the last 90 days, or queued now.
    expect(db.reviewRequest.findMany).toHaveBeenCalledTimes(1)
    const where = db.reviewRequest.findMany.mock.calls[0][0].where
    expect(where.OR).toEqual([
      { status: 'SENT', sentAt: { gte: expect.any(Date) } },
      { status: { in: ['SCHEDULED', 'ELIGIBLE'] } },
      { status: 'FAILED', nextRetryAt: { not: null } },
    ])
    expect(Math.round((now - where.OR[0].sentAt.gte.getTime()) / DAY)).toBe(90)
  })

  it('an order no active rule covers keeps the default timing (no rule on the request)', async () => {
    db.reviewRule.findMany.mockResolvedValue([rule('ebay', { scope: 'EBAY', exclusions: ['is_cancelled'] })])
    db.order.findMany.mockResolvedValue([order('o1', { status: 'CANCELLED' })])
    const result = await schedulePendingOrders()
    expect(result).toMatchObject({ scheduled: 1 })
    expect(db.reviewRequest.create.mock.calls[0][0].data).toMatchObject({ orderId: 'o1', status: 'SCHEDULED', ruleId: null })
  })

  it('an eBay order is recorded as not asked, with the reason, whatever rule covers it — never e-mailed, no check', async () => {
    db.reviewRule.findMany.mockResolvedValue([rule('ebay', { scope: 'EBAY', useSentimentDiversion: true })])
    db.order.findMany.mockResolvedValue([order('o1', { channel: 'EBAY', marketplace: 'DE' }), order('o2', { channel: 'SHOPIFY', marketplace: null })])
    const result = await schedulePendingOrders()
    expect(result).toMatchObject({ examined: 2, scheduled: 1, skipped: 1 })
    const created = db.reviewRequest.create.mock.calls.map(([arg]) => arg.data)
    expect(created[0]).toEqual({
      orderId: 'o1', channel: 'EBAY', marketplace: 'DE', status: 'SKIPPED', providerResponseCode: 'EBAY_ASKS',
      suppressedReason: 'Not sent — eBay asks the buyer for feedback itself', ruleId: null,
    })
    expect(created[1]).toMatchObject({ orderId: 'o2', channel: 'SHOPIFY', status: 'SCHEDULED' })
    expect(db.reviewSentimentCheck.create).not.toHaveBeenCalled()
  })

  it('every other way in (Orders, Claude, a rule\'s "Queue these") makes the same not-asked request for an eBay order', async () => {
    const made = await createScheduledRequest({ id: 'o9', channel: 'EBAY', marketplace: 'IT', customerEmail: 'b@example.com' }, { id: 'r1', useSentimentDiversion: true }, new Date(now))
    expect(made).toEqual({ id: 'rq-o9', diversion: false })
    expect(db.reviewRequest.create.mock.calls[0][0].data).toMatchObject({ status: 'SKIPPED', providerResponseCode: 'EBAY_ASKS', ruleId: 'r1' })
    expect(db.reviewSentimentCheck.create).not.toHaveBeenCalled()
    // An eBay rule's Test run lists no order to ask.
    expect(await findOrdersMatchingRule(rule('ebay', { scope: 'EBAY' }))).toEqual([])
    expect(db.order.findMany).not.toHaveBeenCalled()
  })
})

describe('schedulePendingOrders — a running timing test (PR J)', () => {
  const now = Date.now()
  const order = (id: string, over: Record<string, unknown> = {}) => ({
    id, channel: 'AMAZON', channelOrderId: `305-${id}`, marketplace: 'DE', deliveredAt: new Date(now - 2 * DAY), shippedAt: null, purchaseDate: null,
    customerEmail: `${id}@example.com`, customerId: null, totalPrice: 80, fulfillmentMethod: 'FBM', status: 'DELIVERED', cancelledAt: null,
    items: [{ product: { productType: 'Gloves touring' } }], returns: [], financialTransactions: [], ...over,
  })
  const timing = {
    id: 'tt-1', kind: 'TIMING', channel: 'AMAZON', market: 'DE', productType: 'glove', ruleId: null, holdoutPct: 20, startedAt: new Date(now - 5 * DAY),
    arms: [
      { id: 'd4', position: 0, holdout: false, delayDays: 4, ruleId: null },
      { id: 'd10', position: 1, holdout: false, delayDays: 10, ruleId: null },
      { id: 'hold', position: 2, holdout: true, delayDays: null, ruleId: null },
    ],
  }
  const orders = Array.from({ length: 40 }, (_, i) => order(`o${i}`))
  const created = () => db.reviewRequest.create.mock.calls.map(([arg]) => arg.data)

  beforeEach(() => {
    vi.clearAllMocks()
    db.reviewRequest.findMany.mockResolvedValue([])
    db.reviewRule.findMany.mockResolvedValue([rule('germany', { scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE', sendDelayDays: 12, minDaysSinceDelivery: 7, maxDaysSinceDelivery: 25 })])
    db.order.findMany.mockResolvedValue(orders)
    running.tests = [timing]
  })

  it('each order goes to the group its order number picks; the holdout gets NO request (SKIPPED, with the reason)', async () => {
    const result = await schedulePendingOrders()
    const rows = created()
    expect(rows).toHaveLength(orders.length)
    for (const o of orders) {
      const arm = assignArm(timing as never, o.channelOrderId)!
      const row = rows.find((r) => r.orderId === o.id)!
      expect(row.timingTestArmId).toBe(arm.id)
      if (arm.holdout) {
        expect(row).toMatchObject({ status: 'SKIPPED', suppressedReason: 'timing_test_holdout', providerResponseCode: 'TIMING_TEST_HOLDOUT', ruleId: 'germany' })
      } else {
        expect(row).toMatchObject({ status: 'SCHEDULED', ruleId: 'germany' })
        // The group's own first-try day after delivery, not the rule's 12.
        const days = Math.round((row.scheduledFor.getTime() - o.deliveredAt.getTime()) / DAY)
        expect(days).toBe(arm.delayDays)
      }
    }
    const held = rows.filter((r) => r.status === 'SKIPPED').length
    expect(held).toBeGreaterThan(0)
    expect(result).toMatchObject({ inTests: orders.length, heldOut: held, scheduled: orders.length - held })
    // A holdout order gets no "How was it?" e-mail either.
    expect(db.reviewSentimentCheck.create).not.toHaveBeenCalled()
  })

  it('the same orders land in the same groups on the next run', async () => {
    await schedulePendingOrders()
    const first = created().map((r) => [r.orderId, r.timingTestArmId])
    vi.clearAllMocks()
    await schedulePendingOrders()
    expect(created().map((r) => [r.orderId, r.timingTestArmId])).toEqual(first)
  })

  it('"Skip when" decides first, and orders the test does not cover are asked as before', async () => {
    db.reviewRule.findMany.mockResolvedValue([rule('germany', { scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE', exclusions: ['is_cancelled'], sendDelayDays: 12 })])
    db.order.findMany.mockResolvedValue([
      order('c1', { status: 'CANCELLED' }),
      order('it1', { marketplace: 'IT' }),
      order('jk1', { items: [{ product: { productType: 'Jacket' } }] }),
    ])
    await schedulePendingOrders()
    const rows = created()
    expect(rows.find((r) => r.orderId === 'c1')).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'rule_exclusion:is_cancelled' })
    expect(rows.find((r) => r.orderId === 'c1').timingTestArmId).toBeUndefined()
    expect(rows.find((r) => r.orderId === 'it1').timingTestArmId).toBeUndefined()
    expect(rows.find((r) => r.orderId === 'jk1').timingTestArmId).toBeUndefined()
  })

  it('an A/B split: the orders rule A decides go to A or to B (B is off, and asks with its own timing)', async () => {
    const a = rule('A', { scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE', sendDelayDays: 4 })
    const b = rule('B', { scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE', name: 'A (variant 1)', isActive: false, sendDelayDays: 9 })
    db.reviewRule.findMany.mockImplementation(async ({ where }: { where: { isActive?: boolean; id?: { in: string[] } } }) => (where.isActive ? [a] : where.id ? [b] : []))
    running.tests = [{ id: 'ab-1', kind: 'AB', channel: 'AMAZON', market: 'DE', productType: null, ruleId: 'A', holdoutPct: 0, startedAt: new Date(), arms: [
      { id: 'side-a', position: 0, holdout: false, delayDays: null, ruleId: 'A' },
      { id: 'side-b', position: 1, holdout: false, delayDays: null, ruleId: 'B' },
    ] }]
    await schedulePendingOrders()
    const rows = created()
    const sides = new Set(rows.map((r) => r.timingTestArmId))
    expect(sides).toEqual(new Set(['side-a', 'side-b']))
    for (const r of rows) {
      const o = orders.find((x) => x.id === r.orderId)!
      const days = Math.round((r.scheduledFor.getTime() - o.deliveredAt.getTime()) / DAY)
      expect(r.status).toBe('SCHEDULED')
      expect([r.timingTestArmId, r.ruleId, days]).toEqual(r.timingTestArmId === 'side-a' ? ['side-a', 'A', 4] : ['side-b', 'B', 9])
    }
  })

  it('no test running: nothing is put in a group', async () => {
    running.tests = []
    const result = await schedulePendingOrders()
    expect(created().every((r) => r.timingTestArmId === undefined && r.status === 'SCHEDULED')).toBe(true)
    expect(result.inTests).toBeUndefined()
  })
})

describe('"Queue these" while a timing test runs (PR J)', () => {
  const now = Date.now()
  const germany = rule('germany', { scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE', sendDelayDays: 12, minDaysSinceDelivery: 1, maxDaysSinceDelivery: 25 })
  const order = (id: string) => ({
    id, channel: 'AMAZON', channelOrderId: `306-${id}`, marketplace: 'DE', deliveredAt: new Date(now - 2 * DAY), shippedAt: null, purchaseDate: null,
    customerEmail: `${id}@example.com`, customerId: null, totalPrice: 80, fulfillmentMethod: 'FBM', status: 'DELIVERED', cancelledAt: null,
    items: [{ product: { productType: 'Gloves touring' } }], returns: [], financialTransactions: [],
  })
  const timing = {
    id: 'tt-q', kind: 'TIMING', channel: 'AMAZON', market: 'DE', productType: 'glove', ruleId: null, holdoutPct: 20, startedAt: new Date(now - 5 * DAY),
    arms: [
      { id: 'q4', position: 0, holdout: false, delayDays: 4, ruleId: null },
      { id: 'q10', position: 1, holdout: false, delayDays: 10, ruleId: null },
      { id: 'q-hold', position: 2, holdout: true, delayDays: null, ruleId: null },
    ],
  }
  const orders = Array.from({ length: 30 }, (_, i) => order(`q${i}`))

  beforeEach(() => {
    vi.clearAllMocks()
    db.reviewRule.findUnique.mockResolvedValue(germany)
    db.reviewRule.findMany.mockResolvedValue([germany])
    db.order.findMany.mockResolvedValue(orders)
    running.tests = [timing]
  })

  it('each order goes to the group the scheduler would pick; a holdout order is recorded as not asked, never queued', async () => {
    const out = await queueOrdersForRule('germany')
    const rows = db.reviewRequest.create.mock.calls.map(([arg]) => arg.data)
    expect(rows).toHaveLength(orders.length)
    let held = 0
    for (const o of orders) {
      const arm = assignArm(timing as never, o.channelOrderId)!
      const row = rows.find((r) => r.orderId === o.id)!
      expect(row.timingTestArmId).toBe(arm.id)
      if (arm.holdout) {
        held += 1
        expect(row).toMatchObject({ status: 'SKIPPED', suppressedReason: 'timing_test_holdout', providerResponseCode: 'TIMING_TEST_HOLDOUT', ruleId: 'germany' })
      } else {
        expect(row).toMatchObject({ status: 'SCHEDULED', ruleId: 'germany' })
        expect(Math.round((row.scheduledFor.getTime() - o.deliveredAt.getTime()) / DAY)).toBe(arm.delayDays)
      }
    }
    expect(held).toBeGreaterThan(0)
    expect(out).toEqual({ enqueued: orders.length - held, skipped: 0, decidedElsewhere: 0, heldOut: held, totalMatches: orders.length })
    expect(db.reviewSentimentCheck.create).not.toHaveBeenCalled()
  })

  it('no test running: queued on the rule’s own day, in no group', async () => {
    running.tests = []
    const out = await queueOrdersForRule('germany')
    const rows = db.reviewRequest.create.mock.calls.map(([arg]) => arg.data)
    expect(out).toMatchObject({ enqueued: orders.length, heldOut: 0 })
    expect(rows.every((r) => r.status === 'SCHEDULED' && r.timingTestArmId === undefined)).toBe(true)
  })
})

describe('a Shopify timing test (lane N6) — the scheduler and "Queue these"', () => {
  const now = Date.now()
  // The send hours the Timing table sets for every market: 10:00 on every day of the week (#801's rules stay).
  const tenOClock = Array.from({ length: 7 }, (_, dayOfWeek) => ({ marketplace: '*', dayOfWeek, hourLocal: 10, dayRank: 1, isActive: true }))
  const shopifyRule = rule('shop', { scope: 'SHOPIFY', sendDelayDays: 12, minDaysSinceDelivery: 2, maxDaysSinceDelivery: 25, useSentimentDiversion: true, exclusions: ['has_refund'] })
  const order = (id: string, over: Record<string, unknown> = {}) => ({
    id, channel: 'SHOPIFY', channelOrderId: `5${id.replace(/\D/g, '').padStart(9, '0')}`, marketplace: null, deliveredAt: new Date(now - 2 * DAY), shippedAt: null, purchaseDate: null,
    customerEmail: `${id}@example.com`, customerId: null, totalPrice: 80, fulfillmentMethod: null, status: 'DELIVERED', cancelledAt: null,
    items: [{ product: { productType: 'Gloves touring' } }], returns: [], financialTransactions: [], ...over,
  })
  // A Shopify test covers the whole store: market "*".
  const timing = {
    id: 'tt-shop', kind: 'TIMING', channel: 'SHOPIFY', market: '*', productType: 'glove', ruleId: null, holdoutPct: 20, startedAt: new Date(now - 5 * DAY),
    arms: [
      { id: 's12', position: 0, holdout: false, delayDays: 12, ruleId: null },
      { id: 's4', position: 1, holdout: false, delayDays: 4, ruleId: null },
      { id: 's-hold', position: 2, holdout: true, delayDays: null, ruleId: null },
    ],
  }
  const orders = Array.from({ length: 40 }, (_, i) => order(`s${i}`))
  const created = () => db.reviewRequest.create.mock.calls.map(([arg]) => arg.data)
  const romeHour = (d: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(d))

  beforeEach(() => {
    vi.clearAllMocks()
    db.reviewRequest.findMany.mockResolvedValue([])
    db.reviewRule.findMany.mockResolvedValue([shopifyRule])
    db.reviewRule.findUnique.mockResolvedValue(shopifyRule)
    db.reviewSendWindow.findMany.mockResolvedValue(tenOClock as never)
    db.order.findMany.mockResolvedValue(orders)
    running.tests = [timing]
  })

  it('each Shopify order goes to its group by order number; the holdout gets no e-mail and no "How was it?" check', async () => {
    const result = await schedulePendingOrders()
    const rows = created()
    expect(rows).toHaveLength(orders.length)
    let held = 0
    for (const o of orders) {
      const arm = assignArm(timing as never, o.channelOrderId)!
      const row = rows.find((r) => r.orderId === o.id)!
      expect(row.timingTestArmId).toBe(arm.id)
      if (arm.holdout) {
        held += 1
        expect(row).toMatchObject({ channel: 'SHOPIFY', marketplace: null, status: 'SKIPPED', suppressedReason: 'timing_test_holdout', providerResponseCode: 'TIMING_TEST_HOLDOUT', ruleId: 'shop' })
      } else {
        expect(row).toMatchObject({ channel: 'SHOPIFY', status: 'SCHEDULED', ruleId: 'shop' })
        // The group's own day after delivery (not the rule's 12 for group "4"), at the Timing table's send hour.
        const days = (row.scheduledFor.getTime() - o.deliveredAt.getTime()) / DAY
        expect(Math.abs(days - arm.delayDays!)).toBeLessThan(1)
        expect(romeHour(row.scheduledFor)).toBe(10)
      }
    }
    expect(held).toBeGreaterThan(0)
    expect(new Set(rows.map((r) => r.timingTestArmId))).toEqual(new Set(['s12', 's4', 's-hold']))
    expect(result).toMatchObject({ inTests: orders.length, heldOut: held, scheduled: orders.length - held })
    // The rule asks "How was it?" first: every asked order gets its check, no holdout order does.
    const checks = db.reviewSentimentCheck.create.mock.calls.map(([arg]) => arg.data.orderId)
    expect(checks).toHaveLength(orders.length - held)
    for (const id of checks) expect(rows.find((r) => r.orderId === id)!.status).toBe('SCHEDULED')
  })

  it('"Skip when" decides first; Amazon and eBay orders of the same run are not in the Shopify test', async () => {
    db.order.findMany.mockResolvedValue([
      order('refunded1', { financialTransactions: [{ id: 'f1' }] }),
      order('jacket1', { items: [{ product: { productType: 'Jacket' } }] }),
      { ...order('amazon1'), channel: 'AMAZON', channelOrderId: '305-0000001', marketplace: 'DE' },
      { ...order('ebay1'), channel: 'EBAY', channelOrderId: '11-00001-00001', marketplace: 'IT' },
    ])
    await schedulePendingOrders()
    const rows = created()
    expect(rows.find((r) => r.orderId === 'refunded1')).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'rule_exclusion:has_refund' })
    for (const id of ['refunded1', 'jacket1', 'amazon1', 'ebay1']) expect(rows.find((r) => r.orderId === id).timingTestArmId).toBeUndefined()
    expect(rows.find((r) => r.orderId === 'ebay1')).toMatchObject({ status: 'SKIPPED', providerResponseCode: 'EBAY_ASKS' })
  })

  it('"Queue these" of the Shopify rule puts each order in the group the scheduler would pick; the holdout is never queued', async () => {
    const out = await queueOrdersForRule('shop')
    const rows = created()
    expect(rows).toHaveLength(orders.length)
    let held = 0
    for (const o of orders) {
      const arm = assignArm(timing as never, o.channelOrderId)!
      const row = rows.find((r) => r.orderId === o.id)!
      expect(row.timingTestArmId).toBe(arm.id)
      if (arm.holdout) {
        held += 1
        expect(row).toMatchObject({ status: 'SKIPPED', providerResponseCode: 'TIMING_TEST_HOLDOUT', ruleId: 'shop' })
      } else {
        expect(row).toMatchObject({ status: 'SCHEDULED', ruleId: 'shop' })
      }
    }
    expect(out).toEqual({ enqueued: orders.length - held, skipped: 0, decidedElsewhere: 0, heldOut: held, totalMatches: orders.length })
    expect(db.reviewSentimentCheck.create).toHaveBeenCalledTimes(orders.length - held)
  })
})
