import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, COMPANIES, inShell, NOW, PREFIX } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import type { Allocation, Series, SeriesProof } from './api'
import { legalOf, newDraft, type DocumentsViewModel, type ProofRead } from './model'
import { DocumentsView } from './view/DocumentsView'

/** SCR-014 Documents & numbering with made-up series of the two Demo companies (invented numbers and dates). */

const [demo, esempio] = COMPANIES as [(typeof COMPANIES)[number], (typeof COMPANIES)[number]]
const uid = (n: number) => `0190f0e2-5151-7000-8000-${String(n).padStart(12, '0')}`
let next = 1
function series(companyId: string, kind: Series['kind'], extra: Partial<Series> = {}): Series {
  const fiscal = ['INVOICE', 'DDT', 'DEPOSIT_INVOICE', 'CREDIT_NOTE'].includes(kind)
  const year = extra.reset === 'NEVER' ? null : (extra.year ?? 2026)
  return {
    id: uid(next++),
    companyId,
    kind,
    code: 'MAIN',
    scopeKey: year === null ? 'ALL' : String(year),
    year,
    reset: year === null ? 'NEVER' : 'YEARLY',
    pattern: 'X-{YYYY}-{N:5}',
    fiscal,
    startValue: 1,
    nextValue: 1,
    nextNumber: null,
    lastIssuedDate: null,
    status: 'ACTIVE',
    version: 1,
    createdAt: at(1, 8),
    updatedAt: at(28, 16),
    ...extra,
  }
}

export const SERIES: Series[] = [
  series(demo.id, 'QUOTE', { pattern: 'QT-{YYYY}-{N:4}', nextValue: 143, nextNumber: 'QT-2026-0143', lastIssuedDate: '2026-10-28', version: 143 }),
  series(demo.id, 'SALES_ORDER', { pattern: 'SO-{YYYY}-{N:5}', nextValue: 42, nextNumber: 'SO-2026-00042', lastIssuedDate: '2026-10-27', version: 42 }),
  series(demo.id, 'PURCHASE_ORDER', { pattern: 'PO-{YYYY}-{N:5}', nextValue: 18, nextNumber: 'PO-2026-00018', lastIssuedDate: '2026-10-21', version: 18 }),
  series(demo.id, 'WORK_ORDER', { pattern: 'WO-{YY}-{N:4}', nextValue: 77, nextNumber: 'WO-26-0077', lastIssuedDate: '2026-10-28', version: 77 }),
  series(demo.id, 'DDT', { pattern: 'DDT-{YYYY}-{N:5}', startValue: 101, nextValue: 229, nextNumber: 'DDT-2026-00229', lastIssuedDate: '2026-10-28', version: 130 }),
  series(demo.id, 'INVOICE', { pattern: 'FT-{YYYY}-{N:5}', nextValue: 42, nextNumber: 'FT-2026-00042', lastIssuedDate: '2026-10-28', version: 42 }),
  series(demo.id, 'INVOICE', { year: 2025, scopeKey: '2025', pattern: 'FT-{YYYY}-{N:5}', nextValue: 389, nextNumber: 'FT-2025-00389', lastIssuedDate: '2025-12-30', status: 'CLOSED', version: 390 }),
  series(demo.id, 'CREDIT_NOTE', { pattern: 'NC-{YYYY}-{N:4}', nextNumber: 'NC-2026-0001' }),
  series(demo.id, 'LOT', { reset: 'NEVER', pattern: 'LOT-{N:6}', nextValue: 1287, nextNumber: 'LOT-001287', lastIssuedDate: '2026-10-29', version: 1287 }),
  series(esempio.id, 'INVOICE', { pattern: 'E/{N}/{YY}', nextNumber: 'E/1/26' }),
]
const [, , , , ddt, invoice, , creditNote, lot, esempioInvoice] = SERIES as [Series, Series, Series, Series, Series, Series, Series, Series, Series, Series]

const proofOf = (row: Series, count: number, skipped: SeriesProof['skipped'] = []): SeriesProof => ({
  count,
  first: row.startValue,
  last: row.nextValue - 1,
  firstFormatted: row.pattern.replace('{YYYY}', '2026').replace(/\{N:(\d+)\}/, (_, digits: string) => String(row.startValue).padStart(Number(digits), '0')),
  lastFormatted: row.nextNumber ? row.pattern.replace('{YYYY}', '2026').replace(/\{N:(\d+)\}/, (_, digits: string) => String(row.nextValue - 1).padStart(Number(digits), '0')) : null,
  lastDocumentDate: row.lastIssuedDate,
  skipped,
  moreSkipped: false,
})
const INVOICE_PROOF = proofOf(invoice, 41)
const DDT_PROOF = proofOf(ddt, 120, [{ from: 181, to: 188 }])
const PROOFS: Record<string, ProofRead> = { [invoice.id]: { state: 'ok', proof: INVOICE_PROOF }, [ddt.id]: { state: 'ok', proof: DDT_PROOF } }

const allocation = (value: number, day: number, record: string, who: string | null): Allocation => ({
  value,
  formatted: `FT-2026-${String(value).padStart(5, '0')}`,
  documentDate: `2026-10-${String(day).padStart(2, '0')}`,
  recordType: record,
  recordId: uid(900 + value),
  allocatedAt: at(day, 10, value % 60),
  allocatedByName: who,
})
const NUMBERS: Allocation[] = [allocation(41, 28, 'Invoice', 'Alex Demo'), allocation(40, 27, 'Invoice', 'Bianca Esempio'), allocation(39, 27, 'Invoice', null), allocation(38, 24, 'Invoice', 'Alex Demo')]

