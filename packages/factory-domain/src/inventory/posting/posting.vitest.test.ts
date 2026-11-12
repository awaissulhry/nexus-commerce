import { describe, expect, it } from 'vitest'
import { adjustmentAboveLimit, adjustmentLimitLoosened, backDatingLoosened, looseningReasonProblem, postingDateProblem, postingWindow, rulesInForce } from './rules'

const row = (backDatingDays: number | null, adjustmentApprovalAmount: number | null, lowStockAlerts: boolean | null) => ({ backDatingDays, adjustmentApprovalAmount, lowStockAlerts })

describe('warehouse rules: posting dates, the adjustment value, low-stock alerts (B-W2b-314)', () => {
  it('reads each rule from the company, else every company, else its default (as the database does)', () => {
    expect(rulesInForce(row(3, null, null), row(7, 50000, false))).toEqual({
      backDatingDays: { value: 3, source: 'COMPANY' },
      adjustmentApprovalAmount: { value: 50000, source: 'TENANT' },
      lowStockAlerts: { value: false, source: 'TENANT' },
    })
    expect(rulesInForce(undefined, null)).toEqual({
      backDatingDays: { value: null, source: 'DEFAULT' },
      adjustmentApprovalAmount: { value: null, source: 'DEFAULT' },
      lowStockAlerts: { value: true, source: 'DEFAULT' },
    })
  })

  it('allows a posting date from today back to the limit, never after today, the floor only today (SCM-196)', () => {
    expect(postingWindow('2026-11-12', 3)).toEqual({ earliest: '2026-11-09', latest: '2026-11-12' })
    expect(postingWindow('2026-11-12', null).earliest).toBeNull()
    expect(postingDateProblem({ day: '2026-11-09', today: '2026-11-12', backDatingDays: 3 })).toBeNull()
    expect(postingDateProblem({ day: '2026-11-08', today: '2026-11-12', backDatingDays: 3 })).toBe('The posting date 8 Nov 2026 goes back further than the warehouse rules allow (3 days back): the earliest is 9 Nov 2026.')
    expect(postingDateProblem({ day: '2026-11-13', today: '2026-11-12', backDatingDays: null })).toContain('is after today')
    expect(postingDateProblem({ day: '2026-11-11', today: '2026-11-12', backDatingDays: 0 })).toContain('(no day back)')
    expect(postingDateProblem({ day: '2025-01-01', today: '2026-11-12', backDatingDays: null })).toBeNull()
    expect(postingDateProblem({ day: '2026-11-11', today: '2026-11-12', backDatingDays: null, floor: true })).toContain('from the floor')
    expect(postingDateProblem({ day: '2026-02-30', today: '2026-11-12', backDatingDays: null })).toContain('YYYY-MM-DD')
  })

  it('knows a looser rule (it asks the reason and a fresh code)', () => {
    expect(backDatingLoosened(3, 7)).toBe(true)
    expect(backDatingLoosened(3, null)).toBe(true)
    expect(backDatingLoosened(3, 1)).toBe(false)
    expect(backDatingLoosened(null, 3)).toBe(false)
    expect(adjustmentLimitLoosened(50000, 80000)).toBe(true)
    expect(adjustmentLimitLoosened(50000, null)).toBe(true)
    expect(adjustmentLimitLoosened(null, 100)).toBe(false)
    expect(looseningReasonProblem('  ')).toContain('needs the reason')
    expect(looseningReasonProblem('x'.repeat(501))).toContain('500')
    expect(looseningReasonProblem('Year-end count corrections')).toBeNull()
  })

  it('makes an adjustment wait above the value, and one whose value nobody can tell', () => {
    expect(adjustmentAboveLimit({ limit: null, valueAmount: 999999 })).toBe(false)
    expect(adjustmentAboveLimit({ limit: 50000, valueAmount: -50001 })).toBe(true)
    expect(adjustmentAboveLimit({ limit: 50000, valueAmount: 50000 })).toBe(false)
    expect(adjustmentAboveLimit({ limit: 50000, valueAmount: null })).toBe(true)
  })
})
