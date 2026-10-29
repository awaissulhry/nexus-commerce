import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen } from './fixtures'
import { changedLanguages, completenessOf, dateSample, localeCounts, numberSample, zonesInUse, type CompanyLanguage, type LanguagesViewModel } from './model'

/** SCR-016 Languages & formats: the counts, the samples, the zones, the changes to save, and every design case. */

const company = (id: string, locale: string, timezone: string, sites: CompanyLanguage['sites'] = []): CompanyLanguage => ({ id, code: id.toUpperCase(), legalName: `Demo ${id}`, locale, timezone, status: 'ACTIVE', version: 3, sites })

describe('the rules', () => {
  it('counts languages, and says how much of each interface language is written', () => {
    expect(localeCounts([{ locale: 'it' }, { locale: 'ro' }, { locale: 'it' }])).toEqual({ it: 2, ro: 1 })
    expect(completenessOf(CATALOGUE)).toEqual({ it: 100, en: 100 })
    expect(completenessOf({ it: { a: { x: 'uno', y: '' } }, en: { a: { x: 'one', y: 'two' } } })).toEqual({ it: 50, en: 100 })
  })

  it('writes the samples the way of each language: the day first in both', () => {
    expect(numberSample('it')).toBe('12.345,50')
    expect(numberSample('en')).toBe('12,345.50')
    expect(dateSample('it')).toBe('29/10/2026')
    expect(dateSample('en')).toBe('29/10/2026')
  })

  it('saves only the companies whose language changes; lists the zones in use', () => {
    const a = company('a', 'it', 'Europe/Rome', [{ id: 's1', name: 'Plant', kind: 'PLANT', timezone: 'Europe/Rome', status: 'ACTIVE' }])
    const b = company('b', 'en', 'Europe/London', [{ id: 's2', name: 'Old', kind: 'PLANT', timezone: 'Europe/Paris', status: 'ARCHIVED' }])
    expect(changedLanguages([a, b], { a: 'en', b: 'en' })).toEqual([{ company: a, locale: 'en' }])
    expect(changedLanguages([a, b], {})).toEqual([])
    expect(zonesInUse([a, b])).toEqual([
      { zone: 'Europe/London', companies: 1, sites: 0 },
      { zone: 'Europe/Rome', companies: 1, sites: 1 },
    ])
  })
})

const LEFT_KEY = /\b(?:langs|common|list|problem|held|form|right)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
const render = (model: unknown, locale: (typeof LOCALES)[number]) =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model })))
const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => render(designScreen.cases.find((item) => item.id === id)!.model as LanguagesViewModel, locale)

describe('SCR-016 draws every case in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      for (const item of designScreen.cases) {
        const html = render(item.model, locale)
        expect(html.length, item.id).toBeGreaterThan(500)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('names floor languages in their own words; a section the person may not read is absent', () => {
    expect(draw('normal')).toContain('Română')
    expect(draw('normal')).toContain('Not on the screens yet')
    expect(draw('no-people-rights')).not.toContain('Floor languages')
    expect(draw('no-people-rights')).not.toContain('people use it')
    expect(draw('read-only')).toContain('Needs the right: Manage companies')
    expect(draw('read-only')).not.toContain('<select')
    expect(draw('editing')).toContain('1 change not saved')
    expect(draw('normal', 'it')).toContain('Lingue dell&#x27;ufficio')
  })
})
