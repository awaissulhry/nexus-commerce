import { KIND_RULES, taskWords, type PartnerTaskKind } from '@nexus/factory-domain/portal/tasks/kinds'
import type { PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { badgesOf } from '../../shell/model'
import { portalNavFor } from '../../shell/nav/portal-nav'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { TasksViewModel } from '../../shell/view/TasksView'
import type { ThreadViewModel } from '../../shell/view/ThreadView'
import type { Conversation, HomeRead, ShippableRead } from '../home/api'
import type { NoticeRow, OrderLine, OrderPage, OrderRow, OrdersRead } from './api'
import { NS } from './model'

/**
 * SCR-189's made-up world (B-W2b-179; PLAN §3.1): an invented buying company (Officina Demo, its buyer Paola Esempio) and an
 * invented tannery (Conceria Prova S.p.A., its person Luca Prova), purchase orders PO-2026-0101… with leather by the ft², a
 * lining by the metre and protectors by the piece. Never a real company, person or number; never a price.
 */

const HOUR = 3_600_000
// One clock for the server render and the first client render.
export const NOW = Math.floor(Date.now() / HOUR) * HOUR
export const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
export const dayAt = (days: number) => at(days * 24).slice(0, 10)
export const TODAY = dayAt(0)
export const PREFIX = '/p/CONCERIA-PROVA'
export const words = (locale: Locale, namespace = NS) => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})

const id = (n: number) => `0190f0e2-7777-7000-8000-${String(n).padStart(12, '0')}`
export const PO_ID = id(1)

const LEGAL = {
  it: { name: 'Officina Demo S.r.l.', lines: ['Sede legale: Via Fittizia 22, 20900 Monza (MB)', 'P. IVA IT00000000000 · C.F. 00000000000'] },
  en: { name: 'Officina Demo S.r.l.', lines: ['Registered office: Via Fittizia 22, 20900 Monza (MB)', 'VAT IT00000000000 · Tax code 00000000000'] },
} as const

const CAN = (permission: string) => permission.startsWith('portal.') || permission === 'threads.read' || permission === 'files.read'

