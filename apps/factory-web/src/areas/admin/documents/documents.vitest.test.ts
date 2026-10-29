import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { LOCALES } from '../../../lib/i18n/locales'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { COMPANIES } from '../shared/fixtures'
import { closeSeries, createSeries, listSeries, sampleHref, seriesAllocations, setSeriesStart, type Series } from './api'
import { designScreen, SERIES } from './fixtures'
import {
  chipsPattern,
  draftBody,
  draftPreview,
  draftProblems,
  fiscalRows,
  hasOtherActive,
  legalOf,
  newDraft,
  newSeriesHeld,
  patternChips,
  patternIssue,
  proofWords,
  sampleCompany,
  seriesRows,
  skippedWords,
  startEditable,
  type DocumentsViewModel,
} from './model'

/**
 * SCR-014 Documents & numbering: the pattern rules in this web's words, the new-series form, the lists' order, the
 * Fiscal check's words, the calls to platform/numbering, and every design case in it and en with no key on screen.
 */

const series = (extra: Partial<Series>): Series => ({ ...SERIES[0]!, ...extra })

describe('the pattern', () => {
  it('says what is wrong in this web\'s words, as factory-domain\'s rules', () => {
    expect(patternIssue('', 'YEARLY', false)).toBe('docs.pattern.issue.empty')
    expect(patternIssue('X'.repeat(41) + '{N}', 'YEARLY', false)).toBe('docs.pattern.issue.tooLong')
    expect(patternIssue('FT-{DATE}-{N}', 'YEARLY', false)).toBe('docs.pattern.issue.badToken')
    expect(patternIssue('FT-{YYYY}', 'YEARLY', false)).toBe('docs.pattern.issue.noNumber')
    expect(patternIssue('{N}-{N}', 'YEARLY', false)).toBe('docs.pattern.issue.twoNumbers')
    expect(patternIssue('FT {N}', 'YEARLY', false)).toBe('docs.pattern.issue.badText')
    expect(patternIssue('LOT-{YY}-{N}', 'NEVER', false)).toBe('docs.pattern.issue.yearNeedsYearly')
    expect(patternIssue('FATTURA-ITALIA-{YYYY}-{N:9}', 'YEARLY', true)).toBe('docs.pattern.issue.fiscalTooLong')
    expect(patternIssue('FATTURA-ITALIA-{YYYY}-{N:9}', 'YEARLY', false)).toBeNull()
    expect(patternIssue('FT-{YYYY}-{N:5}', 'YEARLY', true)).toBeNull()
    expect(patternIssue('{N:13}', 'NEVER', false)).toBe('docs.pattern.issue.digits')
  })

  it('draws a pattern as chips: fixed text, the year, the counter with its digits', () => {
    expect(patternChips('FT-{YYYY}-{N:5}')).toEqual([{ kind: 'text', text: 'FT-' }, { kind: 'year', digits: 4 }, { kind: 'text', text: '-' }, { kind: 'number', digits: 5 }])
    expect(patternChips('E/{N}/{YY}')).toEqual([{ kind: 'text', text: 'E/' }, { kind: 'number', digits: 1 }, { kind: 'text', text: '/' }, { kind: 'year', digits: 2 }])
    expect(patternChips('bad {X}')).toBeNull()
  })

  it('builds the pattern from the chips, the year only for a yearly series', () => {
    expect(chipsPattern({ prefix: 'FT', separator: '-', yearToken: 'YYYY', digits: '5', reset: 'YEARLY' })).toBe('FT-{YYYY}-{N:5}')
    expect(chipsPattern({ prefix: 'LOT', separator: '-', yearToken: 'YYYY', digits: '6', reset: 'NEVER' })).toBe('LOT-{N:6}')
    expect(chipsPattern({ prefix: '', separator: '/', yearToken: 'YY', digits: '1', reset: 'YEARLY' })).toBe('{YY}/{N}')
  })
})

