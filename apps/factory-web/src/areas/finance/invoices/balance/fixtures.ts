import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, ORDER, PREFIX, type Role } from '../../_demo/fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import { InvoiceRecordView } from '../record/view/InvoiceRecordView'
import type { BalanceHold } from './api'
import type { BalanceOrder } from './model'
import { BalanceView, type BalanceModel } from './view/BalanceView'

/**
 * SCR-444 — Balance before shipping on the invoice's Deposits & payments (design finance.invoices rec:Invoice
 * deposits/payments "Balance before shipping (W2b): shipment held until paid"; B-W2b-417 on B-W2b-386's holds; FIN-079),
 * made-up data only: an order whose balance is still open with its shipment held by the system (Record a payment, Let it
 * go…), the reason typed to let it go (held while too short), a refusal, a balance paid with a hold a person placed, no
 * shipment yet, the holds not readable without the right to see shipments, loading and failed; roles Finance and Sales
 * (no amount without the price grain, Let it go held with why). Every order, shipment and amount is invented.
 */

const HOLD: BalanceHold = { id: '0190f0e2-4545-7000-8000-000000000001', inForce: true, bySystem: true, placedAt: '2026-11-12T07:30:00.000Z', mayRelease: true, shipment: { id: '0190f0e2-7272-7000-8000-000000000009', number: 'SH-2026-0009', status: 'PACKED', salesOrderId: ORDER.id, salesOrderNumber: ORDER.number } }
const OPEN: BalanceOrder = { orderId: ORDER.id, number: ORDER.number, open: [{ id: '0190f0e2-4343-7000-8000-000000000013', openAmount: 532896, currency: 'EUR' }], holds: [HOLD] }

interface BalanceCase {
  role: Role
  balance: BalanceModel
}

const base = (role: Role, over: Partial<BalanceModel> = {}): BalanceCase => ({
  role,
  balance: { prefix: PREFIX, price: true, recordPayments: role !== 'sales', orders: [OPEN], problem: null, holdsUnknown: false, releasing: null, words: '', busy: false, writeProblem: null, notice: null, ...over },
})

function BalanceDesign({ model }: { model: BalanceCase }) {
  const record = recordScreen.cases.find((item) => item.id === (model.role === 'sales' ? 'sales-read-only' : 'money'))!.model.record
  return inShell('/finance/invoices/money', createElement(InvoiceRecordView, { model: { ...record, tab: 'money' }, depth: { balance: createElement(BalanceView, { model: model.balance }) } }), model.role)
}

export const designScreen = defineDesignScreen<BalanceCase>({
  screen: 'SCR-444',
  title: 'Invoice › Deposits & payments › Balance before shipping: the shipment held until paid, let it go with the reason',
  view: BalanceDesign,
  cases: [
    { id: 'held', label: 'Finance · Balance of SO-2026-0088 open; shipment SH-2026-0009 held by the system', model: base('finance') },
    { id: 'release', label: 'Finance · Let it go: why it may leave unpaid', model: base('finance', { releasing: HOLD, words: 'Il cliente paga alla consegna, accordo del titolare' }) },
    { id: 'release-short', label: 'Finance · Let it go: the reason too short (held with why)', model: base('finance', { releasing: HOLD, words: 'ok' }) },
    { id: 'release-refused', label: 'Finance · Refused: the shipment is no longer held (said in the dialog)', model: base('finance', { releasing: HOLD, words: 'Il cliente paga alla consegna', writeProblem: { key: 'finance-invoices-depth:refusal.NOT_IN_FORCE', reload: false } }) },
    { id: 'released', label: 'Finance · Let go: the shipment may leave (notice)', model: base('finance', { orders: [{ ...OPEN, holds: [] }], notice: { key: 'balance.released', params: { number: HOLD.shipment.number } } }) },
    { id: 'paid-person-hold', label: 'Finance · The balance paid; a hold a person placed stays until let go', model: base('finance', { orders: [{ ...OPEN, open: [], holds: [{ ...HOLD, bySystem: false }] }] }) },
    { id: 'no-shipment', label: 'Finance · Balance open, no shipment waiting yet', model: base('finance', { orders: [{ ...OPEN, holds: [] }] }) },
    { id: 'holds-unknown', label: 'Finance · The holds not readable (no right to see shipments): said in words', model: base('finance', { orders: [{ ...OPEN, holds: [] }], holdsUnknown: true }) },
    { id: 'sales', label: 'Sales · Let it go held with why; Record a payment absent', model: base('sales', { orders: [{ ...OPEN, holds: [{ ...HOLD, mayRelease: false }] }] }) },
    { id: 'loading', label: 'Loading', model: base('finance', { orders: null }) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: base('finance', { orders: null, problem: 'problem.read.unavailable' }) },
  ],
})
