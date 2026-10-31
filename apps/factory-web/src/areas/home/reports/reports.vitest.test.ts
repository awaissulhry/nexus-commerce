import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GRAINS as DOMAIN_GRAINS } from '@nexus/factory-domain/auth/grains/grains'
import { COLUMN_KINDS as DOMAIN_COLUMN_KINDS, FILTER_KINDS as DOMAIN_FILTER_KINDS, PERIODS, REPORT_AREAS as DOMAIN_AREAS, REPORT_FORMATS as DOMAIN_FORMATS } from '@nexus/factory-domain/insights/reports/definition'
import { NUMBER_RULES, NUMBER_UNITS as DOMAIN_UNITS, TARGET_WORDS as DOMAIN_TARGET_WORDS } from '@nexus/factory-domain/insights/reports/numbers'
import { LIBRARY_STATES as DOMAIN_STATES } from '@nexus/factory-domain/insights/reports/rights'
import { FLOW_LENSES } from '@nexus/factory-domain/insights/flow'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { OFFICE_NAV, OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { NUMBER_UNITS, TARGET_WORDS } from '../today/numbers/api'
import { OWNER_NUMBERS } from '../today/numbers/demo'
import { numberHref, numbersOfLens, problemKey, targetText, valueText } from '../today/numbers/model'
import { COLUMN_KINDS, FILTER_KINDS, GRAINS, LIBRARY_STATES, REPORT_AREAS, REPORT_FORMATS } from './api'
import { DAILY, OPEN_ORDERS, OWNER_LIBRARY, PLANNER_LIBRARY } from './demo/fixtures'
import { designScreen as libraryScreen } from './fixtures'
import {
  cellText,
  csvName,
  csvOf,
  heldOf,
  knownFilters,
  libraryAddressOf,
  libraryHref,
  libraryRows,
  markOpened,
  outsideCount,
  printHref,
  readLastOpened,
  readProblem,
  reportAddressOf,
  reportHref,
  reportsCanOf,
  rightsLines,
  stateWords,
} from './model'
import { designScreen as printScreen } from './print/fixtures'
import { designScreen as reportScreen } from './report/fixtures'
import { designScreen as todayScreen } from '../today/fixtures'
import { ApiError } from '../../../lib/api/errors'

const en = createTranslator('en', messagesFor('en', ['home-reports'])['home-reports']!)
const it_ = createTranslator('it', messagesFor('it', ['home-reports'])['home-reports']!)
const params = (query: string) => new URLSearchParams(query)

describe('the shapes and words mirror factory-domain (B-W2a-79)', () => {
  it('holds every enum list equal to the domain’s', () => {
    expect([...REPORT_AREAS]).toEqual([...DOMAIN_AREAS])
    expect([...LIBRARY_STATES]).toEqual([...DOMAIN_STATES])
    expect([...COLUMN_KINDS]).toEqual([...DOMAIN_COLUMN_KINDS])
    expect([...FILTER_KINDS]).toEqual([...DOMAIN_FILTER_KINDS])
    expect([...GRAINS]).toEqual([...DOMAIN_GRAINS])
    expect([...REPORT_FORMATS]).toEqual([...DOMAIN_FORMATS])
    expect([...NUMBER_UNITS]).toEqual([...DOMAIN_UNITS])
    expect([...TARGET_WORDS]).toEqual([...DOMAIN_TARGET_WORDS])
  })

  it('says every number in both languages, the English equal to the domain’s', () => {
    for (const rule of NUMBER_RULES) {
      for (const part of ['label', 'definition', 'formula', 'sources', 'period'] as const) {
        expect(en(`number.${rule.key}.${part}`), `${rule.key}.${part}`).toBe(rule[part])
        expect(it_(`number.${rule.key}.${part}`), `${rule.key}.${part} (it)`).not.toBe(`number.${rule.key}.${part}`)
      }
    }
    for (const lens of FLOW_LENSES) for (const t of [en, it_]) expect(t(`lens.${lens}`)).not.toBe(`lens.${lens}`)
    for (const period of PERIODS) for (const t of [en, it_]) expect(t(`period.${period}`)).not.toBe(`period.${period}`)
    for (const area of DOMAIN_AREAS) for (const t of [en, it_]) expect(t(`area.${area}`)).not.toBe(`area.${area}`)
    for (const grain of DOMAIN_GRAINS) for (const t of [en, it_]) expect(t(`grain.${grain}`)).not.toBe(`grain.${grain}`)
  })

  it('Home › Insights › Reports is a built page with its navigation row (home.reports.view)', () => {
    for (const page of ['/home/reports', '/home/reports/[key]', '/home/reports/[key]/print']) expect(OFFICE_PAGES.has(page), page).toBe(true)
    const home = OFFICE_NAV.areas.find((area) => area.id === 'home')!
    const insights = (home.sections ?? []).find((section) => section.id === 'home-insights')!
    expect(insights.items.map((item) => [item.href, item.permission])).toEqual([['/home/reports', 'home.reports.view'], ['/home/alerts', 'alerts.view']])
  })
})

describe('the library (design home.reports library)', () => {
  const words = (report: { key: string }) => ({ title: en(`report.${report.key}.title`), question: en(`report.${report.key}.question`) })

  it('keeps the search, the area and "outside my role" in the address', () => {
    expect(libraryAddressOf(params('q=late&area=sales&outside=1'))).toEqual({ q: 'late', area: 'sales', outside: true })
    expect(libraryAddressOf(params('area=nope'))).toEqual({ q: '', area: null, outside: false })
    expect(libraryHref('/w/DEMO', { q: 'late', area: 'sales', outside: false })).toBe('/w/DEMO/home/reports?q=late&area=sales')
  })

  it('hides the reports of lists outside the role until asked, and keeps a report needing a grain listed', () => {
    expect(outsideCount(PLANNER_LIBRARY.reports)).toBe(3)
    const shown = libraryRows(PLANNER_LIBRARY.reports, { q: '', area: null, outside: false }, words)
    expect(shown).toHaveLength(11)
    expect(shown.find((report) => report.key === 'finance.stock-value')?.state).toBe('NEEDS_GRAIN')
    expect(stateWords({ state: 'NEEDS_GRAIN', grain: 'cost' }, en)).toBe('Needs cost rights')
    expect(stateWords({ state: 'NEEDS_GRAIN', grain: 'cost' }, it_)).toBe('Richiede i permessi su costi')
    expect(libraryRows(PLANNER_LIBRARY.reports, { q: '', area: null, outside: true }, words)).toHaveLength(14)
  })

  it('searches the words the person reads, without accents, and filters by area', () => {
    expect(libraryRows(OWNER_LIBRARY.reports, { q: 'LATE', area: null, outside: false }, words).map((report) => report.key)).toEqual(['sales.late-orders', 'purchasing.receipts-due'])
    const italian = (report: { key: string }) => ({ title: it_(`report.${report.key}.title`), question: it_(`report.${report.key}.question`) })
    expect(libraryRows(OWNER_LIBRARY.reports, { q: 'qualita', area: null, outside: false }, italian)).toEqual([])
    expect(libraryRows(OWNER_LIBRARY.reports, { q: 'conformita', area: null, outside: false }, italian).map((report) => report.key)).toEqual(['quality.open-ncrs'])
    expect(libraryRows(OWNER_LIBRARY.reports, { q: '', area: 'production', outside: false }, words).map((report) => report.key)).toEqual(['production.daily', 'production.scrap-by-reason', 'production.wip-by-stage'])
  })

  it('remembers "last opened by me" in this browser, and survives a browser that refuses storage', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) }
    markOpened(storage, 'sales.late-orders', '2026-10-30T08:00:00.000Z')
    markOpened(storage, 'production.daily', '2026-10-30T09:00:00.000Z')
    expect(readLastOpened(storage)).toEqual({ 'sales.late-orders': '2026-10-30T08:00:00.000Z', 'production.daily': '2026-10-30T09:00:00.000Z' })
    const refusing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(() => markOpened(refusing, 'x', 'y')).not.toThrow()
    expect(readLastOpened(refusing)).toEqual({})
    expect(readLastOpened(null)).toEqual({})
  })
})

