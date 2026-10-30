import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Order } from '../api'
import { draftOf, newKey, type DraftLine } from '../daily-model'
import { STEP_UP_CLOSED } from '../hooks'
import type { NewOrderModel } from '../new/new-model'
import { NewOrderView } from '../new/view/NewOrderView'
import {
  AMEND_PREVIEW,
  AMEND_PREVIEW_PROBLEMS,
  AMENDED_SUMMARY,
  amendmentsFor,
  at,
  BLK,
  BRN,
  COMPANY,
  CANCEL_BLOCKED,
  CANCEL_CHECK,
  CANCEL_CONFIRMED,
  canOf,
  deposit,
  forRole,
  inShell,
  LINE_BLK,
  LINE_RED,
  MANUAL_PREVIEW,
  MANUAL_PROBLEMS,
  NO_AMENDMENTS,
  order,
  PAID,
  panelsModel,
  PARTY,
  PREFIX,
  SCHEDULE,
  SCHEDULE_NONE,
  SCHEDULE_OVERDUE,
  SCHEDULE_REMADE,
  sdi,
  SENT_LINK,
  SETTLEMENT_OPEN,
  SETTLEMENT_SHIPPED,
  STYLE,
  STYLE_ID,
  STYLE_ROWS,
  TD02,
  TD02_ID,
  TODAY,
  VERSIONS,
  WORK_ORDERS,
  type Role,
} from '../_demo/fixtures'
import { COMPOSER_EMPTY, type AmendState, type OrderRecordModel } from './record-model'
import { OrderRecordView } from './view/OrderRecordView'

/**
 * SCR-039 — the order studio (design sales.orders "Record: Sales order") with made-up data only: every tab, the states
 * (loading, error, not found, no permission, held with its reason, read-only, closed, cancelled, changed meanwhile), the
 * deposit end to end (asked → bank-details page sent → payment recorded → TD02 issued → SDI) with each dialog and the
 * step-up, and the roles: Owner, Sales (prices and margin %, no cost: S2), Finance (records payments, issues the TD02)
 * and the Production manager (read-only, no money; makes work orders). B-W2a-50: Amend order (the lines as an amendment
 * draft, the review), Close remaining lines and Reopen, Cancel order with its impact and the typed number, Copy as new
 * quote, the payment schedule, the amended band — and a typed New order (the draft studio before "Confirm order").
 */

type RecordCase = { role: Role; record: OrderRecordModel; draft?: undefined } | { role: Role; draft: NewOrderModel; record?: undefined }

const CHAIN_SDI = (code: Parameters<typeof sdi>[0], action: Parameters<typeof sdi>[1], canSend = false) => ({ [TD02_ID]: { value: sdi(code, action, canSend), problem: null } })

export const base = (role: Role, value: Order, over: Partial<OrderRecordModel> = {}): { role: Role; record: OrderRecordModel } => {
  const can = canOf(role)
  return {
    role,
    record: {
      prefix: PREFIX,
      can,
      today: TODAY,
      tab: 'lines',
      order: { status: 'ready', value: forRole(value, role) },
      workOrders: can.viewWorkOrders ? { value: value.chain.workOrders.length > 0 ? WORK_ORDERS : [], problem: null } : null,
      settlement: can.viewInvoices ? { value: forRole(value.status === 'SHIPPED' || value.status === 'CLOSED' ? SETTLEMENT_SHIPPED : SETTLEMENT_OPEN, role), problem: null } : null,
      sdi: can.viewInvoices ? (value.chain.invoices.some((invoice) => invoice.id === TD02_ID) ? CHAIN_SDI('DELIVERED', 'NONE') : {}) : null,
      versions: can.viewQuotes ? { value: VERSIONS, problem: null } : null,
      live: 'live',
      dockOpen: false,
      changed: null,
      notice: null,
      busy: false,
      dialog: null,
      dialogProblem: null,
      sentLink: null,
      recorded: null,
      stepUp: STEP_UP_CLOSED,
      sizeLayer: 'ordered',
      amend: null,
      schedule: { value: forRole(value.status === 'CONFIRMED' ? { ...SCHEDULE, steps: SCHEDULE.steps.map((step) => (step.kind === 'DEPOSIT' ? { ...step, status: 'OPEN' as const, paidAt: null } : step)) } : SCHEDULE, role), problem: null },
      amendments: { value: value.amendments.count > 0 ? amendmentsFor(role) : NO_AMENDMENTS, problem: null },
      changeStyles: {},
      cancelCheck: null,
      closedLines: null,
      copied: null,
      panelsPreview: panelsModel(),
      ...over,
    },
  }
}

