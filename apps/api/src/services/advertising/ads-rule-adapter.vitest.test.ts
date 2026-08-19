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
import { maybeTranslateAdsRule, listUntranslatableMetrics, BUILDER_SLUG_ACTIONS, isBuilderShapedAdsRule, engineRuleToBuilderView } from './ads-rule-adapter.service.js'

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

/**
 * EA4 — the REVERSE direction, and the fail-open it closed.
 *
 * Measured on prod 2026-08-19: 0 of 51 stored rules are builder-shaped, so `engineRuleToBuilderView`
 * is the only thing that lets the builder show a real rule at all. These pin the two things that
 * matter: the conditions come back with their REAL values, and a rule the builder cannot reproduce
 * is reported as not editable rather than shown as an editable blank.
 */
describe('EA4 — engine rule → builder view', () => {
  it('reads a real stored rule\'s conditions back with their true values', () => {
    // The live rule "Boost budget on profitable campaigns": ACoS <= 0.2 AND spend >= 5000 cents.
    const v = engineRuleToBuilderView({
      id: 'r1',
      conditions: [
        { op: 'lte', field: 'campaign.acos', value: 0.2 },
        { op: 'gte', field: 'campaign.spendCents', value: 5000 },
      ],
      actions: [{ type: 'adjust_ad_budget', percent: 15 }],
    })!
    expect(v.slug).toBe('budget')
    const leaves = v.groups[0].conditions
    // fraction → percent, cents → euros. The exact inverse of `convert`.
    expect(leaves.find((c) => c.metric === 'ACOS')).toMatchObject({ op: 'lte', value: '20' })
    expect(leaves.find((c) => c.metric === 'Spend')).toMatchObject({ op: 'gte', value: '50' })
  })

  it('refuses to call a rule editable when its action has no builder control', () => {
    const v = engineRuleToBuilderView({
      id: 'r2',
      conditions: [{ op: 'gt', field: 'campaign.acos', value: 0.4 }],
      actions: [{ type: 'bid_to_target_acos', targetAcos: 0.25, profitMode: true }],
    })!
    expect(v.editable).toBe(false)
    expect(v.blockers.join(' ')).toContain('bid_to_target_acos')
    // it still explains what the rule DOES, so the page is never blank about that
    expect(v.actionSummary[0]).toContain('target ACoS')
  })

  it('flags a multi-action rule, because the builder writes one', () => {
    const v = engineRuleToBuilderView({
      id: 'r3', conditions: [],
      actions: [{ type: 'promote_to_exact', bidEur: 0.75 }, { type: 'notify', target: 'operator' }],
    })!
    expect(v.editable).toBe(false)
    expect(v.blockers.some((b) => b.includes('2 actions'))).toBe(true)
  })

  it('returns null for a builder-shaped rule — those need no translation', () => {
    expect(engineRuleToBuilderView({ id: 'r4', actions: [{ type: 'budget' }], conditions: [] })).toBeNull()
  })

  it('names an engine field that has no builder metric instead of dropping it', () => {
    const v = engineRuleToBuilderView({
      id: 'r5',
      conditions: [{ op: 'lte', field: 'fbaAge.daysToLtsThreshold', value: 14 }],
      actions: [{ type: 'adjust_ad_budget', percent: 15 }],
    })!
    expect(v.unmappedFields).toContain('fbaAge.daysToLtsThreshold')
    expect(v.editable).toBe(false)
  })
})

describe('EA4 — a builder action with non-builder conditions must NOT match everything', () => {
  it('refuses instead of translating to zero conditions', () => {
    // The fail-open: `evaluateConditions` treats an empty list as TRUE, so a rule that translated
    // to no leaves would have written to every campaign on every tick.
    const t = maybeTranslateAdsRule({
      id: 'r6',
      actions: [{ type: 'budget', budgetFloor: 1 }],
      conditions: [{ op: 'lte', field: 'campaign.acos', value: 0.2 }] as unknown as object[],
    })!
    expect(t.conditions).toHaveLength(0)
    expect(t.untranslatable?.length).toBeGreaterThan(0)
  })

  it('still translates a genuinely empty condition list (dayparting is always-match by design)', () => {
    const t = maybeTranslateAdsRule({ id: 'r7', actions: [{ type: 'dayparting-schedule', windows: [] }], conditions: [] })!
    expect(t.untranslatable).toBeUndefined()
  })
})

describe('EA4 — the campaign picker actually binds', () => {
  it('passes the builder campaigns into budget_apply and placement_apply', () => {
    const camps = [{ id: 'c1' }, { id: 'c2' }]
    const bud = maybeTranslateAdsRule({
      id: 'r8', actions: [{ type: 'budget', campaigns: camps }],
      conditions: [{ conditions: [{ metric: 'ACOS', op: 'lte', value: '20' }], action: { op: 'inc', value: '15' } }] as unknown as object[],
    })!
    expect(bud.actions[0].campaignIds).toEqual(['c1', 'c2'])
    const pl = maybeTranslateAdsRule({
      id: 'r9', actions: [{ type: 'placement', campaigns: camps }],
      conditions: [{ conditions: [{ metric: 'ACOS', op: 'lte', value: '20' }], action: { op: 'set', value: '50', placeTarget: 'tos' } }] as unknown as object[],
    })!
    expect(pl.actions[0].campaignIds).toEqual(['c1', 'c2'])
  })

  it('also accepts the Autopilot\'s `campaignIds` spelling, which nothing read before', () => {
    const t = maybeTranslateAdsRule({
      id: 'r10', actions: [{ type: 'bid', campaignIds: ['c9'] }],
      conditions: [{ conditions: [{ metric: 'ACOS', op: 'gt', value: '80' }], action: { op: 'dec', value: '10' } }] as unknown as object[],
    })!
    expect(t.actions[0].campaignIds).toEqual(['c9'])
  })
})
