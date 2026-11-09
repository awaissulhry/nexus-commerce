import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KIND_RULES } from '@nexus/factory-domain/sales/portal-documents/library'
import { RECEIVED_STATES as DOMAIN_RECEIVED } from '@nexus/factory-domain/sales/portal-documents/conformity'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { isLibraryChip, LIBRARY_CHIPS, PAY_METHODS, type ConformityStyle, type OpenItemsRead } from './api'
import { documentsBandOf } from './band'
import { designScreen } from './fixtures'
import {
  addressOf,
  addressQuery,
  bulkDownloadHeld,
  conformityRowsOf,
  DOCUMENT_KINDS,
  dueWords,
  FAILURE_CODES,
  failureKey,
  fakeStageOf,
  groupedRows,
  kindKey,
  libraryRowOf,
  panelStateAfterStart,
  payHeld,
  payRowsOf,
  SDI_STATUSES,
  sectionsOf,
  START_REFUSALS,
  startRefusal,
  totalsOf,
  UNAVAILABLE_REASONS,
} from './model'
import type { CustomerDocument } from './preview/api'
import { DOCUMENT_LANGUAGES, languageWords, mainFileOf, neighbourOf, openRefusal, previewRowOf, versionLines } from './preview/model'

/**
 * SCR-186 › the customer's Documents (B-W2b-195), pure: the address, which sections a chip shows, the library's rows and
 * groupings, what is to pay and why Pay waits, the payment's state as the panel shows it, the refusals in our words, the
 * conformity rows, the lifted document pop-up's rules — and every design case drawn in Italian and English with no raw key.
 */

const UUID = (n: number) => `0190f0e2-1950-7000-8000-${String(n).padStart(12, '0')}`
const params = (query: string) => new URLSearchParams(query)

const doc = (n: number, over: Partial<CustomerDocument> = {}): CustomerDocument => ({
  id: UUID(n),
  kind: 'DDT',
  kindWords: { it: 'DDT', en: 'DDT' },
  group: 'DELIVERY',
  title: { it: `Documento ${n}`, en: `Document ${n}` },
  for: { type: 'Shipment', id: UUID(100 + n), label: `SH-${n}`, order: { id: UUID(200), number: 'SO-1', customerRef: 'PO-1' } },
  style: null,
  date: `2026-11-0${n}T10:00:00.000Z`,
  version: 1,
  fingerprint: 'abc',
  language: 'it',
  current: true,
  replacedBy: null,
  new: true,
  files: [{ fileId: UUID(n), format: 'PDF', name: `d${n}.pdf`, contentType: 'application/pdf', sizeBytes: 1000 }],
  ...over,
})

describe('the address', () => {
  it('reads the chip, search, grouping, versions and an invoice; anything else is the default', () => {
    expect(addressOf(params('group=FINANCE&q=FT-1&by=order&versions=all&invoice=' + UUID(1)), isLibraryChip)).toEqual({ group: 'FINANCE', q: 'FT-1', by: 'order', versions: 'all', invoice: UUID(1), messages: false })
    expect(addressOf(params('group=NOPE&by=x&invoice=1;drop'), isLibraryChip)).toMatchObject({ group: 'ALL', by: 'newest', versions: 'current', invoice: null })
    expect(addressOf(params(`invoice=${UUID(2)}&tab=messages`), isLibraryChip)).toMatchObject({ invoice: UUID(2), messages: true })
    expect(addressQuery({ group: 'ALL', q: ' ', by: 'newest', versions: 'current' })).toBe('')
    expect(addressQuery({ group: 'CONFORMITY', q: 'jkt', by: 'style', versions: 'all' })).toBe('?group=CONFORMITY&q=jkt&by=style&versions=all')
  })

  it('a chip filters the library; All shows To pay and conformity, Invoices To pay, Conformity the conformity — each only to whom may', () => {
    const both = { toPay: true, conformity: true }
    expect(sectionsOf('ALL', both)).toEqual({ toPay: true, conformity: true })
    expect(sectionsOf('FINANCE', both)).toEqual({ toPay: true, conformity: false })
    expect(sectionsOf('CONFORMITY', both)).toEqual({ toPay: false, conformity: true })
    expect(sectionsOf('DELIVERY', both)).toEqual({ toPay: false, conformity: false })
    expect(sectionsOf('ALL', { toPay: false, conformity: true })).toEqual({ toPay: false, conformity: true })
    expect(LIBRARY_CHIPS).toEqual(['ALL', 'DELIVERY', 'CONFORMITY', 'FINANCE', 'ORDERS', 'OTHER'])
  })
})

