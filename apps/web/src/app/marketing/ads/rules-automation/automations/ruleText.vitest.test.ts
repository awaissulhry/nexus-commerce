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
import { conditionText, actionLines, triggerText, detectConflicts, NON_WRITING } from './ruleText'

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

describe('detectConflicts', () => {
  const base = { trigger: 'CAC_SPIKE', level: 'PROPOSE', marketplace: null, conditions: [] }

  it('flags opposing actions on the same trigger', () => {
    const m = detectConflicts([
      { ...base, id: 'a', name: 'Raiser', actions: [{ type: 'bid_up' }] },
      { ...base, id: 'b', name: 'Lowerer', actions: [{ type: 'bid_down' }] },
    ])
    expect(m.get('a')?.[0]).toContain('Lowerer')
    expect(m.get('b')?.[0]).toContain('Raiser')
  })

  it('ignores rules that cannot run', () => {
    // An OFF rule is a plan, not a participant. Flagging it as a conflict produces noise an
    // operator has to dismiss 29 times on this account.
    const m = detectConflicts([
      { ...base, id: 'a', name: 'Raiser', level: 'OFF', actions: [{ type: 'bid_up' }] },
      { ...base, id: 'b', name: 'Lowerer', level: 'OFF', actions: [{ type: 'bid_down' }] },
    ])
    expect(m.size).toBe(0)
  })

  it('does not flag rules on different triggers', () => {
    const m = detectConflicts([
      { ...base, id: 'a', name: 'Raiser', actions: [{ type: 'bid_up' }] },
      { ...base, id: 'b', name: 'Lowerer', trigger: 'CVR_DROP', actions: [{ type: 'bid_down' }] },
    ])
    expect(m.size).toBe(0)
  })

  it('treats a null market as everywhere, so it can still conflict with a scoped rule', () => {
    const m = detectConflicts([
      { ...base, id: 'a', name: 'Everywhere', marketplace: null, actions: [{ type: 'bid_up' }] },
      { ...base, id: 'b', name: 'Italy only', marketplace: 'IT', actions: [{ type: 'bid_down' }] },
    ])
    expect(m.size).toBe(2)
  })

  it('does not flag two rules scoped to different markets', () => {
    const m = detectConflicts([
      { ...base, id: 'a', name: 'Germany', marketplace: 'DE', actions: [{ type: 'bid_up' }] },
      { ...base, id: 'b', name: 'Italy', marketplace: 'IT', actions: [{ type: 'bid_down' }] },
    ])
    expect(m.size).toBe(0)
  })

  it('flags exact duplicates', () => {
    const m = detectConflicts([
      { ...base, id: 'a', name: 'One', actions: [{ type: 'bid_up', percent: 10 }] },
      { ...base, id: 'b', name: 'Two', actions: [{ type: 'bid_up', percent: 10 }] },
    ])
    expect(m.get('a')?.[0]).toContain('Duplicate of')
  })

  it('reads actionTypes when the full actions array is absent', () => {
    // `GET /autonomy/rules` strips notify/alert_operator out of `actionTypes`, so the fallback
    // path has to work on that shape too.
    const m = detectConflicts([
      { ...base, id: 'a', name: 'Raiser', actionTypes: ['bid_up'] },
      { ...base, id: 'b', name: 'Lowerer', actionTypes: ['bid_down'] },
    ])
    expect(m.size).toBe(2)
  })
})
