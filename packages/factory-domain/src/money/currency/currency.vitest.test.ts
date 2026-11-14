import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { convertMinor, convertUnit, sumPerCurrency, totalIn } from './convert'
import { addCurrencyProblem, isDocumentCurrency, minorUnitsOf, switchOffProblem } from './currencies'
import { ecbFileOf, parseEcbFile } from './ecb'
import { CURRENCIES_MANAGE, CURRENCIES_VIEW } from './permissions'
import { addDays, dayRateFrom, dayRowsOf, farFromEcb, inverseRate, manualRateProblem, normalRate, pairsFor, rateKey, rateWords, type RateRow } from './rates'

/** Every figure below is worked out by hand; the rates are made up. */
const ecb = (quote: string, rateDate: string, rate: string): RateRow => ({ base: 'EUR', quote, rateDate, rate, source: 'ECB' })
const manual = (base: string, quote: string, rateDate: string, rate: string): RateRow => ({ base, quote, rateDate, rate, source: 'MANUAL' })

describe('document currencies', () => {
  it('offers the euro and the ECB list, refuses one already on, never switches the base off', () => {
    expect(addCurrencyProblem('USD', [])).toBeNull()
    expect(addCurrencyProblem('usd', [])).toMatch(/three capital letters/)
    expect(addCurrencyProblem('BGN', [])).toMatch(/no ECB reference rate/)
    expect(addCurrencyProblem('USD', [{ code: 'USD', active: true }])).toMatch(/already/)
    expect(addCurrencyProblem('USD', [{ code: 'USD', active: false }])).toBeNull()
    expect(switchOffProblem('EUR', 'EUR')).toMatch(/never switched off/)
    expect(switchOffProblem('USD', 'EUR')).toBeNull()
    expect(minorUnitsOf('JPY')).toBe(0)
    expect(minorUnitsOf('USD')).toBe(2)
    expect(isDocumentCurrency('EUR', 'EUR', [])).toBe(true)
    expect(isDocumentCurrency('USD', 'EUR', ['GBP'])).toBe(false)
  })
})

