/**
 * AM-36 — one date vocabulary on the ads screens.
 *
 *  · Weeks start MONDAY, as the server's `wtd` does: "This Week" / "Last Week" and the calendar's columns started on
 *    Sunday in the picker, so on a Sunday "This Week" was one day in the browser and seven on the server.
 *  · Reporting's Business and Explorer windows are complete LOCAL days ending yesterday (the AM-16 rule, the picker's
 *    vocabulary); they were UTC days running into today.
 *  · The Budget Manager opens on the month of today's BUDGET day, which runs 00:00–24:00 UTC (the engine's).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { presetRange } from './DateRangePicker'
import { completeDaysWindow, defaultRange, isoDay } from '../reporting/report-api'
import { budgetMonthOf } from '../budget-manager/budgetMonth'

const day = (d: Date) => isoDay(d)

describe('weeks start on Monday', () => {
  afterEach(() => { vi.useRealTimers() })

  it('"This Week" on a Wednesday runs Monday to today', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 15, 0)) // Wed 7 Oct 2026, local
    const r = presetRange('thisWeek')
    expect([day(r.start), day(r.end)]).toEqual(['2026-10-05', '2026-10-07'])
  })

  it('"This Week" on a Sunday is the whole week from Monday, not one day', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 11, 9, 0)) // Sun 11 Oct 2026
    const r = presetRange('thisWeek')
    expect([day(r.start), day(r.end)]).toEqual(['2026-10-05', '2026-10-11']) // was 11 → 11
  })

  it('"Last Week" is the Monday-to-Sunday week before', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 15, 0)) // Wed 7 Oct
    const r = presetRange('lastWeek')
    expect([day(r.start), day(r.end)]).toEqual(['2026-09-28', '2026-10-04']) // was Sun 27 Sep – Sat 3 Oct
    vi.setSystemTime(new Date(2026, 9, 11, 9, 0)) // Sun 11 Oct
    const s = presetRange('lastWeek')
    expect([day(s.start), day(s.end)]).toEqual(['2026-09-28', '2026-10-04'])
  })
})

describe('Reporting windows are complete local days ending yesterday', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('N days that end yesterday, never today', () => {
    const now = new Date(2026, 9, 6, 0, 30) // 00:30 local: UTC would still be the 5th in Rome
    expect(completeDaysWindow(56, now)).toEqual({ from: '2026-08-11', to: '2026-10-05' })
    expect(completeDaysWindow(1, now)).toEqual({ from: '2026-10-05', to: '2026-10-05' })
  })

  it('the runner’s default is the same rule (30 complete days)', () => {
    vi.setSystemTime(new Date(2026, 9, 6, 12, 0))
    expect(defaultRange()).toEqual({ from: '2026-09-06', to: '2026-10-05' })
  })
})

describe('the Budget Manager month is the budget day’s month (UTC)', () => {
  it('00:30 Rome on the 1st is still the previous budget month', () => {
    expect(budgetMonthOf(new Date('2026-11-01T00:30:00+01:00'))).toBe('2026-10') // 31 Oct 23:30 UTC
    expect(budgetMonthOf(new Date('2026-11-01T01:30:00+01:00'))).toBe('2026-11')
  })
})
