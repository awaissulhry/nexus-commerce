import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GUEST_REFUSALS, PURCHASE_SOURCES, SALES_SDI_STATES } from '@nexus/factory-domain/accounting/guest/files'
import { ApiError } from '../../../lib/api/errors'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { accountantBandOf } from './band'
import { overviewOf, periodOf } from './design-data'
import { designScreen } from './fixtures'
import {
  accountingHref,
  addressOf,
  choicesOf,
  chosenPeriod,
  downloadHeld,
  exportRowsOf,
  invoiceFileIds,
  invoiceRowsOf,
  invoiceSelectable,
  NS,
  periodOfKind,
  periodWords,
  periodZipHeld,
  refusalKey,
  registerRowsOf,
  sizeWords,
  stateTone,
  WORD_KEYS,
} from './model'

/**
 * SCR-268 (B-W2b-201), the accountant's room, the pure part: the address, the period picker, the three lists' rows, what
 * holds a download, the refusals by code, every word in both languages, and every design case drawn with no key on screen
 * and no amount.
 */

const t = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
const FACTS = { preview: false, offline: false, busy: false }

describe('the address and the period picker', () => {
  it('reads a month, a quarter or a year from ?period=, and nothing else', () => {
    expect(addressOf(new URLSearchParams('period=2026-10'))).toEqual({ period: '2026-10' })
    expect(addressOf(new URLSearchParams('period=2026-Q4'))).toEqual({ period: '2026-Q4' })
    expect(addressOf(new URLSearchParams('period=2026-13'))).toEqual({ period: null })
    expect(addressOf(null)).toEqual({ period: null })
    expect(accountingHref('/p/STUDIO', '2026-Q4')).toBe('/p/STUDIO/accounting?period=2026-Q4')
    expect(accountingHref('/p/STUDIO', null)).toBe('/p/STUDIO/accounting')
  })

  it('opens on the newest handed-over month; a typed address wins', () => {
    const overview = overviewOf()
    expect(chosenPeriod({ period: null }, overview)).toBe('2026-10')
    expect(chosenPeriod({ period: '2026-Q3' }, overview)).toBe('2026-Q3')
    expect(chosenPeriod({ period: null }, overviewOf({ months: [] }))).toBeNull()
  })

  it('offers each kind’s choices in the page’s language, the typed one among them', () => {
    const { choices } = overviewOf()
    expect(choicesOf(choices, 'QUARTER', 'it', '2026-Q4')).toEqual([
      { value: '2026-Q4', label: '4° trimestre 2026' },
      { value: '2026-Q3', label: '3° trimestre 2026' },
    ])
    expect(choicesOf(choices, 'MONTH', 'en', '2026-11').map((option) => option.value)).toEqual(['2026-11', '2026-10', '2026-09', '2026-08', '2026-07'])
    expect(periodWords('2026-10', 'it')).toBe('ottobre 2026')
  })

  it('switching the kind keeps the period that holds the one shown', () => {
    const { choices } = overviewOf()
    expect(periodOfKind('2026-10', 'QUARTER', choices)).toBe('2026-Q4')
    expect(periodOfKind('2026-10', 'YEAR', choices)).toBe('2026')
    expect(periodOfKind('2026-Q3', 'MONTH', choices)).toBe('2026-09')
    expect(periodOfKind(null, 'MONTH', choices)).toBe('2026-10')
  })
})

describe('the three lists', () => {
  const october = periodOf('2026-10')

  it('one row per journal file, the re-export after the batch it amends', () => {
    const rows = exportRowsOf(october)
    expect(rows.map((row) => [row.number, row.journal, row.amendedBy, row.amends])).toEqual([
      ['EXP-2026-0012', 'SALES_JOURNAL', 'EXP-2026-0014', null],
      ['EXP-2026-0012', 'PURCHASES_JOURNAL', 'EXP-2026-0014', null],
      ['EXP-2026-0012', 'PAYMENTS', 'EXP-2026-0014', null],
      ['EXP-2026-0014', 'PAYMENTS', null, 'EXP-2026-0012'],
    ])
  })

  it('sales before purchases; an invoice with no file cannot be chosen; a chosen invoice zips its XML and PDF', () => {
    const rows = invoiceRowsOf(october)
    expect(rows.slice(0, 5).every((row) => row.side === 'SALES')).toBe(true)
    const typedIn = rows.find((row) => row.state === 'MANUAL')!
    expect(invoiceSelectable(typedIn)).toBe('einvoices.noFile')
    expect(invoiceSelectable(rows[0]!)).toBeNull()
    expect(invoiceFileIds(rows, [rows[0]!.id, typedIn.id])).toEqual([rows[0]!.xml!.id, rows[0]!.pdf!.id])
  })

  it('the current register file before the one it replaced', () => {
    expect(registerRowsOf(october).map((row) => [row.number, row.current, row.replacedBy])).toEqual([
      ['EXP-2026-0014', true, null],
      ['EXP-2026-0012', false, 'EXP-2026-0014'],
    ])
  })
})

