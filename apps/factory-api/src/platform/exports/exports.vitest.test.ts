import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { ReportColumn } from '@nexus/factory-domain/insights/reports/definition'
import { loadReports } from '../../modules/insights/reports/registry'
import { processImporters } from '../imports/registry'
import { exportFormatsFor, exportSourceOf, processExportSources } from './registry'
import { formatsOf, pageOf, titleText } from './source'
import { EXPORT_SOURCES } from './sources'
import { REPORT_CODE_WORDS, reportCell, reportListKey } from './sources/reports'
import { salesOrders } from './sources/sales-orders' // B-TH-008
import { sheetName } from './writer' // B-TH-008

/**
 * The export sources (B-W2a-23, B-W2b-11): every list source names a real Office list page, its words in both
 * languages, and an importer that exists when it offers the file for re-import; every report of the pack is a dynamic
 * source whose code words are the web catalogue's (apps/factory-web messages home-reports.json `code.*`: the API cannot
 * read the web's catalogue at run time, so the words are copied and this test holds them equal).
 */

const SRC = fileURLToPath(new URL('../..', import.meta.url))
const WEB = fileURLToPath(new URL('../../../../factory-web', import.meta.url))

type Tree = { [key: string]: string | Tree }
const flatten = (tree: Tree, prefix = ''): Record<string, string> =>
  Object.entries(tree).reduce<Record<string, string>>((all, [key, value]) => (typeof value === 'string' ? { ...all, [`${prefix}${key}`]: value } : { ...all, ...flatten(value, `${prefix}${key}.`) }), {})
const reportWords = (locale: 'it' | 'en') => flatten(JSON.parse(readFileSync(`${WEB}/messages/${locale}/home-reports.json`, 'utf8')) as Tree)

describe('the list sources', () => {
  it('one per list key, each a real Office list page, with its own view permission', () => {
    expect(processExportSources().size).toBe(EXPORT_SOURCES.length)
    for (const source of EXPORT_SOURCES) {
      expect(existsSync(`${WEB}/src/app/(office)/w/[company]${pageOf(source)}/page.tsx`), `${source.listKey}: no page at ${pageOf(source)}`).toBe(true)
      expect(FACTORY_PERMISSIONS.isDeclared(source.permission as Permission), source.listKey).toBe(true)
      expect(Object.keys(source.columns).length, source.listKey).toBeGreaterThan(0)
    }
  })

  it('the same words in Italian and English', () => {
    for (const source of EXPORT_SOURCES) {
      if (!source.words) continue
      expect(Object.keys(source.words.it).sort(), source.listKey).toEqual(Object.keys(source.words.en).sort())
    }
  })

  it('"Full file for re-import" only where the importer exists, named by its key columns', () => {
    const offering = EXPORT_SOURCES.filter((source) => source.reimport)
    expect(offering.map((source) => source.listKey).sort()).toEqual(['products.materials', 'products.operations', 'purchasing.suppliers', 'sales.customers', 'warehouse.locations'])
    for (const source of EXPORT_SOURCES) {
      const formats = formatsOf(source)
      if (!source.reimport) {
        expect(formats, source.listKey).toEqual(['CSV', 'XLSX'])
        continue
      }
      expect(formats, source.listKey).toEqual(['CSV', 'XLSX', 'XLSX_REIMPORT'])
      expect(processImporters().get(source.reimport.importer), `${source.listKey}: importer ${source.reimport.importer}`).toBeDefined()
    }
  })
})

describe('every report is a source (XLSX of a report)', () => {
  it('home.reports.<key>: CSV and Excel, the report page as its address, the report’s columns with their grains', async () => {
    const reports = await loadReports(SRC)
    for (const report of reports) {
      const source = exportSourceOf(reportListKey(report.key))
      expect(source, report.key).toBeDefined()
      expect(exportFormatsFor(reportListKey(report.key))).toEqual(['CSV', 'XLSX'])
      expect(pageOf(source!)).toBe(`/home/reports/${report.key}`)
      expect(Object.keys(source!.columns)).toEqual(report.columns.map((column) => column.key))
      for (const column of report.columns) expect(source!.columns[column.key]!.grain, `${report.key}.${column.key}`).toBe(column.grain)
    }
    expect(exportSourceOf('home.reports.nothing.here')).toBeUndefined()
  })

  it('the code words are the web catalogue’s, and every code a report can show has them', async () => {
    for (const locale of ['it', 'en'] as const) {
      const web = Object.fromEntries(Object.entries(reportWords(locale)).filter(([key]) => key.startsWith('code.')))
      expect(REPORT_CODE_WORDS[locale], locale).toEqual(web)
    }
    for (const report of await loadReports(SRC)) {
      for (const column of report.columns.filter((entry) => entry.kind === 'code')) {
        for (const code of column.codes ?? []) expect(REPORT_CODE_WORDS.en[`code.${code}`], `${report.key}.${column.key}: ${code}`).toBeDefined()
      }
    }
  })

  it('a cell by its column’s kind: money in the row’s currency, codes in words, decimals as decimals', () => {
    const row = { id: 'r', record: null, currency: 'EUR', cells: { a: 'LATE', b: 123450, c: '18.5', d: '2026-10-31', e: 7, f: 'Rossi', g: null } }
    const words = (code: string) => REPORT_CODE_WORDS.it[code] ?? code
    const column = (key: string, kind: ReportColumn['kind']): ReportColumn => ({ key, label: key, kind })
    expect(reportCell(column('a', 'code'), row, words)).toBe('In ritardo')
    expect(reportCell(column('b', 'money'), row, words)).toEqual({ minor: 123450, currency: 'EUR' })
    expect(reportCell(column('c', 'percent'), row, words)).toEqual({ decimal: '18.5' })
    expect(reportCell(column('d', 'day'), row, words)).toEqual({ day: '2026-10-31' })
    expect(reportCell(column('e', 'number'), row, words)).toBe(7)
    expect(reportCell(column('f', 'text'), row, words)).toBe('Rossi')
    expect(reportCell(column('g', 'text'), row, words)).toBeNull()
  })
})

