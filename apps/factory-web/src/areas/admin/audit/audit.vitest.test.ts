import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { WORKERS } from '../shared/fixtures'
import { AUDIT_SURFACES, AUDIT_VIEWS, listAudit, type AuditEntry } from './api'
import { AdminPageMessages } from '../kit/messages'
import { AUDIT_ENTRIES, designScreen } from './fixtures'
import { EntryDetail } from './view/AuditView'
import {
  ACTION_AREAS,
  AUDIT_MODES,
  AUDIT_PERIODS,
  changedRows,
  changeRows,
  deviceTimeDiffers,
  didKey,
  entryHref,
  fieldWords,
  filterCount,
  findOnPage,
  hiddenGrains,
  NO_FILTERS,
  paramsOf,
  periodFrom,
  queryOf,
  RECORD_TYPES,
  recordHref,
  recordLabel,
  stateFromParams,
  type AuditViewModel,
  valueText,
  whereOf,
  whoOf,
} from './model'

/**
 * SCR-018 Audit log (B-W0-28): the address as the page's state, the words of who did what (never a floor worker's
 * name), before → after, the call to `GET /audit`, and every design case drawn in it and en with no key left on screen.
 */

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({ ...AUDIT_ENTRIES[0]!, ...over })
const ID = '0190f0e2-5555-7000-8000-000000000001'

describe('the address holds the filters, the mode and the open entry', () => {
  it('reads what it knows and drops what is malformed', () => {
    const state = stateFromParams(new URLSearchParams(`view=roles&who=${ID}&surface=FLOOR&type=NumberSeries&record=${ID}&area=numbering&company=${ID}&period=7d&mode=table&open=${ID}`))
    expect(state).toEqual({
      filters: { view: 'roles', actorId: ID, audience: 'FLOOR', recordType: 'NumberSeries', recordId: ID, area: 'numbering', companyId: ID, period: '7d' },
      mode: 'table',
      open: ID,
    })
    expect(stateFromParams(new URLSearchParams('view=all&who=nobody&surface=MOON&type=drop table&area=x&period=2y&mode=grid&open=1'))).toEqual({ filters: NO_FILTERS, mode: 'story', open: null })
    expect(stateFromParams(null)).toEqual({ filters: NO_FILTERS, mode: 'story', open: null })
  })

  it('writes the address back, leaving the defaults out, and round-trips', () => {
    expect(paramsOf(NO_FILTERS, 'story')).toBe('')
    const filters = { ...NO_FILTERS, view: 'settings' as const, companyId: ID, period: '30d' as const }
    const query = paramsOf(filters, 'table', ID)
    expect(query).toBe(`view=settings&company=${ID}&period=30d&mode=table&open=${ID}`)
    expect(stateFromParams(new URLSearchParams(query))).toEqual({ filters, mode: 'table', open: ID })
    expect(entryHref('/w/DEMO', { filters: NO_FILTERS, mode: 'story' }, ID)).toBe(`/w/DEMO/admin/audit?open=${ID}`)
  })

  it('turns the filters into the API query: an area is an action prefix, a period a start from now', () => {
    const now = new Date('2026-10-29T09:42:00.000Z')
    expect(queryOf({ ...NO_FILTERS, area: 'numbering', period: '24h', audience: 'OFFICE' }, now)).toMatchObject({ action: 'numbering.', from: '2026-10-28T09:42:00.000Z', audience: 'OFFICE' })
    expect(queryOf(NO_FILTERS, now)).toMatchObject({ action: null, from: null })
    expect(periodFrom('30d', now)).toBe('2026-09-29T09:42:00.000Z')
    expect(filterCount(NO_FILTERS)).toBe(0)
    expect(filterCount({ ...NO_FILTERS, recordType: 'Company', recordId: ID, period: '7d' })).toBe(2)
  })
})

