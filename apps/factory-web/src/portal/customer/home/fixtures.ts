import { KIND_RULES, taskWords, type PartnerTaskKind } from '@nexus/factory-domain/portal/tasks/kinds'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { formatDate, formatTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { badgesOf, noticesOf } from '../../shell/model'
import { portalNavFor } from '../../shell/nav/portal-nav'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { TasksViewModel } from '../../shell/view/TasksView'
import type { ApprovalRead, Conversation, DocumentsRead, HomeRead, OpenItemsRead, OrdersRead } from './api'
import { homeBandOf } from './band'
import { previewRowOf, versionLines } from '../documents/preview/model'
import type { DocumentPreviewModel } from '../documents/preview/view/DocumentPreview'
import { documentRows, nextOrderRows, NS, orderCounts, tilesFor, tilesOf, type BuiltPages } from './model'
import type { ApproveDialogModel } from './view/ApproveDialog'
import type { CustomerHomeViewModel } from './view/CustomerHomeView'
import { HomeCase, type HomeCaseBuilder } from './view/HomeCase'
import { dayWriter, moneyWriter } from './words'

/**
 * SCR-183 — the customer's Home (design portal.customer.home; B-W2b-187), every state with MADE-UP data only (no real
 * customer, person or number): an invented brand (Brand Alpha S.r.l., its buyer Anna Esempio, its finance colleague Carla
 * Prova) and an invented maker (Pelletteria Esempio). A buyer's Home today (no list page built yet: counts without links)
 * and as it will be (every tile a link), Finance with the open amount and the statement, a designer, Find anything with
 * results, recent searches, nothing found and a failed search, loading, still loading, every section failed, nothing new,
 * the first visit (a buyer, another role), the Approve pop-up (a sample with its photos, a revised order with and without
 * prices, a photo open, the checks, held, sending, the end, loading, failed, gone) and the Document pop-up (a PDF with its
 * versions, a picture, a failed open), an office preview and offline.
 */

const HOUR = 3_600_000
// One clock for the server render and the first client render.
const NOW = Math.floor(Date.now() / HOUR) * HOUR
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
const dayAt = (days: number) => at(days * 24).slice(0, 10)
const PREFIX = '/p/BRAND-ALPHA'
const words = (locale: Locale, namespace = NS) => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})
const id = (n: number) => `0190f0e2-1830-7000-8000-${String(n).padStart(12, '0')}`

