import { defineDesignScreen } from '../../../lib/design/design-screen'
import { formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { noticesOf } from '../../shell/model'
import { portalNavFor } from '../../shell/nav/portal-nav'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { ConformityRead, LibraryChip, LibraryRead, OpenItemsRead } from './api'
import { documentsBandOf } from './band'
import { chipsOf, conformityRowsOf, groupedRows, libraryRowOf, NS, payRowsOf, sectionsOf, totalsOf, type Grouping, type PayFacts } from './model'
import type { CustomerDocument } from './preview/api'
import { previewRowOf, versionLines } from './preview/model'
import type { DocumentPreviewModel } from './preview/view/DocumentPreview'
import { DocumentsCase, type DocumentsCaseBuilder } from './view/DocumentsCase'
import type { DocumentsViewModel } from './view/DocumentsView'
import type { PayDialogModel } from './view/PayDialog'
import { moneyWriter } from './words'

/**
 * SCR-186 — the customer's Documents (design portal.customer.documents; B-W2b-195), every state with MADE-UP data only (no
 * real customer, person, number or document): an invented brand (Brand Alpha S.r.l.; its finance colleague Carla Prova, its
 * quality colleague Sara Esempio, its admin Paolo Esempio) and an invented maker (Pelletteria Esempio). Finance with what is
 * to pay and the statement, Quality with conformity per style, a buyer, a viewer without prices, the admin with everything,
 * each chip, grouped by order and by style, earlier versions, search with nothing found, loading, still loading, every read
 * failed, nothing yet, a role the page does not open, the document pop-up (a PDF with its versions, opening, failed, an
 * earlier version, withdrawn, held in a preview), the Pay pop-up (choose, the test provider's answers, the bank's
 * confirmation, SEPA waiting, paid, failed, refused, held), an office preview, offline, an invoice that is paid already.
 */

const HOUR = 3_600_000
// One clock for the server render and the first client render.
const NOW = Math.floor(Date.now() / HOUR) * HOUR
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
const dayAt = (days: number) => at(days * 24).slice(0, 10)
const TODAY = dayAt(0)
const PREFIX = '/p/BRAND-ALPHA'
const words = (locale: Locale, namespace = NS) => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})
const id = (n: number) => `0190f0e2-1950-7000-8000-${String(n).padStart(12, '0')}`

