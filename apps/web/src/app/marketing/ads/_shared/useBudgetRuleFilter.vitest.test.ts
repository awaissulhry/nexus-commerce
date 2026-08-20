import { describe, it, expect } from 'vitest'
import { filterBudgetRules, type FilterableRule } from './useBudgetRuleFilter'

const R = (id: string, name: string, level: string, condition: string, delta: string): FilterableRule =>
  ({ id, name, level, condition, delta })

/** The six rules this account actually has, with the wording the modal renders. */
const RULES = [
  R('a', 'Campaign ACOS rebalance (cut + scale)', 'AUTO', 'ACoS ≥ 50%', '−20%'),
  R('b', 'Trim budget on weak ACOS', 'AUTO', 'ACoS ≥ 40% and Spend ≥ €50', '−15%'),
  R('c', 'Boost budget on profitable campaigns', 'PROPOSE', 'ACoS ≤ 20% and Target spend ≥ €50', '+15%'),
  R('d', 'Scale budget-capped winners', 'PROPOSE', 'ROAS ≥ 4× and Budget used ≥ 85%', '+20%'),
  R('e', 'Scale budget on ROAS winners', 'OFF', 'ROAS ≥ 5× and Budget used ≥ 90%', '+25%'),
  R('f', 'Trim budget on weak ACOS', 'OFF', 'ACoS ≥ 40% and Spend ≥ €50', '−15%'),
]
const assignedAll = () => true
const ids = (rs: FilterableRule[]) => rs.map((r) => r.id)

describe('filterBudgetRules', () => {
  it('returns everything with no query and the All segment', () => {
    expect(ids(filterBudgetRules(RULES, '', 'all', assignedAll))).toHaveLength(6)
  })

  it('matches THRESHOLDS inside the criteria, not just names', () => {
    // The handoff's headline example, and the reason the haystack includes the condition:
    // typing 50 must find "ACoS ≥ 50%" as well as "Spend ≥ €50".
    expect(ids(filterBudgetRules(RULES, '50', 'all', assignedAll))).toEqual(['a', 'b', 'c', 'f'])
  })

  it('matches the delta too', () => {
    expect(ids(filterBudgetRules(RULES, '+25', 'all', assignedAll))).toEqual(['e'])
  })

  it('is case-insensitive and trimmed', () => {
    expect(ids(filterBudgetRules(RULES, '  ROAS  ', 'all', assignedAll)))
      .toEqual(ids(filterBudgetRules(RULES, 'roas', 'all', assignedAll)))
  })

  it('segments by mode', () => {
    expect(ids(filterBudgetRules(RULES, '', 'AUTO', assignedAll))).toEqual(['a', 'b'])
    expect(ids(filterBudgetRules(RULES, '', 'PROPOSE', assignedAll))).toEqual(['c', 'd'])
  })

  it('the Active segment reads ASSIGNMENT, not the rule mode', () => {
    // A rule can be switched OFF and still be assigned, and an AUTO rule can be unassigned —
    // conflating the two is the whole reason assignment exists as its own concept here.
    const assigned = new Set(['a', 'f'])
    expect(ids(filterBudgetRules(RULES, '', 'on', (id) => assigned.has(id)))).toEqual(['a', 'f'])
  })

  it('composes query AND segment', () => {
    expect(ids(filterBudgetRules(RULES, 'trim', 'AUTO', assignedAll))).toEqual(['b'])
    expect(ids(filterBudgetRules(RULES, 'trim', 'PROPOSE', assignedAll))).toEqual([])
  })

  it('returns nothing for a query that matches nothing', () => {
    expect(filterBudgetRules(RULES, 'zzzz', 'all', assignedAll)).toEqual([])
  })
})
