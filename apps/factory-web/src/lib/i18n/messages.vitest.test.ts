import { describe, expect, it } from 'vitest'
import { navLabelKeys } from '../../shell/nav/office-nav'
import { formatDate, formatDateTime, formatNumber, formatTime } from './format'
import { localeFromAcceptLanguage, LOCALES, pickLocale } from './locales'
import { CATALOGUE, createScopedTranslator, createTranslator, interpolate, messagesFor, placeholdersOf } from './messages'

describe('every UI string exists in every language (PLAN §4.6, PLT-127)', () => {
  const namespaces = [...new Set(LOCALES.flatMap((locale) => Object.keys(CATALOGUE[locale])))].sort()

  it('finds the catalogues by themselves (messages/<locale>/<area>.json)', () => {
    expect(namespaces).toContain('shell')
    for (const locale of LOCALES) expect(Object.keys(CATALOGUE[locale]).sort()).toEqual(namespaces)
  })

  for (const namespace of ['shell']) {
    it(`${namespace}: the same keys, the same placeholders, no empty text, in it and en`, () => {
      const en = CATALOGUE.en[namespace] ?? {}
      const itc = CATALOGUE.it[namespace] ?? {}
      expect(Object.keys(itc).sort()).toEqual(Object.keys(en).sort())
      for (const key of Object.keys(en)) {
        expect(en[key]?.trim(), `en ${key}`).not.toBe('')
        expect(itc[key]?.trim(), `it ${key}`).not.toBe('')
        expect(placeholdersOf(itc[key] ?? ''), `placeholders of ${key}`).toEqual(placeholdersOf(en[key] ?? ''))
      }
    })
  }

  it('every navigation label key exists in every language', () => {
    for (const locale of LOCALES) {
      const t = createScopedTranslator(locale, messagesFor(locale, namespaces), 'shell')
      for (const key of navLabelKeys()) expect(t(key), `${locale} ${key}`).not.toBe(key.slice(key.indexOf(':') + 1))
    }
  })
})

describe('the translator', () => {
  const t = createTranslator('en', { hello: 'Hello {name}', item_one: '{count} item', item_other: '{count} items' })

  it('fills placeholders and leaves a missing one visible', () => {
    expect(t('hello', { name: 'Ada' })).toBe('Hello Ada')
    expect(interpolate('Hello {name}')).toBe('Hello {name}')
  })

  it('picks the plural form of the language', () => {
    expect(t('item', { count: 1 })).toBe('1 item')
    expect(t('item', { count: 3 })).toBe('3 items')
  })

  it('answers a missing key with the key (it shows, and this test catches it)', () => {
    expect(t('nope')).toBe('nope')
  })
})

describe('the page language: the person, the cookie, the browser, Italian', () => {
  it('prefers the person, then the cookie, then Accept-Language by weight', () => {
    expect(pickLocale({ person: 'en', cookie: 'it', acceptLanguage: 'it' })).toBe('en')
    expect(pickLocale({ cookie: 'en-GB' })).toBe('en')
    expect(pickLocale({ acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8,it;q=0.7' })).toBe('en')
    expect(pickLocale({ acceptLanguage: 'fr' })).toBe('it')
    expect(localeFromAcceptLanguage('en;q=0, it;q=0.5')).toBe('it')
  })
})

describe('numbers and times as the person reads them (PLT-134, PLT-135)', () => {
  const instant = '2026-10-28T13:05:00.000Z'

  it('Italian: decimal comma; English: decimal point', () => {
    expect(formatNumber(1234.5, 'it')).toBe('1234,5')
    expect(formatNumber(12345.5, 'it')).toBe('12.345,5')
    expect(formatNumber(12345.5, 'en')).toBe('12,345.5')
  })

  it('shows a UTC instant in the site\'s time zone, day first, 24-hour clock', () => {
    expect(formatDate(instant, { locale: 'it' })).toBe('28/10/2026')
    expect(formatTime(instant, { locale: 'it' })).toBe('14:05')
    expect(formatDateTime(instant, { locale: 'en' })).toBe('28/10/2026, 14:05')
    expect(formatTime(instant, { locale: 'en', timeZone: 'UTC' })).toBe('13:05')
  })
})