describe('a report (design home.reports rec:Report)', () => {
  it('keeps the tab, the filters and the grouping in the address; prints the same run', () => {
    const address = reportAddressOf(params('tab=about&period=THIS_MONTH&site=abc&group=status&bad-key=1'))
    expect(address).toEqual({ tab: 'about', filters: { period: 'THIS_MONTH', site: 'abc' }, group: 'status' })
    expect(reportAddressOf(params('tab=nope')).tab).toBe('results')
    expect(reportHref('/w/DEMO', 'sales.late-orders', address)).toBe('/w/DEMO/home/reports/sales.late-orders?tab=about&period=THIS_MONTH&site=abc&group=status')
    expect(printHref('/w/DEMO', 'sales.late-orders', address)).toBe('/w/DEMO/home/reports/sales.late-orders/print?period=THIS_MONTH&site=abc&group=status')
    expect(knownFilters({ filters: [{ key: 'period', label: '', kind: 'period', default: 'THIS_WEEK', choices: [] }] }, { period: 'LAST_WEEK', other: 'x' })).toEqual({ period: 'LAST_WEEK' })
    expect(knownFilters({ filters: [{ key: 'site', label: '', kind: 'site', default: null, choices: [] }] }, {})).toEqual({ site: null })
  })

  it('says each cell in the person’s language', () => {
    expect(cellText({ kind: 'money' }, 3_917_000, 'EUR', en, 'en')).toBe('€39,170.00')
    expect(cellText({ kind: 'money' }, 3_917_000, 'EUR', it_, 'it')).toMatch(/^39\.170,00\s€$/)
    expect(cellText({ kind: 'percent' }, '87.5', null, en, 'en')).toBe('87.5 %')
    expect(cellText({ kind: 'percent' }, '87.5', null, it_, 'it')).toBe('87,5 %')
    expect(cellText({ kind: 'code' }, 'IN_PRODUCTION', null, it_, 'it')).toBe('In produzione')
    expect(cellText({ kind: 'day' }, '2026-10-27', null, en, 'en')).toMatch(/27/)
    expect(cellText({ kind: 'number' }, null, null, en, 'en')).toBe('')
  })

  it('writes the CSV of the rows the person sees: Italian with ; and a decimal comma, a BOM, the currency', () => {
    const csv = csvOf('sales.open-orders', OPEN_ORDERS.columns, OPEN_ORDERS.rows.slice(0, 1), it_, 'it')
    expect(csv.startsWith('﻿')).toBe(true)
    const [head, line] = csv.slice(1).trim().split('\r\n')
    expect(head).toBe('Ordine;Cliente;Stato;Data ordine;Promesso;Giorni di ritardo;Capi;Spediti;Imponibile;Valuta')
    expect(line).toBe('SO-DEMO-0107;Pista Demo Srl;In produzione;2026-10-12;2026-10-27;3;40;0;18400,00;EUR')
    const english = csvOf('production.daily', DAILY.columns, DAILY.rows, en, 'en')
    expect(english.split('\r\n')[1]).toBe('L1 · Linea cucito 1,Line,142,3,5,87.5')
    expect(english.split('\r\n')[2]).toBe('L2 · Linea campionario,Line,18,1,0,')
    expect(csvName('Ordini in ritardo', '2026-10-30')).toBe('ordini-in-ritardo-2026-10-30.csv')
  })

  it('says what the rights left out and the small groups hidden, and why a report is held', () => {
    expect(rightsLines({ leftOut: ['cost', 'margin'], hiddenGroups: 0 }, en)).toEqual(['Left out because of your rights: cost, margin.'])
    expect(rightsLines({ leftOut: [], hiddenGroups: 2 }, it_)).toEqual(['Nascosti: 2 gruppi con meno di 5 persone (i loro dati sulle persone).'])
    expect(rightsLines(null, en)).toEqual([])
    expect(heldOf({ state: 'NEEDS_GRAIN', grain: 'cost' })).toEqual({ key: 'held.needsGrain', grain: 'cost' })
    expect(heldOf({ state: 'NO_ACCESS', grain: null })).toEqual({ key: 'held.noAccess', grain: null })
    expect(heldOf({ state: 'READY', grain: null })).toBeNull()
    expect(readProblem(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('error.notFound')
    expect(reportsCanOf(['home.view']).view).toBe(false)
  })
})

describe('My numbers on Today (design home.today key-numbers)', () => {
  it('shows the picked lens, else the first; says values and targets in words', () => {
    expect(numbersOfLens(OWNER_NUMBERS, 'WORK_ORDERS')?.lens).toBe('WORK_ORDERS')
    expect(numbersOfLens(OWNER_NUMBERS, 'INVOICES')?.lens).toBe('ORDERS')
    expect(numbersOfLens({ ...OWNER_NUMBERS, lenses: [] }, null)).toBeNull()
    const [orders, late, , onTime] = OWNER_NUMBERS.lenses[0]!.numbers
    expect(valueText(orders!, 'en')).toBe('€84,120')
    expect(valueText(onTime!, 'it')).toBe('91,4 %')
    expect(valueText({ unit: 'COUNT', value: null, currency: null }, 'en')).toBeNull()
    expect(targetText(late!, en, 'en')).toBe('Target 0')
    expect(targetText(onTime!, it_, 'it')).toBe('Obiettivo 95 % o più')
    expect(problemKey({ problem: 'MIXED_CURRENCIES', value: null })).toBe('numbers.mixed')
  })

  it('links a tile to the list that shows exactly its rows when that page is built, else to its report', () => {
    const [, late, promised] = OWNER_NUMBERS.lenses[0]!.numbers
    expect(numberHref(late!, OFFICE_PAGES)).toBe('/sales/orders?late=true')
    expect(numberHref(late!, new Set())).toBe('/home/reports/sales.late-orders')
    expect(numberHref(promised!, OFFICE_PAGES)).toBe('/home/reports/sales.open-orders?promise=THIS_WEEK')
  })
})

const LEFT_KEY = /\b(?:noAccess|band|library|report|tab|held|filters|period|rights|results|schedule|about|print|numbers|number|lens|code|grain|area|format|state|common|error|language|day)\.[a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Record words that look like keys (a report's own key in a link, an e-mail address) are not left keys. */
const SAID = /\/home\/reports\/[a-z.-]+|\b[\w.-]+@[\w.-]+\.\w+\b|\bhome\.reports\.view\b|\b(?:sales|production|finance|planning|purchasing|quality|compliance)\.[a-z]+-[a-z-]+\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [libraryScreen, reportScreen, printScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('SCR-029: the My numbers cases draw their words (no key left), the numbers in the picked lens', () => {
    const cases = todayScreen.cases.filter((item) => item.id.startsWith('numbers-'))
    expect(cases.map((item) => item.id)).toEqual(['numbers-owner', 'numbers-explain', 'numbers-planner', 'numbers-problems', 'numbers-loading', 'numbers-error', 'numbers-none'])
    for (const item of cases) {
      for (const locale of LOCALES) {
        const html = render(todayScreen as unknown as DesignScreen<unknown>, item.model, locale).replace(SAID, '')
        expect(html.match(/\b(?:numbers|number|lens)\.[a-zA-Z_][a-zA-Z0-9_.-]*\b/)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    }
    const owner = render(todayScreen as unknown as DesignScreen<unknown>, cases[0]!.model, 'en')
    expect(owner).toContain('My numbers')
    expect(owner).toContain('Below target')
    expect(owner).toContain('Above target')
    expect(render(todayScreen as unknown as DesignScreen<unknown>, cases[2]!.model, 'it')).toContain('Senza materiale')
    expect(render(todayScreen as unknown as DesignScreen<unknown>, cases[6]!.model, 'en')).not.toContain('My numbers')
  })
})
