/**
 * R9 (MCP full control, part 06 gap 4) — the rule guard: what a rule Claude saves must be. Pure.
 *
 * Each of the four silent failures on record (memory reference_four_inert_ads_rules) and every pause is refused, in
 * words, naming what to do instead.
 */
import { describe, expect, it } from 'vitest'
import { guardRule, type RuleDraft } from './automation-rule-guard.js'
import { ADS_TRIGGER_FIELDS } from './ads-trigger-fields.js'

const good: RuleDraft = {
  kind: 'amazon-ads',
  name: 'TEST lower bids on high ACOS',
  trigger: 'KEYWORD_HIGH_ACOS',
  conditions: [{ field: 'adTarget.acos', op: 'gt', value: 0.45 }, { field: 'adTarget.clicks', op: 'gte', value: 20 }],
  actions: [{ type: 'bid_down', percent: 10 }],
  scope: { marketplace: 'IT' },
  caps: { maxExecutionsPerDay: 50, maxWritesPerDay: 20, maxValueCentsEur: 500 },
}
const problems = (patch: Partial<RuleDraft>) => guardRule({ ...good, ...patch })

describe('R9 — the rule guard', () => {
  it('a sound rule passes', () => {
    expect(guardRule(good)).toEqual([])
    expect(problems({ scope: { wholeAccount: true } })).toEqual([])
  })

  it('never pause: every pausing action is refused, with the substitute', () => {
    for (const type of ['pause_campaign', 'pause_ad_group', 'pause_target', 'pause_all_campaigns', 'pause_keyword_x']) {
      const out = problems({ actions: [{ type }] })
      expect(out.join(' '), type).toContain(`${type}: refused — it pauses — a rule never pauses (Owner rule: a temporary stop is lower bids); use lower_bid_to_floor`)
    }
    // Switching on, archiving and the structural actions are refused too; eBay and marketing alike.
    expect(problems({ actions: [{ type: 'enable_target' }] }).join(' ')).toContain('enable_target: refused')
    expect(problems({ actions: [{ type: 'archive_keyword' }] }).join(' ')).toContain('archive_keyword: refused')
    expect(problems({ actions: [{ type: 'dayparting_apply' }] }).join(' ')).toContain('dayparting_apply: refused')
    expect(guardRule({ kind: 'ebay-ads', name: 'x', action: { type: 'pause_ad' }, guardrails: { maxActionsPerRun: 5 }, scope: { marketplace: 'EBAY_IT' } }).join(' ')).toContain('pause_ad: refused')
    expect(guardRule({ kind: 'ebay-ads', name: 'x', action: { type: 'reactivate_ad' }, guardrails: { maxActionsPerRun: 5 }, scope: { marketplace: 'EBAY_IT' } }).join(' ')).toContain('reactivate_ad: refused')
    expect(guardRule({ ...good, kind: 'marketing', trigger: 'MKT_ACOS_BREACH', conditions: [{ field: 'campaign.acos', op: 'gt', value: 0.5 }], actions: [{ type: 'mkt_pause_campaign' }] }).join(' ')).toContain('mkt_pause_campaign: refused')
  })

  it('an action outside the allowlist is refused, naming the allowed ones', () => {
    expect(problems({ actions: [{ type: 'create_amazon_promotion' }] }).join(' ')).toContain('create_amazon_promotion: refused')
    expect(problems({ actions: [{ type: 'teleport_bids' }] }).join(' ')).toContain('teleport_bids: not an action a Claude amazon-ads rule may carry')
  })

  it('a cap of 0 or a missing cap is refused (a cap of 0 refuses every run)', () => {
    expect(problems({ caps: { ...good.caps, maxValueCentsEur: 0 } }).join(' ')).toContain('caps.maxValueCentsEur: required, a whole number above 0')
    expect(problems({ caps: { maxExecutionsPerDay: 5 } }).join(' ')).toMatch(/caps\.maxWritesPerDay.*caps\.maxValueCentsEur/)
  })

  it('a percent where a fraction belongs is refused — in a condition and in an action', () => {
    expect(problems({ conditions: [{ field: 'adTarget.acos', op: 'gt', value: 30 }] }).join(' ')).toContain('adTarget.acos gt 30 reads as a percent')
    expect(problems({ trigger: 'KEYWORD_LOW_CTR', conditions: [{ field: 'adTarget.ctr', op: 'lt', value: 2 }] }).join(' ')).toContain('adTarget.ctr lt 2 reads as a percent')
    expect(problems({ actions: [{ type: 'bid_to_target_acos', targetAcos: 30 }] }).join(' ')).toContain('bid_to_target_acos.targetAcos: 30 reads as a percent')
    // An ACOS of 200 % is a real fraction (2): not refused.
    expect(problems({ conditions: [{ field: 'adTarget.acos', op: 'gt', value: 2 }] })).toEqual([])
  })

  it("a condition on a field the trigger never hands the rule is refused, naming the fields it does", () => {
    const out = problems({ conditions: [{ field: 'campaign.acos', op: 'gt', value: 0.4 }] }).join(' ')
    expect(out).toContain('campaign.acos is not a field the KEYWORD_HIGH_ACOS trigger hands a rule, so it would never match')
    expect(out).toContain('adTarget.bidCents')
    // SOV_BID hands no bid: a Current Bid condition there never matched (traced 2026-10-01).
    expect(problems({ trigger: 'SOV_BID', conditions: [{ field: 'adTarget.bidCents', op: 'gt', value: 50 }] }).join(' ')).toContain('adTarget.bidCents is not a field the SOV_BID trigger')
    expect(ADS_TRIGGER_FIELDS.SCHEDULE).toEqual(['trigger', 'marketplace', 'budget.monthlySpendCents'])
  })

  it('an empty condition list is refused (it would match everything); so is a nested builder group', () => {
    expect(problems({ conditions: [] })).toEqual(['conditions: at least one — an empty list matches everything'])
    expect(problems({ conditions: [{ conditions: [{ metric: 'ACOS', op: '>=', value: 40 }] }] }).join(' ')).toContain('a flat { field, op, value }')
  })

  it('no scope is refused: the whole account must be said', () => {
    expect(problems({ scope: {} }).join(' ')).toContain('or say wholeAccount: true — a rule with no scope reaches every campaign')
    expect(problems({ scope: { portfolioId: 'P1', campaignId: 'C1' } }).join(' ')).toContain('a portfolio and a campaign at once')
    expect(guardRule({ kind: 'ebay-ads', name: 'x', action: { type: 'adjust_ad_rate' }, guardrails: { maxActionsPerRun: 5 }, scope: {} }).join(' ')).toContain('name the campaigns (campaignIds) or the market')
  })

  it("eBay: the run's own cap (guardrails.maxActionsPerRun) is required", () => {
    expect(guardRule({ kind: 'ebay-ads', name: 'x', action: { type: 'adjust_ad_rate' }, guardrails: {}, scope: { marketplace: 'EBAY_IT' } }))
      .toEqual(['guardrails.maxActionsPerRun: required, a whole number above 0 (how many listings or keywords one run may change)'])
  })
})