const confirmed = order('CONFIRMED')
const pageSent = order('CONFIRMED', { chain: { ...confirmed.chain, depositRequests: [deposit({ link: SENT_LINK })] } })
const partPaid = order('CONFIRMED', { chain: { ...confirmed.chain, depositRequests: [deposit({ link: SENT_LINK, paidAmount: 100000 })] } })
const paidNotSent = order('CONFIRMED', { chain: { ...confirmed.chain, depositRequests: [PAID], invoices: [TD02] } })
const paidDraft = order('CONFIRMED', { chain: { ...confirmed.chain, depositRequests: [PAID], invoices: [{ ...TD02, number: null, status: 'DRAFT', issueDate: null }] } })
const noTd02 = order('CONFIRMED', { chain: { ...confirmed.chain, depositRequests: [deposit({ fiscalDocument: 'NONE', fiscalRule: 'DEPOSIT_EU_B2B_GOODS', status: 'PAID', paidAt: at(29, 9), paidAmount: 228384, link: SENT_LINK })] } })
const noDeposit = order('CONFIRMED', { depositRequired: false, chain: { ...confirmed.chain, depositRequests: [] } })
const production = order('IN_PRODUCTION')
const partly = order('PARTLY_SHIPPED')
const shipped = order('SHIPPED')
const settled = order('SHIPPED', { settled: true })
const closed = order('CLOSED', { settled: true, actions: [] })
const cancelled = order('CANCELLED', { actions: [], chain: { ...confirmed.chain, depositRequests: [deposit({ status: 'CANCELLED' })] } })
const late = order('IN_PRODUCTION', { promiseDate: '2026-10-24', daysLate: 5 })

const RECORDED = {
  payment: { id: '0190f0e2-1717-7000-8000-000000000001', amount: 228384, receivedOn: TODAY, externalRef: 'CRO-0000-ESEMPIO-88' },
  depositRequest: { id: PAID.id, status: 'PAID' },
  depositInvoice: { required: true, invoice: { id: TD02_ID, number: TD02.number, docType: 'TD02', status: 'ISSUED', issueDate: TODAY }, filesPending: false },
}

// ---- B-W2a-50 ---------------------------------------------------------------------------------------------------------

export const amended = (value: Order): Order => ({ ...value, amendments: AMENDED_SUMMARY, reapprovalNeededAt: at(30, 11, 5), customerRef: 'PO-ESEMPIO-88B' })

/** The amendment draft of an order (optionally with typed changes). */
function amendOf(value: Order, change: (lines: DraftLine[]) => DraftLine[] = (lines) => lines, over: Partial<AmendState> = {}): AmendState {
  return {
    revision: (value.amendments.latestRevision ?? 0) + 1,
    lines: change(draftOf(value)),
    customerRef: value.customerRef ?? '',
    requestedDate: value.requestedDate ?? '',
    styles: { [STYLE_ID]: STYLE },
    composer: COMPOSER_EMPTY,
    review: null,
    ...over,
  }
}
const moreBlack = (lines: DraftLine[]): DraftLine[] => [
  ...lines.map((line) => (line.lineId === LINE_BLK ? { ...line, sizes: { ...line.sizes, '50': 3, '52': 3 } } : line)),
  { key: newKey(STYLE_ID, BRN.id), lineId: null, styleId: STYLE_ID, colourwayId: BRN.id, sizes: { '50': 2, '52': 2 }, price: '450', locked: false },
]
const underMade = (lines: DraftLine[]): DraftLine[] => lines.map((line) => (line.lineId === LINE_BLK ? { ...line, sizes: { ...line.sizes, '48': 1 } } : line))

