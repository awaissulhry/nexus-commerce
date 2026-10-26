/**
 * Reviews area PR C (B10) — one rule decides each order, and its "Skip when" boxes hold:
 *   - the most specific active rule that covers the order decides (a market rule over "all markets"; "Shipped by",
 *     product types and the minimum total say what a rule covers);
 *   - cancelled orders and buyers asked in the last 90 days (or twice in one run) are not asked when the deciding rule
 *     says so: they get a SUPPRESSED request with the reason, never another rule's or the default timing;
 *   - an order no rule covers keeps the default timing.
 * The database is a fake: nothing is read or written for real, nothing is sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  reviewRule: { findMany: vi.fn() },
  reviewTimingDefault: { findMany: vi.fn(async () => []) },
  reviewSendWindow: { findMany: vi.fn(async () => []) },
  order: { findMany: vi.fn() },
  reviewRequest: { findMany: vi.fn(async () => []), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `rq-${data.orderId}`, ...data })) },
  reviewSentimentCheck: { create: vi.fn() },
}))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { decideRuleForOrder, schedulePendingOrders, type MatchableOrder } from './review-scheduler.service.js'

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
})
