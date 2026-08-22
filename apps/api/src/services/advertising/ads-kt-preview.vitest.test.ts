/**
 * KT-P2 — the Keyword Tracker preview, on a feed that HAS data.
 *
 * The live answer today is "0 matched, feed empty", which is verifiable against prod but exercises
 * none of the rendering the surface will do the day a feed lands. These pin the parts that only
 * matter then, and that a prod probe therefore cannot reach:
 *
 *   · the criteria actually gate (the old browser preview applied none);
 *   · only KEYWORD targets are candidates (90 of 100 rows used to be ineligible kinds);
 *   · suppressed targets are COUNTED IN TWO — flag and ≤3¢ — never merged;
 *   · an unobserved rank travels as null, never 0.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    keywordRank: { count: vi.fn(), aggregate: vi.fn() },
    adTarget: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    campaign: { findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
}))
const ctxs: unknown[] = []
vi.mock('../../jobs/advertising-rule-evaluator.job.js', () => ({
  buildKeywordRankBidContexts: vi.fn(async () => ctxs),
  buildCampaignBudgetContexts: vi.fn(async () => []),
}))

import prisma from '../../db.js'
import { previewKeywordTrackerRule } from './ads-rule-preview.service.js'

const db = vi.mocked(prisma, true)

const ctx = (id: string, organicRank: number | undefined, extra: Record<string, unknown> = {}) => ({
  trigger: 'KEYWORD_RANK_BID',
  marketplace: 'IT',
  campaign: { id: 'c1', name: 'GALE IT' },
  adGroup: { id: 'ag1' },
  adTarget: { id, ...(organicRank !== undefined ? { organicRank } : {}), spendCents: 500, ...extra },
})

const draft = {
  actions: [{ type: 'keyword-tracker', campaigns: [{ id: 'c1' }], bidFloor: 0.05, bidCeiling: null }],
  conditions: [{ conditions: [{ metric: 'Organic Rank', op: 'gt', value: '50' }], action: { op: 'set', value: '0.80' } }],
  scopeMarketplace: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  ctxs.length = 0
  db.keywordRank.count.mockResolvedValue(12 as never)
  db.keywordRank.aggregate.mockResolvedValue({ _max: { capturedAt: new Date('2026-08-21T00:00:00Z') } } as never)
  db.adTarget.count.mockResolvedValue(2130 as never)
  db.$queryRawUnsafe.mockImplementation(async (q: string) =>
    (q.includes('DISTINCT lower') ? [{ keywords: 9, markets: 2 }] : [{ n: 40 }]) as never)
  db.campaign.findMany.mockResolvedValue([] as never)
})

/** bid_apply reads the target's own bid; give each id a bid + suppression state. */
const targetsAre = (rows: Array<{ id: string; bidCents: number; suppressedFromBidCents?: number | null; text?: string }>) => {
  db.adTarget.findUnique.mockImplementation(async ({ where }: never) => {
    const r = rows.find((x) => x.id === (where as { id: string }).id)
    return r ? { bidCents: r.bidCents, adGroup: { campaignId: 'c1' } } : null
  })
  db.adTarget.findMany.mockResolvedValue(rows.map((r) => ({
    id: r.id, expressionValue: r.text ?? r.id, suppressedFromBidCents: r.suppressedFromBidCents ?? null,
  })) as never)
}

describe('previewKeywordTrackerRule', () => {
  it('applies the criteria — a keyword ranking better than the bar does not match', async () => {
    ctxs.push(ctx('t1', 80), ctx('t2', 12))
    targetsAre([{ id: 't1', bidCents: 40 }, { id: 't2', bidCents: 40 }])
    const out = await previewKeywordTrackerRule(draft)
    expect(out.measurable).toBe(2)
    expect(out.matched).toBe(1)
    expect(out.rows.map((r) => r.targetId)).toEqual(['t1'])
    expect(out.rows[0].currentEur).toBe(0.4)
    expect(out.rows[0].proposedEur).toBe(0.8)
  })

  it('a keyword with NO rank observation never matches — it is not treated as ranking last', async () => {
    ctxs.push(ctx('t1', undefined))
    targetsAre([{ id: 't1', bidCents: 40 }])
    const out = await previewKeywordTrackerRule(draft)
    expect(out.measurable).toBe(1)
    expect(out.matched).toBe(0)
    expect(out.rows).toEqual([])
  })

  it('counts suppressed targets in TWO, never merged, and still shows them', async () => {
    ctxs.push(ctx('flagged', 80), ctx('lowbid', 80), ctx('normal', 80))
    targetsAre([
      { id: 'flagged', bidCents: 40, suppressedFromBidCents: 55 },
      { id: 'lowbid', bidCents: 2 },
      { id: 'normal', bidCents: 40 },
    ])
    const out = await previewKeywordTrackerRule(draft)
    expect(out.matched).toBe(3)
    expect(out.suppressedMatched).toBe(2)
    // 🔴 the flag is evidence, ≤3¢ is a convention — merging hides the ones the flag misses
    expect(out.suppressedUnflaggedMatched).toBe(1)
    const by = Object.fromEntries(out.rows.map((r) => [r.targetId, r.suppressed]))
    expect(by).toEqual({ flagged: 'flag', lowbid: 'bid', normal: null })
    // and they are still LISTED — the preview reports what the engine would really do
    expect(out.rows).toHaveLength(3)
  })

  it('an unobserved rank travels as null, never 0', async () => {
    ctxs.push(ctx('t1', 80))
    targetsAre([{ id: 't1', bidCents: 40 }])
    const out = await previewKeywordTrackerRule(draft)
    expect(out.rows[0].organicRank).toBe(80)
    expect(out.rows[0].sponsoredRank).toBeNull()
    expect(out.rows[0].rankDelta).toBeNull()
  })

  it('reports the feed so "nothing matched" and "nothing measured" can be told apart', async () => {
    ctxs.push(ctx('t1', 12))
    targetsAre([{ id: 't1', bidCents: 40 }])
    const out = await previewKeywordTrackerRule(draft)
    expect(out.matched).toBe(0)
    expect(out.feed).toMatchObject({ rows: 12, keywords: 9, markets: 2, coveredTargets: 40, totalTargets: 2130 })
  })

  it('an empty feed is reported as such, with no rows', async () => {
    db.keywordRank.count.mockResolvedValue(0 as never)
    const out = await previewKeywordTrackerRule(draft)
    expect(out.feed).toMatchObject({ rows: 0, keywords: 0, coveredTargets: 0, totalTargets: 2130 })
    expect(out.matched).toBe(0)
    expect(out.rows).toEqual([])
  })

  it('refuses a draft whose metric has no engine signal, rather than previewing the rest', async () => {
    const bad = { ...draft, conditions: [{ conditions: [{ metric: 'Share of Voice', op: 'lt', value: '5' }], action: { op: 'set', value: '0.80' } }] }
    const out = await previewKeywordTrackerRule(bad)
    expect(out.ok).toBe(false)
    expect(out.untranslatable).toContain('Share of Voice')
  })
})
