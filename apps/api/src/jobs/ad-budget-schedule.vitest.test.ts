/**
 * W4 (2026-08-20) — first tests this executor has ever had. They pin the two pure functions;
 * the write path is exercised on prod by clicking, not here.
 */
import { describe, expect, it } from 'vitest'
import { computeBudget, dateActive } from './ad-budget-schedule.job.js'

describe('computeBudget', () => {
  it('multiplier multiplies the base; 0/absent value means ×1, never ×0', () => {
    expect(computeBudget(10, 'budget-multiplier', undefined, 2)).toBe(20)
    expect(computeBudget(10, 'budget-multiplier', undefined, 0)).toBe(10)
    expect(computeBudget(10, 'budget-multiplier', undefined, undefined)).toBe(10)
  })

  it('campaign-budget: set / incPct / decPct', () => {
    expect(computeBudget(10, 'campaign-budget', 'set', 25)).toBe(25)
    expect(computeBudget(10, 'campaign-budget', 'incPct', 50)).toBe(15)
    expect(computeBudget(10, 'campaign-budget', 'decPct', 30)).toBe(7)
  })

  it('clamps to Amazon’s €1 floor and rounds to cents', () => {
    expect(computeBudget(2, 'campaign-budget', 'decPct', 90)).toBe(1)
    expect(computeBudget(3.333, 'campaign-budget', 'incPct', 10)).toBe(3.67)
  })
})

describe('dateActive', () => {
  const base = { startDate: new Date('2026-08-10'), endDate: new Date('2026-08-30'), neverExpire: false }
  const on = (iso: string) => new Date(`${iso}T09:00:00Z`)

  it('inside the range with no blackouts', () => {
    expect(dateActive({ ...base, excludeDates: [] }, on('2026-08-20'))).toBe(true)
  })

  it('before start and after end are inactive; neverExpire ignores the end', () => {
    expect(dateActive({ ...base, excludeDates: [] }, on('2026-08-09'))).toBe(false)
    expect(dateActive({ ...base, excludeDates: [] }, on('2026-08-31'))).toBe(false)
    expect(dateActive({ ...base, neverExpire: true, excludeDates: [] }, on('2026-09-15'))).toBe(true)
  })

  it('🔴 a blackout range covers its END day inclusively (the W4 fix)', () => {
    const s = { ...base, excludeDates: [{ start: '2026-08-25', end: '2026-08-26' }] }
    expect(dateActive(s, on('2026-08-24'))).toBe(true)
    expect(dateActive(s, on('2026-08-25'))).toBe(false)
    // Before the fix this day was ACTIVE: date-only ISO parses to UTC midnight, "today" is pinned
    // to UTC noon, so `today <= end` failed on the operator's own chosen end date.
    expect(dateActive(s, on('2026-08-26'))).toBe(false)
    expect(dateActive(s, on('2026-08-27'))).toBe(true)
  })

  it('a half-empty or boolean-era excludeDates entry is ignored, never a crash', () => {
    expect(dateActive({ ...base, excludeDates: [{ start: '2026-08-25' }] }, on('2026-08-25'))).toBe(true)
    expect(dateActive({ ...base, excludeDates: true }, on('2026-08-20'))).toBe(true)
  })
})