const LEGAL = {
  it: { name: 'Pelletteria Esempio S.r.l.', lines: ['Sede legale: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'P. IVA IT00000000000 · C.F. 00000000000'] },
  en: { name: 'Pelletteria Esempio S.r.l.', lines: ['Registered office: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'VAT IT00000000000 · Tax code 00000000000'] },
} as const

/** A buyer: orders, documents, messages, search, approvals, ordering — no payments. */
const BUYER = (permission: string) => permission.startsWith('portal.') && !permission.startsWith('portal.payments') ? true : permission === 'threads.read'
const FINANCE = (permission: string) => permission.startsWith('portal.') || permission === 'threads.read'
const DESIGNER = (permission: string) => ['portal.home.view', 'portal.search', 'portal.approve', 'portal.approvals.view', 'portal.comment'].includes(permission) || permission === 'threads.read'

const TODAY_BUILT: BuiltPages = { orders: false, documents: false, returns: false }
const ALL_BUILT: BuiltPages = { orders: true, documents: true, returns: true }

function shell(locale: Locale, over: Partial<PortalShellViewModel> = {}, can = BUYER): PortalShellViewModel {
  return {
    brand: { name: 'Pelletteria Esempio', logoUrl: null, logoDarkUrl: null, accent: '#7a1f3d' },
    companyName: 'Pelletteria Esempio',
    partyName: 'Brand Alpha S.r.l.',
    person: { displayName: 'Anna Esempio', email: 'anna@brand-alpha.example' },
    nav: portalNavFor({ can, kinds: ['CUSTOMER'] }),
    path: '/',
    prefix: PREFIX,
    badges: badgesOf([{ area: 'orders', count: 1, words: { it: '1 da riconfermare', en: '1 to re-confirm' } }], locale),
    bell: { unread: 2, complete: true },
    notice: null,
    band: null,
    live: 'live',
    legal: LEGAL[locale],
    privacyHref: '/privacy/00000000-0000-7000-8000-000000000001',
    termsHref: `${PREFIX}/terms`,
    freeForSuppliers: false,
    preview: false,
    canSearch: true,
    ...over,
  }
}

// ── What waits for you ─────────────────────────────────────────────────────────────────────────────────────────────────
interface FixtureTask {
  id: string
  kind: PartnerTaskKind
  record: string
  recordType: string
  recordId: string
  due: 'overdue' | 'today' | 'soon' | 'later'
  dueIn: number
  askedBy: string | null
  inline: boolean
}

const SAMPLE_ID = id(101)
const REVISED_ID = id(102)
const TASKS: readonly FixtureTask[] = [
  { id: id(1), kind: 'RECONFIRM_ORDER', record: 'SO-2026-0042', recordType: 'ApprovalRequest', recordId: REVISED_ID, due: 'today', dueIn: 5, askedBy: 'Marta Verdi', inline: false },
  { id: id(2), kind: 'APPROVE', record: 'Campione JKT-ESEMPIO-01', recordType: 'ApprovalRequest', recordId: SAMPLE_ID, due: 'soon', dueIn: 52, askedBy: 'Marta Verdi', inline: false },
  { id: id(3), kind: 'UPLOAD_DOCUMENT', record: 'SO-2026-0040', recordType: 'SalesOrder', recordId: id(40), due: 'overdue', dueIn: -30, askedBy: 'Marta Verdi', inline: true },
  { id: id(4), kind: 'ANSWER_MESSAGE', record: 'SO-2026-0038', recordType: 'SalesOrder', recordId: id(38), due: 'later', dueIn: 24 * 6, askedBy: null, inline: false },
]
const PAY: FixtureTask = { id: id(5), kind: 'PAY_INVOICE', record: 'FT-2026-0101', recordType: 'Invoice', recordId: id(60), due: 'overdue', dueIn: -72, askedBy: null, inline: false }

function tasksOf(locale: Locale, list: readonly FixtureTask[] = TASKS, state: TasksViewModel['state'] = 'ready', held: string | null = null): TasksViewModel {
  const groups = new Map<string, TasksViewModel['groups'][number]['rows'][number][]>()
  for (const task of list) {
    const rows = groups.get(task.kind) ?? []
    rows.push({
      id: task.id,
      kind: task.kind,
      title: taskWords(task.kind, task.record, locale),
      verb: KIND_RULES[task.kind].verb[locale],
      record: task.record,
      askedBy: task.askedBy,
      due: { at: at(task.dueIn), state: task.due, text: formatDate(at(task.dueIn), { locale }) },
      act: task.inline ? 'inline' : 'link',
      href: `${PREFIX}/open/${task.recordType}/${task.recordId}#task:${task.id}`,
      held,
    })
    groups.set(task.kind, rows)
  }
  return { state, now: NOW, groups: [...groups.entries()].map(([kind, rows]) => ({ kind, rows })) }
}

// ── the reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const HOME: HomeRead = {
  asOf: at(0),
  kind: 'CUSTOMER',
  counts: [
    { key: 'orders.open', area: 'orders', words: { it: 'Ordini aperti', en: 'Open orders' }, value: 7 },
    { key: 'orders.in_production', area: 'orders', words: { it: 'In produzione', en: 'In production' }, value: 3 },
    { key: 'orders.shipping_this_week', area: 'orders', words: { it: 'In spedizione questa settimana', en: 'Shipping this week' }, value: 120 },
    { key: 'orders.in_transit', area: 'orders', words: { it: 'In viaggio', en: 'On the way' }, value: 1 },
    { key: 'invoices.to_pay', area: 'documents', words: { it: 'Fatture da pagare', en: 'Invoices to pay' }, value: 2 },
    { key: 'invoices.overdue', area: 'documents', words: { it: 'Fatture scadute', en: 'Overdue invoices' }, value: 1 },
    { key: 'returns.open', area: 'returns', words: { it: 'Resi e reclami aperti', en: 'Open returns and claims' }, value: 1 },
    { key: 'returns.complaints_open', area: 'returns', words: { it: 'Reclami aperti', en: 'Open complaints' }, value: null },
    { key: 'documents.new', area: 'documents', words: { it: 'Nuovi documenti', en: 'New documents' }, value: 3 },
  ],
  live: { events: ['partner_task.opened', 'partner_notification.created'] },
}

const OPEN_ITEMS: OpenItemsRead = { byCurrency: [{ currency: 'EUR', open: 1_245_000, overdue: 320_000 }], counts: { invoices: 2, overdue: 1, deposits: 0 } }

const W = (it: string, en: string) => ({ it, en })
const row = (n: number, status: OrdersRead['items'][number]['status'], over: Partial<OrdersRead['items'][number]> = {}): OrdersRead['items'][number] => ({
  kind: 'ORDER',
  id: id(200 + n),
  customerRef: `PO-BA-${880 + n}`,
  number: `SO-2026-00${40 + n}`,
  status,
  promiseDate: dayAt(3 + n * 4),
  originalPromiseDate: dayAt(3 + n * 4),
  promiseMoved: false,
  requestedDate: dayAt(n * 4),
  pieces: { ordered: 60 + n * 10, shipped: 0, open: 60 + n * 10 },
  nextShipment: null,
  progressPercent: null,
  ...over,
})
const ORDERS: OrdersRead = {
  asOf: at(0),
  progressShared: true,
  chips: [
    { chip: 'OPEN', count: 7 },
    { chip: 'ALL', count: 23 },
  ],
  count: 7,
  items: [
    row(1, 'PARTLY_SHIPPED', { pieces: { ordered: 70, shipped: 40, open: 30 }, nextShipment: { id: id(301), number: 'SH-2026-0012', status: 'IN_TRANSIT', words: W('In viaggio', 'On the way') } }),
    row(2, 'READY', { progressPercent: 100 }),
    row(3, 'IN_PRODUCTION', { promiseMoved: true, originalPromiseDate: dayAt(8), promiseDate: dayAt(15), progressPercent: 45 }),
    row(4, 'CONFIRMED', { progressPercent: 0 }),
    row(5, 'REQUESTED', { kind: 'REQUEST', number: 'RQ-2026-0007', promiseDate: null, originalPromiseDate: null }),
  ],
  live: { events: ['partner_notification.created'] },
}
const NO_ORDERS: OrdersRead = { ...ORDERS, chips: [{ chip: 'OPEN', count: 0 }, { chip: 'ALL', count: 0 }], count: 0, items: [] }

const doc = (n: number, kind: string, title: [string, string], over: Partial<DocumentsRead['items'][number]> = {}): DocumentsRead['items'][number] => ({
  id: id(400 + n),
  kind,
  kindWords: W(title[0], title[1]),
  group: 'CONFORMITY',
  title: W(title[0], title[1]),
  for: { type: 'Shipment', id: id(301), label: 'SH-2026-0012', order: { id: id(201), number: 'SO-2026-0041', customerRef: 'PO-BA-881' } },
  date: at(-6 - n * 5),
  version: 1,
  fingerprint: '3f9a1c2b0d4e',
  language: 'it',
  current: true,
  replacedBy: null,
  new: true,
  files: [{ fileId: id(400 + n), format: 'PDF', name: `documento-esempio-${n}.pdf`, contentType: 'application/pdf', sizeBytes: 182_000 + n * 1000 }],
  ...over,
})
const DOCUMENTS: DocumentsRead = {
  asOf: at(0),
  count: 3,
  newCount: 3,
  lastVisitAt: at(-96),
  items: [
    doc(1, 'DECLARATION_OF_CONFORMITY', ['Dichiarazione di conformità · JKT-ESEMPIO-01 · v3', 'Declaration of conformity · JKT-ESEMPIO-01 · v3'], { version: 3 }),
    doc(2, 'DDT', ['DDT 2026/0144', 'Delivery note 2026/0144'], { group: 'DELIVERY' }),
    doc(3, 'INVOICE', ['Fattura FT-2026-0101', 'Invoice FT-2026-0101'], { group: 'FINANCE', for: { type: 'Invoice', id: id(60), label: 'FT-2026-0101', order: null }, files: [{ fileId: id(403), format: 'XML', name: 'IT00000000000_00101.xml', contentType: 'application/xml', sizeBytes: 9_400 }] }),
  ],
  live: { events: ['partner_notification.created'] },
}

function conversations(locale: Locale): Conversation[] {
  const line = (n: number, type: string, theirs: string | null, ours: string, author: string, it: string, en: string, hours: number): Conversation => ({
    record: { type, id: id(500 + n), theirRef: theirs, ourRef: ours, subtitle: null, status: null },
    thread: { id: id(600 + n), status: 'OPEN' },
    last: { id: id(700 + n), side: 'COMPANY', channel: 'PORTAL', authorName: author, excerpt: locale === 'it' ? it : en, attachmentCount: 0, at: at(hours) },
  })
  return [
    line(1, 'SalesOrder', 'PO-BA-883', 'SO-2026-0043', 'Marta Verdi', 'La pelle nera arriva lunedì: la consegna slitta di una settimana.', 'The black leather arrives on Monday: the delivery moves by one week.', -3),
    line(2, 'Quote', null, 'Q-2026-0042', 'Marta Verdi', 'Vi abbiamo mandato la nuova offerta con le taglie richieste.', 'We sent you the new quote with the sizes you asked for.', -27),
    line(3, 'SalesOrder', 'PO-BA-881', 'SO-2026-0041', 'Luca Prova', 'Il secondo collo parte domani con il corriere.', 'The second parcel leaves tomorrow with the carrier.', -50),
  ]
}

const SEARCH_GROUPS = (locale: Locale) => {
  const portal = words(locale, 'portal')
  return [
    {
      group: 'orders',
      label: portal('search.group.orders'),
      count: 2,
      results: [
        { key: 'SalesOrder:a', href: `${PREFIX}/open/SalesOrder/${id(203)}`, theirs: 'PO-BA-883', ours: 'SO-2026-0043', subtitle: locale === 'it' ? 'In produzione' : 'In production', when: formatDate(at(-240), { locale }) },
        { key: 'SalesOrder:b', href: `${PREFIX}/open/SalesOrder/${id(208)}`, theirs: 'PO-BA-838', ours: 'SO-2026-0012', subtitle: locale === 'it' ? 'Consegnato' : 'Delivered', when: formatDate(at(-2000), { locale }) },
      ],
    },
    {
      group: 'documents',
      label: portal('search.group.documents'),
      count: 1,
      results: [{ key: 'StoredFile:c', href: `${PREFIX}/open/StoredFile/${id(401)}`, theirs: null, ours: 'DDT 2026/0144', subtitle: 'SH-2026-0012', when: formatDate(at(-11), { locale }) }],
    },
  ]
}

// ── the Approve pop-up ─────────────────────────────────────────────────────────────────────────────────────────────────
const PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><rect width="640" height="420" fill="#2b2b2b"/><path d="M200 90h240l60 80-40 30v170H180V200l-40-30z" fill="#7a1f3d"/><text x="320" y="400" fill="#ddd" font-family="sans-serif" font-size="20" text-anchor="middle">JKT-ESEMPIO-01</text></svg>')}`

function samplePage(locale: Locale, over: Partial<ApprovalRead> = {}): ApprovalRead {
  return {
    request: {
      id: SAMPLE_ID,
      kind: 'SAMPLE',
      label: 'JKT-ESEMPIO-01',
      question: locale === 'it' ? 'Approvate le cuciture e il colore del campione? Se va bene, partiamo con la produzione.' : 'Do you approve the stitching and the colour of the sample? If so, we start production.',
      from: { companyName: 'Pelletteria Esempio' },
      dueAt: at(52),
      status: 'OPEN',
      answer: null,
      version: 1,
    },
    content: { facts: [{ label: locale === 'it' ? 'Modello' : 'Style', value: 'JKT-ESEMPIO-01 Giacca demo' }], revisedOrder: null },
    files: [
      { id: id(801), originalName: 'campione-fronte.jpg', contentType: 'image/jpeg', sizeBytes: 420_000 },
      { id: id(802), originalName: 'scheda-campione.pdf', contentType: 'application/pdf', sizeBytes: 96_000 },
    ],
    may: { answer: true, withChanges: true },
    locale,
    ...over,
  }
}

function revisedPage(locale: Locale, priced = true): ApprovalRead {
  return {
    request: {
      id: REVISED_ID,
      kind: 'REVISED_ORDER',
      label: 'SO-2026-0042 · revision 2',
      question: locale === 'it' ? "Confermate l'ordine con le nuove quantità?" : 'Please confirm the order with the new quantities.',
      from: { companyName: 'Pelletteria Esempio' },
      dueAt: at(5),
      status: 'OPEN',
      answer: null,
      version: 2,
    },
    content: {
      facts: [],
      revisedOrder: {
        orderNumber: 'SO-2026-0042',
        revision: 2,
        currency: 'EUR',
        header: [{ field: 'requestedDate', before: dayAt(20), after: dayAt(27) }],
        lines: [
          { change: 'CHANGED', lineId: id(901), seq: 1, style: { code: 'JKT-ESEMPIO-01', name: 'Giacca demo' }, colour: { code: 'NER', name: 'Nero' }, piecesBefore: 40, piecesAfter: 50, sizes: [{ size: 'M', before: 15, after: 20 }, { size: 'L', before: 10, after: 15 }, { size: 'S', before: 15, after: 15 }] },
          { change: 'ADDED', lineId: id(902), seq: 3, style: { code: 'PNT-ESEMPIO-02', name: 'Pantalone demo' }, colour: { code: 'NER', name: 'Nero' }, piecesBefore: 0, piecesAfter: 12, sizes: [{ size: 'M', before: 0, after: 12 }] },
        ],
        ...(priced
          ? {
              prices: [
                { lineId: id(901), unitPrice: { before: '189.0000', after: '189.0000' }, netBefore: 756_000, netAfter: 945_000 },
                { lineId: id(902), unitPrice: { before: null, after: '149.0000' }, netBefore: 0, netAfter: 178_800 },
              ],
              netAmountBefore: 756_000,
              netAmountAfter: 1_123_800,
              grossAmountBefore: 922_320,
              grossAmountAfter: 1_371_036,
            }
          : {}),
      },
    },
    files: [],
    may: { answer: true, withChanges: false },
    locale,
  }
}

function approveDialog(locale: Locale, over: Partial<ApproveDialogModel> = {}): ApproveDialogModel {
  return { requestId: SAMPLE_ID, state: 'ready', page: samplePage(locale), position: { index: 2, count: 2 }, decision: null, comment: '', answer: 'idle', problem: null, field: null, held: null, file: null, now: NOW, ...over }
}

// ── the Document pop-up ────────────────────────────────────────────────────────────────────────────────────────────────
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
const PDF = samplePdf('Dichiarazione di conformita - esempio')

function documentDialog(locale: Locale, over: Partial<DocumentPreviewModel> = {}): DocumentPreviewModel {
  return {
    row: previewRowOf(DOCUMENTS.items[0]!, locale),
    state: 'ready',
    src: PDF,
    pdf: true,
    versions: versionLines([
      { id: id(401), version: 3, date: at(-11), current: true },
      { id: id(411), version: 2, date: at(-24 * 40), current: false },
      { id: id(412), version: 1, date: at(-24 * 120), current: false },
    ]),
    withdrawn: null,
    position: { index: 1, count: 2 },
    downloading: false,
    problem: null,
    held: null,
    ...over,
  }
}

// ── the cases ──────────────────────────────────────────────────────────────────────────────────────────────────────────
interface CaseInput {
  can?: (permission: string) => boolean
  built?: BuiltPages
  shell?: Partial<PortalShellViewModel>
  home?: Partial<CustomerHomeViewModel>
  tasks?: TasksViewModel
  statement?: boolean
}

function homeModel(locale: Locale, can: (permission: string) => boolean, built: BuiltPages, over: Partial<CustomerHomeViewModel> = {}): CustomerHomeViewModel {
  const day = dayWriter(locale)
  const counts = orderCounts(ORDERS)
  const defs = tilesFor(built, can)
  return {
    prefix: PREFIX,
    search: can('portal.search') ? { query: '', state: 'idle', groups: [], found: 0, capped: false, recent: [] } : null,
    welcome: null,
    tiles: defs.some((def) => can(def.permission)) ? { state: 'ready', items: tilesOf(defs, HOME, can, { openItems: OPEN_ITEMS, format: moneyWriter(locale) }) } : null,
    orders: can('portal.salesOrders.view') ? { state: 'ready', items: nextOrderRows(ORDERS, locale, PREFIX, day), open: counts.open, seeAllHref: built.orders ? `${PREFIX}/orders` : null, newOrderHref: null, why: {} } : null,
    documents: can('portal.customerDocuments.view') ? { state: 'ready', items: documentRows(can('portal.payments.view') ? DOCUMENTS : { ...DOCUMENTS, items: DOCUMENTS.items.slice(0, 2) }, locale), seeAllHref: built.documents ? `${PREFIX}/documents` : null, busy: null, problem: null, held: null } : null,
    messages: can('threads.read') ? { state: 'ready', items: conversations(locale).map((conversation) => ({ ...conversation, href: `${PREFIX}/open/${conversation.record.type}/${conversation.record.id}#messages` })) } : null,
    slow: false,
    approve: null,
    document: null,
    ...over,
  }
}

function homeCase(build: (locale: Locale) => CaseInput = () => ({})): HomeCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const input = build(locale)
    const can = input.can ?? BUYER
    const built = input.built ?? TODAY_BUILT
    return {
      shell: shell(locale, { band: homeBandOf({ t, asOf: formatTime(HOME.asOf, { locale }), statement: input.statement ? '/api/portal/payments/statement/pdf?language=it' : null, emailSettings: !(input.shell?.preview ?? false), ordersKey: built.orders }), ...input.shell }, can),
      home: homeModel(locale, can, built, input.home),
      tasks: input.tasks ?? tasksOf(locale),
      verbs: { APPROVE: t('verb.APPROVE'), RECONFIRM_ORDER: t('verb.RECONFIRM_ORDER') },
    }
  }
}

const loadingSections = (slow: boolean): Partial<CustomerHomeViewModel> => ({
  tiles: { state: 'loading', items: tilesOf(tilesFor(TODAY_BUILT, BUYER), null, BUYER) },
  orders: { state: 'loading', items: [], open: null, seeAllHref: null, newOrderHref: null, why: {} },
  documents: { state: 'loading', items: [], seeAllHref: null, busy: null, problem: null, held: null },
  messages: { state: 'loading', items: [] },
  slow,
})

export const designScreen = defineDesignScreen<HomeCaseBuilder>({
  screen: 'SCR-183',
  title: 'Customer Home (portal.customer.home)',
  view: HomeCase,
  cases: [
    {
      id: 'buyer',
      label: 'A buyer’s Home today',
      model: homeCase(),
      note: 'Find anything first; What waits for you with Review / Approve opening the pop-up (the record a link for ⌘-click); five numbers (the lists are not built yet: counts without a link; no Invoices tile for a buyer); the next five deliveries with the compact steps, the promise, a moved date (its popover reads why) and the % where the account shares it; new documents with Preview and Download; our last three messages with Reply.',
    },
    { id: 'linked', label: 'As it will be: every tile a link', model: homeCase(() => ({ built: ALL_BUILT })), note: 'Once Orders, Documents and Returns are built, each tile opens its list with the matching chip, and "See all 7 open orders" / "See all documents" appear.' },
    { id: 'finance', label: 'Finance: invoices and the statement', model: homeCase((locale) => ({ can: FINANCE, statement: true, tasks: tasksOf(locale, [PAY, ...TASKS.slice(2)]) })), note: 'The Invoices tile with its count, the open amount and the overdue count (price grain); ⋯ Download statement of account opens the PDF in a new tab; Pay on the invoice’s row opens its record.' },
    { id: 'designer', label: 'A designer (no orders, documents or prices)', model: homeCase((locale) => ({ can: DESIGNER, tasks: tasksOf(locale, [TASKS[1]!]) })), note: 'Sections the role cannot open are not drawn (fails closed); what waits and our messages remain.' },
    {
      id: 'search',
      label: 'Find anything: several matches',
      model: homeCase((locale) => ({ home: { search: { query: 'PO-BA-8', state: 'ready', groups: SEARCH_GROUPS(locale), found: 3, capped: false, recent: [] } } })),
      note: 'Grouped as the portal shows them, their reference first with the typed words marked; Enter on one match opens it directly; ↓ moves into the results; ⌘-click opens a new tab.',
    },
    { id: 'search-recent', label: 'Find anything: recent searches', model: homeCase(() => ({ home: { search: { query: '', state: 'idle', groups: [], found: 0, capped: false, recent: ['PO-BA-883', 'JKT-ESEMPIO', 'SO-2026-0041'] } } })), note: 'Kept on this device only, with Clear.' },
    { id: 'search-none', label: 'Find anything: nothing found', model: homeCase(() => ({ home: { search: { query: 'ZZ-0000', state: 'ready', groups: [], found: 0, capped: false, recent: [] } } })) },
    { id: 'search-error', label: 'Find anything: search not answering', model: homeCase(() => ({ home: { search: { query: 'PO-BA', state: 'error', groups: [], found: 0, capped: false, recent: [] } } })) },
    { id: 'loading', label: 'Loading', model: homeCase((locale) => ({ home: loadingSections(false), tasks: tasksOf(locale, [], 'loading') })) },
    { id: 'loading-slow', label: 'Still loading after a second', model: homeCase((locale) => ({ home: loadingSections(true), tasks: tasksOf(locale, [], 'loading') })) },
    {
      id: 'error',
      label: 'Nothing could be read',
      model: homeCase((locale) => ({
        home: {
          tiles: { state: 'error', items: [] },
          orders: { state: 'error', items: [], open: null, seeAllHref: null, newOrderHref: null, why: {} },
          documents: { state: 'error', items: [], seeAllHref: null, busy: null, problem: null, held: null },
          messages: { state: 'error', items: [] },
        },
        tasks: tasksOf(locale, [], 'error'),
      })),
      note: 'Each section says its problem in our words with Try again; a failed read is never drawn as an empty list.',
    },
    {
      id: 'empty',
      label: 'Nothing new (an existing customer)',
      model: homeCase((locale) => ({
        home: {
          orders: { state: 'ready', items: nextOrderRows(NO_ORDERS, locale, PREFIX, dayWriter(locale)), open: 0, seeAllHref: null, newOrderHref: null, why: {} },
          documents: { state: 'ready', items: [], seeAllHref: null, busy: null, problem: null, held: null },
          messages: { state: 'ready', items: [] },
        },
        tasks: tasksOf(locale, []),
      })),
    },
    {
      id: 'welcome',
      label: 'First visit: a buyer',
      model: homeCase(() => ({ home: { welcome: { name: 'Anna', company: 'Pelletteria Esempio', buyer: true, newOrderHref: null, catalogueHref: null, admins: ['Paolo Esempio'] }, messages: { state: 'ready', items: [] } }, tasks: tasksOf('it', []) })),
      note: 'No order, nothing waits, no new document: a clear first step, not empty panels. While ordering in the portal is not built, the step is Ask us a question (the account’s conversation).',
    },
    {
      id: 'welcome-other',
      label: 'First visit: another role',
      model: homeCase(() => ({ can: DESIGNER, home: { welcome: { name: 'Sara', company: 'Pelletteria Esempio', buyer: false, newOrderHref: null, catalogueHref: null, admins: ['Paolo Esempio'] }, messages: { state: 'ready', items: [] } }, tasks: tasksOf('it', []) })),
    },
    { id: 'approve', label: 'Pop-up: Approve a sample', model: homeCase((locale) => ({ home: { approve: approveDialog(locale) } })), note: 'What we ask with the countdown, the facts in your language, the files (opened here), Approve · Approve with changes · Refuse, the comment, the typed name signs (Enter). J / K: the next waiting approval.' },
    { id: 'approve-photo', label: 'Pop-up: a photo open', model: homeCase((locale) => ({ home: { approve: approveDialog(locale, { file: { id: id(801), name: 'campione-fronte.jpg', state: 'ready', src: PICTURE, pdf: false }, decision: 'APPROVED_WITH_CHANGES', comment: locale === 'it' ? 'Cuciture del colletto più strette.' : 'Tighter stitching on the collar.' }) } })) },
    { id: 'approve-revised', label: 'Pop-up: Review a revised order', model: homeCase((locale) => ({ home: { approve: approveDialog(locale, { requestId: REVISED_ID, page: revisedPage(locale), position: { index: 1, count: 2 } }) } })), note: 'Line by line old → new, the sizes that moved, prices and totals old → new with the price grain, and what a changed value means.' },
    { id: 'approve-revised-noprices', label: 'Pop-up: a revised order without prices', model: homeCase((locale) => ({ home: { approve: approveDialog(locale, { requestId: REVISED_ID, page: revisedPage(locale, false), position: null }) } })) },
    { id: 'approve-check', label: 'Pop-up: refuse without words', model: homeCase((locale) => ({ home: { approve: approveDialog(locale, { decision: 'REFUSED', problem: 'approve.problem.why', field: 'comment' }) } })) },
    { id: 'approve-held', label: 'Pop-up: may not approve', model: homeCase((locale) => ({ home: { approve: approveDialog(locale, { held: words(locale)('held.mayApproveAsk', { admins: 'Paolo Esempio' }) }) } })), note: 'Readable; the choices and the signature held with the reason and whom to ask.' },
    { id: 'approve-sending', label: 'Pop-up: sending', model: homeCase((locale) => ({ home: { approve: approveDialog(locale, { decision: 'APPROVED', answer: 'busy', held: words(locale)('held.busy') }) } })) },
    {
      id: 'approve-done',
      label: 'Pop-up: answered',
      model: homeCase((locale) => ({
        home: { approve: approveDialog(locale, { answer: 'done', page: samplePage(locale, { request: { ...samplePage(locale).request, status: 'APPROVED', answer: { at: at(0), typedName: 'Anna Esempio', words: null } }, receipt: 'SENT' }) }) },
        tasks: tasksOf(locale, TASKS.filter((task) => task.kind !== 'APPROVE')),
      })),
      note: 'The end in our words with the signed facts; the row leaves What waits for you; Next waiting approval.',
    },
    { id: 'approve-loading', label: 'Pop-up: reading', model: homeCase((locale) => ({ home: { approve: approveDialog(locale, { state: 'loading', page: null }) } })) },
    { id: 'approve-error', label: 'Pop-up: could not be read', model: homeCase((locale) => ({ home: { approve: approveDialog(locale, { state: 'error', page: null }) } })) },
    { id: 'approve-gone', label: 'Pop-up: no longer waits', model: homeCase((locale) => ({ home: { approve: approveDialog(locale, { state: 'gone', page: null, position: null }) } })) },
    { id: 'document', label: 'Pop-up: a document with its versions', model: homeCase((locale) => ({ home: { document: documentDialog(locale) } })), note: 'The PDF in the viewer (PageUp / PageDown), Download (logged), the versions; J / K: the next new document.' },
    { id: 'document-loading', label: 'Pop-up: opening a document', model: homeCase((locale) => ({ home: { document: documentDialog(locale, { state: 'loading', src: null }) } })) },
    { id: 'document-error', label: 'Pop-up: a document that could not be opened', model: homeCase((locale) => ({ home: { document: documentDialog(locale, { state: 'error', src: null, versions: [] }) } })) },
    {
      id: 'preview',
      label: 'An office preview',
      model: homeCase((locale) => ({
        shell: { preview: true, notice: noticesOf({ preview: { viewer: 'Marta Verdi', company: 'Pelletteria Esempio', party: 'Brand Alpha S.r.l.' } })[0] ?? null },
        tasks: tasksOf(locale, TASKS, 'ready', words(locale, 'portal')('preview.held')),
        home: { documents: { state: 'ready', items: documentRows({ ...DOCUMENTS, items: DOCUMENTS.items.slice(0, 2) }, locale), seeAllHref: null, busy: null, problem: null, held: words(locale)('held.preview') } },
      })),
      note: 'Read only: every verb, Preview and Download held with the reason; no E-mail settings in ⋯.',
    },
    {
      id: 'offline',
      label: 'Offline',
      model: homeCase((locale) => ({
        shell: { live: 'offline', notice: noticesOf({ offlineSince: formatTime(at(-1), { locale }) })[0] ?? null },
        home: { documents: { state: 'ready', items: documentRows({ ...DOCUMENTS, items: DOCUMENTS.items.slice(0, 2) }, locale), seeAllHref: null, busy: null, problem: null, held: words(locale)('held.offline') } },
      })),
      note: 'What was loaded stays; actions that send are held with "No connection".',
    },
  ],
})