// ── B-TH-008 (WALL-G01, SHEET-G14): screen = file on Sales › Orders ────────────────────────────────────────────────────
describe('the orders file reads every term the screen reads (B-TH-008)', () => {
  const A = '0190a1b2-0000-7000-8000-00000000000a'
  const C = '0190a1b2-0000-7000-8000-0000000000c1'
  const query = (address: string) => salesOrders.query(new URLSearchParams(address)) as Record<string, unknown>

  it('keeps the customer, the company and the promise range with every rows view; Waiting for the customer is its own', () => {
    expect(query(`party=${A}`)).toEqual({ partyId: A, open: 'true', q: undefined })
    expect(query(`partyId=${A}&rows=all`)).toEqual({ partyId: A, q: undefined })
    expect(query(`party=${A}&late=true&q=SO-1`)).toEqual({ partyId: A, late: 'true', q: 'SO-1' })
    expect(query(`party=${A}&company=${C}&status=READY`)).toEqual({ partyId: A, companyId: C, status: 'READY', q: undefined })
    expect(query(`companyId=${C}&promiseFrom=2026-11-16&promiseTo=2026-11-22&rows=all`)).toEqual({ companyId: C, promiseFrom: '2026-11-16', promiseTo: '2026-11-22', q: undefined })
    expect(query(`reaccept=true&party=${A}`)).toEqual({ partyId: A, reaccept: 'true', q: undefined })
    expect(query('')).toEqual({ open: 'true', q: undefined })
  })

  it('refuses a malformed customer, company or day: never a file of every customer for one customer’s sheet', () => {
    expect(() => query('party=DEMO-C1')).toThrow(/Not a customer/)
    expect(() => query('company=nope')).toThrow(/Not a company/)
    expect(() => query('promiseFrom=2026-13-40')).toThrow(/Not a day/)
    expect(() => query('promiseFrom=2026-11-22&promiseTo=2026-11-16')).toThrow(/ends before it starts/)
  })

  it('says every status in both languages (a waiting or delivered order is never a raw code)', () => {
    for (const locale of ['it', 'en'] as const) {
      expect(salesOrders.words?.[locale]['status.PENDING_APPROVAL']).toMatch(/approv/)
      expect(salesOrders.words?.[locale]['status.DELIVERED']).toBeTruthy()
    }
  })

  it('names the file after what it holds; the Excel tab keeps the rows it holds whole', () => {
    expect(titleText({ name: 'Orders - Brand Alpha S.r.l.', rows: '42 orders' }, 'Sales orders')).toBe('Orders - Brand Alpha S.r.l. - 42 orders')
    expect(titleText(null, 'Sales orders')).toBe('Sales orders')
    expect(sheetName('Orders - Brand Alpha - 3 orders', '3 orders')).toBe('Orders - Brand Alpha - 3 orders')
    const long = sheetName('Ordini - Brand Alpha Abbigliamento Tecnico S.r.l. - 1250 ordini', '1250 ordini')
    expect(long.length).toBeLessThanOrEqual(31)
    expect(long.endsWith(' - 1250 ordini')).toBe(true)
    expect(long.startsWith('Ordini - Brand')).toBe(true)
    expect(sheetName('Ordini di vendita: tutte le righe / [archivio] della stagione')).toBe('Ordini di vendita  tutte le rig')
  })
})
// ── end B-TH-008 ──

// ── B-TH-018 (ORD-G01, N22): the file writes what the sheet shows ─────────────────────────────────────────────────────────
describe('the orders file writes the sheet’s columns and reads its Brand term (B-TH-018)', () => {
  const B = '0190a1b2-0000-7000-8000-0000000000b1'
  const query = (address: string) => salesOrders.query(new URLSearchParams(address)) as Record<string, unknown>

  it('keeps the brand (a party or our own collection) with every rows view; a malformed one is refused', () => {
    expect(query(`brand=${B}`)).toEqual({ brand: B, open: 'true', q: undefined })
    expect(query('brand=own&rows=all')).toEqual({ brand: 'own', q: undefined })
    expect(query(`brand=${B}&status=READY`)).toEqual({ brand: B, status: 'READY', q: undefined })
    expect(() => query('brand=OWN')).toThrow(/Not a brand/)
    expect(() => query('brand=Brand Alpha')).toThrow(/Not a brand/)
  })

  it('has a column for every column of the sheet, money only with the price grain', () => {
    for (const key of ['picture', 'customerRef', 'company', 'brand', 'invoiced', 'invoicedAmount', 'requested', 'gross', 'daysLate', 'priority', 'season']) expect(salesOrders.columns[key], key).toBeDefined()
    expect(salesOrders.columns.invoicedAmount!.grain).toBe('price')
    expect(salesOrders.columns.gross!.grain).toBe('price')
    expect(salesOrders.columns.invoiced!.grain).toBeUndefined()
  })

  it('says Invoiced, the label words and every priority in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = salesOrders.words![locale]
      for (const code of ['invoiced.NONE', 'invoiced.PART', 'invoiced.ALL', 'brand.own', 'brand.hidden', 'priority.LOW', 'priority.NORMAL', 'priority.HIGH', 'priority.URGENT']) expect(words[code], `${locale} ${code}`).toBeTruthy()
    }
    expect(salesOrders.words!.it['invoiced.PART']).toBe('In parte')
    expect(salesOrders.words!.en['brand.own']).toBe('Own collection')
  })
})
// ── end B-TH-018 ──
