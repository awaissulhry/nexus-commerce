import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../_shared/hooks'
import { canOf, COMPANY, CUSTOMER, inShell, OPEN_ITEMS, PARTIES, PAYMENT, PAYMENT_REVERSED, PAYMENT_ROWS, PREFIX, TD01_ID, TODAY, withoutPrices, type Role } from '../../_demo/fixtures'
import type { PaymentRecordModel } from '../record/record-model'
import { PaymentRecordView } from '../record/view/PaymentRecordView'
import type { PaymentsListModel } from './list-model'
import { PaymentsListView } from './view/PaymentsListView'

/**
 * SCR-082 — Payments (design finance.payments) with made-up data only: the tiles, every payment with where it is placed
 * and what is left, Record a payment (step 1: the customer, day, amount, bank reference; step 2: where it goes, oldest
 * first, Suggest, what is left; a deposit paid in full with "Issue the deposit invoice (TD02) now" and the step-up), the
 * reference recorded already (held), opened from an invoice, done; the payment record (placed, partly, taken back,
 * voided; Place the rest; Take back with a reason; Void), the states (loading, error, empty, no permission) and the
 * roles: Owner, Finance, Sales (read-only).
 */

type PaymentsCase = { role: Role; kind: 'list'; list: PaymentsListModel } | { role: Role; kind: 'record'; record: PaymentRecordModel }

const list = (role: Role, over: Partial<PaymentsListModel> = {}): PaymentsCase => {
  const can = canOf(role)
  return {
    role,
    kind: 'list',
    list: {
      prefix: PREFIX,
      can,
      today: TODAY,
      companyId: COMPANY,
      rows: 'all',
      list: { items: can.price ? PAYMENT_ROWS : withoutPrices(PAYMENT_ROWS), more: false, problem: null },
      tiles: { monthCount: 6, monthAmount: can.price ? 1440680 : null, notPlacedCount: 2, notPlacedAmount: can.price ? 250000 : null, capped: false },
      asOf: '2026-10-29T15:05:00.000Z',
      live: 'live',
      updates: 0,
      notice: null,
      dialog: null,
      customers: { q: '', items: null, problem: null },
      items: { value: null, problem: null },
      recorded: null,
      busy: false,
      dialogProblem: null,
      stepUp: STEP_UP_CLOSED,
      ...over,
    },
  }
}

const record = (role: Role, payment = PAYMENT, over: Partial<PaymentRecordModel> = {}): PaymentsCase => {
  const can = canOf(role)
  return {
    role,
    kind: 'record',
    record: { prefix: PREFIX, can, today: TODAY, tab: 'allocation', payment: { status: 'ready', value: can.price ? payment : withoutPrices(payment) }, items: { value: null, problem: null }, live: 'live', notice: null, busy: false, dialog: null, dialogProblem: null, ...over },
  }
}

const CUSTOMERS = PARTIES.map((party) => ({ id: party.id, companyId: COMPANY, code: party.code, legalName: party.name, tradeName: null, status: 'ACTIVE', currency: 'EUR', vatNumber: 'IT00000000000' }))
const PICKED = { id: PARTIES[0].id, name: PARTIES[0].name, companyId: COMPANY }
const STEP2 = { kind: 'record' as const, step: 2 as const, customer: PICKED, invoiceId: null }
const DEPOSIT_ONLY = [OPEN_ITEMS[1]!]

function PaymentsDesign({ model }: { model: PaymentsCase }) {
  if (model.kind === 'list') return inShell('/finance/payments', createElement(PaymentsListView, { model: model.list }), model.role)
  const id = model.record.payment.status === 'ready' ? model.record.payment.value.id : 'x'
  return inShell(`/finance/payments/${id}`, createElement(PaymentRecordView, { model: model.record }), model.role)
}

