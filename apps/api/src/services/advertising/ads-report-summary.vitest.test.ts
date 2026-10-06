/**
 * AM-16 — Reporting's "vs previous period" compares COMPLETE days on both sides. A window that runs into today is
 * compared on its days through yesterday, against the same number of days just before them.
 */
import { describe, expect, it } from 'vitest'
import { comparedWindow, comparisonWindow } from './ads-report-summary.service.js'

const LAST = '2026-10-04' // yesterday

describe('comparedWindow + comparisonWindow (complete days only)', () => {
  it('a window of complete days is compared whole, with the equal block before it', () => {
    const c = comparedWindow('previous', '2026-09-05', '2026-10-04', LAST)
    expect(c).toEqual({ from: '2026-09-05', to: '2026-10-04', todayLeftOut: false })
    expect(comparisonWindow('previous', c!.from, c!.to)).toEqual({ from: '2026-08-06', to: '2026-09-04' })
  })

  it('a window ending today leaves today out of BOTH sides — 30 days set against 30, not 31', () => {
    const c = comparedWindow('previous', '2026-09-05', '2026-10-05', LAST)
    expect(c).toEqual({ from: '2026-09-05', to: '2026-10-04', todayLeftOut: true })
    expect(comparisonWindow('previous', c!.from, c!.to)).toEqual({ from: '2026-08-06', to: '2026-09-04' })
  })

  it('year over year shifts the same complete days', () => {
    const c = comparedWindow('yoy', '2026-10-01', '2026-10-05', LAST)
    expect(comparisonWindow('yoy', c!.from, c!.to)).toEqual({ from: '2025-10-01', to: '2025-10-04' })
  })

  it('today alone, or no comparison asked: nothing to compare', () => {
    expect(comparedWindow('previous', '2026-10-05', '2026-10-05', LAST)).toBeNull()
    expect(comparedWindow('none', '2026-09-05', '2026-10-04', LAST)).toBeNull()
  })
})
