import { describe, it, expect } from 'vitest'
import { projectMonthEnd, budgetUtilizationPct } from './ebay-ads-dashboard.service.js'

// ER3.3 — protects the pacing maths shown on the dashboard.

describe('projectMonthEnd — straight-line projection', () => {
  it('mid-month: scales MTD by days-in-month / day-of-month', () => {
    // 2026-07-10 in a 31-day month, €100 MTD → €310 projected
    expect(projectMonthEnd(10_000, new Date('2026-07-10T12:00:00Z'))).toBe(31_000)
  })
  it('day 1 projects ×daysInMonth', () => {
    expect(projectMonthEnd(500, new Date('2026-07-01T08:00:00Z'))).toBe(500 * 31)
  })
  it('last day ≈ MTD (February non-leap)', () => {
    expect(projectMonthEnd(2_800, new Date('2026-02-28T23:00:00Z'))).toBe(2_800)
  })
  it('zero MTD stays zero', () => {
    expect(projectMonthEnd(0, new Date('2026-07-15T00:00:00Z'))).toBe(0)
  })
})

describe('budgetUtilizationPct', () => {
  it('yesterday fees vs summed daily budgets, 0.1% precision', () => {
    expect(budgetUtilizationPct(4_500, 10_000)).toBe(45)
    expect(budgetUtilizationPct(333, 10_000)).toBe(3.3)
  })
  it('null when no CPC budgets exist (never divide by zero)', () => {
    expect(budgetUtilizationPct(1_000, 0)).toBeNull()
  })
  it('can exceed 100% (eBay may spend 2× a day)', () => {
    expect(budgetUtilizationPct(15_000, 10_000)).toBe(150)
  })
})
