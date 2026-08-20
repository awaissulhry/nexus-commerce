/**
 * P2 — the threshold reader, and the properties that keep the columns from inventing anything.
 *
 * The point of this file is NOT that it formats numbers. It is that the three sources of a
 * threshold stay distinguishable (a value the rule sets · a handler fallback · no such ceiling at
 * all), and that a threshold is a COLUMN or a CLAUSE and never both — because one field rendered
 * twice on one screen is how the Ad Manager came to print a fabricated 30.00% beside the truth.
 *
 * The rule shapes below are real, copied from production 2026-08-20 via `_hvr-params.mts`.
 */
import { describe, it, expect } from 'vitest'
import { HARVEST_DEFAULTS } from '@nexus/shared/ads-rule-window'
import {
  readThreshold, readThresholds, thresholdClauses, defaultClauses,
  RULE_TAB_THRESHOLDS, THRESHOLD_SPEC, THRESHOLD_ORDER,
} from './ruleThresholds'

/** "Harvest & negate search terms" / "Auto harvest & negate" — thresholds on the action. */
const HARVEST_WITH_THRESHOLDS = { type: 'harvest_and_negate', minOrders: 2, minSpendCents: 1000, windowDays: 60, graduationBidEur: 0.5 }
/** "Exact match discovery engine" — the stricter one. */
const HARVEST_STRICTER = { type: 'harvest_and_negate', minOrders: 3, minSpendCents: 500, windowDays: 30, graduationBidEur: 0.65 }
/** "Daily automation digest" — a harvest action carrying no parameters at all. */
const HARVEST_BARE = { type: 'harvest_and_negate' }
/** "Reduce bids on ACOS spike" — a THEN-side action, which must yield no thresholds whatsoever. */
const BID_DOWN = { type: 'bid_down', percent: 25, reason: 'ACOS spike — bid -20%', target: 'ad_target' }

describe('readThreshold — three sources, never collapsed', () => {
  it('reads a value the rule stores', () => {
    expect(readThreshold(HARVEST_WITH_THRESHOLDS, 'minOrders')).toEqual({ value: 2, source: 'rule' })
    expect(readThreshold(HARVEST_STRICTER, 'minOrders')).toEqual({ value: 3, source: 'rule' })
  })

  it('falls back to the handler default, and SAYS it is a fallback', () => {
    const r = readThreshold(HARVEST_BARE, 'minOrders')
    expect(r.value).toBe(HARVEST_DEFAULTS.minOrders)
    // 🔴 `source` is the whole point. A default rendered as a chosen value tells the operator
    // somebody decided 2 orders, and nobody did.
    expect(r.source).toBe('default')
  })

  it('reports no ceiling as `none`, not as zero and not as a default', () => {
    const r = readThreshold(HARVEST_WITH_THRESHOLDS, 'maxAcosPct')
    expect(r.value).toBeNull()
    expect(r.source).toBe('none')
    // 🔴 Measured on prod 2026-08-20: no rule in the account carries `maxAcosPct`, so this is what
    // the whole Max ACoS column says. It has to mean something, not just be blank.
    expect(THRESHOLD_SPEC.maxAcosPct.absent).toMatch(/however expensive/)
  })

  it('takes nothing at all off a THEN-side action', () => {
    const all = readThresholds(BID_DOWN)
    for (const k of THRESHOLD_ORDER) expect(all[k].value, k).toBeNull()
    // `percent`, `reason` and `target` are on that action and none of them is a criterion.
    expect(thresholdClauses(BID_DOWN, 'bid')).toEqual([])
  })

  it('survives a rule with no action', () => {
    expect(readThreshold(null, 'minOrders')).toEqual({ value: null, source: 'none' })
    expect(thresholdClauses(null, 'keyword-harvest')).toEqual([])
  })
})

describe('a threshold is a column OR a clause, never both', () => {
  it('drops the columned thresholds from the Criteria clauses on a tab that has columns', () => {
    // Keyword Harvest declares Order Threshold + Max ACoS, so only the spend clause is left.
    expect(RULE_TAB_THRESHOLDS['keyword-harvest']).toEqual(['minOrders', 'maxAcosPct'])
    expect(thresholdClauses(HARVEST_WITH_THRESHOLDS, 'keyword-harvest')).toEqual(['spend ≥ €10'])
  })

  it('keeps every clause on a tab that declares no columns', () => {
    // The SAME rule on Negative Targeting, where there is no Order Threshold column to move it to.
    expect(RULE_TAB_THRESHOLDS['negative-targeting']).toBeUndefined()
    expect(thresholdClauses(HARVEST_WITH_THRESHOLDS, 'negative-targeting')).toEqual(['≥ 2 orders', 'spend ≥ €10'])
  })

  it('never promotes a handler fallback into a criterion clause', () => {
    // 🔴 A default is not something the operator chose, and printing it as a condition is how
    // "Always" got written in the first place. It reaches the cell through `defaultClauses`,
    // labelled, and never through `thresholdClauses`.
    expect(thresholdClauses(HARVEST_BARE, 'negative-targeting')).toEqual([])
    expect(defaultClauses(HARVEST_BARE, 'negative-targeting')).toEqual(['≥ 2 orders', 'spend ≥ €10'])
    // and on the tab where orders has its own column, only the spend default is left to say
    expect(defaultClauses(HARVEST_BARE, 'keyword-harvest')).toEqual(['spend ≥ €10'])
  })
})

describe('formatting', () => {
  it('prints money in euros from cents, and does not invent decimals', () => {
    expect(THRESHOLD_SPEC.minSpendCents.cell(1000)).toBe('Min €10')
    expect(THRESHOLD_SPEC.minSpendCents.cell(500)).toBe('Min €5')
    expect(THRESHOLD_SPEC.minSpendCents.cell(1550)).toBe('Min €15.50')
  })

  it('singularises, because "Min 1 orders" is the kind of thing an operator screenshots', () => {
    expect(THRESHOLD_SPEC.minOrders.cell(1)).toBe('Min 1 order')
    expect(THRESHOLD_SPEC.minOrders.cell(3)).toBe('Min 3 orders')
  })

  it('accepts an ACoS stored either way, because this account stores both', () => {
    // 🔴 `targetAcos` is `0.3` on most rules and `30` on AIREON — measured, and the reason nothing
    // here may blind-multiply by 100 ([[project_ra_h10_reduction_plan]] trap 3).
    expect(THRESHOLD_SPEC.maxAcosPct.cell(0.3)).toBe('Max 30%')
    expect(THRESHOLD_SPEC.maxAcosPct.cell(30)).toBe('Max 30%')
  })

  it('every declared column has a header, a tip and a sentence for its empty state', () => {
    for (const key of THRESHOLD_ORDER) {
      const s = THRESHOLD_SPEC[key]
      expect(s.column, key).toBeTruthy()
      expect(s.columnTip.length, key).toBeGreaterThan(20)
      // An em dash with no explanation is the decoration this programme removes.
      expect(s.absent.length, key).toBeGreaterThan(20)
    }
  })
})