export function shellOf(locale: Locale, over: Partial<PortalShellViewModel> = {}): PortalShellViewModel {
  return {
    brand: null,
    companyName: 'Officina Demo',
    partyName: 'Conceria Prova S.p.A.',
    person: { displayName: 'Luca Prova', email: 'luca@conceria-prova.example' },
    nav: portalNavFor({ can: CAN, kinds: ['SUPPLIER'] }),
    path: '/',
    prefix: PREFIX,
    badges: badgesOf([{ area: 'orders', count: 2, words: { it: '2 da confermare', en: '2 to confirm' } }], locale),
    bell: { unread: 1, complete: true },
    notice: null,
    band: null,
    live: 'live',
    legal: LEGAL[locale],
    privacyHref: '/privacy/00000000-0000-7000-8000-000000000001',
    termsHref: `${PREFIX}/terms`,
    freeForSuppliers: true,
    preview: false,
    canSearch: true,
    ...over,
  }
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const STATE_WORDS = {
  TO_CONFIRM: { it: 'Da confermare', en: 'To confirm' },
  CONFIRMED: { it: 'Confermato', en: 'Confirmed' },
  CHANGE_PROPOSED: { it: 'Modifica proposta', en: 'Change proposed' },
  PARTLY_DELIVERED: { it: 'Consegnato in parte', en: 'Partly delivered' },
  DELIVERED: { it: 'Consegnato', en: 'Delivered' },
  BEING_CHANGED: { it: 'In modifica da parte nostra', en: 'Being changed by us' },
} as const

const row = (n: number, state: keyof typeof STATE_WORDS, over: Partial<OrderRow> = {}): OrderRow => ({
  id: id(n),
  number: `PO-2026-01${String(n).padStart(2, '0')}`,
  documentNumber: `PO-2026-01${String(n).padStart(2, '0')}`,
  revision: 1,
  status: state === 'TO_CONFIRM' ? 'SENT' : state === 'CHANGE_PROPOSED' ? 'CHANGES_PROPOSED' : state === 'PARTLY_DELIVERED' ? 'PARTLY_RECEIVED' : state === 'DELIVERED' ? 'RECEIVED' : state === 'BEING_CHANGED' ? 'DRAFT' : 'CONFIRMED',
  state,
  words: STATE_WORDS[state],
  supplierRef: state === 'TO_CONFIRM' ? null : `CP-OC-${400 + n}`,
  sentAt: at(-24 * (n + 1)),
  orderDate: dayAt(-(n + 1)),
  lines: 1 + (n % 3),
  earliestNeedDate: dayAt(6 + n),
  nextExpected: state === 'TO_CONFIRM' ? null : dayAt(5 + n),
  late: false,
  confirmBy: state === 'TO_CONFIRM' ? at(24 * (2 + n)) : null,
  canAnswer: state === 'TO_CONFIRM',
  version: 3,
  ...over,
})

export const ROWS: readonly OrderRow[] = [
  row(1, 'TO_CONFIRM', { revision: 2, documentNumber: 'PO-2026-0101 rev. 2', lines: 3 }),
  row(2, 'TO_CONFIRM'),
  row(3, 'CONFIRMED', { late: true, nextExpected: dayAt(-2) }),
  row(4, 'CHANGE_PROPOSED'),
  row(5, 'PARTLY_DELIVERED'),
  row(6, 'DELIVERED', { nextExpected: null }),
  row(7, 'BEING_CHANGED', { revision: 1 }),
]

export function ordersRead(chip: OrdersRead['chip'] = 'TO_CONFIRM', items: readonly OrderRow[] = ROWS.filter((entry) => entry.state === 'TO_CONFIRM')): OrdersRead {
  const count = (state: string) => ROWS.filter((entry) => entry.state === state).length
  return {
    asOf: at(0),
    chip,
    chips: [
      { chip: 'TO_CONFIRM', count: count('TO_CONFIRM'), words: STATE_WORDS.TO_CONFIRM },
      { chip: 'CONFIRMED', count: count('CONFIRMED'), words: STATE_WORDS.CONFIRMED },
      { chip: 'CHANGE_PROPOSED', count: count('CHANGE_PROPOSED'), words: STATE_WORDS.CHANGE_PROPOSED },
      { chip: 'PARTLY_DELIVERED', count: count('PARTLY_DELIVERED'), words: STATE_WORDS.PARTLY_DELIVERED },
      { chip: 'DELIVERED', count: count('DELIVERED'), words: STATE_WORDS.DELIVERED },
      { chip: 'CLOSED', count: 0, words: { it: 'Chiusi', en: 'Closed' } },
      { chip: 'ALL', count: ROWS.length, words: { it: 'Tutti', en: 'All' } },
    ],
    counts: { toConfirm: count('TO_CONFIRM'), late: 1 },
    items: [...items],
    complete: true,
    live: { events: ['partner_task.opened', 'partner_task.closed', 'partner_task.reopened'] },
  }
}

// ── one order ────────────────────────────────────────────────────────────────────────────────────────────────────────
const line = (over: Partial<OrderLine> & Pick<OrderLine, 'id' | 'seq'>): OrderLine => ({
  code: null,
  name: null,
  colour: null,
  description: null,
  quantity: '1.0000',
  uom: 'PCS',
  baseQuantity: '1.0000',
  baseUom: 'PCS',
  needDate: dayAt(14),
  grade: null,
  thicknessMinMm: null,
  thicknessMaxMm: null,
  oneDyeBatch: false,
  areaTolerancePct: null,
  estimatedHides: null,
  requiresCrViTest: false,
  note: null,
  confirmedQuantity: null,
  confirmedDate: null,
  receivedBase: '0.0000',
  ended: null,
  locked: false,
  proposal: null,
  version: 1,
  ...over,
})

export const LINES: readonly OrderLine[] = [
  line({ id: id(10), seq: 10, code: 'VACH-NAPPA-12', name: 'Vacchetta nappa demo', colour: { name: 'Nero', supplierCode: 'N01' }, quantity: '1200.0000', uom: 'FT2', baseQuantity: '111.4836', baseUom: 'M2', needDate: dayAt(14), grade: 'A', thicknessMinMm: '1.20', thicknessMaxMm: '1.40', oneDyeBatch: true, areaTolerancePct: '5.00', estimatedHides: 48, requiresCrViTest: true }),
  line({ id: id(20), seq: 20, code: 'FOD-MESH-02', name: 'Fodera mesh demo', colour: { name: 'Grigio', supplierCode: null }, quantity: '350.0000', uom: 'M', baseQuantity: '350.0000', baseUom: 'M', needDate: dayAt(10), note: 'Rotoli da 50 m' }),
  line({ id: id(30), seq: 30, code: 'PROT-CE-L1', name: 'Protezione spalla demo (EN 1621-1)', quantity: '120.0000', uom: 'PCS', baseQuantity: '120.0000', baseUom: 'PCS', needDate: dayAt(21) }),
]

export function orderPage(over: Omit<Partial<OrderPage>, 'order' | 'answer'> & { order?: Partial<OrderPage['order']>; answer?: Partial<OrderPage['answer']> } = {}): OrderPage {
  const { order, answer, ...rest } = over
  return {
    from: { legalName: 'Officina Demo S.r.l.', tradeName: 'Officina Demo', buyerName: 'Paola Esempio' },
    deliverTo: { name: 'Officina Demo — Stabilimento A', line1: 'Via Fittizia 22', line2: null, postalCode: '20900', city: 'Monza', province: 'MB', country: 'IT' },
    lines: [...LINES],
    proposal: null,
    changes: null,
    history: [{ revision: 1, documentNumber: 'PO-2026-0101', sentAt: at(-48), answer: 'WAITING', confirmation: null, decline: null, proposal: null }],
    copy: { href: `/portal/purchase-orders/${PO_ID}/copy` },
    live: { events: ['partner_task.opened', 'partner_task.closed', 'partner_task.reopened'] },
    ...rest,
    order: {
      id: PO_ID,
      number: 'PO-2026-0101',
      documentNumber: 'PO-2026-0101',
      revision: 1,
      status: 'SENT',
      state: 'TO_CONFIRM',
      words: STATE_WORDS.TO_CONFIRM,
      orderDate: dayAt(-2),
      requestedDate: dayAt(14),
      incoterms: 'DAP Monza',
      paymentTerms: null,
      note: 'Per favore indicate il numero di bagno su ogni lotto.',
      sentAt: at(-48),
      confirmBy: at(48),
      confirmedAt: null,
      confirmedByName: null,
      supplierRef: null,
      confirmNote: null,
      declinedAt: null,
      declineReason: null,
      cancelledAt: null,
      version: 4,
      ...order,
    },
    answer: {
      canAnswer: true,
      message: null,
      mayAnswer: true,
      lineAnswers: ['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT_DELIVER', 'SUBSTITUTE', 'CHANGE'],
      declineReasons: ['NO_CAPACITY', 'MATERIAL_NOT_AVAILABLE', 'PRICE', 'OTHER'],
      substitutes: { [id(30)]: [{ itemId: id(31), code: 'PROT-CE-L2', name: 'Protezione spalla demo livello 2' }] },
      ...answer,
    },
  }
}

/** Version 2 of the order: line 10's quantity and line 20's date changed (what the supplier reads on the Lines tab). */
export function revisedPage(): OrderPage {
  return orderPage({
    order: { revision: 2, documentNumber: 'PO-2026-0101 rev. 2' },
    lines: [{ ...LINES[0]!, quantity: '1400.0000' }, { ...LINES[1]!, needDate: dayAt(12) }, LINES[2]!],
    changes: {
      revision: 2,
      documentNumber: 'PO-2026-0101 rev. 2',
      sentAt: at(-6),
      changeNote: 'Il cliente ha aumentato le quantità della collezione.',
      words: ['Riga 10 VACH-NAPPA-12: quantità 1.200 ft² → 1.400 ft²', 'Riga 20 FOD-MESH-02: serve il 08/11 → 10/11'],
      lines: [
        { lineId: id(10), seq: 10, kind: 'CHANGED', changes: [{ field: 'quantity', before: '1200.0000 FT2', after: '1400.0000 FT2' }] },
        { lineId: id(20), seq: 20, kind: 'CHANGED', changes: [{ field: 'needDate', before: dayAt(10), after: dayAt(12) }] },
      ],
      header: [],
    },
    history: [
      { revision: 1, documentNumber: 'PO-2026-0101', sentAt: at(-72), answer: 'CONFIRMED', confirmation: { at: at(-60), byName: 'Luca Prova', supplierRef: 'CP-OC-401' }, decline: null, proposal: null },
      { revision: 2, documentNumber: 'PO-2026-0101 rev. 2', sentAt: at(-6), answer: 'WAITING', confirmation: null, decline: null, proposal: null },
    ],
  })
}

/** The order after the supplier proposed changes (read-only: the buyer decides). */
export function proposedPage(decision: 'ACCEPTED' | 'REFUSED' | null = null): OrderPage {
  return orderPage({
    order: { status: 'CHANGES_PROPOSED', state: 'CHANGE_PROPOSED', words: STATE_WORDS.CHANGE_PROPOSED, confirmBy: null },
    answer: { canAnswer: false, message: 'Your changes are with the buyer.', substitutes: {} },
    lines: [
      { ...LINES[0]!, confirmedQuantity: '1200.0000', confirmedDate: dayAt(14), locked: true },
      { ...LINES[1]!, proposal: { kind: 'OTHER', quantity: '350.0000', date: dayAt(17), deliveries: [{ quantity: '350.0000', date: dayAt(17) }], reason: 'Il colore Grigio arriva dal fornitore la settimana prossima.', changes: ['LATER'], substitute: null, needsBuyer: true } },
      { ...LINES[2]!, proposal: { kind: 'SUBSTITUTE', quantity: '120.0000', date: null, deliveries: [{ quantity: '120.0000', date: dayAt(21) }], reason: null, changes: ['SUBSTITUTE'], substitute: { itemId: id(31), code: 'PROT-CE-L2', name: 'Protezione spalla demo livello 2', note: null }, needsBuyer: true } },
    ],
    proposal: { at: at(-3), byName: 'Luca Prova', supplierRef: 'CP-OC-401', note: null, summary: '1 line as asked · 1 later date · 1 substitute', decision, decidedAt: decision ? at(-1) : null },
    history: [{ revision: 1, documentNumber: 'PO-2026-0101', sentAt: at(-48), answer: 'CHANGES_PROPOSED', confirmation: null, decline: null, proposal: { at: at(-3), byName: 'Luca Prova', supplierRef: 'CP-OC-401', note: null, decision } }],
  })
}

/** A confirmed order: the lines locked, part of line 10 received, a ship notice on its way. */
export function confirmedPage(): OrderPage {
  return orderPage({
    order: { status: 'CONFIRMED', state: 'CONFIRMED', words: STATE_WORDS.CONFIRMED, confirmBy: null, confirmedAt: at(-30), confirmedByName: 'Luca Prova', supplierRef: 'CP-OC-401' },
    answer: { canAnswer: false, message: 'This order is confirmed.', substitutes: {} },
    lines: LINES.map((entry, index) => ({ ...entry, confirmedQuantity: entry.quantity, confirmedDate: entry.needDate, locked: true, receivedBase: index === 0 ? '40.0000' : '0.0000' })),
    history: [{ revision: 1, documentNumber: 'PO-2026-0101', sentAt: at(-48), answer: 'CONFIRMED', confirmation: { at: at(-30), byName: 'Luca Prova', supplierRef: 'CP-OC-401' }, decline: null, proposal: null }],
  })
}

export const NOTICES: readonly NoticeRow[] = [
  {
    id: id(90),
    number: 'ASN-2026-0042',
    status: 'SENT',
    state: 'IN_TRANSIT',
    words: { it: 'In viaggio', en: 'On its way' },
    purchaseOrder: { id: PO_ID, number: 'PO-2026-0101' },
    shipDate: dayAt(-1),
    expectedDate: dayAt(1),
    carrier: 'Corriere Demo',
    trackingNumber: 'CD000123',
    ddtNumber: '118/2026',
    supplierRef: null,
    parcels: 3,
    sentAt: at(-26),
    lines: 1,
    hides: 24,
    differing: 0,
    version: 2,
  },
]

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export function threadOf(locale: Locale): ThreadViewModel {
  const portal = words(locale, 'portal')
  const messages: PartnerMessage[] = [
    {
      id: 'm1',
      side: 'company',
      channel: 'email',
      author: { name: 'Paola Esempio', mine: false },
      body: locale === 'it' ? 'Buongiorno, vi abbiamo mandato PO-2026-0101. Il bagno di tintura deve essere uno solo per tutta la riga 10.' : 'Good morning, we sent you PO-2026-0101. Line 10 must come from one dye batch.',
      attachments: [],
      at: at(-47),
      atText: formatDateTime(at(-47), { locale }),
    },
    {
      id: 'm2',
      side: 'partner',
      channel: 'portal',
      author: { name: 'Luca Prova', mine: true },
      body: locale === 'it' ? 'Ricevuto. La fodera grigia arriva la settimana prossima: vi proponiamo una data.' : 'Received. The grey lining arrives next week: we propose a date.',
      at: at(-5),
      atText: formatDateTime(at(-5), { locale }),
    },
  ]
  return { state: 'ready', record: null, companyName: 'Officina Demo', messages, composer: { value: '', busy: false, heldReason: null, hint: portal('thread.hint'), limit: 20_000 }, loadMore: null, accessLine: null, failed: null }
}

// ── Home ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
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

export const SUPPLIER_TASKS: readonly FixtureTask[] = [
  { id: 's1', kind: 'CONFIRM_PO', record: 'PO-2026-0101 rev. 2', recordType: 'PurchaseOrder', recordId: id(1), due: 'today', dueIn: 5, askedBy: null, inline: false },
  { id: 's2', kind: 'CONFIRM_PO', record: 'PO-2026-0102', recordType: 'PurchaseOrder', recordId: id(2), due: 'later', dueIn: 24 * 3, askedBy: null, inline: false },
  { id: 's3', kind: 'UPLOAD_DOCUMENT', record: 'Rapporto Cr VI bagno 2231', recordType: 'PurchaseOrder', recordId: id(3), due: 'soon', dueIn: 30, askedBy: 'Paola Esempio', inline: true },
  { id: 's4', kind: 'ANSWER_MESSAGE', record: 'PO-2026-0104', recordType: 'PurchaseOrder', recordId: id(4), due: 'later', dueIn: 24 * 5, askedBy: 'Paola Esempio', inline: false },
]

export function tasksOf(locale: Locale, list: readonly FixtureTask[] = SUPPLIER_TASKS, state: TasksViewModel['state'] = 'ready', held: string | null = null): TasksViewModel {
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

export const HOME: HomeRead = {
  asOf: at(0),
  kind: 'SUPPLIER',
  counts: [
    { key: 'purchase_orders.to_confirm', area: 'orders', words: { it: 'Ordini da confermare', en: 'Orders to confirm' }, value: 2 },
    { key: 'purchase_orders.late', area: 'orders', words: { it: 'Ordini in ritardo', en: 'Late orders' }, value: 1 },
    { key: 'deliveries.to_announce', area: 'deliveries', words: { it: 'Consegne da annunciare', en: 'Deliveries to announce' }, value: 3 },
    { key: 'deliveries.on_the_way', area: 'deliveries', words: { it: 'Consegne in arrivo', en: 'Deliveries on their way' }, value: 1 },
    { key: 'supplier_documents.expiring', area: 'documents', words: { it: 'Documenti in scadenza', en: 'Documents expiring' }, value: null },
    { key: 'jobs.to_accept', area: 'orders', words: { it: 'Lavorazioni da accettare', en: 'Jobs to accept' }, value: 1 },
    { key: 'jobs.kit_to_confirm', area: 'orders', words: { it: 'Kit da confermare', en: 'Kits to confirm' }, value: 0 },
    { key: 'jobs.ready_to_send_back', area: 'orders', words: { it: 'Pronti da rendere', en: 'Ready to send back' }, value: 2 },
    { key: 'jobs.late', area: 'orders', words: { it: 'Lavorazioni in ritardo', en: 'Late jobs' }, value: 0 },
  ],
  live: { events: ['partner_task.opened', 'partner_notification.created'] },
}

export const SHIPPABLE: ShippableRead = {
  mayWrite: true,
  orders: [
    {
      id: id(3),
      number: 'PO-2026-0103',
      documentNumber: 'PO-2026-0103',
      status: 'CONFIRMED',
      lines: [
        { purchaseOrderLineId: id(301), seq: 10, item: { code: 'VACH-NAPPA-12', name: 'Vacchetta nappa demo', leather: true }, supplierArticleCode: 'CP-NAPPA-N01', colour: 'Nero', uom: 'FT2', expected: '800.0000', received: '0.0000', inTransit: '0.0000', open: '800.0000', needDate: dayAt(-2), confirmedDate: dayAt(-2) },
        { purchaseOrderLineId: id(302), seq: 20, item: { code: 'FOD-MESH-02', name: 'Fodera mesh demo', leather: false }, supplierArticleCode: null, colour: 'Grigio', uom: 'M', expected: '200.0000', received: '0.0000', inTransit: '200.0000', open: '200.0000', needDate: dayAt(3), confirmedDate: dayAt(4) },
      ],
    },
    {
      id: id(5),
      number: 'PO-2026-0105',
      documentNumber: 'PO-2026-0105',
      status: 'PARTLY_RECEIVED',
      lines: [{ purchaseOrderLineId: id(501), seq: 10, item: { code: 'PROT-CE-L1', name: 'Protezione spalla demo (EN 1621-1)', leather: false }, supplierArticleCode: 'CP-PR-1', colour: null, uom: 'PCS', expected: '240.0000', received: '120.0000', inTransit: '0.0000', open: '120.0000', needDate: dayAt(9), confirmedDate: null }],
    },
  ],
}

export function conversations(locale: Locale): (Conversation & { href: string })[] {
  return [
    {
      record: { type: 'PurchaseOrder', id: id(1), theirRef: null, ourRef: 'PO-2026-0101', subtitle: null, status: 'SENT' },
      thread: { id: id(801), status: 'OPEN' },
      last: { id: id(811), side: 'COMPANY', channel: 'EMAIL', authorName: 'Paola Esempio', excerpt: locale === 'it' ? 'Il bagno di tintura deve essere uno solo per tutta la riga 10.' : 'Line 10 must come from one dye batch.', attachmentCount: 0, at: at(-3) },
      href: `${PREFIX}/orders/${id(1)}?tab=messages#messages`,
    },
    {
      record: { type: 'PurchaseOrder', id: id(3), theirRef: 'CP-OC-403', ourRef: 'PO-2026-0103', subtitle: null, status: 'CONFIRMED' },
      thread: { id: id(802), status: 'OPEN' },
      last: { id: id(812), side: 'COMPANY', channel: 'APP', authorName: 'Paola Esempio', excerpt: locale === 'it' ? 'Ci serve il rapporto Cr VI del bagno 2231 prima della consegna.' : 'We need the Cr VI report of batch 2231 before the delivery.', attachmentCount: 1, at: at(-27) },
      href: `${PREFIX}/orders/${id(3)}?tab=messages#messages`,
    },
  ]
}
