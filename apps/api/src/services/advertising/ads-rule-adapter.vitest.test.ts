/**
 * P2.1 — the adapter's two contracts, pinned:
 *
 *   1. COVERAGE — every metric the builder OFFERS for a slug translates for that slug. The
 *      offered lists are mirrored here as literals (the client module is 'use client' TSX-adjacent
 *      and cannot be imported under vitest); if PerformanceCriteria gains a metric without the
 *      adapter learning it, this fails naming the metric.
 *   2. REFUSE, NOT DROP — an unmapped metric marks the whole rule untranslatable. The old
 *      behaviour dropped the condition, and a dropped AND-condition makes a rule LOOSER.
 */
import { describe, it, expect } from 'vitest'
import { maybeTranslateAdsRule, listUntranslatableMetrics, BUILDER_SLUG_ACTIONS, isBuilderShapedAdsRule } from './ads-rule-adapter.service.js'

const rule = (slug: string, metrics: string[], action: Record<string, unknown> = {}) => ({
  id: 'test-rule',
  actions: [{ type: slug, ...action }],
  conditions: [{ match: 'all', lookback: 'Last 30 Days', exclude: 'None', conditions: metrics.map((m) => ({ metric: m, op: 'gte', value: '10' })) }],
})

// Mirrors PerformanceCriteria.tsx (METRICS_BASE / _SOV / _RANK / _PLACEMENT) — keep in step by hand.
const OFFERED: Record<string, string[]> = {
  budget: ['Sales', 'ACOS', 'ROAS', 'Clicks', 'Impressions', 'CVR', 'CTR', 'CPC', 'PPC Orders', 'Spend', 'Orders'],
  placement: ['ACOS', 'ROAS', 'Sales', 'Spend', 'Orders', 'CVR', 'CTR', 'CPC', 'Clicks', 'Impressions'],
  bid: ['Sales', 'ACOS', 'ROAS', 'Clicks', 'Impressions', 'CVR', 'CTR', 'CPC', 'PPC Orders', 'Spend', 'Orders'],
  'keyword-harvesting': ['Sales', 'ACOS', 'ROAS', 'Clicks', 'Impressions', 'CVR', 'CTR', 'CPC', 'PPC Orders', 'Spend', 'Orders'],
  'negative-targeting': ['Sales', 'ACOS', 'ROAS', 'Clicks', 'Impressions', 'CVR', 'CTR', 'CPC', 'PPC Orders', 'Spend', 'Orders'],
  sov: ['Share of Voice', 'Top Campaign Share', 'Impression Share', 'ACOS', 'Spend', 'Sales', 'Orders'],
  'keyword-tracker': ['Organic Rank', 'Sponsored Rank', 'Rank Change', 'Search Volume', 'Share of Voice', 'ACOS', 'Spend'],
}

describe('every offered metric translates for its slug', () => {
  for (const [slug, metrics] of Object.entries(OFFERED)) {
    it(`${slug}: all ${metrics.length} offered metrics map`, () => {
      const t = maybeTranslateAdsRule(rule(slug, metrics))
      expect(t, `${slug} did not translate at all`).not.toBeNull()
      expect(t!.untranslatable ?? [], `unmapped for ${slug}`).toEqual([])
      expect(t!.conditions).toHaveLength(metrics.length)
    })
  }
})

describe('an unmapped metric refuses the rule instead of loosening it', () => {
  it('marks the rule untranslatable and names the metric', () => {
    const t = maybeTranslateAdsRule(rule('negative-targeting', ['Spend', 'Frobnication Index']))
    expect(t).not.toBeNull()
    expect(t!.untranslatable).toEqual(['Frobnication Index'])
  })

  it('listUntranslatableMetrics answers the save-time question', () => {
    expect(listUntranslatableMetrics(rule('bid', ['ACOS', 'Made Up']))).toEqual(['Made Up'])
    expect(listUntranslatableMetrics(rule('bid', ['ACOS', 'Spend']))).toEqual([])
    // engine-native rules are not the adapter's business
    expect(listUntranslatableMetrics({ id: 'x', actions: [{ type: 'adjust_ad_budget' }], conditions: [] })).toEqual([])
  })
})

describe('unit conversion', () => {
  it('percent → fraction, euros → cents, counts stay plain', () => {
    const t = maybeTranslateAdsRule({
      id: 'conv',
      actions: [{ type: 'bid' }],
      conditions: [{ match: 'all', conditions: [
        { metric: 'ACOS', op: 'gt', value: '80' },
        { metric: 'Spend', op: 'gte', value: '5' },
        { metric: 'CPC', op: 'lt', value: '0.4' },
        { metric: 'Clicks', op: 'gte', value: '12' },
      ] }],
    })
    const by = Object.fromEntries(t!.conditions.map((c) => [c.field, c.value]))
    expect(by['adTarget.acos']).toBeCloseTo(0.8)
    expect(by['adTarget.spendCents']).toBe(500)
    expect(by['adTarget.cpcCents']).toBe(40)
    expect(by['adTarget.clicks']).toBe(12)
  })
})

describe('the governance vocabulary covers every builder slug', () => {
  it('BUILDER_SLUG_ACTIONS has an entry for each slug the adapter recognises', () => {
    for (const slug of ['budget', 'placement', 'bid', 'negative-targeting', 'keyword-harvesting', 'dayparting-schedule', 'sov', 'keyword-tracker']) {
      expect(isBuilderShapedAdsRule({ actions: [{ type: slug }] }), `${slug} not builder-shaped?`).toBe(true)
      expect(BUILDER_SLUG_ACTIONS[slug]?.length, `${slug} missing from BUILDER_SLUG_ACTIONS`).toBeGreaterThan(0)
    }
  })
})