const LEGAL = {
  it: { name: 'Pelletteria Esempio S.r.l.', lines: ['Sede legale: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'P. IVA IT00000000000 · C.F. 00000000000'] },
  en: { name: 'Pelletteria Esempio S.r.l.', lines: ['Registered office: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'VAT IT00000000000 · Tax code 00000000000'] },
} as const

// ── who looks ─────────────────────────────────────────────────────────────────────────────────────────────────────────
type Can = (permission: string) => boolean
const set = (...names: string[]): Can => (permission) => names.includes(permission)
const BASE = ['portal.home.view', 'portal.search', 'threads.read', 'portal.customerDocuments.view']
const FINANCE = set(...BASE, 'portal.customerDocuments.finance', 'portal.payments.view', 'portal.payments.pay')
const QUALITY = set(...BASE, 'portal.customerDocuments.conformity')
const BUYER = set(...BASE, 'portal.customerDocuments.conformity', 'portal.salesOrders.view')
const VIEWER = set(...BASE, 'portal.customerDocuments.conformity', 'portal.salesOrders.view')
const ADMIN = set(...BASE, 'portal.customerDocuments.conformity', 'portal.customerDocuments.finance', 'portal.payments.view', 'portal.payments.pay', 'portal.salesOrders.view', 'portal.colleagues.view')
const DESIGNER = set('portal.home.view', 'portal.search', 'threads.read', 'portal.catalogue.view', 'portal.colleagues.view')

const PERSON: Readonly<Record<string, { displayName: string; email: string }>> = {
  finance: { displayName: 'Carla Prova', email: 'carla@brand-alpha.example' },
  quality: { displayName: 'Sara Esempio', email: 'sara@brand-alpha.example' },
  buyer: { displayName: 'Anna Esempio', email: 'anna@brand-alpha.example' },
  admin: { displayName: 'Paolo Esempio', email: 'paolo@brand-alpha.example' },
  designer: { displayName: 'Lia Prova', email: 'lia@brand-alpha.example' },
}

// ── the documents ─────────────────────────────────────────────────────────────────────────────────────────────────────
type DocOver = Partial<CustomerDocument>
const pdf = (n: number, name: string, size = 180_000) => [{ fileId: id(n), format: 'PDF' as const, name, contentType: 'application/pdf', sizeBytes: size }]
const doc = (n: number, kind: string, group: string, title: [string, string], over: DocOver = {}): CustomerDocument => ({
  id: id(n),
  kind,
  kindWords: { it: kind, en: kind },
  group,
  title: { it: title[0], en: title[1] },
  for: { type: 'Shipment', id: id(n + 5000), label: 'SH-2026-0031', order: { id: id(900), number: 'SO-2026-0042', customerRef: 'PO-BA-883' } },
  style: null,
  date: at(-n * 9),
  version: 1,
  sha256: `${'3f9a1c2b0d4e'}${String(n).padStart(52, '0')}`,
  fingerprint: `3f9a1c2b0d${String(n % 100).padStart(2, '0')}`,
  language: 'it',
  current: true,
  replacedBy: null,
  new: false,
  expiresOn: null,
  files: pdf(n, `documento-esempio-${n}.pdf`),
  ...over,
})

const JACKET = { code: 'JKT-ESEMPIO-01', name: 'Giacca da moto Esempio' }
const GLOVE = { code: 'GLV-ESEMPIO-02', name: 'Guanto Esempio' }
const ORDER_2 = { id: id(901), number: 'SO-2026-0039', customerRef: 'PO-BA-871' }

const DOCS: readonly CustomerDocument[] = [
  doc(1, 'DECLARATION_OF_CONFORMITY', 'CONFORMITY', ['Dichiarazione di conformità UE · JKT-ESEMPIO-01 · rev. 3', 'EU declaration of conformity · JKT-ESEMPIO-01 · rev. 3'], { version: 3, style: JACKET, new: true }),
  doc(2, 'USER_INFORMATION', 'CONFORMITY', ['Nota informativa · JKT-ESEMPIO-01', 'User information · JKT-ESEMPIO-01'], { version: 3, style: JACKET, new: true }),
  doc(3, 'DDT', 'DELIVERY', ['DDT 2026/0144', 'Delivery note 2026/0144'], { new: true }),
  doc(4, 'INVOICE', 'FINANCE', ['Fattura FT-2026-0310', 'Invoice FT-2026-0310'], {
    for: { type: 'Invoice', id: id(60), label: 'FT-2026-0310', order: { id: id(900), number: 'SO-2026-0042', customerRef: 'PO-BA-883' } },
    files: [...pdf(4, 'FT-2026-0310.pdf', 64_000), { fileId: id(404), format: 'XML', name: 'IT00000000000_00310.xml', contentType: 'application/xml', sizeBytes: 9_400 }],
    grossTotal: 124_000,
    currency: 'EUR',
  }),
  doc(5, 'INSPECTION_REPORT', 'CONFORMITY', ['Rapporto di ispezione INS-2026-0021', 'Inspection report INS-2026-0021'], { style: JACKET, language: 'en', version: 2 }),
  doc(6, 'PACKING_LIST', 'DELIVERY', ['Distinta colli SH-2026-0027', 'Packing list SH-2026-0027'], { for: { type: 'Shipment', id: id(5006), label: 'SH-2026-0027', order: ORDER_2 } }),
  doc(7, 'ORDER_CONFIRMATION', 'ORDERS', ["Conferma d'ordine Q-2026-0042 v2", 'Order confirmation Q-2026-0042 v2'], { version: 2, for: { type: 'SalesOrder', id: id(900), label: 'SO-2026-0042', order: { id: id(900), number: 'SO-2026-0042', customerRef: 'PO-BA-883' } } }),
  doc(8, 'DECLARATION_OF_CONFORMITY', 'CONFORMITY', ['Dichiarazione di conformità UE · GLV-ESEMPIO-02 · rev. 1', 'EU declaration of conformity · GLV-ESEMPIO-02 · rev. 1'], { style: GLOVE, for: { type: 'Shipment', id: id(5006), label: 'SH-2026-0027', order: ORDER_2 } }),
  doc(9, 'CREDIT_NOTE', 'FINANCE', ['Nota di credito NC-2026-0012', 'Credit note NC-2026-0012'], { for: { type: 'Invoice', id: id(61), label: 'FT-2026-0288', order: ORDER_2 }, files: [{ fileId: id(409), format: 'XML', name: 'IT00000000000_00012.xml', contentType: 'application/xml', sizeBytes: 7_100 }] }),
  doc(10, 'OTHER', 'OTHER', ['Scheda lavaggio esempio.pdf', 'Scheda lavaggio esempio.pdf'], { for: { type: 'Party', id: id(70), label: 'Brand Alpha S.r.l.', order: null }, language: null }),
]
const EARLIER: readonly CustomerDocument[] = [
  doc(11, 'DECLARATION_OF_CONFORMITY', 'CONFORMITY', ['Dichiarazione di conformità UE · JKT-ESEMPIO-01 · rev. 2', 'EU declaration of conformity · JKT-ESEMPIO-01 · rev. 2'], { version: 2, style: JACKET, current: false, replacedBy: { id: id(1), title: { it: 'Dichiarazione', en: 'Declaration' }, version: 3 }, date: at(-24 * 60) }),
]

const PRICE_GROUPS = new Set(['FINANCE', 'ORDERS'])
function libraryOf(can: Can, prices: boolean, group: LibraryChip = 'ALL', extra: readonly CustomerDocument[] = []): LibraryRead {
  const sees = (entry: CustomerDocument) =>
    (entry.group === 'CONFORMITY' ? can('portal.customerDocuments.conformity') : entry.group === 'FINANCE' ? can('portal.customerDocuments.finance') : true) && (prices || !PRICE_GROUPS.has(entry.group))
  const all = [...DOCS, ...extra].filter(sees).sort((a, b) => b.date.localeCompare(a.date))
  const groups = (['DELIVERY', 'CONFORMITY', 'FINANCE', 'ORDERS', 'OTHER'] as const).filter((name) => (name === 'CONFORMITY' ? can('portal.customerDocuments.conformity') : name === 'FINANCE' ? can('portal.customerDocuments.finance') && prices : name === 'ORDERS' ? prices : true))
  const items = group === 'ALL' ? all : all.filter((entry) => entry.group === group)
  return {
    asOf: at(0),
    seesPrices: prices,
    group,
    chips: [{ chip: 'ALL', count: all.length }, ...groups.map((name) => ({ chip: name, count: all.filter((entry) => entry.group === name).length }))],
    count: items.length,
    newCount: items.filter((entry) => entry.new).length,
    lastVisitAt: at(-96),
    items: prices ? items : items.map(({ grossTotal: _grossTotal, currency: _currency, ...rest }) => rest),
    live: { events: ['partner_notification.created'] },
  }
}

// ── to pay ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const intent = (status: 'CREATED' | 'WAITING' | 'SUCCEEDED' | 'FAILED', method: 'CARD' | 'SEPA_DEBIT' = 'CARD', failureCode: string | null = null) => ({
  id: id(990),
  method,
  amount: 124_000,
  currency: 'EUR',
  status,
  providerRef: 'pi_fake_abcdefghijklmnopabcdefghijklmnop',
  failureCode,
  finishedAt: status === 'SUCCEEDED' || status === 'FAILED' ? at(-1) : null,
  createdAt: at(-2),
})
const OPEN_ITEMS: OpenItemsRead = {
  asOf: TODAY,
  invoices: [
    { invoiceId: id(60), number: 'FT-2026-0310', docType: 'TD01', issueDate: dayAt(-40), dueDate: dayAt(-10), dueDateKnown: true, daysLate: 10, total: 124_000, open: 124_000, currency: 'EUR', sdiStatus: 'DELIVERED', pdfFileId: id(4), xmlFileId: id(404), payment: null, canPay: true },
    { invoiceId: id(62), number: 'FT-2026-0331', docType: 'TD01', issueDate: dayAt(-12), dueDate: dayAt(18), dueDateKnown: true, daysLate: 0, total: 248_000, open: 98_000, currency: 'EUR', sdiStatus: 'NOT_DELIVERABLE', pdfFileId: id(12), xmlFileId: id(412), payment: intent('FAILED', 'CARD', 'card_declined'), canPay: true },
    { invoiceId: id(63), number: 'FT-2026-0340', docType: 'TD24', issueDate: dayAt(-2), dueDate: dayAt(28), dueDateKnown: true, daysLate: 0, total: 61_000, open: 61_000, currency: 'EUR', sdiStatus: 'SENT', pdfFileId: id(13), xmlFileId: id(413), payment: null, canPay: true },
  ],
  deposits: [{ depositRequestId: id(80), orderNumber: 'SO-2026-0045', quoteDocument: 'Q-2026-0051 v1', dueDate: dayAt(5), daysLate: 0, total: 150_000, open: 150_000, currency: 'EUR', payment: null, canPay: true }],
  byCurrency: [{ currency: 'EUR', open: 433_000, overdue: 124_000 }],
  counts: { invoices: 3, overdue: 1, deposits: 1 },
  card: { available: true, methods: ['CARD', 'SEPA_DEBIT'], provider: 'PAYMENT_FAKE', mode: 'FAKE', reason: null },
  mayPay: true,
  live: { events: ['partner_task.opened', 'partner_task.closed'] },
}
const NOTHING_TO_PAY: OpenItemsRead = { ...OPEN_ITEMS, invoices: [], deposits: [], byCurrency: [], counts: { invoices: 0, overdue: 0, deposits: 0 } }

// ── conformity ────────────────────────────────────────────────────────────────────────────────────────────────────────
const ref = (n: number, kind: string, title: [string, string], over: Partial<{ version: number; language: string | null; isNew: boolean }> = {}) => ({
  id: id(n),
  kind,
  title: { it: title[0], en: title[1] },
  version: over.version ?? 1,
  language: over.language === undefined ? 'it' : over.language,
  fingerprint: `3f9a1c2b0d${String(n % 100).padStart(2, '0')}`,
  new: over.isNew ?? false,
})
const CONFORMITY: ConformityRead = {
  asOf: at(0),
  count: 2,
  styles: [
    {
      style: JACKET,
      ppe: true,
      certificateRequired: true,
      standard: 'EN 17092-3:2020',
      ppeClass: 'AA',
      received: [
        {
          shipment: { id: id(5001), number: 'SH-2026-0031' },
          order: { id: id(900), number: 'SO-2026-0042', customerRef: 'PO-BA-883' },
          shippedOn: dayAt(-3),
          revision: 3,
          pieces: 120,
          state: 'COMPLETE',
          declaration: ref(1, 'DECLARATION_OF_CONFORMITY', ['Dichiarazione di conformità UE · rev. 3', 'EU declaration of conformity · rev. 3'], { version: 3, isNew: true }),
          userInformation: ref(2, 'USER_INFORMATION', ['Nota informativa · rev. 3', 'User information · rev. 3'], { version: 3, isNew: true }),
          certificate: { number: 'CERT-ESEMPIO-0003', standard: 'EN 17092-3:2020', ppeClass: 'AA', notifiedBody: { name: 'Organismo Esempio', number: '0000' }, validFrom: dayAt(-400), validTo: dayAt(800), validOnShippingDate: true },
          reports: [ref(5, 'INSPECTION_REPORT', ['Rapporto di ispezione INS-2026-0021', 'Inspection report INS-2026-0021'], { version: 2, language: 'en' })],
        },
        {
          shipment: { id: id(5002), number: 'SH-2026-0018' },
          order: { id: id(902), number: 'SO-2026-0030', customerRef: null },
          shippedOn: dayAt(-70),
          revision: 2,
          pieces: 60,
          state: 'INCOMPLETE',
          declaration: ref(11, 'DECLARATION_OF_CONFORMITY', ['Dichiarazione di conformità UE · rev. 2', 'EU declaration of conformity · rev. 2'], { version: 2 }),
          userInformation: null,
          certificate: { number: 'CERT-ESEMPIO-0003', standard: 'EN 17092-3:2020', ppeClass: 'AA', notifiedBody: { name: 'Organismo Esempio', number: '0000' }, validFrom: dayAt(-400), validTo: dayAt(800), validOnShippingDate: true },
          reports: [],
        },
      ],
    },
    {
      style: GLOVE,
      ppe: true,
      certificateRequired: false,
      standard: 'EN 13594:2015',
      ppeClass: '1',
      received: [
        {
          shipment: { id: id(5006), number: 'SH-2026-0027' },
          order: ORDER_2,
          shippedOn: dayAt(-20),
          revision: 1,
          pieces: 200,
          state: 'COMPLETE',
          declaration: ref(8, 'DECLARATION_OF_CONFORMITY', ['Dichiarazione di conformità UE · rev. 1', 'EU declaration of conformity · rev. 1']),
          userInformation: ref(14, 'USER_INFORMATION', ['Nota informativa · rev. 1', 'User information · rev. 1']),
          certificate: null,
          reports: [],
        },
      ],
    },
  ],
  live: { events: [] },
}

// ── the pop-ups ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** A one-page made-up PDF (pdf.js reads it without a cross-reference table). */
function samplePdf(text: string): Uint8Array {
  const stream = `BT /F1 22 Tf 72 760 Td (${text}) Tj ET`
  const body = [
    '%PDF-1.4',
    '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj',
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>> endobj',
    `4 0 obj <</Length ${stream.length}>> stream`,
    stream,
    'endstream endobj',
    '5 0 obj <</Type/Font/Subtype/Type1/BaseFont/Helvetica>> endobj',
    'trailer <</Root 1 0 R>>',
    '%%EOF',
  ].join('\n')
  return new TextEncoder().encode(body)
}
const PDF = samplePdf('Dichiarazione di conformita UE - esempio')

function previewOf(locale: Locale, document: CustomerDocument, over: Partial<DocumentPreviewModel> = {}): DocumentPreviewModel {
  return {
    row: previewRowOf(document, locale),
    state: 'ready',
    src: PDF,
    pdf: true,
    versions: versionLines([
      { id: id(1), version: 3, date: at(-9), current: true },
      { id: id(11), version: 2, date: at(-24 * 60), current: false },
      { id: id(15), version: 1, date: at(-24 * 200), current: false },
    ]),
    withdrawn: null,
    position: { index: 1, count: DOCS.length },
    downloading: false,
    problem: null,
    held: null,
    ...over,
  }
}

const FIRST_INVOICE = payRowsOf(OPEN_ITEMS)[0]!
function payOf(over: Partial<PayDialogModel> = {}): PayDialogModel {
  return { row: FIRST_INVOICE, today: TODAY, methods: ['CARD', 'SEPA_DEBIT'], method: 'CARD', state: 'idle', fake: true, stage: null, failure: null, problem: null, held: null, resumed: false, sending: false, ...over }
}

// ── the case ──────────────────────────────────────────────────────────────────────────────────────────────────────────
interface CaseInput {
  can?: Can
  person?: keyof typeof PERSON
  prices?: boolean
  group?: LibraryChip
  by?: Grouping
  versions?: 'current' | 'all'
  q?: string
  facts?: Partial<PayFacts>
  shell?: Partial<PortalShellViewModel>
  page?: Partial<DocumentsViewModel>
  library?: Partial<DocumentsViewModel['library']>
  openItems?: OpenItemsRead
  closed?: boolean
}

function shellOf(locale: Locale, input: CaseInput, page: Partial<DocumentsViewModel>): PortalShellViewModel {
  const t = words(locale)
  const can = input.can ?? FINANCE
  const statement = can('portal.payments.view') && (input.prices ?? true) && !input.facts?.preview
  return {
    brand: { name: 'Pelletteria Esempio', logoUrl: null, logoDarkUrl: null, accent: '#7a1f3d' },
    companyName: 'Pelletteria Esempio',
    partyName: 'Brand Alpha S.r.l.',
    person: PERSON[input.person ?? 'finance']!,
    nav: portalNavFor({ can, kinds: ['CUSTOMER'] }),
    path: '/documents',
    prefix: PREFIX,
    badges: null,
    bell: { unread: 1, complete: true },
    notice: null,
    band: input.closed ? { title: t('title'), back: { href: PREFIX, label: t('noAccess.home') } } : documentsBandOf({ t, asOf: page.chips?.state === 'loading' ? null : formatTime(at(0), { locale }), onStatement: statement ? () => undefined : null, statementHeld: input.facts?.offline ? t('held.offline') : null }),
    live: 'live',
    legal: LEGAL[locale],
    privacyHref: '/privacy/00000000-0000-7000-8000-000000000001',
    termsHref: `${PREFIX}/terms`,
    freeForSuppliers: false,
    preview: false,
    canSearch: true,
    ...input.shell,
  }
}

function pageOf(locale: Locale, input: CaseInput): DocumentsViewModel {
  const can = input.can ?? FINANCE
  const prices = input.prices ?? true
  const group = input.group ?? 'ALL'
  const by = input.by ?? 'newest'
  const read = libraryOf(can, prices, group, input.versions === 'all' ? EARLIER : [])
  const facts: PayFacts = { preview: false, offline: false, mayPay: can('portal.payments.pay'), card: OPEN_ITEMS.card, ...input.facts }
  const held = facts.preview ? 'held.preview' : facts.offline ? 'held.offline' : null
  const sections = sectionsOf(group, { toPay: can('portal.payments.view'), conformity: can('portal.customerDocuments.conformity') })
  const open = input.openItems ?? OPEN_ITEMS
  const money = moneyWriter(locale)
  const rows = groupedRows(read.items.map((item) => libraryRowOf(item, locale, new Set())), by)
  const matching = input.q ? rows.filter((row) => row.title.toLowerCase().includes(input.q!.toLowerCase())) : rows
  return {
    chips: { state: 'ready', items: chipsOf(read) },
    group,
    noPrices: !prices,
    notice: null,
    toPay: sections.toPay
      ? {
          state: 'ready',
          rows: payRowsOf(open),
          totals: totalsOf(open).map((total) => ({ open: money(total.open, total.currency), overdue: total.overdue > 0 ? money(total.overdue, total.currency) : null })),
          overdue: open.counts.overdue,
          facts,
          today: TODAY,
          selected: [],
          busy: null,
          held,
        }
      : null,
    library: { state: 'ready', rows: matching, total: input.q ? matching.length : read.count, group, q: input.q ?? '', by, versions: input.versions ?? 'current', selected: [], busy: null, held, updates: 0, more: false, loadingMore: false, prefix: PREFIX, ...input.library },
    conformity: sections.conformity ? { state: 'ready', styles: conformityRowsOf(CONFORMITY.styles, locale), busy: null, held, open: [JACKET.code] } : null,
    preview: null,
    problem: null,
    pay: null,
    ...input.page,
  }
}

const docCase =
  (input: CaseInput | ((locale: Locale) => CaseInput) = {}): DocumentsCaseBuilder =>
  (locale) => {
    const resolved = typeof input === 'function' ? input(locale) : input
    if (resolved.closed) return { shell: shellOf(locale, resolved, {}), page: { kind: 'closed', admins: ['Paolo Esempio'] } }
    const page = pageOf(locale, resolved)
    return { shell: shellOf(locale, resolved, page), page: { kind: 'page', model: page } }
  }

const loadingPage = (slow: boolean): Partial<DocumentsViewModel> => ({
  chips: { state: 'loading', items: [] },
  slow,
})

export const designScreen = defineDesignScreen<DocumentsCaseBuilder>({
  screen: 'SCR-186',
  title: 'Customer Documents (portal.customer.documents)',
  view: DocumentsCase,
  cases: [
    {
      id: 'finance',
      label: 'Finance: to pay and every document',
      model: docCase(),
      note: 'Which documents (the groups Finance sees, with counts); To pay oldest due first (overdue in words, the SDI state, the PDF and the XML in new tabs, Pay); All documents with their fixed version and fingerprint, NEW, Preview, Download (logged), ⋯ each file in a new tab; Download statement in the band (a new tab).',
    },
    { id: 'quality', label: 'Quality: conformity per style', model: docCase({ can: QUALITY, person: 'quality', prices: false }), note: 'No prices: one line says so; no invoices or quotes. Conformity per style received: per shipment the declaration, the user information, the certificate valid on the shipping date and the reports; a missing document says "ask us".' },
    { id: 'buyer', label: 'A buyer (delivery papers and conformity)', model: docCase({ can: BUYER, person: 'buyer', prices: false }) },
    { id: 'viewer', label: 'A viewer (everything without prices)', model: docCase({ can: VIEWER, person: 'buyer', prices: false }) },
    { id: 'admin', label: 'The customer’s admin (everything)', model: docCase({ can: ADMIN, person: 'admin' }) },
    { id: 'chip-finance', label: 'Chip: invoices and statements', model: docCase({ can: ADMIN, person: 'admin', group: 'FINANCE' }), note: 'Home’s Invoices tile opens this: To pay and the invoices only (no conformity section).' },
    { id: 'chip-conformity', label: 'Chip: conformity', model: docCase({ can: ADMIN, person: 'admin', group: 'CONFORMITY' }), note: 'The conformity documents and the conformity per style; no To pay.' },
    { id: 'by-order', label: 'Grouped by order', model: docCase({ by: 'order' }), note: 'Each order’s documents together (their PO first), documents of no order last.' },
    { id: 'by-style', label: 'Grouped by style', model: docCase({ can: QUALITY, person: 'quality', prices: false, by: 'style' }) },
    { id: 'versions', label: 'Earlier versions too', model: docCase({ can: QUALITY, person: 'quality', prices: false, versions: 'all' }), note: 'An earlier version stays readable and says "Replaced by v3"; the link opens the current one.' },
    { id: 'search-none', label: 'Search: nothing found', model: docCase({ q: 'ZZ-0000' }) },
    {
      id: 'loading',
      label: 'Loading',
      model: docCase({ page: { ...loadingPage(false) }, library: { state: 'loading', rows: null } }),
    },
    {
      id: 'loading-slow',
      label: 'Still loading after a second',
      model: docCase({ can: ADMIN, person: 'admin', page: { ...loadingPage(true) }, library: { state: 'loading', rows: null } }),
    },
    {
      id: 'error',
      label: 'Nothing could be read',
      model: docCase((locale) => {
        const base = pageOf(locale, { can: ADMIN })
        return {
          can: ADMIN,
          person: 'admin',
          page: { chips: { state: 'error', items: [] }, toPay: base.toPay ? { ...base.toPay, state: 'error', rows: [], totals: [], overdue: 0 } : null, conformity: base.conformity ? { ...base.conformity, state: 'error', styles: [] } : null },
          library: { state: 'error', rows: [] },
        }
      }),
      note: 'Each section says its problem in our words with Try again: a failed read is never drawn as an empty list.',
    },
    {
      id: 'empty',
      label: 'Nothing yet',
      model: docCase((locale) => {
        const base = pageOf(locale, { can: ADMIN, openItems: NOTHING_TO_PAY })
        return { can: ADMIN, person: 'admin', openItems: NOTHING_TO_PAY, page: { chips: { state: 'ready', items: [{ chip: 'ALL', count: 0 }] }, conformity: base.conformity ? { ...base.conformity, styles: [] } : null }, library: { rows: [], total: 0 } }
      }),
      note: '“Nothing to pay.”, “No documents yet.”, “Nothing shipped yet.”',
    },
    { id: 'no-permission', label: 'A role the page does not open', model: docCase({ can: DESIGNER, person: 'designer', closed: true }), note: 'Not in the navigation (fails closed); a typed or old address says it is not part of the access, with the admin to ask.' },
    { id: 'preview', label: 'Pop-up: a document with its versions', model: docCase((locale) => ({ can: QUALITY, person: 'quality', prices: false, page: { preview: previewOf(locale, DOCS[0]!) } })), note: 'The PDF in the viewer (PageUp / PageDown; its Download is the same logged one), the version with its fingerprint, the versions (an earlier one opens from there); J / K: the next document of the list.' },
    { id: 'preview-loading', label: 'Pop-up: opening', model: docCase((locale) => ({ can: QUALITY, person: 'quality', prices: false, page: { preview: previewOf(locale, DOCS[0]!, { state: 'loading', src: null }) } })) },
    { id: 'preview-error', label: 'Pop-up: could not be opened', model: docCase((locale) => ({ can: QUALITY, person: 'quality', prices: false, page: { preview: previewOf(locale, DOCS[0]!, { state: 'error', src: null, versions: [], problem: { key: 'preview.problem.unavailable' } }) } })) },
    { id: 'preview-earlier', label: 'Pop-up: an earlier version', model: docCase((locale) => ({ can: QUALITY, person: 'quality', prices: false, versions: 'all', page: { preview: previewOf(locale, EARLIER[0]!) } })), note: 'Readable, and it names the version that replaced it (Open v3).' },
    { id: 'preview-withdrawn', label: 'Pop-up: a withdrawn version', model: docCase((locale) => ({ can: QUALITY, person: 'quality', prices: false, page: { preview: previewOf(locale, EARLIER[0]!, { state: 'withdrawn', src: null, withdrawn: { id: id(1), title: locale === 'it' ? 'Dichiarazione di conformità UE' : 'EU declaration of conformity', version: 3 } }) } })) },
    { id: 'preview-xml', label: 'Pop-up: a file without a preview', model: docCase((locale) => ({ page: { preview: previewOf(locale, DOCS[8]!, { src: null, pdf: false, versions: [] }) } })), note: 'A credit note’s XML: “download it”, with Download in the foot.' },
    { id: 'pay', label: 'Pop-up: Pay — choose how', model: docCase({ page: { pay: payOf() } }), note: 'The amount and the due date, card or SEPA (RadioCards), Continue; the bank transfer is always there.' },
    { id: 'pay-ready', label: 'Pop-up: Pay — the test provider’s fields', model: docCase({ page: { pay: payOf({ state: 'ready', stage: 'CARD' }) } }), note: 'The FAKE provider: the tester says what the bank answers; no card is asked, no money moves.' },
    { id: 'pay-confirm', label: 'Pop-up: Pay — the bank asks to confirm', model: docCase({ page: { pay: payOf({ state: 'waiting', stage: 'CARD_CONFIRM' }) } }) },
    { id: 'pay-waiting', label: 'Pop-up: Pay — SEPA, the bank decides', model: docCase({ page: { pay: payOf({ method: 'SEPA_DEBIT', state: 'waiting', stage: 'SEPA_WAITING' }) } }), note: '“Waiting for your bank… don’t close this page.”' },
    { id: 'pay-paid', label: 'Pop-up: Pay — paid', model: docCase({ page: { pay: payOf({ state: 'succeeded' }) } }) },
    { id: 'pay-failed', label: 'Pop-up: Pay — declined', model: docCase({ page: { pay: payOf({ state: 'failed', failure: 'failure.card_declined' }) } }), note: 'Why in our words; Try again (another card or SEPA).' },
    { id: 'pay-refused', label: 'Pop-up: Pay — a payment under way', model: docCase({ page: { pay: payOf({ problem: 'refusal.IN_PROGRESS' }) } }) },
    { id: 'pay-sending', label: 'Pop-up: Pay — sending', model: docCase({ page: { pay: payOf({ state: 'paying', stage: 'CARD', sending: true }) } }), note: 'Close waits with the reason while a step is sent.' },
    {
      id: 'pay-held',
      label: 'Pop-up: Pay — not online',
      model: docCase((locale) => ({ page: { pay: payOf({ held: words(locale)('unavailable.GATE_SPEND') }) } })),
      note: 'Card payment not switched on: the panel says why; the bank transfer stays.',
    },
    {
      id: 'invoice-paid',
      label: 'An invoice that is paid already',
      model: docCase({ page: { notice: { key: 'invoice.nothingOpen', tone: 'info' } } }),
      note: 'Opened from a request or a notification (`?invoice=`): nothing left to pay, said once.',
    },
    {
      id: 'preview-office',
      label: 'An office preview',
      model: docCase(() => ({
        can: ADMIN,
        person: 'admin',
        facts: { preview: true, mayPay: false },
        shell: { preview: true, notice: noticesOf({ preview: { viewer: 'Marta Verdi', company: 'Pelletteria Esempio', party: 'Brand Alpha S.r.l.' } })[0] ?? null },
        page: { preview: null },
        library: { held: 'held.preview' },
      })),
      note: 'Read only: Preview, Download, the files and Pay held with the reason; no statement.',
    },
    {
      id: 'offline',
      label: 'Offline',
      model: docCase((locale) => ({ facts: { offline: true }, shell: { live: 'offline', notice: noticesOf({ offlineSince: formatTime(at(-1), { locale }) })[0] ?? null } })),
      note: 'What was loaded stays; every open and Pay is held with “No connection”.',
    },
    { id: 'keys', label: 'The keys (the footer’s icon)', model: docCase({ library: { keysOpen: true, focusRow: 0 } }) },
  ],
})