/** A partly shipped order whose red line was closed short (2 pieces of 54 will not be made). */
export const closedShort = (() => {
  const value = order('PARTLY_SHIPPED')
  return {
    ...value,
    lines: value.lines.map((line) => (line.id === LINE_RED ? { ...line, closedShort: { quantity: 2, at: at(30, 16), byId: null, reason: 'Pelle rossa finita: il cliente accetta meno pezzi.' } } : line)),
    progress: { ...value.progress, closedShort: 2 },
    dailyActions: value.dailyActions.map((entry) => (entry.action === 'reopenLines' ? { ...entry, allowed: true, held: null } : entry)),
  }
})()

const COPIED = { quote: { id: '0190f0e2-4141-7000-8000-000000000201', number: 'QT-2026-00201' }, dropped: [{ seq: 20, size: '56' }], warnings: [] }

/** The typed New order (the draft studio before "Confirm order"). */
function draftCase(role: Role, over: Partial<NewOrderModel> = {}): RecordCase {
  const can = canOf(role)
  return {
    role,
    draft: {
      prefix: PREFIX,
      can,
      today: TODAY,
      header: { companyId: COMPANY, partyId: PARTY.id, contactId: PARTY.contacts[0]!.id, customerRef: 'PO-ESEMPIO-89' },
      party: { status: 'ready', value: PARTY },
      number: 'SO-2026-0089',
      draft: { lines: [], requestedDate: '', promiseDate: '', internalNote: '' },
      styles: {},
      composer: COMPOSER_EMPTY,
      preview: { phase: 'idle', value: null, problem: null },
      busy: false,
      problem: null,
      ...over,
    },
  }
}
const TYPED: DraftLine[] = [
  { key: newKey(STYLE_ID, BLK.id), lineId: null, styleId: STYLE_ID, colourwayId: BLK.id, sizes: { '48': 2, '50': 2, '52': 2, '54': 2 }, price: '', locked: false },
  { key: newKey(STYLE_ID, BRN.id), lineId: null, styleId: STYLE_ID, colourwayId: BRN.id, sizes: { '50': 2, '52': 2 }, price: '430', locked: false },
]
const typedDraft = { lines: TYPED, requestedDate: '2026-12-01', promiseDate: '2026-12-08', internalNote: 'Etichetta del cliente sulle giacche.' }

