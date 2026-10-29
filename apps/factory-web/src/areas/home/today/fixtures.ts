import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { FlowLensView, PanelView, QueueData, QueueItem, QuoteReview, TodayItem, TodayViewModel } from './model'
import { TodayView } from './view/TodayView'

/**
 * SCR-029 Home › Today — made-up data only (PLAN §3.1): invented companies, customers, suppliers, numbers and amounts.
 * Each case is one state the Owner reviews: the role switch (Owner, Sales, Buyer, Inspector, Finance), the decide modal
 * on a quote approval and on other rows, a pressed tile, new rows waiting, a count that is a lower bound, nothing to do,
 * loading, an error, and a person without Today. Open a case alone for the keyboard: j / k move, Enter opens, and in
 * the modal a approves, r rejects, j / k step through.
 */

const NOW = Date.UTC(2026, 9, 29, 9, 42)
const AS_OF = new Date(NOW).toISOString()
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()
const id = (n: number) => `0190f0e2-7777-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = '0190f0e2-1111-7000-8000-000000000001'
const SITE = '0190f0e2-2222-7000-8000-000000000001'

function row(n: number, item: Partial<TodayItem> & Pick<TodayItem, 'kind' | 'state' | 'severity' | 'group' | 'record' | 'sentence' | 'why'>): QueueItem {
  const base: TodayItem = {
    key: `${item.kind}:${item.record.id}`,
    category: 'ALERT',
    severityWord: '',
    companyId: COMPANY,
    siteId: null,
    partyId: null,
    blocks: null,
    due: null,
    since: at(29 - (n % 9)),
    ageDays: n % 9,
    decide: 'OPEN',
    figures: null,
    ...item,
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
    sentence: 'Order SO-2026-0042 for Pista Demo S.r.l. is 2 days late: it was promised for 2026-10-27.',
    why: "You manage this customer's orders and their promise dates.",
    blocks: 'Pista Demo S.r.l. waits for 12 pieces.',
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
    sentence: 'Work order WO-00098 (DEMO-JKT-02) cannot be released: 2 checks open (deposit, material).',
    why: 'You release work orders at this site.',
    blocks: 'Production of SO-2026-0042 waits for it.',
    due: { date: '2026-10-30', days: 1, word: 'SOON' },
  }),
  sdiRejected: row(3, {
    kind: 'INVOICE_SDI',
    state: 'REJECTED',
    severity: 'HIGH',
    group: 'NOW',
    record: { type: 'Invoice', id: id(3), label: 'FT-2026-00031' },
    sentence: 'Invoice FT-2026-00031 for Pista Demo S.r.l. was rejected by SDI: correct it and send it again by 2026-11-04.',
    why: "You issue and send this customer's invoices.",
    blocks: 'Until it is sent again it counts as never issued.',
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
    sentence: 'Lot LOT-A-000214 (Demo black cowhide 1.2 mm) is blocked: its chromium VI result failed.',
    why: 'You release lots at this site.',
    blocks: 'Its stock stays held: reject the lot, or release it again with new evidence.',
  }),
  quoteApproval: row(5, {
    kind: 'QUOTE_APPROVAL',
    state: 'PENDING',
    severity: 'MEDIUM',
    group: 'TODAY',
    category: 'APPROVAL',
    decide: 'REVIEW',
    record: { type: 'Quote', id: id(5), label: 'Q-2026-0142' },
    sentence: 'Quote Q-2026-0142 for Moto Demo Club: margin under the floor (margin 18.2 %).',
    why: "You approve this customer's quotes, and someone else asked.",
    blocks: 'It cannot be sent to the customer until it is decided.',
    figures: { currency: 'EUR', netAmount: 1240000, marginPct: '18.2', marginAmount: 225680 },
  }),
  quarantineLot: row(6, {
    kind: 'LOT_HOLD',
    state: 'QUARANTINE',
    severity: 'MEDIUM',
    group: 'TODAY',
    siteId: SITE,
    record: { type: 'Lot', id: id(6), label: 'LOT-A-000219' },
    sentence: 'Lot LOT-A-000219 (Demo mesh lining) waits in quarantine for its release.',
    why: 'You release lots at this site.',
    blocks: 'Its stock cannot be issued to work orders until it is released.',
  }),
  mail: row(7, {
    kind: 'MAIL_TO_SORT',
    state: 'TRIAGE',
    severity: 'MEDIUM',
    group: 'TODAY',
    category: 'TASK',
    decide: 'REVIEW',
    record: { type: 'InboundEmail', id: id(7), label: 'Preventivo 200 giacche' },
    sentence: '"Preventivo 200 giacche" from Giulia Esempio reached no record: sort it.',
    why: "You sort this company's received mail.",
    blocks: 'Its sender waits: nobody sees it on a record until it is sorted.',
  }),
  riskOrder: row(8, {
    kind: 'ORDER_PROMISE',
    state: 'AT_RISK',
    severity: 'MEDIUM',
    group: 'THIS_WEEK',
    record: { type: 'SalesOrder', id: id(8), label: 'SO-2026-0047' },
    sentence: 'Order SO-2026-0047 for Moto Demo Club is promised for 2026-10-31 (in 2 days) and is not ready yet.',
    why: "You manage this customer's orders and their promise dates.",
    blocks: 'Moto Demo Club waits for 4 pieces.',
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
    sentence: 'Purchase order PO-2026-0031 to Conceria Demo is not confirmed 3 days after it was sent (EUR 4,820.00).',
    why: 'You send purchase orders to this supplier.',
    blocks: 'The goods are needed by 2026-11-05.',
    due: { date: '2026-11-05', days: 7, word: 'SOON' },
    figures: { currency: 'EUR', purchaseAmount: 482000 },
  }),
  scanCorrection: row(10, {
    kind: 'SCAN_CORRECTION',
    state: 'PENDING',
    severity: 'MEDIUM',
    group: 'TODAY',
    category: 'APPROVAL',
    decide: 'REVIEW',
    siteId: SITE,
    record: { type: 'ScanCorrectionRequest', id: id(10), label: 'WO-00091' },
    sentence: 'A correction of the scan of bundle BN-000412 at Sew and assemble the body (WO-00091) waits for a decision.',
    why: "You decide the floor's scan corrections at this site, and you neither scanned nor asked.",
    blocks: "WO-00091's progress counts the report as it was until the correction is decided.",
  }),
  registerDuty: row(11, {
    kind: 'REGISTER_DUTY',
    state: 'ASSESSING',
    severity: 'MEDIUM',
    group: 'TODAY',
    category: 'TASK',
    record: { type: 'PpeRegisterEntry', id: id(11), label: 'REG-2026-004' },
    sentence: 'PPE register complaint REG-2026-004 (DEMO-JKT-02): the risk to decide, the corrective action.',
    why: "You keep this company's PPE register.",
    blocks: 'The entry cannot close until these duties are done (Reg. (EU) 2016/425 art. 8).',
  }),
  styleHeld: row(12, {
    kind: 'STYLE_COMPLIANCE',
    state: 'BLOCKED',
    severity: 'HIGH',
    group: 'NOW',
    record: { type: 'Style', id: id(12), label: 'DEMO-JKT-03' },
    sentence: 'Style DEMO-JKT-03 is held by its compliance: Declaration of Conformity, user information leaflet.',
    why: "You file the styles' Declarations of Conformity and leaflets.",
    blocks: 'It holds up the shipping of 1 open sales order and 1 open work order.',
  }),
  toInvoice: row(13, {
    kind: 'INVOICE_TO_ISSUE',
    state: 'OPEN',
    severity: 'LOW',
    group: 'LATER',
    category: 'TASK',
    record: { type: 'Party', id: id(13), label: 'Pista Demo S.r.l.' },
    sentence: 'Pista Demo S.r.l.: 2 DDTs of 2026-10 not invoiced yet (144/2026, 151/2026).',
    why: "You invoice this customer's shipped goods.",
    blocks: 'Deferred invoice (TD24) by 15/11/2026 for the DDTs of October 2026: 17 days left.',
    due: { date: '2026-11-15', days: 17, word: null },
  }),
  refusedScan: row(14, {
    kind: 'SCAN_REFUSAL',
    state: 'FINAL',
    severity: 'LOW',
    group: 'THIS_WEEK',
    category: 'TASK',
    siteId: SITE,
    record: { type: 'FloorScanRefusal', id: id(14), label: 'BN-000377' },
    sentence: 'A scan sent from Demo tablet cutting was refused: This is not a bundle ticket of this site.',
    why: "You look after this site's floor scans.",
    blocks: null,
  }),
} satisfies Record<string, QueueItem>

const tile = (kind: string, label: string, count: number, complete = true) => ({ kind, label, count, complete })

function queueOf(items: readonly QueueItem[], tiles: QueueData['tiles'], extra: Partial<QueueData> = {}): QueueData {
  return { asOf: AS_OF, total: items.length, needYou: items.length, now: items.filter((item) => item.group === 'NOW').length, tiles, items, more: false, loadingMore: false, fresh: 0, ...extra }
}

const OWNER_ITEMS = [ROWS.lateOrder, ROWS.heldWorkOrder, ROWS.sdiRejected, ROWS.blockedLot, ROWS.styleHeld, ROWS.quoteApproval, ROWS.quarantineLot, ROWS.mail, ROWS.scanCorrection, ROWS.registerDuty, ROWS.riskOrder, ROWS.poNotConfirmed, ROWS.refusedScan, ROWS.toInvoice]
const countOf = (items: readonly QueueItem[], kind: string) => items.filter((item) => item.kind === kind).length
const OWNER_TILES = [
  'ORDER_PROMISE',
  'WORK_ORDER_HELD',
  'LOT_HOLD',
  'INVOICE_SDI',
  'QUOTE_APPROVAL',
  'PO_PROPOSAL',
  'PO_NOT_CONFIRMED',
  'SCAN_CORRECTION',
  'SCAN_REFUSAL',
  'INVOICE_TO_ISSUE',
  'REGISTER_DUTY',
  'PRIVACY_DUTY',
  'STYLE_COMPLIANCE',
  'MAIL_TO_SORT',
].map((kind) => tile(kind, kind, countOf(OWNER_ITEMS, kind)))

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
  kind: null,
  queue: { status: 'ready', data: queueOf(OWNER_ITEMS, OWNER_TILES) },
  flow: flowOf('ORDERS', 'WORK_ORDERS', 'PURCHASE_ORDERS', 'INVOICES', 'LOTS'),
  lens: 'ORDERS',
  panels: panelsOf('quotesToApprove', 'lateOrders', 'ordersWaitingDeposit', 'mailToSort'),
  newVerbs: verbs('quote', 'purchaseOrder', 'workOrder', 'party', 'style', 'material', 'registerEntry', 'certificate'),
  printHref: '/w/DEMO/home/today/print',
  open: null,
  reviews: { [ROWS.quoteApproval.key]: { status: 'ready', data: REVIEW } },
  busy: false,
  notice: null,
}

const SALES_ITEMS = [ROWS.lateOrder, ROWS.mail, ROWS.riskOrder]
const BUYER_ITEMS = [ROWS.mail, ROWS.poNotConfirmed].map((item) => (item.kind === 'MAIL_TO_SORT' ? { ...item, group: 'TODAY' as const } : item))
const INSPECTOR_ITEMS = [ROWS.blockedLot, ROWS.styleHeld, ROWS.quarantineLot, ROWS.registerDuty]
const FINANCE_ITEMS = [ROWS.sdiRejected, ROWS.quoteApproval, ROWS.toInvoice]

const tilesFor = (items: readonly QueueItem[], kinds: readonly string[]) => kinds.map((kind) => tile(kind, kind, countOf(items, kind)))

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
      label: 'Owner — the Lots tile pressed',
      model: { ...base, kind: 'LOT_HOLD', queue: { status: 'ready', data: queueOf([ROWS.blockedLot, ROWS.quarantineLot], OWNER_TILES, { total: 2 }) } },
      note: 'A tile filters the list in place (?kind=LOT_HOLD); its chip clears it.',
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
      model: { ...base, live: 'offline', queue: { status: 'ready', data: queueOf(OWNER_ITEMS, OWNER_TILES, { fresh: 2, more: true }) } },
      note: 'Rows never jump in: "2 new · Show". The live channel is down: the band says so.',
    },
    {
      id: 'owner-partial',
      label: 'Owner — a count that is a lower bound',
      model: { ...base, queue: { status: 'ready', data: queueOf(OWNER_ITEMS, OWNER_TILES.map((entry) => (entry.kind === 'MAIL_TO_SORT' ? { ...entry, count: 200, complete: false } : entry))) } },
      note: 'A source stopped at its limit: its tile says "at least 200".',
    },
    {
      id: 'sales',
      label: 'Sales',
      model: {
        ...base,
        queue: { status: 'ready', data: queueOf(SALES_ITEMS, tilesFor(SALES_ITEMS, ['ORDER_PROMISE', 'MAIL_TO_SORT'])) },
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
        queue: { status: 'ready', data: queueOf(BUYER_ITEMS, tilesFor(BUYER_ITEMS, ['PO_PROPOSAL', 'PO_NOT_CONFIRMED', 'MAIL_TO_SORT'])) },
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
        queue: { status: 'ready', data: queueOf(INSPECTOR_ITEMS, tilesFor(INSPECTOR_ITEMS, ['LOT_HOLD', 'REGISTER_DUTY', 'STYLE_COMPLIANCE'])) },
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
        queue: { status: 'ready', data: queueOf(FINANCE_ITEMS, tilesFor(FINANCE_ITEMS, ['INVOICE_SDI', 'QUOTE_APPROVAL', 'INVOICE_TO_ISSUE'])) },
        flow: flowOf('ORDERS', 'INVOICES'),
        panels: panelsOf('quotesToApprove', 'lateOrders', 'ordersWaitingDeposit', 'sdiRefused'),
        newVerbs: verbs('party'),
      },
      note: 'SDI rejections with their deadline, the quote approval the sales person asked, shipped goods to invoice.',
    },
    {
      id: 'empty',
      label: 'Nothing needs you',
      model: { ...base, queue: { status: 'ready', data: queueOf([], OWNER_TILES.map((entry) => ({ ...entry, count: 0 }))) }, panels: panelsOf('ordersWaitingDeposit', 'supplierChanges'), reviews: {} },
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
  ],
})
