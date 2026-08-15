/**
 * RA.AUTO — the renderer, against the shapes prod actually stores.
 *
 * Every fixture below is a VERBATIM row from prod (`scripts/_ra4-shapes.mts`, 2026-08-10). That
 * is the whole point of the file: the five rule-type tabs render "—" in every Criteria cell
 * because they were written for a nested builder shape that 0 of 51 rows carry, and a test built
 * on invented fixtures would have passed for them too.
 *
 * No `@/` imports — the vitest runner in apps/web has no such alias.
 */
import { describe, it, expect } from 'vitest'
import { conditionText, actionLines, triggerText, targetAcosProblem, NON_WRITING } from './ruleText'

describe('conditionText — the "If" line', () => {
  it('renders a ratio as a percentage, not a fraction', () => {
    // "ACoS convergence (proportional correction)" — verbatim from prod.
    const r = conditionText([{ op: 'gt', field: 'campaign.acos', value: 0 }])
    expect(r.text).toBe('Campaign ACOS > 0%')
    expect(r.unconditional).toBe(false)
  })

  it('renders cents as euro', () => {
    // "Account-wide negative sync" — verbatim from prod. 1000 cents is €10.00, not €1000.
    expect(conditionText([{ op: 'gte', field: 'adTarget.spendCents', value: 1000 }]).text)
      .toBe('Target spend ≥ €10.00')
  })

  it('joins multiple leaves with "and"', () => {
    // "Aggressive growth: raise bids on low-ACOS winners" — verbatim from prod.
    expect(conditionText([
      { op: 'lte', field: 'campaign.acos', value: 0.15 },
      { op: 'gte', field: 'adTarget.ordersCount', value: 3 },
    ]).text).toBe('Campaign ACOS ≤ 15% and Target orders ≥ 3')
  })

  it('says an empty condition list fires every time, and flags it', () => {
    // 24 of 51 rules on prod carry []. This is a fact about the rule, not a missing value —
    // rendering it as "—" (which the rule-type tabs do) reads as broken data.
    const r = conditionText([])
    expect(r.unconditional).toBe(true)
    expect(r.text).toContain('fires every time')
  })

  it('does not invent a unit for an unknown field', () => {
    expect(conditionText([{ op: 'gte', field: 'brand.newMetric', value: 42 }]).text)
      .toBe('brand.newMetric ≥ 42')
  })

  it('survives the nested builder shape it will never see', () => {
    // A `{kind:'and', children:[…]}` payload has no leaves at the top level. It must degrade to
    // "unconditional" rather than throw — 0 of 51 rows carry it, but a future builder might.
    const r = conditionText({ kind: 'and', children: [{ field: 'campaign.acos', op: 'gt', value: 1 }] })
    expect(r.unconditional).toBe(true)
  })
})

describe('actionLines — the "Then" lines', () => {
  it('marks which actions reach Amazon and which do not', () => {
    const lines = actionLines([
      { type: 'bid_to_target_acos', profitMode: false, targetAcos: 0.3 },
      { type: 'notify', target: 'operator', message: 'Proportional ACOS correction applied' },
    ])
    expect(lines.map((l) => l.writes)).toEqual([true, false])
    expect(lines[0].label).toBe('Move bids toward the target ACOS')
    expect(lines[1].label).toBe('Notify you')
  })

  it('prints targetAcos as stored, because prod stores two different units for it', () => {
    // Measured: "ACoS convergence" stores 0.3 and "AIREON — Target ACoS bidding" stores 30.
    // Any surface that picked a unit would misreport one of them by 100×.
    expect(actionLines([{ type: 'bid_to_target_acos', targetAcos: 0.3 }])[0].detail).toContain('0.3')
    expect(actionLines([{ type: 'bid_to_target_acos', targetAcos: 30 }])[0].detail).toContain('30')
  })

  it('names the largest blast radius in the system plainly', () => {
    const l = actionLines([{ type: 'pause_all_campaigns', reason: 'Monthly cap' }])[0]
    expect(l.label).toBe('Pause EVERY campaign')
    expect(l.writes).toBe(true)
  })

  it('counts named campaigns rather than listing eleven ids', () => {
    expect(actionLines([{ type: 'bid_to_target_acos', targetAcos: 30, campaignIds: ['a', 'b', 'c'] }])[0].detail)
      .toContain('3 named campaigns')
  })

  it('treats every unmapped action as a write', () => {
    // The same default-deny as rule-category.ts's fallback: an unknown action is assumed to
    // reach Amazon until someone says otherwise. The opposite default is how eight writing
    // rules came to be labelled "Alerts — informs, never writes".
    const l = actionLines([{ type: 'some_future_action' }])[0]
    expect(l.writes).toBe(true)
    expect(NON_WRITING.has('some_future_action')).toBe(false)
  })

  it('is empty, not crashing, for a rule with no actions', () => {
    expect(actionLines(null)).toEqual([])
    expect(actionLines([])).toEqual([])
  })
})

