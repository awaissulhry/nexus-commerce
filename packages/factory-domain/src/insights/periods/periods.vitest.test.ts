import { describe, expect, it } from 'vitest'
import { hoursOfDay, isoWeekOf, periodOf, periodsBack, shiftOfHour, shiftWindows } from './periods'

describe('periods aligned to calendars (ANA-028)', () => {
  it('cuts weeks Monday to Sunday in the ISO week-year, months and quarters on the calendar', () => {
    expect(periodOf('WEEK', '2026-11-14')).toEqual({ kind: 'WEEK', key: '2026-W46', from: '2026-11-09', to: '2026-11-15' })
    // 1 January 2027 is a Friday: it belongs to the last ISO week of 2026.
    expect(periodOf('WEEK', '2027-01-01').key).toBe('2026-W53')
    expect(isoWeekOf('2026-01-01')).toEqual({ year: 2026, week: 1 })
    expect(periodOf('MONTH', '2028-02-10')).toEqual({ kind: 'MONTH', key: '2028-02', from: '2028-02-01', to: '2028-02-29' })
    expect(periodOf('QUARTER', '2026-11-14')).toEqual({ kind: 'QUARTER', key: '2026-Q4', from: '2026-10-01', to: '2026-12-31' })
    expect(periodOf('YEAR', '2026-11-14')).toMatchObject({ key: '2026', from: '2026-01-01', to: '2026-12-31' })
    expect(periodOf('DAY', '2026-11-14')).toMatchObject({ key: '2026-11-14', from: '2026-11-14', to: '2026-11-14' })
  })

  it('cuts fiscal years and quarters from the company’s start month, named by the year they start in', () => {
    expect(periodOf('FISCAL_YEAR', '2026-11-14', 1)).toMatchObject({ key: 'FY2026', from: '2026-01-01', to: '2026-12-31' })
    expect(periodOf('FISCAL_YEAR', '2026-03-31', 4)).toMatchObject({ key: 'FY2025', from: '2025-04-01', to: '2026-03-31' })
    expect(periodOf('FISCAL_YEAR', '2026-04-01', 4)).toMatchObject({ key: 'FY2026', from: '2026-04-01', to: '2027-03-31' })
    expect(periodOf('FISCAL_QUARTER', '2026-11-14', 7)).toMatchObject({ key: 'FY2026-Q2', from: '2026-10-01', to: '2026-12-31' })
    expect(periodOf('FISCAL_QUARTER', '2027-01-05', 7)).toMatchObject({ key: 'FY2026-Q3', from: '2027-01-01', to: '2027-03-31' })
    expect(() => periodOf('FISCAL_YEAR', '2026-01-01', 13)).toThrow(RangeError)
  })

  it('lists the periods back from a day', () => {
    const twelve = periodsBack('MONTH', '2026-11-14', 12)
    expect(twelve).toHaveLength(12)
    expect(twelve[0]!.key).toBe('2025-12')
    expect(twelve.at(-1)!.key).toBe('2026-11')
    expect(periodsBack('WEEK', '2026-11-14', 3).map((period) => period.key)).toEqual(['2026-W44', '2026-W45', '2026-W46'])
    expect(() => periodsBack('DAY', '2026-11-14', 0)).toThrow(RangeError)
  })

  it('cuts days at the local midnight: 23 hours in March, 25 in October, whole hours of the site’s clock', () => {
    expect(hoursOfDay('2026-03-29', 'Europe/Rome')).toHaveLength(23)
    expect(hoursOfDay('2026-10-25', 'Europe/Rome')).toHaveLength(25)
    expect(hoursOfDay('2026-11-14', 'Europe/Rome')[0]!.toISOString()).toBe('2026-11-13T23:00:00.000Z')
    // A zone half an hour off UTC: its hours start on the half hour.
    expect(hoursOfDay('2026-11-14', 'Asia/Kolkata')[0]!.toISOString()).toBe('2026-11-13T18:30:00.000Z')
  })

  it('puts an hour in the shift it belongs to, a night shift on the day it started', () => {
    const windows = shiftWindows([
      { date: '2026-11-13', shifts: [{ label: null, start: new Date('2026-11-13T05:00:00Z'), end: new Date('2026-11-13T13:00:00Z') }, { label: 'Night', start: new Date('2026-11-13T21:00:00Z'), end: new Date('2026-11-14T05:00:00Z') }] },
    ])
    expect(windows.map((window) => window.label)).toEqual(['1', 'Night'])
    expect(shiftOfHour(new Date('2026-11-14T02:00:00Z'), windows)).toMatchObject({ day: '2026-11-13', label: 'Night' })
    expect(shiftOfHour(new Date('2026-11-13T14:00:00Z'), windows)).toBeNull()
  })
})
