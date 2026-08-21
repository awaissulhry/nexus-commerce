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
import { maybeTranslateAdsRule, listUntranslatableMetrics, BUILDER_SLUG_ACTIONS, isBuilderShapedAdsRule, engineRuleToBuilderView, conditionsForStorage, producedActionTypes } from './ads-rule-adapter.service.js'

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
    expect(v.editLevel).toBe('criteria') // the ACTION is unrepresentable; the criteria still are
    expect(v.blockers.join(' ')).toContain('bid_to_target_acos')
    // it still explains what the rule DOES, so the page is never blank about that
    expect(v.actionSummary[0]).toContain('target ACoS')
  })

  it('flags a multi-action rule, because the builder writes one', () => {
    const v = engineRuleToBuilderView({
      id: 'r3', conditions: [],
      actions: [{ type: 'promote_to_exact', bidEur: 0.75 }, { type: 'notify', target: 'operator' }],
    })!
    expect(v.editLevel).toBe('criteria')
    expect(v.blockers.some((b) => b.includes('2 actions'))).toBe(true)
  })

  it('returns null for a builder-shaped rule — those need no translation', () => {
    expect(engineRuleToBuilderView({ id: 'r4', actions: [{ type: 'budget' }], conditions: [] })).toBeNull()
  })

  it('reads a condition from ANOTHER context than the rule\'s own slug', () => {
    // Six live `adjust_ad_budget` rules gate on adTarget.spendCents; the budget slug's own map
    // holds campaign.* only. Field names carry their context, so the cross-map fallback is safe.
    const v = engineRuleToBuilderView({
      id: 'r11',
      conditions: [{ op: 'gte', field: 'adTarget.spendCents', value: 5000 }],
      actions: [{ type: 'adjust_ad_budget', percent: 15 }],
    })!
    expect(v.unmappedFields).toHaveLength(0)
    expect(v.groups[0].conditions[0]).toMatchObject({ metric: 'Spend', op: 'gte', value: '50' })
  })

  it('names an engine field that has no builder metric instead of dropping it', () => {
    const v = engineRuleToBuilderView({
      id: 'r5',
      conditions: [{ op: 'lte', field: 'fbaAge.daysToLtsThreshold', value: 14 }],
      actions: [{ type: 'adjust_ad_budget', percent: 15 }],
    })!
    expect(v.unmappedFields).toContain('fbaAge.daysToLtsThreshold')
    expect(v.editLevel).toBe('meta') // a condition we cannot draw ⇒ criteria must not be written back
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

/**
 * EA5 — an engine-native rule keeps its shape on save, and only the fields the builder owns move.
 * This is what makes the builder FUNCTION on a stored rule instead of merely displaying it.
 */
describe('EA5 — conditionsForStorage', () => {
  it('translates the builder\'s nested groups back to flat leaves for an engine-native rule', () => {
    const r = conditionsForStorage(
      { actions: [{ type: 'adjust_ad_budget', percent: 15 }] },
      [{ match: 'all', conditions: [{ metric: 'ACOS', op: 'lte', value: '20' }] }],
    )
    expect(r.unmapped).toHaveLength(0)
    expect(r.conditions).toEqual([{ field: 'campaign.acos', op: 'lte', value: 0.2 }])
  })

  it('leaves a builder-shaped rule\'s nested conditions exactly as they are', () => {
    const nested = [{ match: 'all', conditions: [{ metric: 'ACOS', op: 'lte', value: '20' }] }]
    const r = conditionsForStorage({ actions: [{ type: 'budget' }] }, nested)
    expect(r.conditions).toBe(nested)
  })

  it('reports an unmapped metric rather than storing a rule that cannot evaluate', () => {
    const r = conditionsForStorage(
      { actions: [{ type: 'adjust_ad_budget' }] },
      [{ match: 'all', conditions: [{ metric: 'Nonsense', op: 'gte', value: '1' }] }],
    )
    expect(r.unmapped).toContain('Nonsense')
  })

  it('round-trips: engine → builder view → storage gives back the original leaf', () => {
    const original = [{ op: 'lte', field: 'campaign.acos', value: 0.2 }]
    const v = engineRuleToBuilderView({ id: 'rt', conditions: original, actions: [{ type: 'adjust_ad_budget' }] })!
    const back = conditionsForStorage(
      { actions: [{ type: 'adjust_ad_budget' }] },
      [{ match: 'all', conditions: v.groups[0].conditions }],
    )
    expect(back.conditions).toEqual(original)
  })

  /**
   * 🔴 EA5.2 — the round-trip above passed while the bug below shipped, because a budget rule and
   * CAMPAIGN_METRIC happen to agree. A builder metric name is CONTEXT-FREE: "ACOS" is
   * `campaign.acos` or `adTarget.acos` purely by which map is consulted. Measured on prod: editing
   * this rule's threshold also moved it from the campaign's ACoS to the target's.
   */
  it('keeps campaign.acos on a bid rule instead of rewriting it to adTarget.acos', () => {
    const original = [{ op: 'gte', field: 'campaign.acos', value: 0.4 }]
    const acts = [{ type: 'bid_down', percent: 20 }]
    const v = engineRuleToBuilderView({ id: 'rt2', conditions: original, actions: acts })!
    expect(v.groups[0].conditions[0].field).toBe('campaign.acos') // the view carries it
    // the operator edits 40 → 45; everything else is handed straight back
    const edited = v.groups[0].conditions.map((c) => ({ ...c, value: '45' }))
    const back = conditionsForStorage({ actions: acts }, [{ match: 'all', conditions: edited }])
    expect(back.conditions).toEqual([{ op: 'gte', field: 'campaign.acos', value: 0.45 }])
  })

  it('still resolves by metric for a condition built fresh, with no field to pin', () => {
    const back = conditionsForStorage(
      { actions: [{ type: 'bid_down' }] },
      [{ match: 'all', conditions: [{ metric: 'ACOS', op: 'gte', value: '45' }] }],
    )
    expect(back.conditions).toEqual([{ field: 'adTarget.acos', op: 'gte', value: 0.45 }])
  })
})

/**
 * BP.P1 — producedActionTypes: the ceiling judges a rule by what its translation EMITS.
 *
 * The slug expansion (`BUILDER_SLUG_ACTIONS.bid` = bid_apply + pause_target + enable_target)
 * describes the slug's whole repertoire; a stored rule produces exactly one of those, decided by
 * its THEN op. Judging by the repertoire capped every Bid rule at PROPOSE — including a plain
 * "Decrease Bid by 15%" that can never write a status.
 */
describe('BP.P1 — producedActionTypes is op-aware', () => {
  const bidRule = (op: string) => ({
    id: 'bp1',
    actions: [{ type: 'bid' }],
    conditions: [{ match: 'all', conditions: [{ metric: 'ACOS', op: 'gt', value: '30' }], action: { op, value: '15' } }],
  })

  it('a value-moving Bid rule produces only bid_apply', () => {
    for (const op of ['set', 'incPct', 'decPct', 'incAbs', 'decAbs', 'setCpc', 'targetAcos']) {
      expect(producedActionTypes(bidRule(op)), op).toEqual(['bid_apply'])
    }
  })

  it('a pausing Bid rule produces the structural status action', () => {
    expect(producedActionTypes(bidRule('pauseTarget'))).toEqual(['pause_target'])
    expect(producedActionTypes(bidRule('enableTarget'))).toEqual(['enable_target'])
  })

  it('an engine-native rule passes its raw types through', () => {
    expect(producedActionTypes({ id: 'x', actions: [{ type: 'bid_down' }, { type: 'notify' }], conditions: [] }))
      .toEqual(['bid_down', 'notify'])
  })

  it('an untranslatable builder rule falls back to the conservative slug expansion', () => {
    const bad = { id: 'y', actions: [{ type: 'bid' }], conditions: [{ match: 'all', conditions: [{ metric: 'No Such Metric', op: 'gt', value: '1' }] }] }
    expect(producedActionTypes(bad)).toEqual(BUILDER_SLUG_ACTIONS.bid)
  })
})

/**
 * BP.P4b — multi-block translation. Each builder group is its own IF→THEN block; the old shape
 * flattened every group's conditions into one AND-list and ran only groups[0].action.
 */
describe('BP.P4b — each criteria block translates to its own conditions + action', () => {
  const twoBlockBid = {
    id: 'bp4b',
    actions: [{ type: 'bid', bidFloor: 0.1, bidCeiling: 2 }],
    conditions: [
      { match: 'all', conditions: [{ metric: 'ACOS', op: 'gt', value: '40' }], action: { op: 'decPct', value: '15' } },
      { match: 'all', conditions: [{ metric: 'ACOS', op: 'lt', value: '15' }, { metric: 'Orders', op: 'gte', value: '2' }], action: { op: 'incPct', value: '10' } },
    ],
  }

  it('a two-block Bid rule yields two blocks, each with its own conditions and op', () => {
    const t = maybeTranslateAdsRule(twoBlockBid)!
    expect(t.blocks).toHaveLength(2)
    expect(t.blocks![0].conditions).toHaveLength(1)
    expect(t.blocks![1].conditions).toHaveLength(2)
    expect(t.blocks![0].actions[0].op).toBe('decPct')
    expect(t.blocks![1].actions[0].op).toBe('incPct')
    // top level mirrors block 0 so single-block consumers behave exactly as before
    expect(t.conditions).toEqual(t.blocks![0].conditions)
    expect(t.actions).toEqual(t.blocks![0].actions)
  })

  it('a rule that bids in one block and pauses in another produces BOTH action types (→ structural ceiling)', () => {
    const mixed = {
      id: 'bp4b2',
      actions: [{ type: 'bid' }],
      conditions: [
        { match: 'all', conditions: [{ metric: 'ACOS', op: 'gt', value: '40' }], action: { op: 'decPct', value: '15' } },
        { match: 'all', conditions: [{ metric: 'ACOS', op: 'gt', value: '80' }], action: { op: 'pauseTarget' } },
      ],
    }
    expect(producedActionTypes(mixed).sort()).toEqual(['bid_apply', 'pause_target'])
  })

  it('a Bid rule with windowDays carries it into the bid_apply action', () => {
    const windowed = {
      id: 'bp4c',
      actions: [{ type: 'bid', windowDays: 30 }],
      conditions: [{ match: 'all', conditions: [{ metric: 'ACOS', op: 'gt', value: '40' }], action: { op: 'decPct', value: '15' } }],
    }
    expect(maybeTranslateAdsRule(windowed)!.actions[0].windowDays).toBe(30)
  })
})

/**
 * HP1 — the harvest wire rides the translation: mappings, term filters, dedupe, bid modes,
 * OR-of-ANDs condition blocks, and the negate-in-source source-allowlist coupling.
 */
describe('HP1 — the harvest builder form survives into execution', () => {
  const harvestRule = (extra: Record<string, unknown> = {}, conditions?: unknown[]) => ({
    id: 'hp1',
    actions: [{
      type: 'keyword-harvesting',
      negateInSource: true,
      dedupe: true,
      bid: { mode: 'suggested', value: '' },
      searchTerms: [{ term: 'moto', op: 'contains' }],
      filters: { brandExclude: ['xavia'], competitorOnly: false },
      mappings: [{ groups: [
        { id: 'src1', look: true, types: { P: false, E: false, product: false } },
        { id: 'dst1', look: false, types: { P: true, E: true, product: false } },
      ] }],
      ...extra,
    }],
    conditions: conditions ?? [
      { match: 'all', conditions: [{ metric: 'PPC Orders', op: 'gte', value: '2' }] },
      { match: 'all', conditions: [{ metric: 'Sales', op: 'gte', value: '50' }, { metric: 'ACOS', op: 'lte', value: '25' }] },
    ],
  })

  it('promote_to_exact carries the whole wire; "suggested" bid becomes cpc', () => {
    const t = maybeTranslateAdsRule(harvestRule())!
    const promote = t.actions[0] as Record<string, unknown>
    expect(promote.type).toBe('promote_to_exact')
    expect(promote.bid).toEqual({ mode: 'cpc', value: null })
    const harvest = promote.harvest as { blocks: unknown; filters: Record<string, unknown>; dedupe: boolean }
    expect(harvest.dedupe).toBe(true)
    expect(harvest.blocks).toEqual([{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['PHRASE', 'EXACT'] }] }])
    expect(harvest.filters).toEqual({ containsAny: ['moto'], notContains: [], brandExclude: ['xavia'], competitorOnly: false })
  })

  it('negate-in-source gets the SAME source allowlist, so a mapped rule never negates outside it', () => {
    const t = maybeTranslateAdsRule(harvestRule())!
    const neg = t.actions[1] as Record<string, unknown>
    expect(neg.type).toBe('add_negative_exact')
    expect(neg.scope).toBe('AD_GROUP')
    expect(neg.sourceLookAdGroupIds).toEqual(['src1'])
  })

  it('condition groups become OR blocks sharing one THEN (the old flatten AND-ed them)', () => {
    const t = maybeTranslateAdsRule(harvestRule())!
    expect(t.blocks).toHaveLength(2)
    expect(t.blocks![0].conditions).toHaveLength(1)
    expect(t.blocks![1].conditions).toHaveLength(2)
    expect(t.blocks![0].actions).toBe(t.blocks![1].actions) // same THEN, by identity
    expect(t.conditions).toEqual(t.blocks![0].conditions)
  })

  it('negative-targeting groups get the same OR treatment', () => {
    const t = maybeTranslateAdsRule({
      id: 'hp1n',
      actions: [{ type: 'negative-targeting', negationLevel: 'adgroup' }],
      conditions: [
        { match: 'all', conditions: [{ metric: 'Sales', op: 'eq', value: '0' }, { metric: 'Clicks', op: 'gte', value: '20' }] },
        { match: 'all', conditions: [{ metric: 'ACOS', op: 'gte', value: '150' }] },
      ],
    })!
    expect(t.blocks).toHaveLength(2)
    expect((t.actions[0] as Record<string, unknown>).scope).toBe('AD_GROUP')
  })

  // ── NEG-P1 — the negative rule carries its WHOLE form ──────────────────────
  const negativeRule = (a0: Record<string, unknown> = {}) => ({
    id: 'negp1',
    actions: [{
      type: 'negative-targeting',
      negationLevel: 'adgroup',
      protectConverting: true,
      protectDays: 30,
      dedupe: true,
      searchTerms: [{ term: 'moto', op: 'contains' }],
      filters: { brandExclude: ['xavia'], competitorOnly: false },
      mappings: [{ groups: [
        { id: 'src1', look: true, types: { P: false, E: false, product: false } },
        { id: 'dst1', look: false, types: { P: true, E: true, product: false } },
      ] }],
      ...a0,
    }],
    conditions: [{ match: 'all', conditions: [{ metric: 'Sales', op: 'eq', value: '0' }] }],
  })

  it('the negative action carries the wire: mappings, term/brand filters and dedupe', () => {
    const t = maybeTranslateAdsRule(negativeRule())!
    const neg = t.actions[0] as Record<string, unknown>
    expect(neg.type).toBe('add_negative_exact')
    const wire = neg.negative as { blocks: unknown; filters: Record<string, unknown>; dedupe: boolean }
    expect(wire.blocks).toEqual([{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['PHRASE', 'EXACT'] }] }])
    expect(wire.filters).toEqual({ containsAny: ['moto'], notContains: [], brandExclude: ['xavia'], competitorOnly: false })
    expect(wire.dedupe).toBe(true)
    expect(neg.protectConverting).toBe(true)
  })

  it("every Negation Level is honoured — 'both' writes BOTH (it used to silently become CAMPAIGN)", () => {
    expect((maybeTranslateAdsRule(negativeRule())!.actions[0] as Record<string, unknown>).levels).toEqual(['AD_GROUP'])
    expect((maybeTranslateAdsRule(negativeRule({ negationLevel: 'campaign' }))!.actions[0] as Record<string, unknown>).levels).toEqual(['CAMPAIGN'])
    const both = maybeTranslateAdsRule(negativeRule({ negationLevel: 'both' }))!.actions[0] as Record<string, unknown>
    expect(both.levels).toEqual(['AD_GROUP', 'CAMPAIGN'])
    expect(both.scope).toBe('AD_GROUP') // display scope = the first level
  })

  it("an absent Negation Level defaults to AD_GROUP — the builder's default and the level that lands", () => {
    const t = maybeTranslateAdsRule(negativeRule({ negationLevel: undefined }))!
    expect((t.actions[0] as Record<string, unknown>).levels).toEqual(['AD_GROUP'])
  })

  it('an unmapped rule stays account-wide (blocks null) and fixed bids still ride', () => {
    const t = maybeTranslateAdsRule(harvestRule({ mappings: [], bid: { mode: 'fixed', value: '0.65' } }))!
    const promote = t.actions[0] as Record<string, unknown>
    expect((promote.harvest as { blocks: unknown }).blocks).toBeNull()
    expect(promote.bid).toEqual({ mode: 'fixed', value: 0.65 })
  })
})
