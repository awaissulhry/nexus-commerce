/**
 * 2b (review N2) — one out-of-budget check that matches what Amazon sends.
 *
 * Rank-defend, the `pace_budget` rule and autopilot each matched `OUT_OF_BUDGET`; the sync stores Amazon's v1
 * `deliveryReasons` as sent, and Amazon sends `CAMPAIGN_OUT_OF_BUDGET` (9 of 70 enabled campaigns on 2026-08-21) or
 * `PORTFOLIO_OUT_OF_BUDGET`. So none of the three ever saw a campaign out of budget. The helper is pinned here, and the
 * two budget readers are pinned on the real code: a campaign Amazon reports out of budget now reads as one.
 * Rank-defend's side is in jobs/ad-rank-defend-budget.vitest.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  campaign: { findMany: vi.fn() },
  adTarget: { findMany: vi.fn(async () => []) },
  amazonAdsDailyPerformance: { groupBy: vi.fn(async () => []) },
}))
vi.mock('../../db.js', () => ({ default: db }))

import { isOutOfBudget, isCampaignOutOfBudget, outOfBudgetWords } from './delivery-reasons.js'

describe('isOutOfBudget — a budget stopped the campaign', () => {
  it("matches Amazon's real codes: the campaign's own budget and its portfolio's", () => {
    expect(isOutOfBudget(['CAMPAIGN_OUT_OF_BUDGET'])).toBe(true)
    expect(isOutOfBudget(['PORTFOLIO_OUT_OF_BUDGET'])).toBe(true)
  })
  it('still matches the bare OUT_OF_BUDGET the old check looked for', () => {
    expect(isOutOfBudget(['OUT_OF_BUDGET'])).toBe(true)
  })
  it('finds the code among other reasons', () => {
    expect(isOutOfBudget(['CAMPAIGN_STATUS_ENABLED', 'CAMPAIGN_OUT_OF_BUDGET'])).toBe(true)
  })
  it('is false for every other reason, an empty list and no list', () => {
    expect(isOutOfBudget(['CAMPAIGN_PAUSED'])).toBe(false)
    expect(isOutOfBudget(['CAMPAIGN_INCOMPLETE', 'ADVERTISER_PAYMENT_FAILURE'])).toBe(false)
    expect(isOutOfBudget([])).toBe(false)
    expect(isOutOfBudget(null)).toBe(false)
    expect(isOutOfBudget(undefined)).toBe(false)
  })
  it('does not match a code that only contains the words', () => {
    expect(isOutOfBudget(['OUT_OF_BUDGET_SOON'])).toBe(false)
  })
})

describe("isCampaignOutOfBudget — the campaign's own budget ran out (a raise of it can help)", () => {
  it('is true for the campaign code and the bare old spelling', () => {
    expect(isCampaignOutOfBudget(['CAMPAIGN_OUT_OF_BUDGET'])).toBe(true)
    expect(isCampaignOutOfBudget(['OUT_OF_BUDGET'])).toBe(true)
  })
  it('is false for a portfolio that ran out — the campaign stays capped by the portfolio', () => {
    expect(isCampaignOutOfBudget(['PORTFOLIO_OUT_OF_BUDGET'])).toBe(false)
    expect(isCampaignOutOfBudget(['CAMPAIGN_PAUSED'])).toBe(false)
    expect(isCampaignOutOfBudget(null)).toBe(false)
  })
})

describe('outOfBudgetWords — which budget, in plain words', () => {
  it('names the campaign, then the portfolio, then any other budget by its code', () => {
    expect(outOfBudgetWords(['CAMPAIGN_OUT_OF_BUDGET'])).toBe('Amazon says this campaign is out of budget')
    expect(outOfBudgetWords(['PORTFOLIO_OUT_OF_BUDGET', 'CAMPAIGN_OUT_OF_BUDGET'])).toBe('Amazon says this campaign is out of budget')
    expect(outOfBudgetWords(['PORTFOLIO_OUT_OF_BUDGET'])).toBe('Amazon says this campaign’s portfolio is out of budget')
    expect(outOfBudgetWords(['ACCOUNT_OUT_OF_BUDGET'])).toBe('Amazon says a budget ran out (ACCOUNT_OUT_OF_BUDGET)')
  })
  it('is null when no budget stopped the campaign', () => {
    expect(outOfBudgetWords(['CAMPAIGN_PAUSED'])).toBeNull()
    expect(outOfBudgetWords(undefined)).toBeNull()
  })
})

const { previewPacing } = await import('./ads-budget-pacing.service.js')
const { gatherSignals } = await import('../../jobs/ad-autopilot.job.js')

/** An enabled campaign as the readers select it: €10/day, €20 spent, €100 sold (ROAS 5). */
const camp = (id: string, deliveryReasons: string[]) => ({
  id, name: id, marketplace: 'IT', dailyBudget: '10.00', spend: '20.00', sales: '100.00', roas: null,
  trueProfitMarginPct: null, impressions: 0, deliveryReasons,
})

describe('the pace_budget rule input reads the real code', () => {
  beforeEach(() => db.campaign.findMany.mockReset())
  it("proposes a raise for a winner Amazon reports out of its own budget; not for a portfolio cap or a serving one", async () => {
    db.campaign.findMany.mockResolvedValue([
      camp('own', ['CAMPAIGN_OUT_OF_BUDGET']),
      camp('portfolio', ['PORTFOLIO_OUT_OF_BUDGET']),
      camp('serving', []),
    ])
    const { proposals } = await previewPacing({ targetRoas: 3 })
    expect(proposals.map((p) => [p.campaignId, p.outOfBudget, p.proposedBudgetCents])).toEqual([['own', true, 1250]])
  })
})

describe('autopilot reads the real code', () => {
  beforeEach(() => db.campaign.findMany.mockReset())
  it("marks a campaign out of its own budget, and not one capped by its portfolio or serving", async () => {
    db.campaign.findMany.mockResolvedValue([
      camp('own', ['CAMPAIGN_OUT_OF_BUDGET']),
      camp('portfolio', ['PORTFOLIO_OUT_OF_BUDGET']),
      camp('serving', ['CAMPAIGN_STATUS_ENABLED']),
    ])
    const signals = await gatherSignals(['own', 'portfolio', 'serving'])
    expect(signals.map((s) => [s.campaignId, s.deliveryOutOfBudget])).toEqual([['own', true], ['portfolio', false], ['serving', false]])
  })
})
