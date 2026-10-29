import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Order } from '../api'
import { STEP_UP_CLOSED } from '../hooks'
import { at, canOf, deposit, forRole, inShell, order, PAID, panelsModel, PREFIX, sdi, SENT_LINK, SETTLEMENT_OPEN, SETTLEMENT_SHIPPED, TD02, TD02_ID, TODAY, VERSIONS, WORK_ORDERS, type Role } from '../_demo/fixtures'
import type { OrderRecordModel } from './record-model'
import { OrderRecordView } from './view/OrderRecordView'

/**
 * SCR-039 — the order studio (design sales.orders "Record: Sales order") with made-up data only: every tab, the states
 * (loading, error, not found, no permission, held with its reason, read-only, closed, cancelled, changed meanwhile), the
 * deposit end to end (asked → bank-details page sent → payment recorded → TD02 issued → SDI) with each dialog and the
 * step-up, and the roles: Owner, Sales (prices and margin %, no cost: S2), Finance (records payments, issues the TD02)
 * and the Production manager (read-only, no money; makes work orders).
 */

interface RecordCase {
  role: Role
  record: OrderRecordModel
}

const CHAIN_SDI = (code: Parameters<typeof sdi>[0], action: Parameters<typeof sdi>[1], canSend = false) => ({ [TD02_ID]: { value: sdi(code, action, canSend), problem: null } })

const base = (role: Role, value: Order, over: Partial<OrderRecordModel> = {}): RecordCase => {
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

function OrderDesign({ model }: { model: RecordCase }) {
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
  ],
})
