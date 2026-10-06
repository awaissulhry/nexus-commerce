/**
 * W2-C — the launch guards and the bid-strategy rules every builder launch creates (pure; no database, no Amazon).
 *   CC-29  a missing market is refused, never Italy.
 *   CC-5   a Nexus-only portfolio (`local-pf-…`) is refused before Amazon refuses the whole campaign.
 *   CC-4   Target ACoS → one `bid_to_target_acos` rule PER campaign, a FRACTION, `campaignId` (what the handler reads);
 *          Max Impressions / Max Orders / Custom → no rule, "not running yet".
 */
import { describe, expect, it } from 'vitest'
import { bidStrategyRules, launchMarketRefusal, localPortfolioRefusal } from './ads-launch-guards.js'

const campaigns = [{ id: 'c1', name: 'Group - SP - Auto' }, { id: 'c2', name: 'Group - SP - Exact' }]
const base = { campaigns, market: 'DE', enabled: true, createdBy: 'user:u1', source: 'SP Super Wizard' }

describe('CC-29 — the market is required', () => {
  it('refuses a missing or blank market with a reason, accepts a market', () => {
    for (const m of [undefined, null, '', '  ']) expect(launchMarketRefusal(m)).toMatch(/does not guess/)
    expect(launchMarketRefusal('DE')).toBeNull()
  })
})

describe('CC-5 — never a Nexus-only portfolio to Amazon', () => {
  it('refuses a local-pf- id, accepts a real one or none', () => {
    expect(localPortfolioRefusal('local-pf-123-spring')).toMatch(/exists only in Nexus/)
    expect(localPortfolioRefusal('123456789')).toBeNull()
    expect(localPortfolioRefusal(undefined)).toBeNull()
  })
})

describe('CC-4 — bid strategy → rules the engine runs', () => {
  it('🔴 Target ACoS 30 % → one rule per campaign, targetAcos 0.3, its campaignId, scoped to the launch market', () => {
    const { rules, note } = bidStrategyRules({ ...base, bidConfig: { strategy: 'targetAcos', targetAcos: '30', minBid: '0.2', maxBid: '1.5' } })
    expect(note).toBeNull()
    expect(rules).toHaveLength(2)
    expect(rules.map((r) => r.actions[0])).toEqual([
      { type: 'bid_to_target_acos', targetAcos: 0.3, minBidEur: 0.2, maxBidEur: 1.5, campaignId: 'c1' },
      { type: 'bid_to_target_acos', targetAcos: 0.3, minBidEur: 0.2, maxBidEur: 1.5, campaignId: 'c2' },
    ])
    expect(rules[0]).toMatchObject({ name: 'Group - SP - Auto — Target ACoS bidding', scopeMarketplace: 'DE', domain: 'advertising', trigger: 'SCHEDULE', dryRun: true, enabled: true, createdBy: 'user:u1' })
    // Never the shapes the handler refuses: a percent, or a campaign LIST.
    for (const r of rules) {
      expect(r.actions[0]).not.toHaveProperty('campaignIds')
      expect((r.actions[0] as { targetAcos: number }).targetAcos).toBeLessThanOrEqual(1)
    }
  })

  it('keeps decimals of the target and leaves out absent bounds', () => {
    const { rules } = bidStrategyRules({ ...base, campaigns: [campaigns[0]], bidConfig: { strategy: 'targetAcos', targetAcos: '25,5', minBid: '', maxBid: '0' } })
    expect(rules[0].actions[0]).toEqual({ type: 'bid_to_target_acos', targetAcos: 0.255, campaignId: 'c1' })
  })

  it('🔴 Max Impressions / Max Orders / Custom create no rule and say "not running yet" (they stored an unhandled set_bid_strategy)', () => {
    for (const strategy of ['maxImpressions', 'maxOrders', 'custom']) {
      const { rules, note } = bidStrategyRules({ ...base, bidConfig: { strategy, targetAcos: '30' } })
      expect(rules).toEqual([])
      expect(note).toMatch(/not running yet/)
    }
  })

  it('a blank or out-of-range target creates no rule and says why (it used to become 30 silently)', () => {
    for (const targetAcos of ['', '0', '150', 'abc']) {
      const { rules, note } = bidStrategyRules({ ...base, bidConfig: { strategy: 'targetAcos', targetAcos } })
      expect(rules).toEqual([])
      expect(note).toMatch(/No Target ACoS bid rule was created/)
    }
  })

  it('None, or a launch with no campaigns, creates nothing and says nothing', () => {
    expect(bidStrategyRules({ ...base, bidConfig: { strategy: 'none' } })).toEqual({ rules: [], note: null })
    expect(bidStrategyRules({ ...base, campaigns: [], bidConfig: { strategy: 'targetAcos', targetAcos: '30' } })).toEqual({ rules: [], note: null })
  })
})
