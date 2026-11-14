import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RULE_KINDS } from '@nexus/factory-domain/alerts/kinds'
import { ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { KPI_REFUSALS } from '@nexus/factory-domain/insights/kpis/checks'
import { MEASURES } from '@nexus/factory-domain/insights/kpis/measures'
import { KPI_REFUSAL_ISSUES } from '@nexus/factory-domain/insights/kpis/refusals'
import { KPI_CATALOGUE } from '@nexus/factory-domain/insights/kpis/registry'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { RECORD_PAGES, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_NAV, OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { findAreaNavPlace } from '@nexus/ui/patterns/shell/index'
import {
  CALC_KINDS,
  ITEM_KINDS,
  KPI_GRAINS,
  KPI_PROBLEMS,
  KPI_STATES,
  KPI_UNITS,
  KPI_USE_KINDS,
  LEAD_KINDS,
  OTIF_OUTCOMES,
  OTIF_PROMISES,
  PERIOD_KINDS,
  PRODUCT_TYPES,
  SALES_ORDER_PRIORITY_LEVELS,
  WIP_AGE_BUCKETS,
} from './api'
import { BUILT, LEAD_DRILL, OTIF_DRILL, OTIF_VERSIONS, fileOf, libraryFor, marginDrill, recordFor, supplyDrill, wipDrill } from './demo/fixtures'
import { drillProblem, drillQuery, drillView, isDrillName, recordsHref, spanOf, spanProblem } from './drills'
import { designScreen as libraryScreen } from './fixtures'
import {
  areaOf,
  bodyOf,
  changeLine,
  DASHBOARD_KEYS,
  defaultCompare,
  definitionsCsv,
  deltaText,
  differsFromCalculation,
  draftChanged,
  draftOf,
  formProblems,
  FORM_FIELDS,
  KPI_AREAS,
  kpiAddressOf,
  kpiHref,
  kpisCanOf,
  libraryAddressOf,
  libraryHref,
  libraryRows,
  notInstalled,
  OFFICE_ROLE_KEYS,
  periodChoices,
  periodText,
  problemOf,
  recordsLinkOf,
  SOURCE_RECORDS,
  sourceListOf,
  statusOf,
  useOf,
  valueText,
  versionChanges,
  versionEvents,
  versionsAtHand,
  WRITE_REFUSALS,
  writeProblem,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
import { designScreen as recordsScreen } from './records/fixtures'

const words = (locale: (typeof LOCALES)[number]) => messagesFor(locale, ['home-kpis'])['home-kpis']!
const en = createTranslator('en', words('en'))
const it_ = createTranslator('it', words('it'))
const params = (query: string) => new URLSearchParams(query)
const has = (key: string) => {
  for (const locale of LOCALES) {
    const dictionary = words(locale)
    const found = dictionary[key] ?? dictionary[`${key}_other`]
    expect(found, `${locale}: ${key}`).toBeTruthy()
  }
}

describe('the shapes and words mirror factory-domain (B-W2b-428, B-W2b-429)', () => {
  it('names every unit, rights, state, period kind, calculation, use, problem and code in both languages', () => {
    for (const unit of KPI_UNITS) {
      has(`unit.${unit}`)
      has(`valueOf.${unit}`)
    }
    for (const grain of KPI_GRAINS) has(`grain.${grain.toLowerCase()}`)
    for (const state of KPI_STATES) has(`state.${state}`)
    for (const kind of PERIOD_KINDS) {
      has(`periodKind.${kind}`)
      has(`periodKindShort.${kind}`)
    }
    for (const kind of CALC_KINDS) has(`calc.${kind}`)
    for (const kind of KPI_USE_KINDS) {
      has(`useKind.${kind}`)
      has(`use.unnamed.${kind}`)
      has(`uses.noPage.${kind}`)
    }
    for (const problem of [...KPI_PROBLEMS, 'NO_VALUE']) has(`problem.${problem}`)
    for (const area of [...KPI_AREAS, 'other']) has(`area.${area}`)
    for (const key of DASHBOARD_KEYS) has(`use.dashboard.${key}`)
    for (const kind of RULE_KINDS) has(`use.alert.${kind}`)
    for (const code of SALES_ORDER_PRIORITY_LEVELS) has(`priority.${code}`)
    for (const code of OTIF_OUTCOMES) has(`outcome.${code}`)
    for (const code of OTIF_PROMISES) has(`records.promise.${code}`)
    for (const code of LEAD_KINDS) has(`leadKind.${code}`)
    for (const code of WIP_AGE_BUCKETS) has(`band.${code}`)
    for (const code of PRODUCT_TYPES) has(`family.${code}`)
    for (const code of ITEM_KINDS) has(`category.${code}`)
    for (const field of FORM_FIELDS) has(`form.problem.${field}`)
    for (const code of WRITE_REFUSALS) has(`refusal.${code}`)
  })

  it('every measure the metric layer builds and every record a KPI is computed from has words', () => {
    for (const measure of MEASURES) has(`measure.${measure.key}`)
    for (const file of KPI_CATALOGUE) for (const record of file.sourceRecords) expect(SOURCE_RECORDS, `${file.key}: ${record}`).toContain(record)
    for (const record of SOURCE_RECORDS) has(`record.${record}`)
  })

  it('the owner roles are the office role templates; the refusals cover the API’s and the database’s', () => {
    expect([...OFFICE_ROLE_KEYS].sort()).toEqual(ROLE_TEMPLATES.filter((template) => template.audience === 'office').map((template) => template.key).sort())
    for (const key of OFFICE_ROLE_KEYS) has(`role.${key}`)
    for (const code of KPI_REFUSALS) expect(WRITE_REFUSALS).toContain(code)
    for (const path of Object.values(KPI_REFUSAL_ISSUES).filter((path) => path.startsWith('refusal/'))) expect(WRITE_REFUSALS).toContain(path.slice('refusal/'.length))
  })
})

describe('the library (design home.kpis catalogue)', () => {
  const owner = libraryFor('owner')

  it('reads its address and writes it back', () => {
    expect(libraryAddressOf(params('q=%20margin%20&area=sales'))).toEqual({ q: 'margin', area: 'sales' })
    expect(libraryAddressOf(params('area=nope'))).toEqual({ q: '', area: null })
    expect(libraryHref('/w/A', { q: 'otif', area: 'delivery' })).toBe('/w/A/home/kpis?q=otif&area=delivery')
    expect(libraryHref('/w/A', { q: '', area: null })).toBe('/w/A/home/kpis')
  })

  it('searches the words the person reads (name, definition, formula) in their language, and filters by area', () => {
    expect(libraryRows(owner.kpis, { q: 'puntuali', area: null }, 'it').map((item) => item.key)).toContain('delivery.otif')
    expect(libraryRows(owner.kpis, { q: 'puntuali', area: null }, 'en')).toEqual([])
    expect(libraryRows(owner.kpis, { q: '', area: 'production' }, 'en').every((item) => areaOf(item.key) === 'production')).toBe(true)
    expect(areaOf('foo.bar')).toBe('other')
  })

  it('says each KPI’s state, and which the install would write', () => {
    const by = (key: string) => owner.kpis.find((item) => item.key === key)!
    expect(statusOf(by('delivery.otif'))).toEqual({ kind: 'IN_FORCE', version: 2, drafts: 1 })
    expect(statusOf(by('purchasing.supplier_on_time')).kind).toBe('DRAFT_ONLY')
    expect(statusOf(by('sales.quotes_sent')).kind).toBe('WITHDRAWN')
    expect(statusOf(by('production.leather_yield')).kind).toBe('NOT_INSTALLED')
    expect(notInstalled(owner.kpis).map((item) => item.key)).toEqual(['production.leather_yield', 'sales.quote_to_order_days'])
  })

  it('writes the definitions’ CSV in the person’s language: `;` in Italian, `,` in English, codes in words', () => {
    const items = owner.kpis.filter((item) => item.key === 'delivery.otif')
    const csvIt = definitionsCsv(items, it_, 'it')
    const csvEn = definitionsCsv(items, en, 'en')
    expect(csvIt.startsWith('﻿Chiave;Nome;')).toBe(true)
    expect(csvEn.startsWith('﻿Key,Name,')).toBe(true)
    expect(csvEn).toContain('delivery.otif,On-time in full,')
    expect(csvEn).toContain('Version 2 in force')
    expect(csvIt).toContain('Righe degli ordini di vendita · Spedizioni')
  })

  it('holds every permission: view reads, manage writes, roles picks an owner', () => {
    expect(kpisCanOf(['home.kpis.view'])).toEqual({ view: true, manage: false, roles: false })
    expect(kpisCanOf(['home.kpis.view', 'home.kpis.manage', 'roles.view'])).toEqual({ view: true, manage: true, roles: true })
  })
})

describe('a KPI (design home.kpis rec:KPI)', () => {
  it('reads its address (tab, period kind, the pair compared) and writes it back; Targets is never a tab', () => {
    expect(kpiAddressOf(params('tab=history&period=WEEK&compare=1-3'))).toEqual({ tab: 'history', period: 'WEEK', compare: [1, 3] })
    expect(kpiAddressOf(params('tab=targets&period=SOMETIMES'))).toEqual({ tab: 'definition', period: null, compare: null })
    expect(kpiHref('/w/A', 'delivery.otif', { tab: 'history', period: null, compare: [1, 2] })).toBe('/w/A/home/kpis/delivery.otif?tab=history&compare=1-2')
    expect(kpiHref('/w/A', 'delivery.otif', { tab: 'definition', period: 'WEEK', compare: [1, 2] })).toBe('/w/A/home/kpis/delivery.otif?period=WEEK')
    expect(periodChoices(false)).not.toContain('FISCAL_YEAR')
    expect(periodChoices(true)).toContain('FISCAL_QUARTER')
  })

  it('says a value in its unit, in each language, and the change from the period before (points for a percent)', () => {
    expect(valueText('PERCENT', '93.5', null, en, 'en')).toBe('93.5 %')
    expect(valueText('PERCENT', '93.5', null, it_, 'it')).toBe('93,5 %')
    expect(valueText('MONEY', '1250000', 'EUR', en, 'en')).toBe('€12,500.00')
    expect(valueText('PIECES', '1', null, en, 'en')).toBe('1 piece')
    expect(valueText('DAYS', '4.5', null, it_, 'it')).toBe('4,5 giorni')
    expect(valueText('COUNT', null, null, en, 'en')).toBeNull()
    expect(deltaText('PERCENT', '88.4', '86.0', null, en, 'en')).toBe('+2.4 points')
    expect(deltaText('MONEY', '100000', '150000', 'EUR', en, 'en')).toBe('−€500.00')
    expect(deltaText('COUNT', '5', '5', null, en, 'en')).toBeNull()
    expect(changeLine('COUNT', '5', { value: '5', label: '13/11/2026' }, null, it_, 'it')).toBe('Uguale a 13/11/2026')
    expect(changeLine('PERCENT', '88.4', { value: '86.0', label: 'October 2026' }, null, en, 'en')).toBe('+2.4 points on October 2026')
  })

  it('says every period kind in words', () => {
    expect(periodText({ kind: 'WEEK', key: '2026-W46', from: '2026-11-09' }, en, 'en')).toBe('Week 46 · 2026')
    expect(periodText({ kind: 'MONTH', key: '2026-11', from: '2026-11-01' }, it_, 'it')).toBe('novembre 2026')
    expect(periodText({ kind: 'QUARTER', key: '2026-Q4', from: '2026-10-01' }, it_, 'it')).toBe('T4 2026')
    expect(periodText({ kind: 'FISCAL_QUARTER', key: 'FY2026-Q2', from: '2026-10-01' }, en, 'en')).toBe('Fiscal 2026 · Q2')
    expect(periodText({ kind: 'FISCAL_YEAR', key: 'FY2026', from: '2026-07-01' }, it_, 'it')).toBe('Esercizio 2026')
    expect(periodText({ kind: 'DAY', key: '2026-11-14', from: '2026-11-14' }, en, 'en')).toBe('14/11/2026')
  })

  it('says why a value is missing, the rights named in words', () => {
    expect(problemOf({ problem: 'NEEDS_GRAIN', value: null }, 'MARGIN')).toEqual({ key: 'problem.NEEDS_GRAIN', params: { grain: 'margin' } })
    expect(problemOf({ problem: null, value: null }, null)).toEqual({ key: 'problem.NO_VALUE' })
    expect(problemOf({ problem: null, value: '1' }, null)).toBeNull()
  })

  it('opens the records behind it: a report with its filters, its own records page with the period, an area list, else nothing', () => {
    const period = { from: '2026-11-01', to: '2026-11-30' }
    expect(recordsLinkOf('sales.orders_in', { drill: { kind: 'REPORT', key: 'sales.orders-in', api: null, terms: {} } }, period, OFFICE_PAGES)).toEqual({ kind: 'report', href: '/home/reports/sales.orders-in' })
    expect(recordsLinkOf('delivery.otif', { drill: { kind: 'LIST', key: null, api: '/insights/kpis/drills/otif', terms: { promise: 'FIRST' } } }, period, OFFICE_PAGES)).toEqual({ kind: 'records', href: '/home/kpis/delivery.otif/records?from=2026-11-01&to=2026-11-30' })
    expect(recordsLinkOf('purchasing.receipt_lines', { drill: { kind: 'LIST', key: null, api: '/inventory/receipts', terms: { status: 'POSTED' } } }, period, OFFICE_PAGES)).toEqual({ kind: 'list', href: '/warehouse/receipts?status=POSTED' })
    expect(recordsLinkOf('x.y', { drill: { kind: 'LIST', key: null, api: '/nowhere', terms: {} } }, period, OFFICE_PAGES)).toBeNull()
    expect(recordsLinkOf('x.y', null, period, OFFICE_PAGES)).toBeNull()
    expect(sourceListOf('SalesOrderLine', OFFICE_PAGES)).toBe('/sales/orders')
    expect(sourceListOf('Nothing', OFFICE_PAGES)).toBeNull()
  })

  it('says where each use opens, only when its page is built', () => {
    expect(useOf({ usedIn: 'DASHBOARD', useKey: 'today' }, OFFICE_PAGES, RULE_KINDS).href).toBe('/home/today')
    expect(useOf({ usedIn: 'DASHBOARD', useKey: 'owner-group' }, new Set(['/home/today']), RULE_KINDS).href).toBeNull()
    expect(useOf({ usedIn: 'REPORT', useKey: 'sales.late-orders' }, OFFICE_PAGES, RULE_KINDS)).toEqual({ kind: 'REPORT', word: { namespace: 'home-reports', key: 'report.sales.late-orders.title' }, href: '/home/reports/sales.late-orders' })
    expect(useOf({ usedIn: 'ALERT', useKey: 'ORDER_LATE_RISK' }, OFFICE_PAGES, RULE_KINDS).href).toBe('/home/alerts?kind=ORDER_LATE_RISK')
    expect(useOf({ usedIn: 'ALERT', useKey: 'SOMETHING' }, OFFICE_PAGES, RULE_KINDS)).toEqual({ kind: 'ALERT', word: null, href: null })
    expect(useOf({ usedIn: 'PORTAL', useKey: 'x' }, OFFICE_PAGES, RULE_KINDS).href).toBeNull()
  })

  it('a KPI opens by its key from anywhere (RECORD_PAGES Kpi) and sits in Home › Insights', () => {
    expect(RECORD_PAGES.Kpi).toBe('/home/kpis/[id]')
    const address = recordAddress({ type: 'Kpi', id: 'delivery.otif' }, OFFICE_PAGES)
    expect(address).toBe('/home/kpis/delivery.otif')
    expect(findAreaNavPlace(OFFICE_NAV, address)?.item?.id).toBe('home-kpis')
    for (const page of ['/home/kpis', '/home/kpis/[key]', '/home/kpis/[key]/records']) expect(OFFICE_PAGES.has(page)).toBe(true)
  })

  it('tells its history newest first and compares two versions field by field', () => {
    const events = versionEvents(OTIF_VERSIONS)
    expect(events.map((event) => `${event.what}:${event.kpiVersion}`)).toEqual(['WRITTEN:3', 'IN_FORCE:2', 'SUPERSEDED:1', 'WRITTEN:2', 'IN_FORCE:1', 'WRITTEN:1'])
    expect(defaultCompare(OTIF_VERSIONS)).toEqual([2, 3])
    expect(defaultCompare([OTIF_VERSIONS[0]!])).toBeNull()
    const changes = versionChanges(OTIF_VERSIONS[1]!, OTIF_VERSIONS[0]!, en, 'en')
    expect(changes.map((change) => change.field)).toEqual(['definition'])
    expect(changes[0]!.after).toContain('A line closed short counts')
    expect(changes[0]!.after).toContain('Italian: ')
    expect(versionChanges(OTIF_VERSIONS[2]!, OTIF_VERSIONS[1]!, en, 'en').map((change) => change.field)).toEqual(['name', 'definition'])
  })
})

describe('the owner’s version form', () => {
  const record = recordFor('production.output')
  const base = record.versions[0]!

  it('starts from the version in force; a new version asks what changed; the domain’s draft rules say the rest', () => {
    const draft = draftOf(base, 'new')
    expect(formProblems(draft, base, record.calculation, 'new')).toEqual({ changeNote: 'form.problem.changeNote' })
    expect(formProblems({ ...draft, changeNote: 'x', nameIt: '', sourceRecords: [] }, base, record.calculation, 'new')).toEqual({ nameIt: 'form.problem.nameIt', sourceRecords: 'form.problem.sourceRecords' })
    expect(draftChanged(draft, base)).toBe(false)
    expect(draftChanged({ ...draft, nameEn: 'Good pieces' }, base)).toBe(true)
  })

  it('sends only what changed, and the calculation’s facts when the version names others', () => {
    const draft = { ...draftOf(base, 'new'), nameEn: 'Good pieces', changeNote: ' Shorter name. ' }
    expect(bodyOf(draft, base, record.calculation, 'new')).toEqual({ nameEn: 'Good pieces', changeNote: 'Shorter name.' })
    const margin = recordFor('sales.order_margin')
    const old = margin.versions[0]!
    expect(differsFromCalculation(old, margin.calculation)).toBe(true)
    expect(bodyOf({ ...draftOf(old, 'new'), changeNote: 'Facts.' }, old, margin.calculation, 'new')).toEqual({ measureKeys: ['orders.margin', 'orders.value_costed'], unit: 'PERCENT', grain: 'MARGIN', changeNote: 'Facts.' })
    expect(versionsAtHand(recordFor('delivery.otif')).draft?.kpiVersion).toBe(3)
    expect(versionsAtHand(recordFor('delivery.otif')).base?.kpiVersion).toBe(2)
  })

  it('says a refused write in words: a refusal code, a field, someone else’s change, the network', () => {
    const refused = (status: number, kind: ConstructorParameters<typeof ApiError>[0], path: string) => new ApiError(kind, status, 'x', 'x', null, [{ path, message: 'x' }])
    expect(writeProblem(refused(409, 'conflict', 'refusal/MEASURES_DIFFER'))).toEqual({ key: 'refusal.MEASURES_DIFFER', field: null })
    expect(writeProblem(refused(400, 'invalid', 'body/nameEn'))).toEqual({ key: 'form.problem.nameEn', field: 'nameEn' })
    expect(writeProblem(refused(409, 'conflict', 'version'))).toEqual({ key: 'refusal.stale', field: null })
    expect(writeProblem(new ApiError('unavailable', 503, 'network', 'x'))).toEqual({ key: 'refusal.offline', field: null })
    expect(writeProblem(new Error('x'))).toEqual({ key: 'refusal.failed', field: null })
  })
})

describe('the records behind a KPI (B-W2b-429 drills)', () => {
  it('reads a real period from the address and asks the drill with the KPI’s terms, the period and the company', () => {
    expect(spanOf(params('from=2026-11-01&to=2026-11-30'))).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(spanOf(params('from=2026-11-30&to=2026-11-01'))).toEqual({ from: null, to: null })
    expect(spanOf(params('from=2025-01-01&to=2026-11-01'))).toEqual({ from: null, to: null })
    expect(spanProblem('2026-11-30', '2026-11-01')).toBe('records.span.backwards')
    expect(spanProblem('2026-11-01', '')).toBe('records.span.day')
    const span = { from: '2026-11-01', to: '2026-11-30' }
    expect(drillQuery('otif', { promise: 'FIRST' }, span, 'c1')).toEqual({ promise: 'FIRST', from: '2026-11-01', to: '2026-11-30', companyId: 'c1' })
    expect(drillQuery('wip', {}, span, 'c1')).toEqual({})
    expect(drillQuery('supply', {}, span, 'c1')).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(recordsHref('/w/A', 'delivery.otif', span)).toBe('/w/A/home/kpis/delivery.otif/records?from=2026-11-01&to=2026-11-30')
    expect(isDrillName('otif')).toBe(true)
    expect(isDrillName('nope')).toBe(false)
  })

  it('draws each drill as one view: its overall, groups and rows (money columns only with their rights)', () => {
    const otif = drillView(OTIF_DRILL, en, 'en')
    expect(otif.metrics[0]).toEqual({ label: 'On time in full', value: '83.3 %', hint: 'By the first promised date' })
    expect(otif.rows).toHaveLength(6)
    expect(otif.groups.map((group) => group.id)).toEqual(['customer', 'site', 'month'])
    expect(drillView(LEAD_DRILL, en, 'en').metrics[0]!.value).toBe('7.5 days')
    expect(drillView(wipDrill(true), en, 'en').columns.map((column) => column.id)).toContain('value')
    expect(drillView(wipDrill(false), en, 'en').columns.map((column) => column.id)).not.toContain('value')
    const margin = drillView(marginDrill(false), en, 'en')
    expect(margin.columns.map((column) => column.id)).not.toContain('value')
    expect(margin.notes).toContain('Margin amounts need the cost rights too: percents only.')
    expect(drillView(marginDrill(true), it_, 'it').groups[0]!.columns).toContain('Margine preventivato')
    const hidden = drillView(supplyDrill(false), en, 'en')
    expect(hidden.groups.find((group) => group.id === 'shortages')!.empty).toBe('Shortages need the planning list, which your role does not include.')
  })

  it('says a refused drill by the right it needs', () => {
    const refused = (path: string) => new ApiError('forbidden', 403, 'forbidden', 'x', null, [{ path, message: 'x' }])
    expect(drillProblem(refused('permission/costing.view'))).toEqual({ key: 'records.needsPermission', params: { permission: 'costing.view' } })
    expect(drillProblem(refused('grain/margin'))).toEqual({ key: 'records.needsGrain', params: { grain: 'margin' } })
    expect(drillProblem(new ApiError('unavailable', 503, 'network', 'x'))).toEqual({ key: 'error.offline' })
  })

  it('every demo KPI with a LIST drill has a drill this page knows', () => {
    for (const file of KPI_CATALOGUE) {
      const drill = file.drill
      if (drill?.kind === 'LIST' && drill.api.startsWith('/insights/kpis/drills/')) expect(isDrillName(drill.api.split('/').at(-1)!), file.key).toBe(true)
    }
    expect(fileOf('delivery.otif').drill?.kind).toBe('LIST')
    expect(BUILT.has('/home/kpis/[key]/records')).toBe(true)
  })
})

// ---- every design case draws in both languages with no key left on screen --------------------------------------------------

const NAMESPACES = Object.keys(words('en')).map((key) => key.split('.')[0]!)
const LEFT_KEY = new RegExp(`\\b(?:${[...new Set(NAMESPACES)].join('|')})\\.[a-zA-Z_][a-zA-Z0-9_-]*(?:\\.[a-zA-Z0-9_-]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Data that looks like a key: a KPI's or report's key in a link, the withdrawn KPI's fact, a permission, an e-mail address. */
const SAID = /\/home\/(?:kpis|reports)\/[a-z._-]+|\bquotes\.sent\b|\bhome\.kpis\.[a-z]+\b|\bcosting\.view\b|\b[\w.-]+@[\w.-]+\.\w+\b|\b(?:sales|production|delivery|purchasing)\.[a-z_]+\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [libraryScreen, recordScreen, recordsScreen] as unknown as DesignScreen<unknown>[]) {
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

  it('the owner’s case shows the draft’s buttons; the planner’s holds "New version" with why', () => {
    const owner = render(recordScreen as unknown as DesignScreen<unknown>, recordScreen.cases.find((item) => item.id === 'owner')!.model, 'en')
    expect(owner).toContain('Put in force')
    expect(owner).toContain('Open the records behind it')
    const planner = render(recordScreen as unknown as DesignScreen<unknown>, recordScreen.cases.find((item) => item.id === 'planner')!.model, 'en')
    expect(planner).toContain('Changing a KPI is the owner’s')
    expect(planner).not.toContain('Targets')
  })
})
