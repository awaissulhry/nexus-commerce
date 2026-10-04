/**
 * 3d — the one budget-day definition (Owner D2: UTC everywhere). The write gate, budget usage, the pacer, budget
 * schedules and the schedules screen all read these two functions, so these cases are the boundary for all of them.
 */
import { describe, it, expect } from 'vitest'
import { budgetDayKey, budgetDayStart } from './ads-budget-day.js'

const iso = (s: string) => new Date(s)
const romeClock = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)

describe('budgetDayStart — 00:00 UTC on the UTC date', () => {
  it('returns the UTC midnight that starts the day', () => {
    expect(budgetDayStart(iso('2026-08-22T09:57:08.786Z')).toISOString()).toBe('2026-08-22T00:00:00.000Z')
  })

  it('the boundary itself belongs to the new day; the millisecond before it to the old one', () => {
    expect(budgetDayStart(iso('2026-08-22T00:00:00.000Z')).toISOString()).toBe('2026-08-22T00:00:00.000Z')
    expect(budgetDayStart(iso('2026-08-21T23:59:59.999Z')).toISOString()).toBe('2026-08-21T00:00:00.000Z')
  })

  it('🔴 just after Rome midnight it is still the previous budget day (00:30 Rome = 22:30 UTC)', () => {
    expect(budgetDayKey(iso('2026-08-21T22:30:00Z'))).toBe('2026-08-21')
  })
})

describe('budgetDayStart — the clock change on 2026-10-25 does not move the boundary in UTC', () => {
  it('the day of the change is a whole 24 hours, like every other budget day', () => {
    const day = budgetDayStart(iso('2026-10-25T12:00:00Z'))
    const next = budgetDayStart(iso('2026-10-26T12:00:00Z'))
    expect(day.toISOString()).toBe('2026-10-25T00:00:00.000Z')
    expect(next.getTime() - day.getTime()).toBe(86_400_000)
  })

  it('in Rome time the budget day starts at 02:00 before the change and at 01:00 after it', () => {
    expect(romeClock(budgetDayStart(iso('2026-10-24T12:00:00Z')))).toBe('02:00')
    expect(romeClock(budgetDayStart(iso('2026-10-25T12:00:00Z')))).toBe('02:00') // 00:00 UTC is still summer time
    expect(romeClock(budgetDayStart(iso('2026-10-26T12:00:00Z')))).toBe('01:00')
  })

  it('around the change: 01:30 Rome on the 25th is the 24th; 00:30 Rome on the 26th is the 25th', () => {
    expect(budgetDayKey(iso('2026-10-24T23:30:00Z'))).toBe('2026-10-24') // 01:30 CEST, 25 Oct
    expect(budgetDayKey(iso('2026-10-25T00:30:00Z'))).toBe('2026-10-25') // 02:30 CEST, before the clocks go back
    expect(budgetDayKey(iso('2026-10-25T01:30:00Z'))).toBe('2026-10-25') // 02:30 CET, the repeated hour
    expect(budgetDayKey(iso('2026-10-25T23:30:00Z'))).toBe('2026-10-25') // 00:30 CET, 26 Oct
  })
})

describe('the marketplace argument is kept for the record and does not change the result', () => {
  const instants = ['2026-08-21T22:30:00Z', '2026-10-24T23:30:00Z', '2026-10-25T23:30:00Z', '2027-03-28T00:30:00Z']
  for (const at of instants) {
    it(`same day for every market at ${at}`, () => {
      const plain = budgetDayStart(iso(at)).toISOString()
      for (const m of ['IT', 'DE', 'FR', 'ES', 'UK', 'SE', 'PL', 'US', null, undefined]) {
        expect(budgetDayStart(iso(at), m).toISOString()).toBe(plain)
        expect(budgetDayKey(iso(at), m)).toBe(plain.slice(0, 10))
      }
    })
  }
})

describe('budgetDayKey', () => {
  it('pads single-digit months and days', () => {
    expect(budgetDayKey(iso('2026-01-05T12:00:00Z'))).toBe('2026-01-05')
  })

  it('does not depend on the machine time zone (reads UTC parts only)', () => {
    const at = iso('2026-08-21T23:30:00Z')
    expect(budgetDayKey(at)).toBe(at.toISOString().slice(0, 10))
  })
})