describe('triggerText', () => {
  it('says what SCHEDULE actually means', () => {
    expect(triggerText('SCHEDULE')).toBe('On a schedule (every evaluator tick)')
  })
  it('humanises the rest', () => {
    expect(triggerText('KEYWORD_WASTED_SPEND')).toBe('Keyword wasted spend')
  })

  it('keeps acronyms uppercase', () => {
    // "Cac spike" shipped to prod and reads as a typo. Nine of the 21 triggers in use here
    // contain an acronym.
    expect(triggerText('CAC_SPIKE')).toBe('CAC spike')
    expect(triggerText('KEYWORD_HIGH_ACOS')).toBe('Keyword high ACOS')
    expect(triggerText('CAMPAIGN_ROAS_DECLINING')).toBe('Campaign ROAS declining')
    expect(triggerText('KEYWORD_LOW_CTR')).toBe('Keyword low CTR')
    expect(triggerText('CVR_DROP')).toBe('CVR drop')
    expect(triggerText('SOV_BID')).toBe('SOV bid')
    expect(triggerText('FBA_AGE_THRESHOLD_REACHED')).toBe('FBA age threshold reached')
  })
})

// AUTO.A4 — the detectConflicts suite left with the function it pinned. The replacement model
// (by entity: reach × field × classes) is server-side and its pure core is pinned in
// apps/api/src/services/advertising/ads-conflicts.vitest.test.ts.

describe('actionLines fallback — the missing-field guard', () => {
  it('never claims "does nothing" when only actionTypes survived', () => {
    // `GET /autonomy/rules` shipped without `actions`, and the drawer rendered
    // "no actions — this rule does nothing" over a rule carrying bid_to_target_acos.
    // A missing field must cost detail, never reverse the claim.
    const lines = actionLines(undefined, ['bid_to_target_acos'])
    expect(lines).toHaveLength(1)
    expect(lines[0].writes).toBe(true)
    expect(lines[0].label).toBe('Move bids toward the target ACOS')
    expect(lines[0].detail).toBe('')
  })

  it('prefers the raw actions when both are present', () => {
    const lines = actionLines([{ type: 'bid_up', percent: 20 }], ['bid_to_target_acos'])
    expect(lines).toHaveLength(1)
    expect(lines[0].detail).toContain('20%')
  })

  it('is still empty when a rule genuinely has no actions', () => {
    expect(actionLines([], [])).toEqual([])
    expect(actionLines(null, undefined)).toEqual([])
  })
})

describe('targetAcosProblem — the 100× trap', () => {
  it('accepts a fraction', () => {
    expect(targetAcosProblem(0.3)).toBeNull()
    expect(targetAcosProblem(1)).toBeNull()
    expect(targetAcosProblem(undefined)).toBeNull()
  })

  it('flags the value one rule on prod actually stores', () => {
    // "AIREON — Target ACoS bidding" stores 30. previewBidOptimization defaults this field to
    // 0.3 and uses it directly, so 30 is a 3000% ACOS target — "spend up to 30x revenue".
    const p = targetAcosProblem(30)
    expect(p).toContain('3000%')
    expect(p).toContain('fraction')
  })

  it('flags nonsense rather than passing it through', () => {
    expect(targetAcosProblem(0)).not.toBeNull()
    expect(targetAcosProblem(-1)).not.toBeNull()
    expect(targetAcosProblem('abc')).toContain('invalid')
  })
})

describe('actionLines — parameters the engine will refuse', () => {
  it('flags a percent-shaped targetAcos on the action itself', () => {
    const l = actionLines([{ type: 'bid_to_target_acos', targetAcos: 30 }])[0]
    expect(l.problem).toContain('3000%')
  })

  it('flags a campaignIds array the handler cannot honour', () => {
    // The handler reads `campaignId` (singular). An operator who scoped a rule to 11 campaigns
    // believes it is narrowed; without this it would run account-wide.
    const l = actionLines([{ type: 'bid_to_target_acos', targetAcos: 0.3, campaignIds: ['a', 'b'] }])[0]
    expect(l.problem).toContain('2 campaigns')
    expect(l.problem).toContain('account-wide')
  })

  it('does not flag a singular campaignId, which IS honoured', () => {
    const l = actionLines([{ type: 'bid_to_target_acos', targetAcos: 0.3, campaignId: 'abc' }])[0]
    expect(l.problem).toBeUndefined()
  })

  it('reports both problems when a rule carries both', () => {
    const l = actionLines([{ type: 'bid_to_target_acos', targetAcos: 30, campaignIds: ['a'] }])[0]
    expect(l.problem).toContain('3000%')
    expect(l.problem).toContain('account-wide')
  })

  it('leaves every other action unflagged', () => {
    expect(actionLines([{ type: 'bid_up', percent: 20 }])[0].problem).toBeUndefined()
  })
})