const companies = loaded(
  COMPANIES.map((company) => ({ id: company.id, code: company.code, legalName: company.legalName, status: company.status, ...legalOf(company) })),
)
const base = (over: Partial<DocumentsViewModel> = {}): DocumentsViewModel => ({
  prefix: PREFIX,
  view: 'numbers',
  companies,
  companyId: 'all',
  series: loaded(SERIES),
  proofs: PROOFS,
  asOf: NOW,
  can: { manage: true, documents: true },
  dialog: null,
  ...over,
})

function DocumentsDesign({ model }: { model: DocumentsViewModel }) {
  return inShell('/admin/documents', createElement(DocumentsView, { model }))
}

export const designScreen = defineDesignScreen<DocumentsViewModel>({
  screen: 'SCR-014',
  title: 'Documents & numbering',
  view: DocumentsDesign,
  cases: [
    { id: 'numbers', label: 'Every series of every company, with the fiscal check', model: base(), note: 'Next number as it will print, the pattern as chips; the DDT series was moved past 181–188 after a restore, so the check says which numbers Nexus did not issue.' },
    { id: 'one-company', label: 'One company', model: base({ companyId: demo.id }) },
    { id: 'documents', label: 'Documents: the fixed layouts with a preview', model: base({ view: 'documents' }), note: 'Each preview opens the company\'s sample PDF in a new tab.' },
    { id: 'documents-not-ready', label: 'Documents of a company whose legal data is incomplete', model: base({ view: 'documents', companyId: esempio.id }), note: 'The previews are held with the reason and a link to the legal data: the server refuses a document without it.' },
    { id: 'documents-no-right', label: 'Documents without the right to preview', model: base({ view: 'documents', can: { manage: true, documents: false } }) },
    { id: 'new-series', label: 'New series: built from chips', model: base({ dialog: { kind: 'new' } }), note: 'The first number shows as it will print, live.' },
    { id: 'new-series-lot', label: 'New series: a lot series that never starts again', model: base({ dialog: { kind: 'new', draft: { ...newDraft(demo.id, 'LOT'), code: 'B', start: '5001' } } }) },
    {
      id: 'new-series-problem',
      label: 'New series: a typed pattern with problems',
      model: base({ dialog: { kind: 'new', tried: true, draft: { ...newDraft(demo.id, 'INVOICE'), typed: true, pattern: 'FATTURA-ITALIA-{YYYY}-{N:9}', code: 'b', start: '0' } } }),
      note: 'Create is held with the count; each field says what is wrong, in our words.',
    },
    { id: 'series-unused', label: 'A series with nothing issued: its start can change', model: base({ dialog: { kind: 'series', seriesId: creditNote.id } }) },
    { id: 'series-issued', label: 'A fiscal series in use: start and pattern fixed', model: base({ dialog: { kind: 'series', seriesId: invoice.id, section: 'advance' } }), note: 'After a restore it can move past a number; never back.' },
    { id: 'series-never', label: 'A series that never starts again', model: base({ dialog: { kind: 'series', seriesId: lot.id } }) },
    { id: 'close', label: 'Close a series: the last of its kind', model: base({ dialog: { kind: 'close', seriesId: creditNote.id } }), note: 'Warned before the click: new credit notes would be refused.' },
    { id: 'numbers-issued', label: 'Numbers issued: no gaps', model: base({ dialog: { kind: 'numbers', seriesId: invoice.id }, numbers: { seriesId: invoice.id, read: loaded(NUMBERS), proof: INVOICE_PROOF } }), note: 'J / K move to the next fiscal series.' },
    {
      id: 'numbers-skipped',
      label: 'Numbers issued: a range Nexus did not issue',
      model: base({ dialog: { kind: 'numbers', seriesId: ddt.id }, numbers: { seriesId: ddt.id, read: loaded(NUMBERS.map((item) => ({ ...item, formatted: item.formatted.replace('FT', 'DDT'), recordType: 'Ddt' }))), proof: DDT_PROOF } }),
    },
    { id: 'numbers-loading', label: 'Numbers issued: reading', model: base({ dialog: { kind: 'numbers', seriesId: invoice.id }, numbers: { seriesId: invoice.id, read: loading(), proof: null } }) },
    { id: 'proof-failed', label: 'The fiscal check could not read one series', model: base({ proofs: { [invoice.id]: { state: 'ok', proof: INVOICE_PROOF }, [ddt.id]: { state: 'failed', problem: 'problem.unavailable' } } }) },
    { id: 'read-only', label: 'Without the right to manage series', model: base({ can: { manage: false, documents: true } }), note: 'New series is held with the right it needs.' },
    { id: 'created', label: 'Just created', model: base({ companyId: esempio.id, notice: { key: 'docs.done.created', tone: 'success', params: { number: esempioInvoice.nextNumber ?? '' } } }) },
    { id: 'conflict', label: 'Someone changed the series meanwhile', model: base({ dialog: { kind: 'series', seriesId: creditNote.id }, dialogProblem: 'docs.problem.conflict' }) },
    { id: 'loading', label: 'Loading', model: base({ series: loading(), companies: loading(), asOf: null, proofs: {} }) },
    { id: 'error', label: 'The API did not answer', model: base({ series: failed('problem.unavailable'), asOf: null, proofs: {} }) },
    { id: 'forbidden', label: 'Not the person\'s to read', model: base({ series: failed('problem.forbidden'), asOf: null, proofs: {} }) },
    { id: 'empty', label: 'No series yet', model: base({ series: loaded([]), proofs: {} }) },
    { id: 'no-company', label: 'No active company', model: base({ series: loaded([]), companies: loaded([]), proofs: {} }) },
  ],
})
