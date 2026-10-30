import { defineDesignScreen } from '../../../lib/design/design-screen'
import {
  invoiceSdiWords,
  invoiceToIssueWords,
  lotHoldWords,
  mailToSortWords,
  orderPromiseWords,
  phrase,
  poNotConfirmedWords,
  quoteApprovalWords,
  registerDutyWords,
  scanCorrectionWords,
  scanRefusalWords,
  styleComplianceWords,
  whyKey,
  workOrderHeldWords,
  type Phrase,
  type RowWords,
} from '@nexus/factory-domain/insights/words'
import { mentionWords, personalPhrase, taskDueWords } from '@nexus/factory-domain/insights/personal'
import { alertRowPhrase, alertWhyPhrase } from '@nexus/factory-domain/alerts/today'
import { W2A_TILES, type ComingUpView, DEFAULT_LAYOUT, type FlowLensView, type HandledView, type PanelView, type QueueData, type QueueItem, type QuoteReview, type TodayItem, type TodayLayout, type TodayViewModel } from './model'
import { TodayView } from './view/TodayView'

/**
 * SCR-029 Home › Today — made-up data only (PLAN §3.1): invented companies, customers, suppliers, numbers and amounts.
 * Each case is one state the Owner reviews: the role switch (Owner, Sales, Buyer, Inspector, Finance), the decide modal
 * on a quote approval and on other rows, a pressed tile, new rows waiting, a count that is a lower bound, nothing to do,
 * loading, an error, and a person without Today; the alert verbs (assigned and acknowledged rows, Assign to, Resolve
 * with a note, held while offline), Handled today and Arrange Today. Open a case alone for the keyboard: j / k move,
 * Enter opens, e acknowledges an alert, and in the modal a approves, r rejects, j / k step through.
 */

