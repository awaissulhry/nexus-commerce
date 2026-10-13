import { describe, expect, it } from 'vitest'

import { ago, formatGridValue, when, type GridValueKind } from './format'

const KINDS: GridValueKind[] = ['integer', 'money', 'money2', 'eur', 'percent', 'delta', 'date', 'text']

describe('formatGridValue — a null is never a zero', () => {
  it.each(KINDS)('%s: null / undefined / NaN are EMPTY (dash, no title), never "0"', (kind) => {
    for (const v of [null, undefined, Number.NaN, '']) {
      const f = formatGridValue(kind, v)
      expect(f.empty).toBe(true)
      expect(f.measuredZero).toBe(false)
      expect(f.text).toBe('')
    }
  })

  it.each(['integer', 'money', 'money2', 'eur', 'percent', 'delta'] as const)('%s: a measured zero is NOT empty', (kind) => {
    const f = formatGridValue(kind, 0)
    expect(f.empty).toBe(false)
    expect(f.measuredZero).toBe(false)
    expect(f.text).not.toBe('')
  })

  it('zero:"dash" keeps the distinction — measuredZero, not empty', () => {
    const f = formatGridValue('money', 0, { zero: 'dash' })
    expect(f).toEqual({ text: '', empty: false, measuredZero: true })
    // and a null under the same option is still just empty
    expect(formatGridValue('money', null, { zero: 'dash' })).toEqual({ text: '', empty: true, measuredZero: false })
  })

  it('formats through design-system/lib only', () => {
    expect(formatGridValue('integer', 12345).text).toBe('12,345')
    expect(formatGridValue('money', 123456).text).toBe('€1,235')
    expect(formatGridValue('money2', 123456).text).toBe('€1,234.56')
    expect(formatGridValue('eur', 74.95).text).toBe('€74.95')
    expect(formatGridValue('eur', 1234.5).text).toBe('€1,234.50')
    expect(formatGridValue('percent', 0.1534).text).toBe('15.3%')
    expect(formatGridValue('percent', 0.1534, { dp: 2 }).text).toBe('15.34%')
    expect(formatGridValue('delta', 12).text).toBe('+12')
    expect(formatGridValue('delta', -4).text).toBe('−4')
    expect(formatGridValue('delta', 0).text).toBe('0')
    expect(formatGridValue('text', 'abc').text).toBe('abc')
  })

  it('a numeric string is a number; a non-numeric string in a number column is EMPTY, not 0', () => {
    expect(formatGridValue('integer', '42').text).toBe('42')
    expect(formatGridValue('integer', 'n/a').empty).toBe(true)
  })

  it('date: an unparseable value is EMPTY', () => {
    expect(formatGridValue('date', 'not a date').empty).toBe(true)
    expect(formatGridValue('date', '2026-08-28T10:00:00Z').empty).toBe(false)
  })
})

describe('when / ago — the same English in every browser (grid audit step 5, Owner 2026-10-13)', () => {
  /** An Italian browser: a date or a relative time formatted WITHOUT a locale comes out in Italian. */
  const asItalianBrowser = (run: () => void) => {
    const RTF = Intl.RelativeTimeFormat
    const toLocale = Date.prototype.toLocaleString
    class ItalianRTF extends RTF {
      constructor(locales?: Intl.LocalesArgument, options?: Intl.RelativeTimeFormatOptions) { super(locales ?? 'it-IT', options) }
    }
    const setRTF = (value: typeof Intl.RelativeTimeFormat) => Object.defineProperty(Intl, 'RelativeTimeFormat', { value, configurable: true, writable: true })
    setRTF(ItalianRTF as typeof Intl.RelativeTimeFormat)
    Date.prototype.toLocaleString = function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return toLocale.call(this, locales ?? 'it-IT', options)
    }
    try { run() } finally { setRTF(RTF); Date.prototype.toLocaleString = toLocale }
  }
  // Built in the test's own time zone, so the expected words hold in any zone (`when` shows the viewer's zone).
  const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).toISOString()

  it('when: "13 Oct 2026, 09:30" — 24-hour, with the year, never the browser\'s words', () => {
    asItalianBrowser(() => {
      expect(new Date(2026, 9, 13).toLocaleString()).toMatch(/13\/10\/2026/) // the stub is in force
      expect(when(at(2026, 9, 13, 9, 30))).toBe('13 Oct 2026, 09:30')
      expect(when(at(2025, 8, 1, 17, 5))).toBe('1 Sep 2025, 17:05') // "Sep", never CLDR's "Sept"
      expect(when(at(2026, 0, 31, 0, 0))).toBe('31 Jan 2026, 00:00')
    })
  })

  it('ago: English words in every browser', () => {
    const NOW = Date.parse('2026-09-02T12:00:00.000Z')
    asItalianBrowser(() => {
      expect(new Intl.RelativeTimeFormat(undefined).format(-3, 'hour')).toBe('3 ore fa') // the stub is in force
      expect(ago('2026-09-02T09:00:00.000Z', NOW)).toBe('3 hours ago')
      expect(ago('2026-09-01T12:00:00.000Z', NOW)).toBe('yesterday')
      expect(ago('2026-09-02T12:05:00.000Z', NOW)).toBe('in 5 minutes')
    })
  })
})