describe('the new-series form', () => {
  it('starts from the kind\'s defaults and shows the first number as it will print', () => {
    const draft = newDraft('c1', 'INVOICE')
    expect(draft).toMatchObject({ kind: 'INVOICE', code: 'MAIN', reset: 'YEARLY', prefix: 'FT', yearToken: 'YYYY', digits: '5' })
    expect(draftPreview(draft)).toBe('FT-2026-00001')
    expect(draftPreview({ ...draft, start: '143' })).toBe('FT-2026-00143')
    expect(newDraft('c1', 'LOT')).toMatchObject({ reset: 'NEVER', yearToken: 'none', digits: '6' })
    expect(draftPreview(newDraft('c1', 'LOT'))).toBe('LOT-000001')
  })

  it('lists each problem by field and sends only a clean draft', () => {
    const bad = { ...newDraft('', 'INVOICE'), code: 'b c', year: '99', start: '0', typed: true, pattern: 'FT' }
    expect(draftProblems(bad)).toEqual({ companyId: 'docs.form.required', code: 'docs.form.code', year: 'docs.form.year', pattern: 'docs.pattern.issue.noNumber', start: 'docs.form.start' })
    expect(draftPreview(bad)).toBeNull()
    expect(draftProblems(newDraft('c1', 'DDT'))).toEqual({})
    expect(draftBody({ ...newDraft('c1', 'DDT'), start: '101' })).toEqual({ companyId: 'c1', kind: 'DDT', code: 'MAIN', reset: 'YEARLY', year: 2026, pattern: 'DDT-{YYYY}-{N:5}', startValue: 101 })
    expect(draftBody(newDraft('c1', 'LOT'))).not.toHaveProperty('year')
  })
})

describe('the lists', () => {
  const model = designScreen.cases[0]!.model as DocumentsViewModel
  const companies = model.companies.items!

  it('orders by company, document, code and newest period; filters one company', () => {
    const rows = seriesRows(SERIES, 'all', companies)
    expect(rows.map((row) => `${row.kind}:${row.scopeKey}`)).toEqual(['QUOTE:2026', 'SALES_ORDER:2026', 'PURCHASE_ORDER:2026', 'WORK_ORDER:2026', 'DDT:2026', 'INVOICE:2026', 'INVOICE:2025', 'CREDIT_NOTE:2026', 'LOT:ALL', 'INVOICE:2026'])
    expect(rows.at(-1)!.companyId).toBe(companies[1]!.id)
    expect(seriesRows(SERIES, companies[1]!.id, companies).map((row) => row.kind)).toEqual(['INVOICE'])
  })

  it('a start can change only while nothing was issued; the fiscal check takes the active fiscal series', () => {
    expect(startEditable(series({ startValue: 5, nextValue: 5 }))).toBe(true)
    expect(startEditable(series({ startValue: 5, nextValue: 6 }))).toBe(false)
    expect(startEditable(series({ startValue: 5, nextValue: 5, status: 'CLOSED' }))).toBe(false)
    expect(fiscalRows(SERIES).map((row) => row.kind)).toEqual(['DDT', 'INVOICE', 'CREDIT_NOTE', 'INVOICE'])
  })

  it('says the proof in words: nothing issued, reading, failed, no gaps, numbers not issued by Nexus', () => {
    const issued = series({ startValue: 1, nextValue: 42 })
    expect(proofWords(series({ startValue: 1, nextValue: 1 }), undefined).key).toBe('docs.fiscal.none')
    expect(proofWords(issued, { state: 'checking' }).key).toBe('docs.fiscal.checking')
    expect(proofWords(issued, { state: 'failed', problem: 'problem.unavailable' })).toMatchObject({ key: 'docs.fiscal.failed', tone: 'danger' })
    const proof = { count: 41, first: 1, last: 41, firstFormatted: 'FT-2026-00001', lastFormatted: 'FT-2026-00041', lastDocumentDate: '2026-10-28', skipped: [], moreSkipped: false }
    expect(proofWords(issued, { state: 'ok', proof })).toEqual({ key: 'docs.fiscal.noGaps', params: { first: 'FT-2026-00001', last: 'FT-2026-00041', count: 41 }, tone: 'success' })
    const skipped = { ...proof, skipped: [{ from: 3, to: 9 }, { from: 14, to: 14 }] }
    expect(proofWords(issued, { state: 'ok', proof: skipped })).toMatchObject({ key: 'docs.fiscal.skipped', params: { ranges: '3–9, 14' }, tone: 'warning' })
    expect(skippedWords({ skipped: [{ from: 2, to: 2 }], moreSkipped: true })).toBe('2, …')
  })

  it('warns before closing the last active series of a document; holds New series with its reason', () => {
    const creditNote = SERIES.find((row) => row.kind === 'CREDIT_NOTE')!
    const invoice = SERIES.find((row) => row.kind === 'INVOICE' && row.status === 'ACTIVE' && row.companyId === creditNote.companyId)!
    expect(hasOtherActive(creditNote, SERIES)).toBe(false)
    expect(hasOtherActive(invoice, [...SERIES, { ...invoice, id: 'x', code: 'B' }])).toBe(true)
    expect(newSeriesHeld({ can: { manage: false, documents: true }, companies: model.companies })).toBe('docs.held.manage')
    expect(newSeriesHeld({ can: { manage: true, documents: true }, companies: { items: [], problem: null } })).toBe('docs.held.noCompany')
    expect(newSeriesHeld(model)).toBeNull()
    expect(sampleCompany({ companyId: 'all', companies: model.companies })?.id).toBe(companies[0]!.id)
    expect(sampleCompany({ companyId: companies[1]!.id, companies: model.companies })?.id).toBe(companies[1]!.id)
  })
})

