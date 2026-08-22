/**
 * KT-P3 (2026-08-22) — the Keyword Tracker context, and the one fact the whole tab rests on.
 *
 * The defect this file guards is not "rankDelta was 0". It is that **`null` and `0` are the same
 * value to the engine's comparator**, so the obvious fix for a fabricated zero is a no-op that
 * compiles, reviews and diffs clean. `applyOperator` coerces with `Number()`, and `Number(null)`
 * is `0` while `Number(undefined)` is `NaN`. Only an ABSENT key refuses.
 *
 * These tests would have failed against the original code and would also have failed against the
 * `: null` "fix" — which is the point of writing them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../db.js', () => ({
  default: {
    keywordRank: { findMany: vi.fn() },
    adTarget: { findMany: vi.fn() },
    amazonAdsDailyPerformance: { groupBy: vi.fn(async () => []) },
  },
}))

import prisma from '../db.js'
import { buildKeywordRankBidContexts } from './advertising-rule-evaluator.job.js'
import { applyOperator } from '../services/automation-rule.service.js'

const db = vi.mocked(prisma, true)

const rank = (o: Partial<Record<string, unknown>> = {}) => ({
  id: 'r1', keyword: 'motorradjacke', marketplace: 'DE', asin: 'B01',
  organicRank: 40, sponsoredRank: 8, searchVolume: 1000,
  capturedAt: new Date('2026-08-20T00:00:00Z'), source: 'manual', createdAt: new Date('2026-08-20T00:00:00Z'),
  ...o,
})
const target = (o: Partial<Record<string, unknown>> = {}) => ({
  id: 't1', expressionValue: 'motorradjacke',
  adGroup: { id: 'ag1', campaign: { id: 'c1', marketplace: 'DE' } },
  ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  db.amazonAdsDailyPerformance.groupBy.mockResolvedValue([] as never)
})

const ctxOf = async () => (await buildKeywordRankBidContexts())[0] as { adTarget: Record<string, unknown> }

describe('applyOperator — why "not measurable" must OMIT the key', () => {
  // The table from the KT-P3 note, asserted rather than described.
  it.each([
    ['lte', 0],
    ['gte', 0],
    ['eq', 0],
    ['lt', 5],
  ] as const)('null behaves exactly like a real 0 for %s (so nulling a fabricated zero fixes nothing)', (op, rhs) => {
    expect(applyOperator(op, null, rhs)).toBe(applyOperator(op, 0, rhs))
    expect(applyOperator(op, 0, rhs)).toBe(true)
  })

  it.each(['lte', 'gte', 'eq', 'lt', 'gt'] as const)('an ABSENT value refuses %s', (op) => {
    expect(applyOperator(op, undefined, 0)).toBe(false)
    expect(applyOperator(op, undefined, 5)).toBe(false)
  })
})

describe('buildKeywordRankBidContexts', () => {
  it('emits nothing at all when no rank has ever been ingested — the live state on prod', async () => {
    db.keywordRank.findMany.mockResolvedValue([] as never)
    db.adTarget.findMany.mockResolvedValue([target()] as never)
    expect(await buildKeywordRankBidContexts()).toEqual([])
    // and it does not even ask for targets — the trigger is inert before it costs a query
    expect(db.adTarget.findMany).not.toHaveBeenCalled()
  })

  it('OMITS rankDelta when there is no prior observation, rather than reporting "no change"', async () => {
    db.keywordRank.findMany.mockResolvedValue([rank()] as never)
    db.adTarget.findMany.mockResolvedValue([target()] as never)
    const ctx = await ctxOf()

    expect('rankDelta' in ctx.adTarget).toBe(false)
    // the regression the original shipped: "Rank Change <= 0" matched a keyword seen exactly once
    expect(applyOperator('lte', ctx.adTarget.rankDelta, 0)).toBe(false)
    expect(applyOperator('eq', ctx.adTarget.rankDelta, 0)).toBe(false)
  })

  it('computes rankDelta from the SAME asin, never across two products', async () => {
    // B02 is newest overall; B01 holds the only true pair. Keyed on (keyword, marketplace) alone,
    // `prior` was B01's row and the delta became B02.rank − B01.rank: a cross-product difference.
    db.keywordRank.findMany.mockResolvedValue([
      rank({ id: 'a', asin: 'B02', organicRank: 3, capturedAt: new Date('2026-08-20T12:00:00Z') }),
      rank({ id: 'b', asin: 'B01', organicRank: 40, capturedAt: new Date('2026-08-20T11:00:00Z') }),
      rank({ id: 'c', asin: 'B01', organicRank: 55, capturedAt: new Date('2026-08-19T11:00:00Z') }),
    ] as never)
    db.adTarget.findMany.mockResolvedValue([target()] as never)
    const ctx = await ctxOf()

    // B02 is the newest observation, so it represents the pair — and it has no prior of its own.
    expect(ctx.adTarget.organicRank).toBe(3)
    expect('rankDelta' in ctx.adTarget).toBe(false) // NOT 3 − 40 = −37
  })

  it('keeps a real delta when one asin genuinely has two observations', async () => {
    db.keywordRank.findMany.mockResolvedValue([
      rank({ id: 'b', asin: 'B01', organicRank: 40, capturedAt: new Date('2026-08-20T11:00:00Z') }),
      rank({ id: 'c', asin: 'B01', organicRank: 55, capturedAt: new Date('2026-08-19T11:00:00Z') }),
    ] as never)
    db.adTarget.findMany.mockResolvedValue([target()] as never)
    const ctx = await ctxOf()
    expect(ctx.adTarget.rankDelta).toBe(15) // 55 → 40, improved by 15
  })

  it('omits a rank the source did not measure, instead of reporting position 0', async () => {
    db.keywordRank.findMany.mockResolvedValue([rank({ organicRank: null, sponsoredRank: null, searchVolume: null })] as never)
    db.adTarget.findMany.mockResolvedValue([target()] as never)
    const ctx = await ctxOf()

    for (const k of ['organicRank', 'sponsoredRank', 'searchVolume']) expect(k in ctx.adTarget).toBe(false)
    // "Organic Rank <= 3" must not match a keyword whose rank was never observed
    expect(applyOperator('lte', ctx.adTarget.organicRank, 3)).toBe(false)
  })

  it('omits an unmeasurable ACoS so a zero-sales target is not read as a 0%-ACoS winner', async () => {
    db.keywordRank.findMany.mockResolvedValue([rank()] as never)
    db.adTarget.findMany.mockResolvedValue([target()] as never)
    // spend, no sales → targetPerfMap yields acos: null
    db.amazonAdsDailyPerformance.groupBy.mockResolvedValue([
      { localEntityId: 't1', _sum: { costMicros: 5_000_000, sales7dCents: 0, orders7d: 0, clicks: 10, impressions: 500 } },
    ] as never)
    const ctx = await ctxOf()

    expect(ctx.adTarget.spendCents).toBe(500) // a real 0-sales measurement is still a measurement
    expect(ctx.adTarget.clicks).toBe(10)
    expect('acos' in ctx.adTarget).toBe(false)
    expect(applyOperator('lte', ctx.adTarget.acos, 0.2)).toBe(false)
  })

  it('skips a keyword with no rank snapshot rather than inventing one', async () => {
    db.keywordRank.findMany.mockResolvedValue([rank({ keyword: 'something else' })] as never)
    db.adTarget.findMany.mockResolvedValue([target()] as never)
    expect(await buildKeywordRankBidContexts()).toEqual([])
  })

  it('matches a keyword case- and whitespace-insensitively, within its own marketplace', async () => {
    db.keywordRank.findMany.mockResolvedValue([rank({ keyword: '  MotorradJacke ' })] as never)
    db.adTarget.findMany.mockResolvedValue([
      target({ id: 't1', expressionValue: 'motorradjacke' }),
      target({ id: 't2', expressionValue: 'motorradjacke', adGroup: { id: 'ag2', campaign: { id: 'c2', marketplace: 'IT' } } }),
    ] as never)
    const out = await buildKeywordRankBidContexts()
    expect(out.map((c) => (c as { adTarget: { id: string } }).adTarget.id)).toEqual(['t1'])
  })
})
