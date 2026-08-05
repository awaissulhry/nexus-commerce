/**
 * ACR.4.3 — which operation row an undo button is wired to.
 *
 * This is the function standing between "undo" and a wrong write to Amazon. The change feed
 * shows CampaignBidHistory rows, which carry no action-log id, so the id has to be joined from
 * the operation row — and on this account the same campaign's budget is rewritten repeatedly
 * within seconds (measured: 36 budget ops on one campaign in six hours, two of them nine
 * seconds apart carrying different values). Proximity alone would hand undo the wrong snapshot,
 * so the match must be exact on BOTH the before and the after value.
 */
import { describe, it, expect } from 'vitest'
import { opMatchesField } from './ads-changes.service.js'

const budgetOp = (before: number, after: number) => ({
  payloadBefore: { name: 'GALE | IT | PAT', dailyBudget: before },
  payloadAfter: { name: 'GALE | IT | PAT', dailyBudget: after },
})
const row = (field: string, oldValue: string | null, newValue: string | null) => ({ field, oldValue, newValue })
const placementOp = (before: Array<[string, number]>, after: Array<[string, number]>) => ({
  payloadBefore: { adjustments: before.map(([placement, percentage]) => ({ placement, percentage })) },
  payloadAfter: { adjustments: after.map(([placement, percentage]) => ({ placement, percentage })) },
})

describe('budgets match on both ends or not at all', () => {
  it('the row its op describes', () => {
    expect(opMatchesField(budgetOp(4.14, 3.31), row('dailyBudget', '4.14', '3.31'), 'AD_BUDGET_UPDATE')).toBe(true)
  })

  /**
   * The measured near-miss: two ops nine seconds apart, 4.14 → 6.46 then 6.46 → 5.17. Nearest-
   * in-time could pick either; only one describes the row, and undoing the other restores 4.14
   * where 6.46 belongs.
   */
  it('a neighbouring op that shares only ONE end does not match', () => {
    const r = row('dailyBudget', '6.46', '5.17')
    expect(opMatchesField(budgetOp(4.14, 6.46), r, 'AD_BUDGET_UPDATE')).toBe(false) // shares the after
    expect(opMatchesField(budgetOp(6.46, 4.14), r, 'AD_BUDGET_UPDATE')).toBe(false) // shares the before
    expect(opMatchesField(budgetOp(6.46, 5.17), r, 'AD_BUDGET_UPDATE')).toBe(true)  // the real one
  })

  /** A budget of zero and an unknown budget are different facts; only placements coerce. */
  it('a null budget is NOT treated as zero', () => {
    expect(opMatchesField(budgetOp(0, 3.31), row('dailyBudget', null, '3.31'), 'AD_BUDGET_UPDATE')).toBe(false)
  })

  it('cents-level differences are respected', () => {
    expect(opMatchesField(budgetOp(4.14, 3.31), row('dailyBudget', '4.14', '3.32'), 'AD_BUDGET_UPDATE')).toBe(false)
  })
})

describe('placements: absent means 0%, in both spellings', () => {
  /**
   * The bug this test exists for. The rank engine writes PARTIAL adjustment lists, so a
   * placement missing from the payload means 0% — and the history row spells the same thing as
   * a null oldValue. Mapping only the payload side refused 96 of 200 rows whose record matched
   * them perfectly.
   */
  it('null on the row equals absent in the payload', () => {
    const op = placementOp([['PLACEMENT_TOP', 6]], [['PLACEMENT_TOP', 6], ['PLACEMENT_REST_OF_SEARCH', 0]])
    expect(opMatchesField(op, row('PLACEMENT_REST_OF_SEARCH', null, '0'), 'update_placement_bidding')).toBe(true)
  })

  it('a real percentage change matches on the named placement only', () => {
    const op = placementOp([['PLACEMENT_TOP', 3], ['PLACEMENT_REST_OF_SEARCH', 45]], [['PLACEMENT_TOP', 6], ['PLACEMENT_REST_OF_SEARCH', 0]])
    expect(opMatchesField(op, row('PLACEMENT_TOP', '3', '6'), 'update_placement_bidding')).toBe(true)
    expect(opMatchesField(op, row('PLACEMENT_REST_OF_SEARCH', '45', '0'), 'update_placement_bidding')).toBe(true)
    // The same op does NOT describe a placement it never touched at those values.
    expect(opMatchesField(op, row('PLACEMENT_TOP', '45', '0'), 'update_placement_bidding')).toBe(false)
  })

  it('45 → 0 is a real change, not an absence', () => {
    const op = placementOp([['PLACEMENT_REST_OF_SEARCH', 45]], [['PLACEMENT_TOP', 75]])
    expect(opMatchesField(op, row('PLACEMENT_REST_OF_SEARCH', '45', '0'), 'update_placement_bidding')).toBe(true)
  })
})

describe('anything unrecognised refuses rather than guesses', () => {
  it('an action type with no matching rule never pairs', () => {
    expect(opMatchesField(budgetOp(1, 2), row('dailyBudget', '1', '2'), 'some_other_action')).toBe(false)
  })
  it('a missing payload never pairs', () => {
    expect(opMatchesField({ payloadBefore: null, payloadAfter: { dailyBudget: 3 } }, row('dailyBudget', '1', '3'), 'AD_BUDGET_UPDATE')).toBe(false)
  })
})