describe('all documents', () => {
  it('a row: the order with their PO first, the record beside it, NEW until opened, the newer version named', () => {
    const row = libraryRowOf(doc(1, { replacedBy: { id: UUID(9), title: { it: 'x', en: 'x' }, version: 4 }, current: false }), 'en', new Set())
    expect(row).toMatchObject({ title: 'Document 1', order: { id: UUID(200), words: 'PO-1 · SO-1' }, forLabel: 'SH-1', isNew: true, previewable: true, replacedBy: { id: UUID(9), version: 4 } })
    expect(libraryRowOf(doc(1), 'en', new Set([UUID(1)])).isNew).toBe(false)
    // An order's own document names the order only.
    expect(libraryRowOf(doc(2, { for: { type: 'SalesOrder', id: UUID(200), label: 'SO-1', order: { id: UUID(200), number: 'SO-1', customerRef: null } } }), 'it', new Set())).toMatchObject({ order: { words: 'SO-1' }, forLabel: null })
    // An XML alone is downloaded, never previewed.
    expect(libraryRowOf(doc(3, { files: [{ fileId: UUID(3), format: 'XML', name: 'a.xml', contentType: 'application/xml', sizeBytes: 1 }] }), 'it', new Set()).previewable).toBe(false)
  })

  it('grouping gathers each order’s (or style’s) documents, the newest group first, the rest last', () => {
    const other = { id: UUID(201), number: 'SO-2', customerRef: null }
    const rows = [doc(1), doc(2, { for: { type: 'Shipment', id: UUID(5), label: 'SH', order: other } }), doc(3, { for: null }), doc(4)].map((entry) => libraryRowOf(entry, 'it', new Set()))
    expect(groupedRows(rows, 'newest').map((row) => row.id)).toEqual([UUID(1), UUID(2), UUID(3), UUID(4)])
    expect(groupedRows(rows, 'order').map((row) => row.id)).toEqual([UUID(1), UUID(4), UUID(2), UUID(3)])
    const styled = [doc(1, { style: { code: 'B', name: 'b' } }), doc(2), doc(3, { style: { code: 'A', name: 'a' } }), doc(4, { style: { code: 'B', name: 'b' } })].map((entry) => libraryRowOf(entry, 'it', new Set()))
    expect(groupedRows(styled, 'style').map((row) => row.id)).toEqual([UUID(1), UUID(4), UUID(3), UUID(2)])
  })

  it('Download N goes one logged download each, at most 20 at a time, never in a preview', () => {
    expect(bulkDownloadHeld(3, null)).toBeNull()
    expect(bulkDownloadHeld(21, null)).toEqual({ key: 'bulk.tooMany', params: { max: 20 } })
    expect(bulkDownloadHeld(1, 'held.preview')).toEqual({ key: 'held.preview' })
  })

  it('every kind the library names has our words; an unknown one reads as a document', () => {
    expect([...DOCUMENT_KINDS].sort()).toEqual(Object.keys(KIND_RULES).sort())
    expect(kindKey('CMR')).toBe('kind.CMR')
    expect(kindKey('SOMETHING_NEW')).toBe('kind.OTHER')
  })
})

