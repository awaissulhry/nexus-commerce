import { describe, expect, it } from 'vitest'
import { currencyOf, currencySymbol, dayWords, money, moneyText, periodWord, relWords, signedMoney, WEEK, whenWords } from './format'

describe('time, on the business\'s clock (Rome)', () => {
  it('says a moment as "10 Oct, 23:00" in Rome, whatever the browser\'s zone', () => {
    expect(whenWords('2026-10-10T21:00:00Z')).toBe('10 Oct, 23:00') // CEST, UTC+2
    expect(whenWords('2026-12-01T07:05:00Z')).toBe('1 Dec, 08:05') // CET, UTC+1
    expect(whenWords('2026-09-13T07:30:00Z')).toBe('13 Sep, 09:30') // "Sep", never CLDR's "Sept" (grid audit step 5)
    expect(whenWords(null)).toBe('—')
    expect(whenWords('not a date')).toBe('—')
  })

  it('says a day as "3 Oct": a plain day as written, a moment as its day in Rome', () => {
    expect(dayWords('2026-10-03')).toBe('3 Oct')
    expect(dayWords('2026-10-10T22:30:00Z')).toBe('11 Oct') // already the 11th in Rome
    expect(dayWords(undefined)).toBe('—')
  })

  it('says how long ago in one unit, always with "ago" (or "in" ahead)', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    expect(relWords('2026-10-10T11:59:40Z', now)).toBe('now')
    expect(relWords('2026-10-10T11:15:00Z', now)).toBe('45 min ago')
    expect(relWords('2026-10-10T08:30:00Z', now)).toBe('3 h ago')
    expect(relWords('2026-10-08T13:00:00Z', now)).toBe('47 h ago')
    expect(relWords('2026-09-24T12:00:00Z', now)).toBe('16 d ago')
    expect(relWords('2026-10-10T12:20:00Z', now)).toBe('in 20 min')
    expect(relWords(null, now)).toBe('—')
  })
})

describe('money, in the row\'s own currency', () => {
  it('bills a market in its own money: euros by default, pounds in the UK', () => {
    expect(currencyOf('IT')).toBe('EUR')
    expect(currencyOf('de')).toBe('EUR')
    expect(currencyOf('UK')).toBe('GBP')
    expect(currencyOf(null)).toBe('EUR')
  })

  it('never prints a bare number', () => {
    expect(money(15, 'EUR')).toBe('€0.15')
    expect(money(15, 'GBP')).toBe('£0.15')
    expect(moneyText(1234, 'EUR')).toBe('€12.34')
    expect(moneyText(undefined, 'EUR')).toBe('—')
    expect(moneyText(null, 'EUR')).toBe('—')
    expect(signedMoney(-3, 'EUR')).toBe('−€0.03')
    expect(signedMoney(5, 'GBP')).toBe('+£0.05')
    expect(signedMoney(0, 'EUR')).toBe('±€0.00')
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('GBP')).toBe('£')
  })
})

describe('the period', () => {
  it('is "7 d" everywhere', () => {
    expect(WEEK).toBe('7 d')
    expect(periodWord(14)).toBe('14 d')
  })
})
