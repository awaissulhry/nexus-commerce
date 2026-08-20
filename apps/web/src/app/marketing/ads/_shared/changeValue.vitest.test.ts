import { describe, expect, it } from 'vitest'
import { fmtChangeValue } from './changeValue'

describe('fmtChangeValue', () => {
  it('🔴 the operator’s row: a bid stored "35" → "2" is €0.35 → €0.02, never "35 → 2"', () => {
    expect(fmtChangeValue('35', 'bid')).toBe('€0.35')
    expect(fmtChangeValue('2', 'bid')).toBe('€0.02')
    expect(fmtChangeValue('2', 'defaultBid')).toBe('€0.02')
  })

  it('dailyBudget is ALREADY euros — no second division', () => {
    expect(fmtChangeValue('12.5', 'dailyBudget')).toBe('€12.50')
    expect(fmtChangeValue('4', 'dailyBudget')).toBe('€4.00')
  })

  it('placement lanes are percents', () => {
    expect(fmtChangeValue('150', 'PLACEMENT_TOP')).toBe('150%')
  })

  it('unknown fields print as stored; null is a dash; junk in a cents field stays verbatim', () => {
    expect(fmtChangeValue('ENABLED', 'state')).toBe('ENABLED')
    expect(fmtChangeValue(null, 'bid')).toBe('—')
    expect(fmtChangeValue('n/a', 'bid')).toBe('n/a')
  })
})