describe('to pay', () => {
  const read: OpenItemsRead = {
    asOf: '2026-11-08',
    invoices: [
      { invoiceId: UUID(1), number: 'FT-2', docType: 'TD01', issueDate: '2026-10-01', dueDate: '2026-12-01', dueDateKnown: true, daysLate: 0, total: 1000, open: 1000, currency: 'EUR', sdiStatus: 'SENT', pdfFileId: UUID(11), xmlFileId: UUID(12), payment: null, canPay: true },
      { invoiceId: UUID(2), number: 'FT-1', docType: 'TD01', issueDate: '2026-09-01', dueDate: '2026-10-29', dueDateKnown: true, daysLate: 10, total: 2000, open: 500, currency: 'EUR', sdiStatus: 'DELIVERED', pdfFileId: UUID(21), xmlFileId: UUID(22), payment: null, canPay: true },
    ],
    deposits: [{ depositRequestId: UUID(3), orderNumber: 'SO-9', quoteDocument: 'Q-1 v1', dueDate: '2026-11-20', daysLate: 0, total: 300, open: 300, currency: 'EUR', payment: null, canPay: true }],
    byCurrency: [{ currency: 'EUR', open: 1800, overdue: 500 }, { currency: 'USD', open: 0, overdue: 0 }],
    counts: { invoices: 2, overdue: 1, deposits: 1 },
    card: { available: true, methods: ['CARD', 'SEPA_DEBIT'], provider: 'PAYMENT_FAKE', mode: 'FAKE', reason: null },
    mayPay: true,
    live: { events: [] },
  }

  it('the most overdue first, then by due date; a deposit names its order', () => {
    const rows = payRowsOf(read)
    expect(rows.map((row) => row.key)).toEqual([`invoice:${UUID(2)}`, `deposit:${UUID(3)}`, `invoice:${UUID(1)}`])
    expect(rows[1]).toMatchObject({ target: { kind: 'deposit', id: UUID(3) }, number: 'SO-9', sdiStatus: null, pdfFileId: null })
    expect(payRowsOf(null)).toEqual([])
    expect(totalsOf(read)).toEqual([{ currency: 'EUR', open: 1800, overdue: 500 }])
  })

  it('the due date in words: overdue, today, a day', () => {
    expect(dueWords({ daysLate: 3, dueDate: '2026-11-05', dueDateKnown: true }, '2026-11-08')).toEqual({ key: 'due.overdue', params: { count: 3 }, tone: 'danger' })
    expect(dueWords({ daysLate: 0, dueDate: '2026-11-08', dueDateKnown: true }, '2026-11-08')).toMatchObject({ key: 'due.today', tone: 'warning' })
    expect(dueWords({ daysLate: 0, dueDate: '2026-11-30', dueDateKnown: false }, '2026-11-08')).toEqual({ key: 'due.onIssue', params: { date: '2026-11-30' }, tone: 'neutral' })
  })

  it('Pay waits with the reason: a preview, a role that may not pay, offline, nothing open, no card offer, not euro', () => {
    const row = { canPay: true, currency: 'EUR', open: 100 }
    const facts = { preview: false, offline: false, mayPay: true, card: { available: true, reason: null } }
    expect(payHeld(row, facts)).toBeNull()
    expect(payHeld(row, { ...facts, preview: true })).toBe('held.preview')
    expect(payHeld(row, { ...facts, mayPay: false })).toBe('held.mayPay')
    expect(payHeld(row, { ...facts, offline: true })).toBe('held.offline')
    expect(payHeld({ ...row, open: 0 }, facts)).toBe('held.nothingOpen')
    expect(payHeld(row, { ...facts, card: { available: false, reason: 'GATE_SPEND' } })).toBe('unavailable.GATE_SPEND')
    expect(payHeld(row, { ...facts, card: { available: false, reason: null } })).toBe('unavailable.NO_ACCOUNT')
    expect(payHeld({ ...row, currency: 'USD' }, facts)).toBe('held.currency')
    expect(payHeld({ ...row, canPay: false }, facts)).toBe('held.notPayable')
  })

  it('the payment as the panel shows it, and which test answers fit now', () => {
    // Started (or taken up again): the provider waits for the payer — its fields show; WAITING is our status from the start.
    expect(panelStateAfterStart('CREATED')).toBe('ready')
    expect(panelStateAfterStart('WAITING')).toBe('ready')
    expect(panelStateAfterStart('SUCCEEDED')).toBe('succeeded')
    expect(panelStateAfterStart('FAILED')).toBe('failed')
    expect(panelStateAfterStart('CANCELLED')).toBe('failed')
    expect(fakeStageOf('CARD', 'ready', null)).toBe('CARD')
    expect(fakeStageOf('CARD', 'waiting', 'requires_action')).toBe('CARD_CONFIRM')
    expect(fakeStageOf('CARD', 'waiting', 'succeeded')).toBeNull()
    expect(fakeStageOf('SEPA_DEBIT', 'ready', null)).toBe('SEPA_DEBIT')
    expect(fakeStageOf('SEPA_DEBIT', 'waiting', 'processing')).toBe('SEPA_WAITING')
    expect(fakeStageOf('CARD', 'succeeded', null)).toBeNull()
    expect(PAY_METHODS).toEqual(['CARD', 'SEPA_DEBIT'])
  })

  it('refusals and failures in our words, from the codes (never the API’s English)', () => {
    expect(startRefusal({ kind: 'conflict', issues: [{ path: 'payment/IN_PROGRESS', message: 'A payment … under way' }] })).toBe('refusal.IN_PROGRESS')
    expect(startRefusal({ kind: 'conflict', issues: [{ path: 'payment/WHATEVER' }] })).toBe('refusal.failed')
    expect(startRefusal({ kind: 'forbidden', issues: [] })).toBe('refusal.forbidden')
    expect(startRefusal(null)).toBe('refusal.failed')
    expect(failureKey('card_declined')).toBe('failure.card_declined')
    expect(failureKey('made_up')).toBe('failure.default')
    expect(failureKey(null)).toBe('failure.default')
  })
})