describe('the words of an entry', () => {
  it('names an office person, never a floor worker: a worker on the tablet', () => {
    expect(whoOf(entry({ audience: 'OFFICE', actorName: 'Bea Esempio' }))).toEqual({ key: 'audit.who.person', params: { name: 'Bea Esempio' } })
    expect(whoOf(entry({ audience: 'OFFICE', actorName: null }))).toEqual({ key: 'audit.who.officeUnknown' })
    expect(whoOf(entry({ audience: 'FLOOR', actorName: 'Anna Demo', deviceName: 'Tablet taglio 1' }))).toEqual({ key: 'audit.who.floorOn', params: { device: 'Tablet taglio 1' } })
    expect(whoOf(entry({ audience: 'FLOOR', deviceName: null }))).toEqual({ key: 'audit.who.floor' })
    expect(whoOf(entry({ audience: 'SYSTEM' })).key).toBe('audit.who.system')
    expect(recordLabel(entry({ recordType: 'Worker', after: { displayName: 'Anna Demo' } }))).toBeNull()
  })

  it('says an action by its own words when known, else falls back (the key the catalogue may hold)', () => {
    expect(didKey('numbering.closeSeries')).toBe('audit.did.numbering_closeSeries')
    expect(didKey('compliance.certificates.create')).toBe('audit.did.compliance_certificates_create')
    const en = CATALOGUE.en['admin-audit'] ?? {}
    expect(en[didKey('numbering.closeSeries')]).toBe('closed')
    expect(en[didKey('quotes.update')]).toBeUndefined()
    expect(en['audit.did.other']).toBe('changed')
  })

  it("links a record to its page when the Office has one, and names it by what the write recorded", () => {
    expect(recordHref('/w/DEMO', { recordType: 'NumberSeries', recordId: ID, companyId: null })).toBe(`/w/DEMO/admin/documents?series=${ID}`)
    expect(recordHref('/w/DEMO', { recordType: 'Site', recordId: ID, companyId: 'c1' })).toBe(`/w/DEMO/admin/companies/c1/sites/${ID}`)
    expect(recordHref('/w/DEMO', { recordType: 'Site', recordId: ID, companyId: null })).toBeNull()
    expect(recordHref('/w/DEMO', { recordType: 'Worker', recordId: ID, companyId: 'c1' })).toBe(`/w/DEMO/admin/users/floor/${ID}`)
    expect(recordHref('/w/DEMO', { recordType: 'Quote', recordId: ID, companyId: 'c1' })).toBeNull()
    expect(recordLabel(entry({ before: { code: 'OLD' }, after: { code: 'MAIN', name: 'Main' } }))).toBe('MAIN')
    expect(recordLabel(entry({ before: null, after: null }))).toBeNull()
    const companies = [{ id: 'c1', name: 'Officina Demo S.r.l.', sites: [{ id: 's1', name: 'Stabilimento Demo Nord' }] }]
    expect(whereOf({ companyId: 'c1', siteId: 's1' }, companies)).toBe('Officina Demo S.r.l. › Stabilimento Demo Nord')
    expect(whereOf({ companyId: 'c1', siteId: null }, companies)).toBe('Officina Demo S.r.l.')
    expect(whereOf({ companyId: null, siteId: null }, companies)).toBeNull()
  })

  it('lists every field before → after, marking the changed ones', () => {
    const rows = changeRows({ status: 'ACTIVE', nextValue: 42, tags: ['a', 'b'] }, { status: 'CLOSED', nextValue: 42, extra: { x: 1 } })
    expect(rows).toEqual([
      { field: 'status', from: 'ACTIVE', to: 'CLOSED', changed: true },
      { field: 'nextValue', from: '42', to: '42', changed: false },
      { field: 'extra', from: null, to: '{"x":1}', changed: true },
      { field: 'tags', from: 'a, b', to: null, changed: true },
    ])
    expect(changedRows(null, { a: 1 })).toEqual([{ field: 'a', from: null, to: '1', changed: true }])
    expect(changeRows('not an object', null)).toEqual([])
    expect(valueText(false)).toBe('false')
    expect(valueText(null)).toBeNull()
    expect(valueText({ long: 'x'.repeat(200) })!.length).toBe(120)
    expect(fieldWords('startValue')).toBe('start value')
  })

  it('knows the money a person does not see, the tablet time that differs, and finds on the page', () => {
    expect(hiddenGrains(['audit.read', 'money.price'])).toEqual(['cost', 'margin', 'wages'])
    expect(hiddenGrains(['money.price', 'money.cost', 'money.margin', 'money.wages'])).toEqual([])
    expect(deviceTimeDiffers({ at: '2026-10-29T09:00:00.000Z', deviceTime: '2026-10-29T08:59:58.000Z' })).toBe(true)
    expect(deviceTimeDiffers({ at: '2026-10-29T09:00:00.000Z', deviceTime: '2026-10-29T08:59:59.500Z' })).toBe(false)
    expect(deviceTimeDiffers({ at: '2026-10-29T09:00:00.000Z', deviceTime: null })).toBe(false)
    const found = findOnPage(AUDIT_ENTRIES, ' PAUSÈD ', (item) => (item.action === 'integration.pauseAccount' ? 'Alex paused SDI' : item.action))
    expect(found.map((item) => item.action)).toEqual(['integration.pauseAccount'])
    expect(findOnPage(AUDIT_ENTRIES, '  ', () => '')).toHaveLength(AUDIT_ENTRIES.length)
  })
})