describe('what holds a download, and the refusals', () => {
  it('a preview, offline or a download on its way holds every download; the zip also waits for a period with files', () => {
    expect(downloadHeld(FACTS)).toBeNull()
    expect(downloadHeld({ ...FACTS, preview: true, offline: true })).toBe('held.preview')
    expect(downloadHeld({ ...FACTS, offline: true })).toBe('held.offline')
    expect(downloadHeld({ ...FACTS, busy: true })).toBe('held.busy')
    expect(periodZipHeld({ ...FACTS, files: null })).toBe('held.reading')
    expect(periodZipHeld({ ...FACTS, files: 0 })).toBe('held.nothing')
    expect(periodZipHeld({ ...FACTS, files: 12 })).toBeNull()
  })

  it('says a refusal from its code, never the API’s English', () => {
    const refused = (path: string, kind: 'conflict' | 'forbidden' = 'conflict') => new ApiError(kind, kind === 'conflict' ? 409 : 403, kind, 'English from the API', null, [{ path }])
    expect(refusalKey(refused('problem/PERIOD_NOT_SHARED'))).toBe('refusal.PERIOD_NOT_SHARED')
    expect(refusalKey(refused('problem/TOO_LARGE'))).toBe('refusal.TOO_LARGE')
    expect(refusalKey(refused('problem/SOMETHING_NEW'))).toBe('refusal.generic')
    expect(refusalKey(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('refusal.NOT_ACCOUNTANT')
    expect(refusalKey(new ApiError('unavailable', 503, 'network', 'x'))).toBe('refusal.network')
    expect(Object.keys(GUEST_REFUSALS).every((code) => WORD_KEYS.includes(`refusal.${code}`))).toBe(true)
  })

  it('writes sizes and tones in the page’s language', () => {
    expect(sizeWords(900, 'en')).toBe('900 B')
    expect(sizeWords(12_800, 'it')).toBe('13 KB')
    expect(sizeWords(1_310_720, 'it')).toBe('1,3 MB')
    expect(stateTone('REJECTED')).toBe('danger')
    expect(stateTone('NOT_DELIVERABLE')).toBe('warning')
    expect(stateTone('DELIVERED')).toBe('success')
  })
})

describe('words', () => {
  it('knows every package, state, kind, period kind and refusal in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = t(locale)
      for (const key of WORD_KEYS) expect(words(key), `${locale} ${key}`).not.toBe(key)
      for (const state of [...SALES_SDI_STATES, ...PURCHASE_SOURCES]) expect(words(`state.${state}`), `${locale} state.${state}`).not.toBe(`state.${state}`)
    }
  })

  it('the band: read-only with the end of access, Download period (zip) the primary, Ask a question about the firm', () => {
    const band = accountantBandOf({ t: t('en'), until: '31 Jan 2027', firmId: 'firm', zipHeld: null, onZip: () => undefined })
    expect(band.status?.label).toBe('Read-only · until 31 Jan 2027')
    expect(band.actions?.map((action) => [action.label, action.variant])).toEqual([['Download period (zip)', 'primary']])
    expect(band.ask).toEqual({ type: 'Party', id: 'firm', label: 'Ask finance' })
    expect(accountantBandOf({ t: t('it'), until: null, firmId: null, zipHeld: null, onZip: () => undefined }).status?.label).toBe('Sola lettura')
  })
})

const KEY = /\b(?:band|keys|state|held|refusal|period|exports|einvoices|registers|ask|col|standing|row|file|package|kind|side|count|bulk|done|noAccess|access|notice)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const MONEY = /€|EUR\b|\d+,\d{2}\s?€/

describe('SCR-268 design cases', () => {
  it('every case draws in Italian and English with no key on screen, no amount and made-up data only', () => {
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(18)
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
        expect(html, `${entry.id} (${locale})`).not.toMatch(MONEY)
        expect(html, `${entry.id} (${locale})`).toContain('main-content')
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
      }
    }
  })

  it('the Italian room speaks Italian', () => {
    const entry = designScreen.cases.find((item) => item.id === 'normal')!
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
    expect(html).toContain('Fatture elettroniche')
    expect(html).not.toContain('E-invoices')
  })
})