describe('conformity per style received', () => {
  const ref = (n: number, kind = 'DECLARATION_OF_CONFORMITY') => ({ id: UUID(n), kind, title: { it: `D${n}`, en: `D${n}` }, version: 1, language: 'it', fingerprint: 'f', new: n === 1 })
  const styles: ConformityStyle[] = [
    {
      style: { code: 'JKT', name: 'Jacket' },
      ppe: true,
      certificateRequired: true,
      standard: 'EN 17092-4',
      ppeClass: 'II',
      received: [
        { shipment: { id: UUID(10), number: 'SH-2' }, order: { id: UUID(20), number: 'SO-2', customerRef: 'PO-2' }, shippedOn: '2026-11-01', revision: 3, pieces: 10, state: 'COMPLETE', declaration: ref(1), userInformation: ref(2, 'USER_INFORMATION'), certificate: null, reports: [ref(3, 'TEST_REPORT')] },
        { shipment: { id: UUID(11), number: 'SH-1' }, order: null, shippedOn: '2026-10-01', revision: 3, pieces: 5, state: 'INCOMPLETE', declaration: ref(1), userInformation: null, certificate: null, reports: [] },
      ],
    },
  ]

  it('per shipment its documents; each document once for Download all; a missing one marks the style', () => {
    const [style] = conformityRowsOf(styles, 'it', new Set([UUID(1)]))
    expect(style!.received.map((row) => row.documents.map((entry) => entry.id))).toEqual([[UUID(1), UUID(2), UUID(3)], [UUID(1)]])
    expect(style!.documents.map((entry) => entry.id)).toEqual([UUID(1), UUID(2), UUID(3)])
    expect(style!.incomplete).toBe(true)
    expect(style!.received[0]!.order).toBe('PO-2 · SO-2')
    // Opened in this visit: no longer NEW.
    expect(style!.received[0]!.declaration!.isNew).toBe(false)
  })

  it('every received state of the API has our words', () => {
    for (const locale of ['it', 'en'] as const) for (const state of DOMAIN_RECEIVED) expect(CATALOGUE[locale]['portal-documents']?.[`received.${state}`]).toBeTruthy()
  })
})