interface Call {
  method: string
  url: string
  headers: Headers
}

function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers) })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('GET /audit', () => {
  it('sends the filters it has, with the company header, and checks the answer', async () => {
    const { api, calls } = mockApi([{ status: 200, body: { entries: AUDIT_ENTRIES.slice(0, 2), nextBefore: AUDIT_ENTRIES[1]!.id, counts: null } }])
    const page = await listAudit(api, { view: 'settings', action: 'numbering.', from: '2026-10-22T00:00:00.000Z', before: ID, limit: 50, withCounts: true, actorId: null })
    expect(page.entries).toHaveLength(2)
    expect(page.nextBefore).toBe(AUDIT_ENTRIES[1]!.id)
    expect(calls[0]!.method).toBe('GET')
    const url = new URL(calls[0]!.url, 'http://localhost')
    expect(url.pathname).toBe('/api/audit')
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: 'settings', action: 'numbering.', from: '2026-10-22T00:00:00.000Z', before: ID, limit: '50', withCounts: 'true' })
    expect(calls[0]!.headers.get('x-factory-company')).toBe('DEMO')
  })

  it('an answer of another shape is a contract error, never half-read; a refusal keeps its kind', async () => {
    const { api } = mockApi([
      { status: 200, body: { entries: [{ id: 'x' }], nextBefore: null, counts: null } },
      { status: 403, body: { error: { code: 'forbidden', message: 'No.' } } },
    ])
    const contract = await listAudit(api).catch((error: unknown) => error)
    expect(isApiError(contract) && contract.kind).toBe('contract')
    const refused = await listAudit(api).catch((error: unknown) => error)
    expect(isApiError(refused) && refused.kind).toBe('forbidden')
  })
})

// ---- words and design cases ----

const SRC = fileURLToPath(new URL('.', import.meta.url))
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
const catalogue = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['admin-audit'] ?? {}
const has = (key: string) => LOCALES.every((locale) => key in catalogue(locale) || (`${key}_one` in catalogue(locale) && `${key}_other` in catalogue(locale)))

