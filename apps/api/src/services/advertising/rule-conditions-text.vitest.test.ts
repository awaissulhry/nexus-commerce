/**
 * Rules have TWO stored shapes (engine-flat and builder-nested), and this formatter is the one
 * human reading of both. The builder shape reached it for the first time on 2026-08-21 via the
 * Suggestions queue and it printed "? ? undefined" at the operator — the group object hit the
 * leaf path. These cases pin both shapes so neither reading regresses.
 */
import { describe, it, expect } from 'vitest'
import { conditionsTextOf } from './rule-conditions-text.js'

describe('conditionsTextOf', () => {
  it('reads a builder-nested group in the builder’s own display units', () => {
    expect(conditionsTextOf([{
      match: 'all', exclude: 'Last 2 Days', lookback: 'Last 30 Days',
      conditions: [
        { op: 'gte', value: '2', metric: 'PPC Orders' },
        { op: 'lte', value: '30', metric: 'ACOS' },
      ],
    }])).toBe('PPC Orders ≥ 2 and ACoS ≤ 30%')
  })

  it('reads engine-flat storage units exactly as before (D2d)', () => {
    expect(conditionsTextOf([
      { field: 'campaign.acos', operator: 'lte', value: 0.2 },
      { field: 'adTarget.spendCents', operator: 'gte', value: 5000 },
    ])).toBe('ACoS ≤ 20% and Target spend ≥ €50')
  })

  it('joins an "any" group with or, parenthesised', () => {
    expect(conditionsTextOf([{
      match: 'any',
      conditions: [{ metric: 'ACOS', op: 'gt', value: '40' }, { metric: 'Spend', op: 'gte', value: '50' }],
    }])).toBe('(ACoS > 40% or Spend ≥ €50)')
  })

  it('keeps the ugly truth for an unmapped path, and the empty sentence', () => {
    expect(conditionsTextOf([{ field: 'weird.path', operator: 'eq', value: 1 }])).toBe('weird.path = 1')
    expect(conditionsTextOf([])).toBe('No conditions — matches every context')
    expect(conditionsTextOf(null)).toBe('No conditions — matches every context')
  })
})