describe('the document pop-up (lifted from Home)', () => {
  it('versions newest first, each naming the one it replaced; J / K stop at the ends', () => {
    expect(versionLines([{ id: 'a', version: 1, date: 'x', current: false }, { id: 'c', version: 3, date: 'z', current: true }, { id: 'b', version: 2, date: 'y', current: false }]).map((line) => [line.version, line.previous, line.current])).toEqual([
      [3, 2, true],
      [2, 1, false],
      [1, null, false],
    ])
    expect(neighbourOf(['a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(neighbourOf(['a', 'b', 'c'], 'a', -1)).toBeNull()
  })

  it('opens the PDF of an invoice, names its order, and says a withdrawn version in our words', () => {
    const invoice = doc(5, { files: [{ fileId: UUID(51), format: 'XML', name: 'a.xml', contentType: 'application/xml', sizeBytes: 1 }, { fileId: UUID(5), format: 'PDF', name: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 }] })
    expect(mainFileOf(invoice)?.fileId).toBe(UUID(5))
    expect(previewRowOf(invoice, 'it')).toMatchObject({ forOrder: 'PO-1 · SO-1', forLabel: null, previewable: true, fileName: 'a.pdf' })
    expect(openRefusal({ kind: 'conflict', issues: [{ path: 'document/WITHDRAWN', message: 'This version was withdrawn' }] })).toEqual({ key: 'preview.problem.withdrawn', withdrawn: true })
    expect(openRefusal({ kind: 'not_found', issues: [] }).key).toBe('preview.problem.gone')
    expect(openRefusal(null).key).toBe('preview.problem.failed')
  })

  it('a language in our words; another one as its code', () => {
    const t = (key: string) => `<${key}>`
    expect(languageWords(t, 'EN')).toBe('<language.en>')
    expect(languageWords(t, 'pt')).toBe('PT')
    for (const locale of ['it', 'en'] as const) for (const code of DOCUMENT_LANGUAGES) expect(CATALOGUE[locale]['portal-documents']?.[`language.${code}`]).toBeTruthy()
  })
})

describe('words', () => {
  it('every code the page words has words in Italian and English', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['portal-documents'] ?? {}
      const keys = [
        ...DOCUMENT_KINDS.map((kind) => `kind.${kind}`),
        ...LIBRARY_CHIPS.map((chip) => `group.${chip}`),
        ...SDI_STATUSES.map((status) => `sdi.${status}`),
        ...FAILURE_CODES.map((code) => `failure.${code}`),
        'failure.default',
        ...START_REFUSALS.map((code) => `refusal.${code}`),
        ...UNAVAILABLE_REASONS.map((reason) => `unavailable.${reason}`),
        ...PAY_METHODS.map((method) => `method.${method}`),
      ]
      expect(keys.filter((key) => !words[key])).toEqual([])
    }
  })

  it('the band: Updated, Download statement as the primary (Finance), the keys', () => {
    const t = (key: string) => key
    const band = documentsBandOf({ t, asOf: '10:42', onStatement: () => undefined, statementHeld: null })
    expect(band.actions?.map((action) => [action.id, action.variant])).toEqual([['statement', 'primary']])
    expect(band.keys?.map((entry) => entry.keys.join(' '))).toContain('d')
    expect(documentsBandOf({ t, asOf: null, onStatement: null, statementHeld: null }).actions).toEqual([])
  })
})

const KEY = /\b(band|keys|state|held|unavailable|noAccess|chips|group|kind|language|groupBy|library|col|row|for|bulk|docType|sdi|due|pay|method|fake|failure|refusal|invoice|conformity|received|certificate|preview)\.[a-zA-Z_-]+/

describe('SCR-186 design cases', () => {
  it('every case draws in Italian and English with no raw key and made-up data only', () => {
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(30)
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
        expect(html, `${entry.id} (${locale})`).toContain('main-content')
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
      }
    }
  })

  it('the Italian page speaks Italian', () => {
    const entry = designScreen.cases.find((item) => item.id === 'admin')!
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
    expect(html).toContain('Quali documenti')
    expect(html).toContain('Da pagare')
    expect(html).toContain('Conformità per modello ricevuto')
    expect(html).not.toContain('All documents')
    expect(html).not.toContain('To pay')
  })
})