export const designScreen = defineDesignScreen<PaymentsCase>({
  screen: 'SCR-082',
  title: 'Payments: money in, where it is placed, record a payment and place it; the payment record',
  view: PaymentsDesign,
  cases: [
    { id: 'finance', label: 'Finance · Tiles and every payment with where it is placed', model: list('finance') },
    { id: 'owner', label: 'Owner · the same list', model: list('owner') },
    { id: 'sales-read-only', label: 'Sales · Read-only: Record payment held with the reason', model: list('sales') },
    { id: 'record-step1', label: 'Finance · Record a payment: step 1, pick the customer', model: list('finance', { dialog: { kind: 'record', step: 1, customer: null, invoiceId: null }, customers: { q: '', items: CUSTOMERS, problem: null } }) },
    { id: 'record-step1-filled', label: 'Finance · Step 1 filled: customer, day, amount, bank reference', model: list('finance', { dialog: { kind: 'record', step: 1, customer: PICKED, invoiceId: null }, draft: { amount: '2000,00', reference: 'CRO-0000-ESEMPIO-95' } }) },
    { id: 'record-step2', label: 'Finance · Step 2: where it goes, oldest first; Suggest; what is left', model: list('finance', { dialog: STEP2, items: { value: OPEN_ITEMS, problem: null }, draft: { amount: '2000,00', reference: 'CRO-0000-ESEMPIO-95', plan: { [OPEN_ITEMS[0]!.id]: '2000,00' } } }) },
    { id: 'record-from-invoice', label: 'Finance · From an invoice: its balance chosen', model: list('finance', { dialog: { kind: 'record', step: 2, customer: { id: CUSTOMER.id, name: CUSTOMER.name, companyId: COMPANY }, invoiceId: TD01_ID }, items: { value: OPEN_ITEMS, problem: null }, draft: { amount: '5328,96', reference: 'CRO-0000-ESEMPIO-91', plan: { [TD01_ID]: '5328,96' } } }) },
    { id: 'record-deposit', label: 'Finance · A deposit paid in full: Issue the deposit invoice (TD02) now', model: list('finance', { dialog: STEP2, items: { value: DEPOSIT_ONLY, problem: null }, draft: { amount: '1200,00', reference: 'CRO-0000-ESEMPIO-96', plan: { [DEPOSIT_ONLY[0]!.id]: '1200,00' } } }) },
    { id: 'record-step-up', label: 'Finance · Issuing the TD02 asks a fresh authenticator code first', model: list('finance', { dialog: STEP2, items: { value: DEPOSIT_ONLY, problem: null }, busy: true, draft: { amount: '1200,00', reference: 'CRO-0000-ESEMPIO-96', plan: { [DEPOSIT_ONLY[0]!.id]: '1200,00' } }, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.td02', problem: null } }) },
    { id: 'record-too-much', label: 'Finance · More placed than received: held', model: list('finance', { dialog: STEP2, items: { value: OPEN_ITEMS, problem: null }, draft: { amount: '1000,00', reference: 'CRO-0000-ESEMPIO-97', plan: { [OPEN_ITEMS[0]!.id]: '3294,00' } } }) },
    { id: 'record-reference-used', label: 'Finance · The bank reference was recorded already (a transfer counts once)', model: list('finance', { dialog: STEP2, items: { value: OPEN_ITEMS, problem: null }, dialogProblem: { key: 'problem.write.reference' }, draft: { amount: '2000,00', reference: 'CRO-0000-ESEMPIO-42', plan: { [OPEN_ITEMS[0]!.id]: '2000,00' } } }) },
    { id: 'record-no-items', label: 'Finance · The customer has nothing open: the money stays on account', model: list('finance', { dialog: STEP2, items: { value: [], problem: null }, draft: { amount: '500,00', reference: 'CRO-0000-ESEMPIO-98' } }) },
    { id: 'record-done', label: 'Finance · Recorded and placed; the deposit invoice issued', model: list('finance', { dialog: STEP2, recorded: { payment: { ...PAYMENT, externalRef: 'CRO-0000-ESEMPIO-96', unallocated: 0, allocated: 120000, amount: 120000 }, depositInvoice: { required: true, number: 'FT-2026-00034', filesPending: false } } }) },
    { id: 'list-empty', label: 'Finance · No payment recorded yet', model: list('finance', { list: { items: [], more: false, problem: null }, tiles: { monthCount: 0, monthAmount: 0, notPlacedCount: 0, notPlacedAmount: 0, capped: false } }) },
    { id: 'list-voided', label: 'Finance · Rows: Voided', model: list('finance', { rows: 'voided', list: { items: PAYMENT_ROWS.filter((row) => row.status === 'VOIDED'), more: false, problem: null } }) },
    { id: 'list-selected', label: 'Finance · Rows chosen: Export N (CSV)', model: list('finance', { selected: PAYMENT_ROWS.slice(0, 2).map((row) => row.id) }) },
    { id: 'list-loading', label: 'Loading', model: list('finance', { list: { items: null, more: false, problem: null }, tiles: null, asOf: null, live: 'connecting' }) },
    { id: 'list-error', label: 'The read failed (in words, Try again)', model: list('finance', { list: { items: null, more: false, problem: 'problem.read.unavailable' }, tiles: null }) },
    { id: 'list-keys', label: 'Finance · The keys panel (?)', model: list('finance', { helpOpen: true }) },
    { id: 'list-no-permission', label: 'No permission (payments.view over this company)', model: list('sales', { list: { items: null, more: false, problem: 'problem.read.forbidden' }, tiles: null }) },
    { id: 'payment-partly', label: 'Finance · Payment record: partly placed; Place the rest', model: record('finance') },
    { id: 'payment-place', label: 'Finance · Place the rest on the customer’s open items', model: record('finance', PAYMENT, { dialog: { kind: 'place' }, items: { value: OPEN_ITEMS, problem: null } }) },
    { id: 'payment-take-back', label: 'Finance · Take an allocation back (with the reason)', model: record('finance', PAYMENT, { dialog: { kind: 'reverse', allocationId: PAYMENT.allocations[0]!.id }, draft: { note: 'Placed on the wrong invoice.' } }) },
    { id: 'payment-taken-back', label: 'Finance · Taken back: nothing placed now; Void opens', model: record('finance', PAYMENT_REVERSED, { notice: { tone: 'success', words: { key: 'notice.takenBack' } } }) },
    { id: 'payment-void', label: 'Finance · Void a payment typed by mistake', model: record('finance', PAYMENT_REVERSED, { dialog: { kind: 'void' } }) },
    { id: 'payment-voided', label: 'Finance · Voided', model: record('finance', { ...PAYMENT_REVERSED, status: 'VOIDED', voidedAt: '2026-10-25T10:00:00.000Z', voidReason: 'Typed twice.', unallocated: 0 }) },
    { id: 'payment-bank', label: 'Finance · Bank line: recorded by hand', model: record('finance', PAYMENT, { tab: 'bank' }) },
    { id: 'payment-sales', label: 'Sales · Payment record read-only', model: record('sales') },
    { id: 'payment-loading', label: 'Payment record: loading', model: record('finance', PAYMENT, { payment: { status: 'loading' } }) },
    { id: 'payment-not-found', label: 'Payment record: not found', model: record('finance', PAYMENT, { payment: { status: 'not_found' } }) },
    { id: 'payment-no-permission', label: 'Payment record: no permission', model: record('sales', PAYMENT, { payment: { status: 'forbidden' } }) },
  ],
})