const NOW = Date.UTC(2026, 9, 29, 9, 42)
const AS_OF = new Date(NOW).toISOString()
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()
const id = (n: number) => `0190f0e2-7777-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = '0190f0e2-1111-7000-8000-000000000001'
const SITE = '0190f0e2-2222-7000-8000-000000000001'

function row(n: number, item: Omit<Partial<TodayItem>, 'sentence' | 'why' | 'blocks' | 'words'> & Pick<TodayItem, 'kind' | 'state' | 'severity' | 'group' | 'record'> & { said: RowWords; act: string }): QueueItem {
  const { said, act, ...rest } = item
  const why = phrase(whyKey(item.kind, act))
  const ref = (value: Phrase) => ({ key: value.key, params: value.params as Record<string, string | number | string[]> })
  const base: TodayItem = {
    key: `${item.kind}:${item.record.id}`,
    category: item.decide === 'REVIEW' ? 'APPROVAL' : 'ALERT',
    severityWord: '',
    companyId: COMPANY,
    siteId: null,
    partyId: null,
    sentence: said.sentence.text,
    why: why.text,
    blocks: said.blocks?.text ?? null,
    words: { sentence: ref(said.sentence), why: ref(why), blocks: said.blocks ? ref(said.blocks) : null },
    sentenceFigure: null,
    due: null,
    since: at(29 - (n % 9)),
    ageDays: n % 9,
    decide: 'OPEN',
    figures: null,
    condition: String(n).padStart(32, 'a'),
    actions: { version: 0, verbs: item.decide === 'REVIEW' ? [] : ['ASSIGN', 'RESOLVE', 'ACKNOWLEDGE'], assigned: null, acknowledged: null },
    ...rest,
  }
  const href = `/w/DEMO/records/${base.record.type}/${base.record.id}?label=${encodeURIComponent(base.record.label)}`
  return { ...base, href, reviewHref: base.kind === 'MAIL_TO_SORT' ? `/w/DEMO/home/mail-to-sort?open=${base.record.id}` : null }
}

const ROWS = {
  lateOrder: row(1, {
    kind: 'ORDER_PROMISE',
    state: 'LATE',
    severity: 'HIGH',
    group: 'NOW',
    record: { type: 'SalesOrder', id: id(1), label: 'SO-2026-0042' },
    said: orderPromiseWords({ number: 'SO-2026-0042', customer: 'Pista Demo S.r.l.', state: 'LATE', days: 2, promiseDate: '2026-10-27', toShip: 12 }),
    act: 'orders.manage',
    due: { date: '2026-10-27', days: -2, word: 'OVERDUE' },
    figures: { currency: 'EUR', netAmount: 504000 },
  }),
  heldWorkOrder: row(2, {
    kind: 'WORK_ORDER_HELD',
    state: 'HELD',
    severity: 'HIGH',
    group: 'NOW',
    siteId: SITE,
    record: { type: 'WorkOrder', id: id(2), label: 'WO-00098' },
    said: workOrderHeldWords({ number: 'WO-00098', style: 'DEMO-JKT-02', checks: ['DEPOSIT', 'MATERIAL'], orders: ['SO-2026-0042'] }),
    act: 'workorders.release',
    due: { date: '2026-10-30', days: 1, word: 'SOON' },
  }),
  sdiRejected: row(3, {
    kind: 'INVOICE_SDI',
    state: 'REJECTED',
    severity: 'HIGH',
    group: 'NOW',
    record: { type: 'Invoice', id: id(3), label: 'FT-2026-00031' },
    said: invoiceSdiWords({ number: 'FT-2026-00031', customer: 'Pista Demo S.r.l.', state: 'REJECTED', deadline: '2026-11-04' }),
    act: 'invoices.issue',
    due: { date: '2026-11-04', days: 6, word: 'SOON' },
    figures: { currency: 'EUR', netAmount: 248000 },
  }),
  blockedLot: row(4, {
    kind: 'LOT_HOLD',
    state: 'BLOCKED',
    severity: 'HIGH',
    group: 'NOW',
    siteId: SITE,
    record: { type: 'Lot', id: id(4), label: 'LOT-A-000214' },
    said: lotHoldWords({ code: 'LOT-A-000214', item: 'Demo black cowhide 1.2 mm', state: 'BLOCKED', crViFail: true }),
    act: 'quality.lots.release',
  }),
  quoteApproval: row(5, {
    kind: 'QUOTE_APPROVAL',
    state: 'PENDING',
    severity: 'MEDIUM',
    group: 'TODAY',
    decide: 'REVIEW',
    record: { type: 'Quote', id: id(5), label: 'Q-2026-0142' },
    said: quoteApprovalWords({ number: 'Q-2026-0142', customer: 'Moto Demo Club', reasons: ['MARGIN_FLOOR'] }),
    act: 'quotes.approve',
    figures: { currency: 'EUR', netAmount: 1240000, marginPct: '18.2', marginAmount: 225680 },
    sentenceFigure: 'marginPct',
  }),
  quarantineLot: row(6, {
    kind: 'LOT_HOLD',
    state: 'QUARANTINE',
    severity: 'MEDIUM',
    group: 'TODAY',
    siteId: SITE,
    record: { type: 'Lot', id: id(6), label: 'LOT-A-000219' },
    said: lotHoldWords({ code: 'LOT-A-000219', item: 'Demo mesh lining', state: 'QUARANTINE', crViFail: false }),
    act: 'quality.lots.release',
  }),
  mail: row(7, {
    kind: 'MAIL_TO_SORT',
    state: 'TRIAGE',
    severity: 'MEDIUM',
    group: 'TODAY',
    decide: 'REVIEW',
    record: { type: 'InboundEmail', id: id(7), label: 'Preventivo 200 giacche' },
    said: mailToSortWords({ sender: 'Giulia Esempio', subject: 'Preventivo 200 giacche', state: 'TRIAGE', heldReason: null }),
    act: 'email.triage',
  }),
  riskOrder: row(8, {
    kind: 'ORDER_PROMISE',
    state: 'AT_RISK',
    severity: 'MEDIUM',
    group: 'THIS_WEEK',
    record: { type: 'SalesOrder', id: id(8), label: 'SO-2026-0047' },
    said: orderPromiseWords({ number: 'SO-2026-0047', customer: 'Moto Demo Club', state: 'AT_RISK', days: 2, promiseDate: '2026-10-31', toShip: 4 }),
    act: 'orders.manage',
    due: { date: '2026-10-31', days: 2, word: 'SOON' },
    figures: { currency: 'EUR', netAmount: 168000 },
  }),
  poNotConfirmed: row(9, {
    kind: 'PO_NOT_CONFIRMED',
    state: 'SENT',
    severity: 'MEDIUM',
    group: 'THIS_WEEK',
    siteId: SITE,
    record: { type: 'PurchaseOrder', id: id(9), label: 'PO-2026-0031' },
    said: poNotConfirmedWords({ number: 'PO-2026-0031', supplier: 'Conceria Demo', hours: 74, requestedDate: '2026-11-05' }),
    act: 'purchasing.send',
    due: { date: '2026-11-05', days: 7, word: 'SOON' },
    figures: { currency: 'EUR', purchaseAmount: 482000 },
    sentenceFigure: 'purchaseAmount',
  }),
  scanCorrection: row(10, {
    kind: 'SCAN_CORRECTION',
    state: 'PENDING',
    severity: 'MEDIUM',
    group: 'TODAY',
    decide: 'REVIEW',
    siteId: SITE,
    record: { type: 'ScanCorrectionRequest', id: id(10), label: 'WO-00091' },
    said: scanCorrectionWords({ workOrder: 'WO-00091', operation: 'Sew and assemble the body', bundle: 'BN-000412' }),
    act: 'production.scan.correct',
  }),
  registerDuty: row(11, {
    kind: 'REGISTER_DUTY',
    state: 'ASSESSING',
    severity: 'MEDIUM',
    group: 'TODAY',
    record: { type: 'PpeRegisterEntry', id: id(11), label: 'REG-2026-004' },
    said: registerDutyWords({ reference: 'REG-2026-004', kind: 'COMPLAINT', style: 'DEMO-JKT-02', duties: ['RISK_ASSESSMENT', 'CORRECTIVE_ACTION'] }),
    act: 'compliance.register.manage',
  }),
  styleHeld: row(12, {
    kind: 'STYLE_COMPLIANCE',
    state: 'BLOCKED',
    severity: 'HIGH',
    group: 'NOW',
    record: { type: 'Style', id: id(12), label: 'DEMO-JKT-03' },
    said: styleComplianceWords({ style: 'DEMO-JKT-03', checks: ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'], steps: ['SHIPPING'], orders: 1, workOrders: 1 }),
    act: 'compliance.declarations.manage',
  }),
  toInvoice: row(13, {
    kind: 'INVOICE_TO_ISSUE',
    state: 'OPEN',
    severity: 'LOW',
    group: 'LATER',
    record: { type: 'Party', id: id(13), label: 'Pista Demo S.r.l.' },
    said: invoiceToIssueWords({ customer: 'Pista Demo S.r.l.', month: '2026-10', ddts: ['144/2026', '151/2026'], docType: 'TD24', dueBy: '2026-11-15', daysLeft: 17 }),
    act: 'invoices.manage',
    due: { date: '2026-11-15', days: 17, word: null },
  }),
  refusedScan: row(14, {
    kind: 'SCAN_REFUSAL',
    state: 'FINAL',
    severity: 'LOW',
    group: 'THIS_WEEK',
    siteId: SITE,
    record: { type: 'FloorScanRefusal', id: id(14), label: 'BN-000377' },
    said: scanRefusalWords({ device: 'Demo tablet cutting', message: 'This is not a bundle ticket of this site.', workOrder: null }),
    act: 'production.scan.correct',
  }),
} satisfies Record<string, QueueItem>

function queueOf(items: readonly QueueItem[], extra: Partial<QueueData> = {}): QueueData {
  const approvals = items.filter((item) => item.category === 'APPROVAL').length
  return {
    asOf: AS_OF,
    total: items.length,
    needYou: items.length,
    now: items.filter((item) => item.group === 'NOW').length,
    tiles: [
      { tile: 'ALL', count: items.length, complete: true },
      { tile: 'APPROVAL', count: approvals, complete: true },
      { tile: 'ALERT', count: items.length - approvals, complete: true },
    ],
    kindLabels: {},
    items,
    more: false,
    loadingMore: false,
    fresh: 0,
    handledToday: 0,
    ...extra,
  }
}

const OWNER_ITEMS = [ROWS.lateOrder, ROWS.heldWorkOrder, ROWS.sdiRejected, ROWS.blockedLot, ROWS.styleHeld, ROWS.quoteApproval, ROWS.quarantineLot, ROWS.mail, ROWS.scanCorrection, ROWS.registerDuty, ROWS.riskOrder, ROWS.poNotConfirmed, ROWS.refusedScan, ROWS.toInvoice]

const stage = (key: string, label: string, count: number, late: number | null, oldestDays: number | null, inexact = false) => ({ key, label, count, late, oldestDays, href: null, inexact })
const LENSES: Record<string, FlowLensView> = {
  ORDERS: {
    lens: 'ORDERS',
    label: 'Sales orders',
    complete: true,
    stages: [
      stage('WAITING_FOR_DEPOSIT', 'Waiting for deposit', 3, 1, 9),
      stage('PLANNED', 'Planned', 8, 0, 4, true),
      stage('IN_PRODUCTION', 'In production', 12, 2, 21),
      stage('READY', 'Ready to ship', 4, 0, 2),
      stage('PARTLY_SHIPPED', 'Partly shipped', 1, 0, 30),
      stage('SHIPPED', 'Shipped, to close', 2, null, 6),
    ],
  },
  WORK_ORDERS: {
    lens: 'WORK_ORDERS',
    label: 'Work orders',
    complete: true,
    stages: [stage('DRAFT', 'Draft', 2, 1, 3), stage('RELEASED', 'Released', 5, 0, 6), stage('IN_PROGRESS', 'In progress', 9, 2, 14), stage('COMPLETED', 'Completed', 3, null, 1)],
  },
  PURCHASE_ORDERS: {
    lens: 'PURCHASE_ORDERS',
    label: 'Purchase orders',
    complete: true,
    stages: [
      stage('DRAFT', 'Draft', 1, 0, 2),
      stage('SENT', 'Sent', 3, 1, 5),
      stage('CHANGES_PROPOSED', 'Changes proposed', 0, 0, null),
      stage('CONFIRMED', 'Confirmed', 4, 0, 12),
      stage('PARTLY_RECEIVED', 'Partly received', 2, 1, 20),
      stage('RECEIVED', 'Received', 6, null, 40),
    ],
  },
  INVOICES: {
    lens: 'INVOICES',
    label: 'Invoices',
    complete: true,
    stages: [stage('DRAFT', 'Draft', 1, null, 1), stage('TO_SEND', 'To send to SDI', 1, null, 1), stage('AT_SDI', 'At SDI', 0, null, null), stage('DELIVERED', 'Delivered, not paid', 5, null, 18), stage('PAID', 'Paid', 22, null, 60)],
  },
  LOTS: {
    lens: 'LOTS',
    label: 'Lots',
    complete: true,
    stages: [stage('QUARANTINE', 'In quarantine', 1, null, 2), stage('BLOCKED', 'Blocked', 1, null, 1), stage('RELEASED', 'Released (30 days)', 7, null, 28), stage('REJECTED', 'Rejected (30 days)', 0, null, null)],
  },
}
const flowOf = (...lenses: string[]) => ({ status: 'ready' as const, data: lenses.map((lens) => LENSES[lens]!) })

const panelRow = (n: number, label: string, sub: string, word: string, date: string, params?: Record<string, number>) => ({ id: id(100 + n), label, sub, word: { key: word, ...(params ? { params } : {}) }, date, href: `/w/DEMO/records/Thing/${id(100 + n)}` })
const PANELS: Record<string, PanelView> = {
  quotesToApprove: {
    id: 'quotesToApprove',
    titleKey: 'today.panels.quotesToApprove.title',
    emptyKey: 'today.panels.quotesToApprove.empty',
    seeAllHref: null,
    state: { status: 'ready', data: { rows: [panelRow(1, 'Q-2026-0142', 'Moto Demo Club', 'today.panels.word.waitsApproval', '2026-11-28')], more: false } },
  },
  lateOrders: {
    id: 'lateOrders',
    titleKey: 'today.panels.lateOrders.title',
    emptyKey: 'today.panels.lateOrders.empty',
    seeAllHref: null,
    state: {
      status: 'ready',
      data: {
        rows: [
          panelRow(2, 'SO-2026-0042', 'Pista Demo S.r.l.', 'today.panels.word.daysLate', '2026-10-27', { count: 2 }),
          panelRow(3, 'SO-2026-0039', 'Officina Demo', 'today.panels.word.daysLate', '2026-10-24', { count: 5 }),
        ],
        more: false,
      },
    },
  },
  ordersWaitingDeposit: { id: 'ordersWaitingDeposit', titleKey: 'today.panels.ordersWaitingDeposit.title', emptyKey: 'today.panels.ordersWaitingDeposit.empty', seeAllHref: null, state: { status: 'ready', data: { rows: [], more: false } } },
  draftWorkOrders: {
    id: 'draftWorkOrders',
    titleKey: 'today.panels.draftWorkOrders.title',
    emptyKey: 'today.panels.draftWorkOrders.empty',
    seeAllHref: null,
    state: { status: 'ready', data: { rows: [panelRow(4, 'WO-00098', 'DEMO-JKT-02', 'today.panels.word.draft', '2026-10-30')], more: false } },
  },
  lateWorkOrders: { id: 'lateWorkOrders', titleKey: 'today.panels.lateWorkOrders.title', emptyKey: 'today.panels.lateWorkOrders.empty', seeAllHref: null, state: { status: 'error', problem: 'today.problem.read' } },
  scanCorrections: { id: 'scanCorrections', titleKey: 'today.panels.scanCorrections.title', emptyKey: 'today.panels.scanCorrections.empty', seeAllHref: null, state: { status: 'loading' } },
  posAwaitingSupplier: {
    id: 'posAwaitingSupplier',
    titleKey: 'today.panels.posAwaitingSupplier.title',
    emptyKey: 'today.panels.posAwaitingSupplier.empty',
    seeAllHref: null,
    state: {
      status: 'ready',
      data: {
        rows: [1, 2, 3, 4, 5].map((n) => panelRow(10 + n, `PO-2026-00${20 + n}`, n % 2 ? 'Conceria Demo' : 'Fodere Demo S.p.A.', 'today.panels.word.notConfirmed', `2026-10-2${n}`)),
        more: true,
      },
    },
  },
  supplierChanges: { id: 'supplierChanges', titleKey: 'today.panels.supplierChanges.title', emptyKey: 'today.panels.supplierChanges.empty', seeAllHref: null, state: { status: 'ready', data: { rows: [], more: false } } },
  sdiRefused: {
    id: 'sdiRefused',
    titleKey: 'today.panels.sdiRefused.title',
    emptyKey: 'today.panels.sdiRefused.empty',
    seeAllHref: null,
    state: { status: 'ready', data: { rows: [panelRow(20, 'FT-2026-00031', 'Pista Demo S.r.l.', 'today.panels.word.sdiRejected', '2026-10-27')], more: false } },
  },
  registerOpen: {
    id: 'registerOpen',
    titleKey: 'today.panels.registerOpen.title',
    emptyKey: 'today.panels.registerOpen.empty',
    seeAllHref: null,
    state: { status: 'ready', data: { rows: [panelRow(21, 'REG-2026-004', 'DEMO-JKT-02', 'today.panels.word.open', '2026-10-21')], more: false } },
  },
  certificatesExpiring: {
    id: 'certificatesExpiring',
    titleKey: 'today.panels.certificatesExpiring.title',
    emptyKey: 'today.panels.certificatesExpiring.empty',
    seeAllHref: null,
    state: { status: 'ready', data: { rows: [panelRow(22, 'DEMO-CE-0000-17', 'EN 17092-3', 'today.panels.word.expiresIn', '2026-12-31', { count: 63 })], more: false } },
  },
  mailToSort: {
    id: 'mailToSort',
    titleKey: 'today.panels.mailToSort.title',
    emptyKey: 'today.panels.mailToSort.empty',
    seeAllHref: '/w/DEMO/home/mail-to-sort',
    state: {
      status: 'ready',
      data: {
        rows: [
          { ...panelRow(23, 'Preventivo 200 giacche', 'Giulia Esempio', 'today.panels.word.mail.TRIAGE', at(28, 10)), href: `/w/DEMO/home/mail-to-sort?open=${id(7)}` },
          { ...panelRow(24, 'Nuove coordinate bancarie', 'Marchio Demo', 'today.panels.word.mail.HELD', at(28, 8)), href: `/w/DEMO/home/mail-to-sort?open=${id(124)}` },
        ],
        more: false,
      },
    },
  },
}
const panelsOf = (...ids: string[]) => ids.map((panel) => PANELS[panel]!)

const REVIEW: QuoteReview = {
  quoteId: id(5),
  number: 'Q-2026-0142',
  version: 7,
  customer: 'Moto Demo Club',
  status: 'PENDING_APPROVAL',
  revision: 2,
  currency: 'EUR',
  netAmount: 1240000,
  marginPct: '18.2',
  marginFloorPct: '25',
  validUntil: '2026-11-28',
  rules: [{ reason: 'MARGIN_FLOOR', message: "The quote's margin is under the floor: an approver decides." }],
  request: { reasons: ['MARGIN_FLOOR'], note: 'Launch order for a new club; they reorder every spring.', askedAt: at(28, 16) },
  decidable: true,
}

const verbs = (...ids: string[]) => ids.map((verb) => ({ id: verb, labelKey: `today.new.${verb}`, href: null }))

const base: TodayViewModel = {
  access: 'open',
  now: NOW,
  live: 'live',
  tile: null,
  kind: null,
  queue: { status: 'ready', data: queueOf(OWNER_ITEMS) },
  flow: flowOf('ORDERS', 'WORK_ORDERS', 'PURCHASE_ORDERS', 'INVOICES', 'LOTS'),
  lens: 'ORDERS',
  panels: panelsOf('quotesToApprove', 'lateOrders', 'ordersWaitingDeposit', 'mailToSort'),
  newVerbs: verbs('quote', 'purchaseOrder', 'workOrder', 'party', 'style', 'material', 'registerEntry', 'certificate'),
  printHref: '/w/DEMO/home/today/print',
  open: null,
  reviews: { [ROWS.quoteApproval.key]: { status: 'ready', data: REVIEW } },
  busy: false,
  notice: null,
  layout: DEFAULT_LAYOUT,
  dialog: null,
  arrangeable: {
    panels: ['quotesToApprove', 'lateOrders', 'ordersWaitingDeposit', 'draftWorkOrders', 'lateWorkOrders', 'posAwaitingSupplier', 'sdiRefused', 'mailToSort'].map((panel) => ({ id: panel })),
    lenses: Object.values(LENSES).map((entry) => ({ lens: entry.lens, label: entry.label })),
  },
}

// ---- what people did about the rows (made-up people) -------------------------------------------------------------------
const person = (n: number, name: string, me = false) => ({ id: id(300 + n), name, me })
const MARCO = person(1, 'Marco Esempio')
const LUCIA = person(2, 'Lucia Demo')
const ME = person(3, 'Anna Prova', true)
const acted = (item: QueueItem, actions: Partial<QueueItem['actions']>): QueueItem => ({ ...item, actions: { ...item.actions, version: 2, ...actions } })
const ACTED = {
  lateOrder: acted(ROWS.lateOrder, { assigned: { to: MARCO, by: ME, at: at(29, 8) } }),
  blockedLot: acted(ROWS.blockedLot, { acknowledged: { by: LUCIA, at: at(29, 7) }, verbs: ['ASSIGN', 'RESOLVE'] }),
  heldWorkOrder: acted(ROWS.heldWorkOrder, { assigned: { to: ME, by: LUCIA, at: at(28, 15) }, acknowledged: { by: ME, at: at(28, 16) }, verbs: ['ASSIGN', 'RESOLVE'] }),
}
const ACTED_ITEMS = OWNER_ITEMS.map((item) => (item.key === ROWS.lateOrder.key ? ACTED.lateOrder : item.key === ROWS.blockedLot.key ? ACTED.blockedLot : item.key === ROWS.heldWorkOrder.key ? ACTED.heldWorkOrder : item))
const acting = { ...base, queue: { status: 'ready' as const, data: queueOf(ACTED_ITEMS, { handledToday: 4 }) } }
const PEOPLE = [
  { id: MARCO.id, name: MARCO.name, me: false, suggested: true, assigned: true },
  { id: id(304), name: 'Giulia Esempio', me: false, suggested: true, assigned: false },
  { id: ME.id, name: ME.name, me: true, suggested: false, assigned: false },
  { id: id(305), name: 'Paolo Demo', me: false, suggested: false, assigned: false },
]
const HANDLED: HandledView = {
  count: 4,
  items: [
    { at: at(29, 9), verb: 'RESOLVED', kind: 'INVOICE_TO_ISSUE', key: `INVOICE_TO_ISSUE:${id(40)}`, record: { type: 'Party', id: id(40), label: 'Officina Demo' }, companyId: COMPANY, note: 'Invoiced with TD24 FT-2026-00030 this morning.', assignee: null, href: `/w/DEMO/records/Party/${id(40)}` },
    { at: at(29, 8), verb: 'ASSIGNED', kind: 'ORDER_PROMISE', key: ROWS.lateOrder.key, record: ROWS.lateOrder.record, companyId: COMPANY, note: null, assignee: { id: MARCO.id, name: MARCO.name }, href: ROWS.lateOrder.href },
    { at: at(29, 8), verb: 'APPROVED', kind: 'QUOTE_APPROVAL', key: null, record: { type: 'Quote', id: id(41), label: 'Q-2026-0139' }, companyId: COMPANY, note: null, assignee: null, href: `/w/DEMO/records/Quote/${id(41)}` },
    { at: at(29, 7), verb: 'ACKNOWLEDGED', kind: 'LOT_HOLD', key: ROWS.quarantineLot.key, record: ROWS.quarantineLot.record, companyId: COMPANY, note: null, assignee: null, href: ROWS.quarantineLot.href },
  ],
}
const ARRANGED: TodayLayout = {
  sections: [
    { id: 'focus-strip', hidden: false },
    { id: 'role-panels', hidden: false },
    { id: 'needs-me', hidden: false },
    { id: 'flow', hidden: true },
  ],
  panels: [
    { id: 'lateOrders', hidden: false, width: 'TWO_THIRDS' },
    { id: 'mailToSort', hidden: false, width: 'HALF' },
    { id: 'quotesToApprove', hidden: false, width: 'HALF' },
    { id: 'ordersWaitingDeposit', hidden: true, width: 'HALF' },
  ],
  mainLens: 'ORDERS',
}

const SALES_ITEMS = [ROWS.lateOrder, ROWS.mail, ROWS.riskOrder]
const BUYER_ITEMS = [ROWS.mail, ROWS.poNotConfirmed].map((item) => (item.kind === 'MAIL_TO_SORT' ? { ...item, group: 'TODAY' as const } : item))
const INSPECTOR_ITEMS = [ROWS.blockedLot, ROWS.styleHeld, ROWS.quarantineLot, ROWS.registerDuty]
const FINANCE_ITEMS = [ROWS.sdiRejected, ROWS.quoteApproval, ROWS.toInvoice]


// ---- W2a (B-W2a-40): my tasks and mentions, an exception rule's alert, Snooze, Coming up ---------------------------------

const ref = (value: Phrase) => ({ key: value.key, params: value.params as Record<string, string | number | string[]> })
/** One of my own rows (a task due, a mention) or an exception rule's alert, as the API sends it with `include`. */
function own(n: number, item: Pick<TodayItem, 'kind' | 'state' | 'severity' | 'group' | 'record' | 'category'> & { sentence: Phrase; why: Phrase; blocks?: Phrase | null; due?: TodayItem['due']; key?: string; href: string }): QueueItem {
  const { sentence, why, blocks = null, key, href, ...rest } = item
  return {
    key: key ?? `${item.kind}:${item.record.id}`,
    severityWord: '',
    companyId: COMPANY,
    siteId: null,
    partyId: null,
    sentence: sentence.text,
    why: why.text,
    blocks: blocks?.text ?? null,
    words: { sentence: ref(sentence), why: ref(why), blocks: blocks ? ref(blocks) : null },
    sentenceFigure: null,
    due: item.due ?? null,
    since: at(29 - (n % 5)),
    ageDays: n % 5,
    decide: 'OPEN',
    figures: null,
    condition: String(n).padStart(32, 'b'),
    actions: { version: 0, verbs: [], assigned: null, acknowledged: null, snoozable: false },
    href,
    reviewHref: null,
    ...rest,
  }
}

const TASK_CALL = taskDueWords({ title: 'Call the demo tannery about lot LOT-A-000214', dueDate: '2026-10-27', dueTime: null, overdueDays: 2, recordLabel: 'LOT-A-000214' })
const TASK_SAMPLE = taskDueWords({ title: 'Send the sample jacket to Moto Demo Club', dueDate: '2026-10-29', dueTime: '15:00', overdueDays: 0, recordLabel: 'Q-2026-0142' })
const W2A = {
  taskOverdue: own(21, {
    kind: 'TASK_DUE',
    state: 'OVERDUE',
    category: 'TASK',
    severity: 'HIGH',
    group: 'NOW',
    record: { type: 'Task', id: id(21), label: 'Call the demo tannery about lot LOT-A-000214' },
    sentence: TASK_CALL.sentence,
    blocks: TASK_CALL.blocks,
    why: personalPhrase('why.TASK_DUE.assigned'),
    due: { date: '2026-10-27', days: -2, word: 'OVERDUE' },
    href: `/w/DEMO/home/tasks?open=${id(21)}`,
  }),
  taskToday: own(22, {
    kind: 'TASK_DUE',
    state: 'TODAY',
    category: 'TASK',
    severity: 'MEDIUM',
    group: 'TODAY',
    record: { type: 'Task', id: id(22), label: 'Send the sample jacket to Moto Demo Club' },
    sentence: TASK_SAMPLE.sentence,
    blocks: TASK_SAMPLE.blocks,
    why: personalPhrase('why.TASK_DUE.assigned'),
    due: { date: '2026-10-29', days: 0, word: 'TODAY' },
    href: `/w/DEMO/home/tasks?open=${id(22)}`,
  }),
  mention: own(23, {
    kind: 'MENTION',
    state: 'MENTIONED',
    category: 'MENTION',
    severity: 'MEDIUM',
    group: 'TODAY',
    key: `MENTION:${id(5)}:${id(23)}`,
    record: { type: 'Quote', id: id(5), label: 'Q-2026-0142' },
    sentence: mentionWords({ actor: 'Marco Esempio', recordLabel: 'Q-2026-0142' }),
    why: personalPhrase('why.MENTION.mentioned'),
    href: `/w/DEMO/sales/quotes/${id(5)}`,
  }),
  ruleAlert: own(24, {
    kind: 'RULE_ALERT',
    state: 'OPEN',
    category: 'ALERT',
    severity: 'HIGH',
    group: 'NOW',
    record: { type: 'Alert', id: id(24), label: 'SO-2026-0047' },
    sentence: alertRowPhrase('ORDER_LATE_RISK', 'SO-2026-0047', { late: false, daysLeft: 2, promiseDate: '2026-10-31' }),
    why: alertWhyPhrase(false, 'Orders at risk of being late'),
    due: { date: '2026-10-31', days: 2, word: 'SOON' },
    // Until Home › Alerts exists, the chip opens the row's own review here (which links the order).
    href: `/w/DEMO/home/today?open=${encodeURIComponent(`RULE_ALERT:${id(24)}`)}`,
  }),
}
/** A W1 alert the reader may snooze (W2a: `actions.snoozable`). */
const SNOOZABLE_HOLD: QueueItem = { ...ROWS.blockedLot, actions: { ...ROWS.blockedLot.actions, snoozable: true } }
const W2A_ITEMS: QueueItem[] = [W2A.taskOverdue, W2A.ruleAlert, SNOOZABLE_HOLD, ROWS.heldWorkOrder, W2A.taskToday, W2A.mention, ROWS.quoteApproval, ROWS.mail]

function w2aQueue(items: readonly QueueItem[], extra: Partial<QueueData> = {}): QueueData {
  const count = (test: (item: QueueItem) => boolean) => items.filter(test).length
  return {
    ...queueOf(items, extra),
    tiles: [
      { tile: 'ALL', count: items.length, complete: true },
      { tile: 'APPROVAL', count: count((item) => item.category === 'APPROVAL'), complete: true },
      { tile: 'DUE_TODAY', count: count((item) => item.due?.days === 0), complete: true },
      { tile: 'OVERDUE', count: count((item) => (item.due?.days ?? 0) < 0), complete: true },
      { tile: 'MENTION', count: count((item) => item.category === 'MENTION'), complete: true },
      { tile: 'ALERT', count: count((item) => item.category === 'ALERT'), complete: true },
    ],
    ...extra,
  }
}

const COMING: ComingUpView = {
  calendar: true,
  complete: true,
  days: [
    {
      date: '2026-10-30',
      working: true,
      items: [
        { kind: 'TASK', label: 'Check the size run with the demo club', words: ref(personalPhrase('COMING.TASK', { title: 'Check the size run with the demo club' })), href: `/w/DEMO/home/tasks?open=${id(25)}` },
        { kind: 'ORDER', label: 'SO-2026-0047', words: ref(personalPhrase('COMING.ORDER', { number: 'SO-2026-0047', customer: 'Moto Demo Club' })), href: `/w/DEMO/sales/orders/${id(8)}` },
      ],
    },
    { date: '2026-11-02', working: true, items: [{ kind: 'DELIVERY', label: 'PO-2026-0031', words: ref(personalPhrase('COMING.DELIVERY', { supplier: 'Conceria Demo', number: 'PO-2026-0031' })), href: `/w/DEMO/purchasing/orders/${id(9)}` }] },
    { date: '2026-11-03', working: true, items: [] },
    { date: '2026-11-04', working: true, items: [{ kind: 'CERTIFICATE', label: 'CERT-DEMO-0007', words: ref(personalPhrase('COMING.CERTIFICATE', { number: 'CERT-DEMO-0007' })), href: `/w/DEMO/compliance/certificates/${id(26)}` }] },
    { date: '2026-11-05', working: true, items: [] },
  ],
}

/** Today as the W2a screen draws it: six tiles, my tasks and mentions among the rows, Coming up below the work. */
const w2a: TodayViewModel = {
  ...base,
  tileSet: W2A_TILES,
  queue: { status: 'ready', data: w2aQueue(W2A_ITEMS, { handledToday: 2 }) },
  comingUp: { status: 'ready', data: COMING },
  alertRecords: {},
}
const W2A_CASES: { id: string; label: string; model: TodayViewModel; note?: string }[] = [
  {
    id: 'w2a-owner',
    label: 'W2a — my tasks, a mention and an exception rule’s alert; Coming up',
    model: w2a,
    note: 'Six tiles: Needs me now · Approvals · Due today · Overdue · Mentions · Alerts on my records (kept until Home › Alerts). A task row takes Done (e) and Snooze (h) in its ⋯; a mention the same through its notification; the exception rule’s alert opens its record; a lot on hold the reader may snooze has Snooze beside its alert verbs. Coming up: the next five working days.',
  },
  { id: 'w2a-due-today', label: 'W2a — Due today pressed', model: { ...w2a, tile: 'DUE_TODAY' }, note: 'Rows due today, of any kind.' },
  { id: 'w2a-overdue', label: 'W2a — Overdue pressed', model: { ...w2a, tile: 'OVERDUE' } },
  { id: 'w2a-mentions', label: 'W2a — Mentions pressed', model: { ...w2a, tile: 'MENTION' }, note: 'The notes that mentioned me; Done takes the mention off Today and the notifications.' },
  { id: 'w2a-task-open', label: 'W2a — a task in the decide modal', model: { ...w2a, open: W2A.taskOverdue.key }, note: 'Done (E, primary), Snooze… (H); Open the task opens it on My tasks.' },
  { id: 'w2a-mention-open', label: 'W2a — a mention in the decide modal', model: { ...w2a, open: W2A.mention.key } },
  {
    id: 'w2a-rule-alert',
    label: 'W2a — an exception rule’s alert in the decide modal',
    model: { ...w2a, open: W2A.ruleAlert.key, alertRecords: { [W2A.ruleAlert.key]: { status: 'ready', data: `/w/DEMO/sales/orders/${id(8)}` } } },
    note: 'Handled in the alert itself (Home › Alerts); here its record opens.',
  },
  { id: 'w2a-snooze', label: 'W2a — Snooze an alert row', model: { ...w2a, dialog: { kind: 'snooze', key: SNOOZABLE_HOLD.key } }, note: 'Later today 16:00 · Tomorrow 08:00 · Monday 08:00 · Pick a date · Until something changes on the record; the site’s times.' },
  { id: 'w2a-snooze-task', label: 'W2a — Snooze my task', model: { ...w2a, dialog: { kind: 'snooze', key: W2A.taskToday.key } }, note: 'A task comes back at a time (no "until something changes").' },
  {
    id: 'w2a-done',
    label: 'W2a — after Done on a task',
    model: { ...w2a, queue: { status: 'ready', data: w2aQueue(W2A_ITEMS.filter((item) => item.key !== W2A.taskOverdue.key), { handledToday: 2 }) }, notice: { key: 'today.own.doneTask', tone: 'success', params: { record: W2A.taskOverdue.record.label } } },
  },
  { id: 'w2a-offline', label: 'W2a — offline: Done and Snooze held', model: { ...w2a, live: 'offline', open: W2A.taskToday.key }, note: 'Rows stay readable; Done and Snooze say "Offline — decide when back online".' },
  { id: 'w2a-loading', label: 'W2a — loading', model: { ...w2a, queue: { status: 'loading' }, comingUp: { status: 'loading' } } },
  { id: 'w2a-coming-empty', label: 'W2a — nothing coming up', model: { ...w2a, comingUp: { status: 'ready', data: { calendar: false, complete: true, days: COMING.days.map((day) => ({ ...day, items: [] })) } } }, note: 'No calendar picked: Monday to Friday.' },
  { id: 'w2a-coming-error', label: 'W2a — Coming up could not be read', model: { ...w2a, comingUp: { status: 'error', problem: 'today.problem.offline' } }, note: 'Only that section fails; the rest works.' },
]

export const designScreen = defineDesignScreen<TodayViewModel>({
  screen: 'SCR-029',
  title: 'Today',
  view: TodayView,
  cases: [
    { id: 'owner', label: 'Owner — everything that waits', model: base, note: 'Every area and company, ranked and grouped; tiles per kind (0 is an answer); flow strip with five lenses; the Sales lens lists. Keys: j / k, Enter.' },
    {
      id: 'owner-decide',
      label: 'Owner — decide a quote approval',
      model: { ...base, open: ROWS.quoteApproval.key },
      note: 'The decide modal: the quote, the rule it breaks, the request and its note; Approve (a) and Reject (r, a reason is required). J / K step through every row.',
    },
    {
      id: 'owner-open-row',
      label: 'Owner — open a late order',
      model: { ...base, open: ROWS.lateOrder.key },
      note: 'A row Today does not decide: why it is yours, what waits on it, and its record (its own page when built, else its panels).',
    },
    { id: 'owner-open-mail', label: 'Owner — open a mail to sort', model: { ...base, open: ROWS.mail.key }, note: 'Mail to sort is decided in its own review: the button opens it.' },
    {
      id: 'owner-tile',
      label: 'Owner — the Approvals tile pressed',
      model: { ...base, tile: 'APPROVAL' },
      note: 'A tile filters the list in place (?tile=APPROVAL, aria-pressed); its chip, or the tile again, clears it. Approvals: quote approvals, supplier changes, scan corrections, mail to sort.',
    },
    {
      id: 'owner-alerts',
      label: 'Owner — the Alerts tile pressed',
      model: { ...base, tile: 'ALERT' },
      note: 'Alerts on my records: late or at-risk orders, held work orders, lots on hold, SDI, unconfirmed POs, refused scans, goods to invoice, register and privacy duties, styles held by compliance.',
    },
    {
      id: 'owner-lens',
      label: 'Owner — Work orders lens',
      model: { ...base, lens: 'WORK_ORDERS', panels: panelsOf('draftWorkOrders', 'lateWorkOrders', 'scanCorrections', 'mailToSort') },
      note: 'The lens picks the flow strip and its lists: one list could not be read (Try again), one is still loading.',
    },
    {
      id: 'owner-fresh',
      label: 'Owner — new rows waiting, offline',
      model: { ...base, live: 'offline', queue: { status: 'ready', data: queueOf(OWNER_ITEMS, { fresh: 2, more: true }) } },
      note: 'Rows never jump in: "2 new · Show". The live channel is down: the band says so.',
    },
    {
      id: 'owner-partial',
      label: 'Owner — a count that is a lower bound',
      model: (() => {
        const data = queueOf(OWNER_ITEMS)
        return { ...base, queue: { status: 'ready' as const, data: { ...data, tiles: data.tiles.map((entry) => (entry.tile === 'ALERT' ? entry : { ...entry, count: entry.count + 196, complete: false })) } } }
      })(),
      note: 'A source stopped at its limit (here: mail to sort): its tiles say "at least" with the reason.',
    },
    {
      id: 'sales',
      label: 'Sales',
      model: {
        ...base,
        queue: { status: 'ready', data: queueOf(SALES_ITEMS) },
        flow: flowOf('ORDERS', 'WORK_ORDERS', 'INVOICES'),
        panels: panelsOf('lateOrders', 'ordersWaitingDeposit', 'mailToSort'),
        newVerbs: verbs('quote', 'party'),
        reviews: {},
      },
      note: 'Late and at-risk orders with their value (price), mail to sort; never a cost, never an approval they asked.',
    },
    {
      id: 'buyer',
      label: 'Buyer',
      model: {
        ...base,
        lens: 'PURCHASE_ORDERS',
        queue: { status: 'ready', data: queueOf(BUYER_ITEMS) },
        flow: flowOf('PURCHASE_ORDERS', 'LOTS'),
        panels: panelsOf('posAwaitingSupplier', 'supplierChanges', 'mailToSort'),
        newVerbs: verbs('purchaseOrder', 'party', 'material'),
        reviews: {},
      },
      note: 'Its PO not confirmed (purchase value: the cost grain); no quote approval, no lot it cannot release.',
    },
    {
      id: 'inspector',
      label: 'Quality inspector',
      model: {
        ...base,
        lens: 'LOTS',
        queue: { status: 'ready', data: queueOf(INSPECTOR_ITEMS) },
        flow: flowOf('WORK_ORDERS', 'LOTS'),
        panels: panelsOf('registerOpen', 'certificatesExpiring'),
        newVerbs: verbs('registerEntry', 'certificate'),
        reviews: {},
      },
      note: 'Lots, the PPE register and styles held by compliance; no money anywhere.',
    },
    {
      id: 'finance',
      label: 'Finance',
      model: {
        ...base,
        lens: 'INVOICES',
        queue: { status: 'ready', data: queueOf(FINANCE_ITEMS) },
        flow: flowOf('ORDERS', 'INVOICES'),
        panels: panelsOf('quotesToApprove', 'lateOrders', 'ordersWaitingDeposit', 'sdiRefused'),
        newVerbs: verbs('party'),
      },
      note: 'SDI rejections with their deadline, the quote approval the sales person asked, shipped goods to invoice.',
    },
    {
      id: 'empty',
      label: 'Nothing needs you',
      model: { ...base, queue: { status: 'ready', data: queueOf([]) }, panels: panelsOf('ordersWaitingDeposit', 'supplierChanges'), reviews: {} },
      note: 'All zero is an answer: the tiles show 0 and the list says so.',
    },
    { id: 'loading', label: 'Loading', model: { ...base, queue: { status: 'loading' }, flow: { status: 'loading' }, panels: panelsOf('scanCorrections') } },
    {
      id: 'error',
      label: 'Could not be read',
      model: { ...base, queue: { status: 'error', problem: 'today.problem.offline' }, flow: { status: 'error', problem: 'today.problem.read' }, panels: panelsOf('lateWorkOrders') },
      note: 'Each section fails and retries on its own; the tiles show — with a reason.',
    },
    {
      id: 'decided',
      label: 'After a decision',
      model: { ...base, open: ROWS.quarantineLot.key, notice: { key: 'today.decide.approved', tone: 'success' } },
      note: 'The approval went through; the next row opened.',
    },
    { id: 'no-permission', label: 'Without Today', model: { ...base, access: 'refused' }, note: 'A person without home.view: the page says so (the navigation hides the row).' },
    {
      id: 'owner-acted',
      label: 'Owner — assigned and acknowledged rows',
      model: acting,
      note: 'SO-2026-0042 assigned to Marco; LOT-A-000214 acknowledged by Lucia; WO-00098 assigned to you and acknowledged by you. Each alert row has ⋯ with Acknowledge (e), Assign to…, Resolve…; "Handled today: 4 · Show" in the list footer.',
    },
    {
      id: 'owner-alert-verbs',
      label: 'Owner — an alert in the decide modal',
      model: { ...acting, open: ACTED.lateOrder.key },
      note: 'An alert decides with its verbs: Acknowledge (E, the primary), Assign to…, Resolve…; who it is assigned to among its facts.',
    },
    {
      id: 'owner-acknowledged-held',
      label: 'Owner — an acknowledged alert: Acknowledge held',
      model: { ...acting, open: ACTED.blockedLot.key },
      note: 'Acknowledged in this condition by Lucia: the button says so instead of acting again; Assign and Resolve stay.',
    },
    {
      id: 'owner-assign',
      label: 'Owner — Assign to',
      model: { ...acting, dialog: { kind: 'assign', key: ACTED.lateOrder.key, people: { status: 'ready', data: PEOPLE } } },
      note: 'Only people who may act on the row (its company, its permission, four eyes); the responsible ones first; "Take it back" while assigned.',
    },
    {
      id: 'owner-assign-loading',
      label: 'Owner — Assign to, reading who may act',
      model: { ...base, dialog: { kind: 'assign', key: ROWS.riskOrder.key, people: { status: 'loading' } } },
    },
    {
      id: 'owner-resolve',
      label: 'Owner — Resolve with a note',
      model: { ...acting, open: ACTED.lateOrder.key, dialog: { kind: 'resolve', key: ACTED.lateOrder.key } },
      note: 'A note says what was done (required, 3 to 1,000 characters, ⌘Enter); the alert leaves Today for everyone until its condition changes.',
    },
    {
      id: 'owner-resolved',
      label: 'Owner — after a resolve',
      model: { ...acting, queue: { status: 'ready', data: queueOf(ACTED_ITEMS.filter((item) => item.key !== ACTED.lateOrder.key), { handledToday: 5 }) }, notice: { key: 'today.actions.resolved', tone: 'success', params: { record: 'SO-2026-0042' } } },
      note: 'The row left Today for everyone; it comes back if its condition changes (a promise date moved, a new state).',
    },
    {
      id: 'owner-offline',
      label: 'Owner — offline: the verbs are held',
      model: { ...acting, live: 'offline', open: ACTED.lateOrder.key },
      note: 'Rows stay readable; Acknowledge, Assign and Resolve are held: "Offline — decide when back online".',
    },
    { id: 'owner-handled', label: 'Owner — Handled today', model: { ...acting, dialog: { kind: 'handled', list: { status: 'ready', data: HANDLED } } }, note: 'What I decided today, newest first, with the notes I wrote.' },
    { id: 'owner-handled-empty', label: 'Owner — Handled today, nothing yet', model: { ...base, dialog: { kind: 'handled', list: { status: 'ready', data: { count: 0, items: [] } } } } },
    {
      id: 'owner-arrange',
      label: 'Owner — Arrange Today',
      model: { ...acting, dialog: { kind: 'arrange' } },
      note: 'The one Customise dialog: tick what shows, drag the order ("Needs me now" always shows); widths of My lists and the main lens on the left. Saved on the server for this person.',
    },
    {
      id: 'owner-arranged',
      label: 'Owner — arranged: My lists first, the flow strip hidden',
      model: { ...acting, layout: ARRANGED, panels: panelsOf('quotesToApprove', 'lateOrders', 'ordersWaitingDeposit', 'mailToSort') },
      note: 'My lists above the work, across the page, each list at its width (Late orders two thirds); Where the work is hidden; orders waiting for a deposit hidden.',
    },
    {
      id: 'sales-assigned',
      label: 'Sales — a row assigned to me',
      model: {
        ...base,
        queue: { status: 'ready', data: queueOf([acted(ROWS.lateOrder, { assigned: { to: { ...MARCO, me: true }, by: { ...ME, me: false }, at: at(29, 8) } }), ROWS.mail, ROWS.riskOrder], { handledToday: 1 }) },
        flow: flowOf('ORDERS', 'WORK_ORDERS', 'INVOICES'),
        panels: panelsOf('lateOrders', 'ordersWaitingDeposit', 'mailToSort'),
        newVerbs: verbs('quote', 'party'),
        reviews: {},
      },
      note: 'The assignee sees "Assigned to you by Anna Prova"; mail to sort has no alert verbs (it is sorted in its review).',
    },
    ...W2A_CASES,
  ],
})
