import { describe, expect, it } from 'vitest'
import { closeDayRefusal, DAY_SHEET_LOOKBACK_DAYS, handOverWindow, inSheetOrder, sheetFileName, sheetFingerprint, sheetTotals } from './rules'

describe("the day's close (LOG-049)", () => {
  it('closes today and the days before within the look-back, never a day to come', () => {
    expect(closeDayRefusal('2026-11-16', '2026-11-16')).toBeNull()
    expect(closeDayRefusal('2026-11-09', '2026-11-16')).toBeNull()
    expect(closeDayRefusal('2026-11-17', '2026-11-16')?.code).toBe('FUTURE_DAY')
    expect(closeDayRefusal('2026-11-08', '2026-11-16')?.code).toBe('TOO_OLD')
    expect(DAY_SHEET_LOOKBACK_DAYS).toBe(7)
  })

  it("takes the shipments that left that day, and late hand-overs of the days before (the site's zone)", () => {
    const window = handOverWindow('2026-11-16', 'Europe/Rome')
    expect(window.from.toISOString()).toBe('2026-11-09T23:00:00.000Z')
    expect(window.until.toISOString()).toBe('2026-11-16T23:00:00.000Z')
  })

  it('totals parcels and weight, prints by number, fingerprints what it holds whatever the order', () => {
    expect(sheetTotals([{ parcels: 2, weightKg: '3.250' }, { parcels: 1, weightKg: '0.755' }])).toEqual({ shipments: 2, parcels: 3, weightKg: '4.005' })
    expect(sheetTotals([])).toEqual({ shipments: 0, parcels: 0, weightKg: '0.000' })
    expect(inSheetOrder([{ number: 'SH-0010' }, { number: 'SH-0002' }]).map((row) => row.number)).toEqual(['SH-0002', 'SH-0010'])
    expect(sheetFingerprint('brt', '2026-11-16', ['b', 'a'])).toBe(sheetFingerprint('brt', '2026-11-16', ['a', 'b']))
    expect(sheetFingerprint('brt', '2026-11-16', ['a'])).not.toBe(sheetFingerprint('gls', '2026-11-16', ['a']))
    expect(sheetFileName('A1', 'seed express', '2026-11-16')).toBe('manifest-A1-seed-express-2026-11-16.pdf')
  })
})