describe('the day rate', () => {
  const rows = [ecb('USD', '2026-11-10', '1.0800'), ecb('USD', '2026-11-12', '1.0850'), manual('EUR', 'USD', '2026-11-12', '1.0900'), ecb('GBP', '2026-11-12', '0.8500'), ecb('JPY', '2026-11-03', '160.00')]

  it('takes the latest day on or before, the manual rate winning on its day', () => {
    expect(dayRateFrom(rows, 'EUR', 'USD', '2026-11-12')).toEqual({ base: 'EUR', quote: 'USD', rate: '1.09000000', rateDate: '2026-11-12', source: 'MANUAL', how: 'STORED' })
    expect(dayRateFrom(rows, 'EUR', 'USD', '2026-11-11')).toMatchObject({ rate: '1.08000000', rateDate: '2026-11-10', source: 'ECB' })
    // Saturday 14 takes Thursday 12; a week later nothing is near enough.
    expect(dayRateFrom(rows, 'EUR', 'USD', '2026-11-14')).toMatchObject({ rateDate: '2026-11-12' })
    expect(dayRateFrom(rows, 'EUR', 'USD', '2026-11-20')).toBeNull()
    expect(dayRateFrom(rows, 'EUR', 'JPY', '2026-11-10')).toMatchObject({ rate: '160.00000000', rateDate: '2026-11-03' })
    expect(dayRateFrom(rows, 'EUR', 'JPY', '2026-11-11')).toBeNull()
    expect(dayRateFrom(rows, 'EUR', 'USD', '2026-11-09')).toBeNull()
  })

  it('reads a rate the other way round and across the euro', () => {
    // 1 ÷ 1.09 = 0.917431192… → 0.91743119.
    expect(dayRateFrom(rows, 'USD', 'EUR', '2026-11-12')).toEqual({ base: 'USD', quote: 'EUR', rate: '0.91743119', rateDate: '2026-11-12', source: 'MANUAL', how: 'INVERSE' })
    // GBP→USD = 1.09 ÷ 0.85 = 1.282352941… → 1.28235294.
    expect(dayRateFrom(rows, 'GBP', 'USD', '2026-11-12')).toEqual({ base: 'GBP', quote: 'USD', rate: '1.28235294', rateDate: '2026-11-12', source: 'MANUAL', how: 'CROSS' })
    // Across the euro dated the older leg: USD of the 10th, GBP of the 12th → none for the 11th (GBP has no rate yet).
    expect(dayRateFrom(rows, 'GBP', 'USD', '2026-11-11')).toBeNull()
    expect(dayRateFrom(rows, 'EUR', 'EUR', '2026-11-11')).toMatchObject({ rate: '1.00000000' })
    expect(pairsFor('GBP', 'USD')).toHaveLength(6)
    expect(pairsFor('EUR', 'USD')).toHaveLength(2)
  })

  it('checks a manual rate and words it', () => {
    expect(normalRate('1.085')).toBe('1.08500000')
    expect(normalRate('0')).toBeNull()
    expect(normalRate('1.123456789')).toBeNull()
    expect(normalRate('1,08')).toBeNull()
    expect(manualRateProblem({ base: 'EUR', quote: 'USD', day: '2026-11-15', rate: '1.08' }, '2026-11-14')).toMatchObject({ path: 'day' })
    expect(manualRateProblem({ base: 'EUR', quote: 'EUR', day: '2026-11-14', rate: '1.08' }, '2026-11-14')).toMatchObject({ path: 'quote' })
    expect(manualRateProblem({ base: 'EUR', quote: 'USD', day: '2026-11-14', rate: '-1' }, '2026-11-14')).toMatchObject({ path: 'rate' })
    expect(manualRateProblem({ base: 'EUR', quote: 'USD', day: '2026-11-14', rate: '1.0850' }, '2026-11-14')).toBeNull()
    expect(rateWords({ base: 'EUR', quote: 'USD', rate: '1.08500000' })).toBe('1 EUR = 1.085 USD')
    expect(inverseRate('1.25')).toBe('0.80000000')
    expect(rateKey({ base: 'EUR', quote: 'USD', rateDate: '2026-11-12', source: 'MANUAL' })).toBe('EUR:USD:2026-11-12:MANUAL')
    expect(farFromEcb('1.20', '1.08')).toBe(true)
    expect(farFromEcb('1.10', '1.08')).toBe(false)
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('groups the table per day with the rate the documents take', () => {
    expect(dayRowsOf(rows).slice(0, 2)).toEqual([
      { base: 'EUR', quote: 'GBP', rateDate: '2026-11-12', ecb: '0.8500', manual: null, rate: '0.8500', source: 'ECB' },
      { base: 'EUR', quote: 'USD', rateDate: '2026-11-12', ecb: '1.0850', manual: '1.0900', rate: '1.0900', source: 'MANUAL' },
    ])
  })
})

describe('converting and totals', () => {
  const usd = { base: 'EUR', quote: 'USD', rate: '1.08500000' }

  it('converts once, half up, at the target minor unit', () => {
    // 7,200 US cents ÷ 1.085 = 6,635.94… euro cents → 6,636.
    expect(convertMinor(7200, 'USD', 'EUR', usd)).toBe(6636)
    // 100.00 EUR × 1.085 = 108.50 USD.
    expect(convertMinor(10000, 'EUR', 'USD', usd)).toBe(10850)
    // 1,000 yen at 160 to the euro: 6.25 EUR.
    expect(convertMinor(1000, 'JPY', 'EUR', { base: 'EUR', quote: 'JPY', rate: '160' })).toBe(625)
    expect(convertMinor(5, 'EUR', 'EUR', usd)).toBe(5)
    expect(() => convertMinor(5, 'GBP', 'EUR', usd)).toThrow(RangeError)
    // A fee of 12.50 USD a piece: 11.520737 EUR.
    expect(convertUnit('12.5', 'USD', 'EUR', usd)).toBe('11.520737')
  })

  it('never adds two currencies: converts at a named rate or gives no total', () => {
    const values = [
      { amount: 10000, currency: 'EUR' },
      { amount: 7200, currency: 'USD' },
      { amount: 1000, currency: 'EUR' },
    ]
    expect(sumPerCurrency(values)).toEqual([
      { currency: 'EUR', amount: 11000 },
      { currency: 'USD', amount: 7200 },
    ])
    const rate = { ...usd, rateDate: '2026-11-12', source: 'ECB' as const, how: 'STORED' as const }
    expect(totalIn(values, 'EUR', () => rate)).toEqual({ amount: 17636, currency: 'EUR', converted: [{ currency: 'USD', amount: 7200, converted: 6636, rate: '1.08500000', rateDate: '2026-11-12', source: 'ECB', words: '1 EUR = 1.085 USD' }], missing: [] })
    expect(totalIn(values, 'EUR', () => null)).toEqual({ amount: null, currency: 'EUR', converted: [], missing: ['USD'] })
  })
})

describe('the ECB file', () => {
  it('reads the days and rates, newest first, and refuses a broken file', () => {
    const file = ecbFileOf([
      { day: '2026-11-12', rates: [{ currency: 'USD', rate: '1.0850' }] },
      { day: '2026-11-13', rates: [{ currency: 'USD', rate: '1.0861' }, { currency: 'JPY', rate: '161.20' }] },
    ])
    expect(parseEcbFile(file)).toEqual({
      ok: true,
      days: [
        { day: '2026-11-13', rates: [{ currency: 'USD', rate: '1.08610000' }, { currency: 'JPY', rate: '161.20000000' }] },
        { day: '2026-11-12', rates: [{ currency: 'USD', rate: '1.08500000' }] },
      ],
    })
    expect(parseEcbFile('<html>Service unavailable</html>')).toMatchObject({ ok: false })
    expect(parseEcbFile(ecbFileOf([{ day: '2026-11-13', rates: [{ currency: 'USD', rate: 'abc' }] }]))).toMatchObject({ ok: false, problem: expect.stringMatching(/USD/) })
    expect(parseEcbFile(ecbFileOf([{ day: '2026-11-13', rates: [] }]))).toMatchObject({ ok: false })
  })
})

describe('catalogues', () => {
  it('declares the permissions, gives them to the templates and declares the events', () => {
    expect(FACTORY_PERMISSIONS.get(CURRENCIES_VIEW)?.risk).toBe('read')
    expect(FACTORY_PERMISSIONS.get(CURRENCIES_MANAGE)?.risk).toBe('write')
    expect(templateOf('finance')?.permissions).toEqual(expect.arrayContaining([CURRENCIES_VIEW, CURRENCIES_MANAGE]))
    expect(templateOf('buyer')?.permissions).toContain(CURRENCIES_VIEW)
    expect(templateOf('buyer')?.permissions).not.toContain(CURRENCIES_MANAGE)
    expect(templateOf('warehouse')?.permissions).not.toContain(CURRENCIES_VIEW)
    expect(EVENT_CATALOGUE.get('currency.changed', 1)).toBeTruthy()
    expect(EVENT_CATALOGUE.get('currency.rates_changed', 1)).toBeTruthy()
  })
})
