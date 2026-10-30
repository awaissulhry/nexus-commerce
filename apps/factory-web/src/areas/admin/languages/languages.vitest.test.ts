import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen } from './fixtures'
import { changedLanguages, completenessOf, dateSample, endonymOf, floorHasWords, floorPlanOf, floorRefusalOf, localeCounts, localesAfter, numberSample, zonesInUse, type CompanyLanguage, type FloorSite, type LanguagesViewModel } from './model'

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

const site = (over: Partial<FloorSite> = {}): FloorSite => ({
  id: 's1',
  companyId: 'c1',
  companyCode: 'C1',
  companyName: 'Demo One',
  code: 'P1',
  name: 'Plant',
  status: 'ACTIVE',
  locales: ['it', 'en'],
  version: 4,
  workers: { it: 5, en: 0 },
  notice: { id: 'n1', label: '2026-10', locales: ['en', 'it', 'ro'] },
  canManage: true,
  ...over,
})

describe('the floor languages of a site (B-W2a-41, PLT-128)', () => {
  it('names each language in its own words and says which the floor screens speak', () => {
    expect(endonymOf('ro')).toBe('Română')
    expect(endonymOf('ur')).toBe('اردو')
    expect(endonymOf('xx')).toBe('xx')
    expect(floorHasWords('it')).toBe(true)
    expect(floorHasWords('en')).toBe(true)
    expect(floorHasWords('ro')).toBe(false)
  })

  it('adds only a language the worker notice in force has; the others are held with the reason', () => {
    const plan = floorPlanOf(site())
    expect(plan.addHeld).toBeNull()
    expect(plan.choices.map((choice) => [choice.code, choice.held])).toEqual([
      ['ro', null],
      ['sq', 'langs.floor.held.notInNotice'],
      ['ar', 'langs.floor.held.notInNotice'],
      ['zh', 'langs.floor.held.notInNotice'],
      ['ur', 'langs.floor.held.notInNotice'],
      ['bn', 'langs.floor.held.notInNotice'],
    ])
    expect(plan.rows.map((row) => [row.code, row.inNotice, row.screens])).toEqual([
      ['it', true, true],
      ['en', true, true],
    ])
    expect(floorPlanOf(site({ notice: null })).addHeld).toBe('langs.floor.held.noNotice')
    expect(floorPlanOf(site({ notice: null })).rows[0]!.inNotice).toBeNull()
    expect(floorPlanOf(site({ canManage: false })).addHeld).toBe('langs.floor.held.noRight')
    expect(floorPlanOf(site({ notice: { id: 'n1', label: 'v1', locales: ['it', 'en'] } })).addHeld).toBe('langs.floor.held.noneInNotice')
    expect(floorPlanOf(site({ locales: ['it', 'en', 'ro', 'sq', 'ar', 'zh', 'ur', 'bn'] })).addHeld).toBe('langs.floor.held.allAdded')
  })

  it('never removes the last language nor one active workers read; without the workers in sight the API decides', () => {
    const plan = floorPlanOf(site())
    expect(plan.rows.map((row) => [row.code, row.removeHeld])).toEqual([
      ['it', { key: 'langs.floor.held.workers', params: { count: 5 } }],
      ['en', null],
    ])
    expect(floorPlanOf(site({ locales: ['it'] })).rows[0]!.removeHeld).toEqual({ key: 'langs.floor.held.last' })
    expect(floorPlanOf(site({ workers: null })).rows.map((row) => [row.workers, row.removeHeld])).toEqual([
      [null, null],
      [null, null],
    ])
    expect(floorPlanOf(site({ canManage: false })).rows[1]!.removeHeld).toEqual({ key: 'langs.floor.held.noRight' })
  })

  it('sends the site\'s languages after the change, in the site\'s order', () => {
    expect(localesAfter(site(), { action: 'add', code: 'ro' })).toEqual(['it', 'en', 'ro'])
    expect(localesAfter(site(), { action: 'add', code: 'en' })).toEqual(['it', 'en'])
    expect(localesAfter(site(), { action: 'remove', code: 'it' })).toEqual(['en'])
  })

  it('puts a refusal in the page\'s words, never the API\'s', () => {
    expect(floorRefusalOf(site(), { action: 'remove', code: 'en' }, 'conflict', [{ path: 'remove/en', message: '3 active workers of the site read en: …' }], 'problem.conflict')).toEqual({
      siteId: 's1',
      key: 'langs.floor.problem.workers',
      params: { language: 'English', count: 3 },
    })
    expect(floorRefusalOf(site(), { action: 'add', code: 'sq' }, 'conflict', [{ path: 'body/locales/2', message: 'The worker notice in force has no sq text or PDF' }], 'problem.conflict')).toEqual({
      siteId: 's1',
      key: 'langs.floor.problem.notInNotice',
      params: { language: 'Shqip' },
    })
    expect(floorRefusalOf(site({ notice: null }), { action: 'add', code: 'ro' }, 'conflict', [{ path: 'body/locales/2' }], 'problem.conflict').key).toBe('langs.floor.problem.noNotice')
    expect(floorRefusalOf(site(), { action: 'add', code: 'ro' }, 'conflict', [], 'problem.conflict').key).toBe('langs.floor.problem.changed')
    expect(floorRefusalOf(site(), { action: 'add', code: 'ro' }, 'forbidden', [], 'problem.forbidden').key).toBe('problem.forbidden')
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
    expect(draw('normal')).toContain('Worker notice in force: 2026-10')
    expect(draw('normal')).toContain('No worker notice in force')
    expect(draw('normal')).toContain('Not in the worker notice yet, so not offered: العربية, 中文, اردو, বাংলা.')
    expect(draw('normal')).toContain('Workers of this site read a language it does not offer: Română.')
    expect(draw('floor-refused')).toContain('Română was not removed: 2 active workers of the site read it.')
    expect(draw('floor-no-right')).toContain('Needs the right: Manage sites, lines and stations')
    expect(draw('floor-no-notice')).toContain('No worker notice in force: publish it in Admin › Privacy')
    expect(draw('floor-no-site')).toContain('No active site yet')
    expect(draw('floor-error')).toContain('Office languages')
    expect(draw('floor-no-workers-right')).not.toContain('workers read it')
    expect(draw('no-people-rights')).not.toContain('Floor languages')
    expect(draw('no-people-rights')).not.toContain('people use it')
    expect(draw('read-only')).toContain('Needs the right: Manage companies')
    expect(draw('read-only')).not.toContain('<select')
    expect(draw('editing')).toContain('1 change not saved')
    expect(draw('normal', 'it')).toContain('Lingue dell&#x27;ufficio')
  })
})