describe('every Audit log string exists in it and en', () => {
  it('the same keys and placeholders, no empty text, every key under audit.', () => {
    const en = catalogue('en')
    const itc = catalogue('it')
    expect(Object.keys(en).length).toBeGreaterThan(250)
    expect(Object.keys(itc).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) {
      expect(key.startsWith('audit.'), key).toBe(true)
      expect(en[key]?.trim(), `en ${key}`).not.toBe('')
      expect(itc[key]?.trim(), `it ${key}`).not.toBe('')
      expect(placeholdersOf(itc[key] ?? ''), `placeholders of ${key}`).toEqual(placeholdersOf(en[key] ?? ''))
    }
  })

  it('every key the code names, literally or from a list, exists', () => {
    const literal = new Set<string>()
    for (const file of sources(SRC)) for (const match of readFileSync(file, 'utf8').matchAll(/['"`](audit\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) if (match[1] !== 'audit.read') literal.add(match[1]!) // the permission, not a key
    const built = [
      ...AUDIT_VIEWS.flatMap((view) => [`audit.tile.${view}`, `audit.tileHint.${view}`]),
      ...AUDIT_SURFACES.map((surface) => `audit.surface.${surface}`),
      ...ACTION_AREAS.map((area) => `audit.area.${area}`),
      ...AUDIT_PERIODS.map((period) => `audit.period.${period}`),
      ...AUDIT_MODES.map((mode) => `audit.mode.${mode}`),
      ...RECORD_TYPES.map((type) => `audit.type.${type}`),
      'audit.change.more',
    ]
    const keys = [...literal, ...built]
    expect(keys.length).toBeGreaterThan(100)
    expect(keys.filter((key) => !has(key))).toEqual([])
  })

  it('the admin keys the page borrows exist in admin (common, list, problem, record, grains)', () => {
    const admin = CATALOGUE.en.admin ?? {}
    const borrowed = new Set<string>()
    for (const file of sources(SRC)) for (const match of readFileSync(file, 'utf8').matchAll(/ta\(['"`]((?:common|list|problem|record)\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) borrowed.add(match[1]!)
    expect(borrowed.size).toBeGreaterThan(5)
    expect([...borrowed].filter((key) => !(key in admin))).toEqual([])
  })
})

const LEFT_KEY = /\b(?:audit|common|list|problem|record|grains)\.[a-zA-Z]+(?:\.[a-zA-Z0-9_]+)*\b/

function render(model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = (designScreen as DesignScreen<unknown>).view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every SCR-018 design case draws in both languages with no key left on screen', () => {
  it('has every state: story, table, filtered, floor, money hidden, the entry, empty, loading, error, no access', () => {
    expect(designScreen.screen).toBe('SCR-018')
    const ids = designScreen.cases.map((item) => item.id)
    for (const id of ['story', 'table', 'filtered', 'floor', 'money-hidden', 'entry', 'empty', 'empty-filtered', 'loading', 'error', 'no-access', 'older-loading']) expect(ids).toContain(id)
  })

  for (const locale of LOCALES) {
    it(`${designScreen.cases.length} cases in ${locale}`, () => {
      for (const item of designScreen.cases) {
        const html = render(item.model, locale)
        expect(html.length, item.id).toBeGreaterThan(500)
        // An action code shown on purpose (an action this page has no words for) is not a key.
        const text = html.replace(/<code[^>]*>[^<]*<\/code>/g, '')
        expect(text.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('every open entry draws its body in both languages: before → after, both times, the same request (the modal draws it only in the browser)', () => {
    const opened = designScreen.cases.filter((item) => item.model.model.open?.entry)
    expect(opened.length).toBeGreaterThan(4)
    for (const locale of LOCALES) {
      for (const item of opened) {
        const model = item.model.model as AuditViewModel
        const html = renderToString(
          createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(AdminPageMessages, { namespace: 'admin-audit' }, createElement(EntryDetail, { model, entry: model.open!.entry! }))),
        )
        const text = html.replace(/<code[^>]*>[^<]*<\/code>/g, '')
        expect(text.match(LEFT_KEY)?.[0] ?? null, `${item.id} body (${locale})`).toBeNull()
      }
    }
    const entryCase = designScreen.cases.find((item) => item.id === 'entry')!.model.model as AuditViewModel
    const body = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(AdminPageMessages, { namespace: 'admin-audit' }, createElement(EntryDetail, { model: entryCase, entry: entryCase.open!.entry! }))))
    expect(body).toContain('Before and after')
    expect(body).toContain('ACTIVE')
    expect(body).toContain('CLOSED')
    expect(body).toContain('req-close-01')
    expect(body).toContain('demo-key-0001')
    expect(body).toContain('created') // the series B the same request created
    const floorCase = designScreen.cases.find((item) => item.id === 'entry-floor')!.model.model as AuditViewModel
    const floor = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(AdminPageMessages, { namespace: 'admin-audit' }, createElement(EntryDetail, { model: floorCase, entry: floorCase.open!.entry! }))))
    expect(floor).toContain('Tablet time')
    expect(floor).toContain('Tablet taglio 1')
    for (const worker of WORKERS) expect(floor).not.toContain(worker.displayName)
    const money = designScreen.cases.find((item) => item.id === 'money-hidden')!.model.model as AuditViewModel
    expect(renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(AdminPageMessages, { namespace: 'admin-audit' }, createElement(EntryDetail, { model: money, entry: money.open!.entry! }))))).toContain('Money you do not see (price, cost, margin, wages) is left out')
  })

  it('the Story says who did what in words; a floor entry names the tablet, never the worker', () => {
    const story = render(designScreen.cases.find((item) => item.id === 'story')!.model, 'en')
    expect(story).toContain('closed')
    expect(story).toContain('A worker on Tablet taglio 1')
    for (const worker of WORKERS) expect(story).not.toContain(worker.displayName)
    const it = render(designScreen.cases.find((item) => item.id === 'story')!.model, 'it')
    expect(it).toContain('ha chiuso')
    expect(it).toContain('Un addetto su Tablet taglio 1')
  })

  it('without the right to read the log the page says so and lists nothing', () => {
    const html = render(designScreen.cases.find((item) => item.id === 'no-access')!.model, 'en')
    expect(html).toContain('Reading the audit log needs the right')
    expect(html).not.toContain('Role changes')
  })

  it('an action without words says "changed" and shows its code in the table; export is held with its reason', () => {
    const html = render(designScreen.cases.find((item) => item.id === 'table')!.model, 'en')
    expect(html).toContain('quotes.update')
    expect(html).toContain('Exporting the log comes in a later step.')
  })
})