describe('a company\'s documents can be printed only with its legal data (the API\'s own rule)', () => {
  it('ready with the registered office, VAT number, codice fiscale and REA; each missing fact counted', () => {
    expect(legalOf(COMPANIES[0]!)).toEqual({ legalReady: true, legalMissing: 0 })
    expect(legalOf({ ...COMPANIES[0]!, fiscalCode: null })).toEqual({ legalReady: false, legalMissing: 1 })
    expect(legalOf(COMPANIES[1]!).legalReady).toBe(false)
    expect(legalOf(COMPANIES[1]!).legalMissing).toBeGreaterThan(2)
  })
})

interface Call {
  method: string
  url: string
  headers: Headers
  body: unknown
}
function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('the numbering calls (platform/numbering)', () => {
  it('lists, creates with an Idempotency-Key, sets a start, closes and reads the numbers issued', async () => {
    const one = SERIES[5]!
    const { api, calls } = mockApi([
      { status: 200, body: { series: SERIES } },
      { status: 201, body: { series: one } },
      { status: 200, body: { series: one } },
      { status: 200, body: { series: { ...one, status: 'CLOSED' } } },
      { status: 200, body: { series: one, summary: { count: 0, first: null, last: null, firstFormatted: null, lastFormatted: null, lastDocumentDate: null, skipped: [], moreSkipped: false }, allocations: [] } },
    ])
    expect(await listSeries(api)).toHaveLength(SERIES.length)
    await createSeries(api, { companyId: 'c1', kind: 'INVOICE', startValue: 1 }, 'key-1')
    await setSeriesStart(api, one.id, { startValue: 7, version: 1 })
    expect((await closeSeries(api, one.id, { version: 2, reason: 'Moved' })).status).toBe('CLOSED')
    await seriesAllocations(api, one.id, 50)
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/numbering/series',
      'POST /api/numbering/series',
      `PUT /api/numbering/series/${one.id}/start`,
      `POST /api/numbering/series/${one.id}/close`,
      `GET /api/numbering/series/${one.id}/allocations?limit=50`,
    ])
    expect(calls[1]!.headers.get('idempotency-key')).toBe('key-1')
    expect(calls[2]!.body).toEqual({ startValue: 7, version: 1 })
    expect(calls[3]!.body).toEqual({ version: 2, reason: 'Moved' })
    expect(calls[3]!.headers.get('x-csrf-token')).toBe('csrf-demo')
  })

  it('a sample document is a plain address through /api (a GET in a new tab)', () => {
    expect(sampleHref('c1', 'INVOICE_COPY', 'en')).toBe('/api/documents/sample?companyId=c1&type=INVOICE_COPY&language=en')
  })
})

const LEFT_KEY = /\b(?:docs|common|list|problem|stepUp|held|form)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = designScreen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('SCR-014 draws every case in both languages with no key left on screen', () => {
  it('has every state: loading, error, empty, read-only, dialogs', () => {
    const ids = designScreen.cases.map((item) => item.id)
    for (const id of ['loading', 'error', 'forbidden', 'empty', 'read-only', 'new-series', 'series-issued', 'close', 'numbers-issued', 'documents']) expect(ids).toContain(id)
  })
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      for (const item of designScreen.cases) {
        const html = render(item.model, locale)
        expect(html.length, item.id).toBeGreaterThan(500)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('says the fiscal proof, the moved-past range, and the held reasons in words', () => {
    const draw = (id: string) => render(designScreen.cases.find((item) => item.id === id)!.model, 'en')
    expect(draw('numbers')).toContain('not issued by Nexus: 181–188')
    expect(draw('numbers')).toContain('41 numbers issued, FT-2026-00001 to FT-2026-00041, no gaps.')
    expect(draw('read-only')).toContain('Needs the right: Manage number series')
    expect(draw('documents')).toContain('target="_blank"')
    expect(draw('documents')).toContain('/api/documents/sample?companyId=')
    expect(render(designScreen.cases.find((item) => item.id === 'numbers')!.model, 'it')).toContain('Controllo fiscale')
  })
})