function OrderDesign({ model }: { model: RecordCase }) {
  if (model.draft) return inShell('/sales/orders/new', createElement(NewOrderView, { model: model.draft }), model.role)
  return inShell(`/sales/orders/${model.record.order.status === 'ready' ? model.record.order.value.id : 'x'}`, createElement(OrderRecordView, { model: model.record }), model.role)
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-039',
  title: 'Order studio: lines, dates, production, shipments, invoices & payments with the deposit, documents',
  view: OrderDesign,
  cases: [
    { id: 'held-deposit', label: 'Owner · Lines: a new order; Make work orders held — production waits for the deposit', model: base('owner', confirmed), note: 'Held with its first blocking reason (hover or focus the button). The summary rail: money by every grain, cost too; the record chain.' },
    { id: 'sales-lines', label: 'Sales · Lines: prices and margin %, no cost (S2); making work orders is production’s', model: base('sales', confirmed) },
    { id: 'lines-shipped-layer', label: 'Sales · Lines: Show = Shipped on a partly shipped order', model: base('sales', partly, { sizeLayer: 'shipped' }) },
    { id: 'lines-in-work-orders', label: 'Sales · Lines: Show = In work orders', model: base('sales', production, { sizeLayer: 'inWorkOrders' }) },
    { id: 'manager-lines', label: 'Production manager · Lines: no money; read-only', model: base('manager', paidNotSent) },
    { id: 'money-new', label: 'Owner · Invoices & payments: deposit asked, page not sent yet', model: base('owner', confirmed, { tab: 'money' }), note: 'The five steps: asked → bank-details page → payment → TD02 → SDI, each with what moves it on.' },
    { id: 'link-dialog', label: 'Owner · Send the bank-details page (DEPOSIT_INFO link)', model: base('owner', confirmed, { tab: 'money', dialog: { kind: 'depositLink', requestId: PAID.id }, draft: { message: 'Buongiorno, ecco i dati per il bonifico dell’acconto.' } }) },
    {
      id: 'link-sent',
      label: 'Owner · The page sent: to whom, until when',
      model: base('owner', pageSent, { tab: 'money', dialog: { kind: 'depositLink', requestId: PAID.id }, sentLink: { link: { id: '0190f0e2-1616-7000-8000-000000000001', expiresAt: SENT_LINK.expiresAt, to: SENT_LINK.to!, revokedLinkIds: [] }, emailId: '0190f0e2-1515-7000-8000-000000000001', delivery: 'sent' } }),
    },
    { id: 'money-page-sent', label: 'Finance · Page sent, waiting for the transfer', model: base('finance', pageSent, { tab: 'money' }) },
    { id: 'money-sales', label: 'Sales · Invoices & payments: sees the deposit; sending and recording held with the reason', model: base('sales', pageSent, { tab: 'money' }) },
    { id: 'payment-dialog', label: 'Finance · Record the payment: amount, day, bank reference, Issue the TD02 now', model: base('finance', pageSent, { tab: 'money', dialog: { kind: 'depositPayment', requestId: PAID.id }, draft: { reference: 'CRO-0000-ESEMPIO-88' } }) },
    { id: 'payment-dialog-over', label: 'Finance · Record the payment: more than is left (the rest stays on the payment)', model: base('finance', partPaid, { tab: 'money', dialog: { kind: 'depositPayment', requestId: PAID.id }, draft: { amount: '2000,00', reference: 'CRO-0000-ESEMPIO-89' } }) },
    { id: 'payment-refused', label: 'Finance · Record the payment: the bank reference was recorded already', model: base('finance', pageSent, { tab: 'money', dialog: { kind: 'depositPayment', requestId: PAID.id }, draft: { reference: 'CRO-0000-ESEMPIO-01' }, dialogProblem: { key: 'problem.write.reference' } }) },
    { id: 'step-up', label: 'Finance · Issuing the TD02 asks a fresh authenticator code', model: base('finance', pageSent, { tab: 'money', dialog: { kind: 'depositPayment', requestId: PAID.id }, draft: { reference: 'CRO-0000-ESEMPIO-88' }, busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.td02', problem: null } }) },
    { id: 'payment-done', label: 'Finance · Recorded: the deposit is paid and the TD02 issued', model: base('finance', paidNotSent, { tab: 'money', dialog: { kind: 'depositPayment', requestId: PAID.id }, recorded: RECORDED, sdi: CHAIN_SDI('NOT_SENT', 'SEND', true) }) },
    { id: 'td02-not-sent', label: 'Finance · Paid; TD02 issued, not sent to SDI yet: Send to SDI', model: base('finance', paidNotSent, { tab: 'money', sdi: CHAIN_SDI('NOT_SENT', 'SEND', true) }) },
    { id: 'sdi-dialog', label: 'Finance · Send the TD02 to SDI', model: base('finance', paidNotSent, { tab: 'money', sdi: CHAIN_SDI('NOT_SENT', 'SEND', true), dialog: { kind: 'sdiSend', invoiceId: TD02_ID } }) },
    { id: 'td02-at-sdi', label: 'Finance · TD02 at SDI: waiting for its answer', model: base('finance', paidNotSent, { tab: 'money', sdi: CHAIN_SDI('AT_SDI', 'WAIT'), notice: { tone: 'success', words: { key: 'notice.sdiSent' } } }) },
    { id: 'td02-delivered', label: 'Owner · TD02 delivered by SDI; production may start', model: base('owner', paidNotSent, { tab: 'money', sdi: CHAIN_SDI('DELIVERED', 'NONE') }) },
    { id: 'td02-draft', label: 'Sales · Paid; the TD02 is a draft finance issues', model: base('sales', paidDraft, { tab: 'money' }) },
    { id: 'part-paid', label: 'Finance · A part payment: what is left', model: base('finance', partPaid, { tab: 'money' }) },
    { id: 'deposit-no-td02', label: 'Finance · An EU business deposit: paid, no deposit invoice (its VAT rule)', model: base('finance', noTd02, { tab: 'money' }) },
    { id: 'no-deposit', label: 'Sales · An order that needs no deposit', model: base('sales', noDeposit, { tab: 'money' }) },
    { id: 'manager-money', label: 'Production manager · Invoices & payments without money or invoices', model: base('manager', paidNotSent, { tab: 'money' }) },
    { id: 'production-gate-paid', label: 'Production manager · Production: deposit paid, Make work orders opens New work order', model: base('manager', paidNotSent, { tab: 'production' }) },
    { id: 'production-held', label: 'Sales · Production: the gate waits for the deposit; Make work orders held', model: base('sales', confirmed, { tab: 'production' }) },
    { id: 'production-progress', label: 'Sales · Production: two work orders with their floor progress', model: base('sales', production, { tab: 'production' }) },
    { id: 'production-no-right', label: 'Finance · Production: the work orders by number (no floor progress right)', model: base('finance', production, { tab: 'production' }) },
    { id: 'production-error', label: 'Sales · Production: the work orders could not be read (Try again)', model: base('sales', production, { tab: 'production', workOrders: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'dates', label: 'Sales · Dates & promise: first promise kept, two changes with who and why', model: base('sales', late, { tab: 'dates' }) },
    { id: 'promise-dialog', label: 'Sales · Change promise date: the whole order', model: base('sales', production, { tab: 'dates', dialog: { kind: 'promise' }, draft: { date: '2026-12-29', reason: 'La pelle nera arriva una settimana dopo.' } }) },
    { id: 'promise-lines', label: 'Sales · Change promise date: chosen lines', model: base('sales', production, { tab: 'dates', dialog: { kind: 'promise' }, draft: { scope: 'lines', lineIds: [production.lines[1]!.id], date: '2026-12-29', reason: 'Il rosso chiede un secondo bagno di colore.' } }) },
    { id: 'ready-dialog', label: 'Sales · Mark ready (quality release not used for this order)', model: base('sales', production, { dialog: { kind: 'ready' }, draft: { reason: 'Controllo finale fatto in reparto.' } }) },
    { id: 'shipments', label: 'Sales · Shipments: left to ship per size, two shipments', model: base('sales', shipped, { tab: 'shipments' }) },
    { id: 'shipments-empty', label: 'Sales · Shipments: nothing shipped yet', model: base('sales', production, { tab: 'shipments' }) },
    { id: 'shipped-close-settled', label: 'Sales · Shipped and settled: Close order', model: base('sales', settled, { tab: 'money' }) },
    { id: 'close-dialog-settled', label: 'Sales · Close a settled order', model: base('sales', settled, { dialog: { kind: 'close' } }) },
    { id: 'shipped-unsettled-sales', label: 'Sales · Shipped, not settled: Close held (the right to close unsettled orders)', model: base('sales', shipped, { tab: 'money' }) },
    { id: 'close-dialog-unsettled', label: 'Finance · Close an unsettled order: what is missing, a reason', model: base('finance', shipped, { dialog: { kind: 'close' }, draft: { reason: 'Il cliente salda a parte con il prossimo ordine.' } }) },
    { id: 'closed', label: 'Owner · Closed: final, nothing changes', model: base('owner', closed) },
    { id: 'cancelled', label: 'Sales · Cancelled with its reason', model: base('sales', cancelled) },
    { id: 'documents', label: 'Sales · Documents: the accepted quote and its evidence', model: base('sales', paidNotSent, { tab: 'documents' }) },
    { id: 'documents-no-right', label: 'Production manager · Documents: the quote by number only', model: base('manager', paidNotSent, { tab: 'documents' }) },
    { id: 'activity', label: 'Sales · Activity: thread, files, history', model: base('sales', paidNotSent, { tab: 'activity' }) },
    { id: 'dock', label: 'Sales · The thread beside a tab (⌘J, 1280 px and wider)', model: base('sales', paidNotSent, { dockOpen: true }) },
    { id: 'changed', label: 'Sales · Someone changed the order while a dialog was open', model: base('sales', production, { changed: { at: at(29, 10, 42) } }) },
    { id: 'notice', label: 'Sales · After a write: a notice', model: base('sales', production, { tab: 'dates', notice: { tone: 'success', words: { key: 'notice.promise' } } }) },
    { id: 'loading', label: 'Loading', model: { ...base('sales', confirmed), record: { ...base('sales', confirmed).record, order: { status: 'loading' }, live: 'connecting' } } },
    { id: 'error', label: 'The read failed (in words, Try again)', model: { ...base('sales', confirmed), record: { ...base('sales', confirmed).record, order: { status: 'error', problem: 'problem.read.unavailable' } } } },
    { id: 'not-found', label: 'Not found (another company, or a wrong address)', model: { ...base('sales', confirmed), record: { ...base('sales', confirmed).record, order: { status: 'not_found' } } } },
    { id: 'no-permission', label: 'No permission (orders.view over its company and customer)', model: { ...base('sales', confirmed), record: { ...base('sales', confirmed).record, order: { status: 'forbidden' } } } },
    // ---- B-W2a-50: the order every day ------------------------------------------------------------------------------------
    { id: 'amend-start', label: 'W2a · Sales · Amend order: the lines become a draft; Review held until something changes', model: base('sales', confirmed, { amend: amendOf(confirmed) }), note: 'Type in the grid (arrows, paste); the bar counts the lines that change; ⌘↵ = Review.' },
    { id: 'amend-draft', label: 'W2a · Sales · Amendment draft: black 50 and 52 one more, brown added at 450', model: base('sales', confirmed, { amend: amendOf(confirmed, moreBlack) }) },
    { id: 'amend-under-work-orders', label: 'W2a · Sales · In production: a size typed under what work orders make (held, said in the grid)', model: base('sales', production, { amend: amendOf(production, underMade) }) },
    { id: 'amend-composer', label: 'W2a · Sales · Amendment: Add a style — the style picked, its colours to add', model: base('sales', confirmed, { amend: amendOf(confirmed, (lines) => lines, { composer: { ...COMPOSER_EMPTY, query: 'DEMO', results: STYLE_ROWS, chosen: STYLE, picked: [BRN.id] } }) }) },
    { id: 'amend-search', label: 'W2a · Sales · Amendment: Add a style — the search results', model: base('sales', confirmed, { amend: amendOf(confirmed, (lines) => lines, { composer: { ...COMPOSER_EMPTY, query: 'DEMO', results: STYLE_ROWS } }) }) },
    { id: 'amend-review', label: 'W2a · Sales · Review amendment: lines old → new by size, money change, the customer accepts again', model: base('sales', confirmed, { amend: amendOf(confirmed, moreBlack, { review: { phase: 'ready', preview: AMEND_PREVIEW, problem: null } }), dialog: { kind: 'amendReview' }, draft: { reason: 'Il cliente aggiunge due giacche nere e quattro marroni.' } }) },
    { id: 'amend-review-reading', label: 'W2a · Sales · Review amendment: reading the API’s preview', model: base('sales', confirmed, { amend: amendOf(confirmed, moreBlack, { review: { phase: 'reading', preview: null, problem: null } }), dialog: { kind: 'amendReview' } }) },
    { id: 'amend-review-problems', label: 'W2a · Sales · Review amendment refused by place, in words (Apply held)', model: base('sales', production, { amend: amendOf(production, moreBlack, { review: { phase: 'ready', preview: AMEND_PREVIEW_PROBLEMS, problem: null } }), dialog: { kind: 'amendReview' } }) },
    { id: 'amend-review-moved', label: 'W2a · Sales · Apply refused: someone changed the order meanwhile (read again)', model: base('sales', confirmed, { amend: amendOf(confirmed, moreBlack, { review: { phase: 'ready', preview: AMEND_PREVIEW, problem: null } }), dialog: { kind: 'amendReview' }, dialogProblem: { key: 'problem.write.moved' }, draft: { reason: 'Due giacche in più.' } }) },
    { id: 'amend-held-shipped', label: 'W2a · Sales · Partly shipped: Amend order held — the lines are fixed once anything shipped', model: base('sales', order('PARTLY_SHIPPED')) },
    { id: 'amended-band', label: 'W2a · Sales · An amended order: “Amended · rev 2”, waiting for the customer to accept again', model: base('sales', amended(production)) },
    { id: 'close-lines-dialog', label: 'W2a · Sales · Close remaining lines: what will not be made or shipped, the reason, the reversal', model: base('sales', order('PARTLY_SHIPPED'), { dialog: { kind: 'closeLines' }, draft: { reason: 'Il cliente non vuole il resto.' } }) },
    { id: 'close-lines-done', label: 'W2a · Sales · Lines closed: what work orders still make is Production’s', model: base('sales', closedShort, { dialog: { kind: 'closeLines' }, closedLines: { order: closedShort, closed: [{ lineId: LINE_RED, seq: 20, closedShortQuantity: 2 }], reducesDone: [], stillInWorkOrders: [{ lineId: LINE_RED, pieces: 2 }] } }) },
    { id: 'closed-short', label: 'W2a · Sales · Lines: the red line closed short (2 pieces) with its reason', model: base('sales', closedShort) },
    { id: 'reopen-dialog', label: 'W2a · Sales · Reopen lines (the close’s reversal)', model: base('sales', closedShort, { dialog: { kind: 'reopenLines' }, draft: { reason: 'Arrivata altra pelle rossa.' } }) },
    { id: 'cancel-dialog', label: 'W2a · Sales · Cancel order in production: what it changes and leaves behind; reason; the number typed', model: base('sales', production, { dialog: { kind: 'cancel' }, cancelCheck: { value: CANCEL_CHECK, problem: null }, draft: { reason: 'Il cliente ha chiuso la stagione.', typed: 'SO-2026-0088' } }), note: 'Cancel order waits for the reason and the number typed exactly.' },
    { id: 'cancel-confirmed', label: 'W2a · Owner · Cancel a new confirmed order: its open deposit is cancelled with it', model: base('owner', confirmed, { dialog: { kind: 'cancel' }, cancelCheck: { value: CANCEL_CONFIRMED, problem: null } }) },
    { id: 'cancel-blocked', label: 'W2a · Sales · Cancel order stopped: a draft work order, a shipment being packed, an invoice issued', model: base('sales', order('READY'), { dialog: { kind: 'cancel' }, cancelCheck: { value: CANCEL_BLOCKED, problem: null } }) },
    { id: 'cancel-reading', label: 'W2a · Sales · Cancel order: reading the impact check', model: base('sales', production, { dialog: { kind: 'cancel' }, cancelCheck: { value: null, problem: null } }) },
    { id: 'cancel-failed', label: 'W2a · Sales · Cancel order: the impact check could not be read (Try again)', model: base('sales', production, { dialog: { kind: 'cancel' }, cancelCheck: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'copy-quote', label: 'W2a · Sales · Copy as new quote', model: base('sales', cancelled, { dialog: { kind: 'copyQuote' } }) },
    { id: 'copy-quote-done', label: 'W2a · Sales · Copied: the new quote and what it left out', model: base('sales', cancelled, { dialog: { kind: 'copyQuote' }, copied: COPIED }) },
    { id: 'money-schedule', label: 'W2a · Finance · Payment schedule: deposit paid, balance before shipping', model: base('finance', paidNotSent, { tab: 'money' }) },
    { id: 'money-schedule-overdue', label: 'W2a · Finance · Payment schedule: the deposit step overdue', model: base('finance', confirmed, { tab: 'money', schedule: { value: SCHEDULE_OVERDUE, problem: null } }) },
    { id: 'money-schedule-remade', label: 'W2a · Owner · Payment schedule remade by an amendment (one step replaced)', model: base('owner', amended(production), { tab: 'money', schedule: { value: SCHEDULE_REMADE, problem: null } }) },
    { id: 'money-schedule-none', label: 'W2a · Sales · No milestones: paid on invoice terms', model: base('sales', noDeposit, { tab: 'money', schedule: { value: SCHEDULE_NONE, problem: null } }) },
    { id: 'money-schedule-manager', label: 'W2a · Production manager · Payment schedule without money', model: base('manager', paidNotSent, { tab: 'money' }) },
    { id: 'money-schedule-error', label: 'W2a · Sales · The payment schedule could not be read (Try again)', model: base('sales', confirmed, { tab: 'money', schedule: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'new-empty', label: 'W2a · Sales · New order (typed): the draft studio, no line yet — Confirm held', model: draftCase('sales'), note: 'Add a style (n), pick colours, type sizes; the rail prices it as you type.' },
    { id: 'new-priced', label: 'W2a · Sales · New order: two colour lines priced by the API (list price and a typed one), deposit and schedule', model: draftCase('sales', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PREVIEW, problem: null } }) },
    { id: 'new-owner', label: 'W2a · Owner · New order priced: cost too (cost grain)', model: draftCase('owner', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PREVIEW, problem: null } }) },
    { id: 'new-pricing', label: 'W2a · Sales · New order: pricing while typing', model: draftCase('sales', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'reading', value: MANUAL_PREVIEW, problem: null } }) },
    { id: 'new-problems', label: 'W2a · Sales · New order: the API’s problems by place, in words — Confirm held', model: draftCase('sales', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PROBLEMS, problem: null } }) },
    { id: 'new-refused', label: 'W2a · Sales · New order: Confirm refused (said above the lines; the lines stay)', model: draftCase('sales', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PREVIEW, problem: null }, problem: { key: 'problem.write.unavailable' } }) },
    { id: 'new-composer', label: 'W2a · Sales · New order: Add a style — colours picked', model: draftCase('sales', { composer: { ...COMPOSER_EMPTY, query: 'DEMO', results: STYLE_ROWS, chosen: STYLE, picked: [BRN.id] } }) },
    { id: 'new-reading', label: 'W2a · New order: reading the customer', model: draftCase('sales', { party: { status: 'loading' }, number: undefined }) },
    { id: 'new-missing', label: 'W2a · New order: an address without a customer (start again from the list)', model: draftCase('sales', { header: null, party: { status: 'missing' } }) },
    { id: 'new-error', label: 'W2a · New order: the customer could not be read (Try again)', model: draftCase('sales', { party: { status: 'error', problem: 'problem.read.unavailable' } }) },
    { id: 'new-no-manage', label: 'W2a · Finance · New order held: taking orders is the sales right', model: draftCase('finance', { draft: typedDraft, styles: { [STYLE_ID]: STYLE }, preview: { phase: 'ready', value: MANUAL_PREVIEW, problem: null } }) },
  ],
})
