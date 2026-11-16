import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, ORDER, type Role } from '../../_demo/fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import { InvoiceRecordView } from '../record/view/InvoiceRecordView'
import type { CarryPreview } from './api'
import type { DepositToCarry } from './model'
import { DepositCarryView, type CarryModel } from './view/DepositCarryView'

/**
 * SCR-081-carry — "Deposit to carry" on the invoice's Deposits & payments (B-W2b-GB02, G088; B-W2b-21's carry): a deposit paid
 * without a deposit invoice (an EU business with a VIES proof) waits for its order's invoice; what the carry would do and
 * "Carry onto this invoice…" with its confirm; it cannot be carried (said in words); carried (notice); read-only without the
 * right to record payments; no amounts without the price grain; reading and failed. Every number and amount is invented.
 */

const record = (role: Role) => recordScreen.cases.find((item) => item.id === (role === 'sales' ? 'sales-read-only' : 'money'))!.model.record
const INVOICE_ID = (role: Role): string => {
  const loaded = record(role).invoice
  return loaded.status === 'ready' ? loaded.value.id : '0190f0e2-0000-7000-8000-000000000001'
}
const INVOICE_NUMBER = (role: Role): string => {
  const loaded = record(role).invoice
  return (loaded.status === 'ready' ? loaded.value.number : null) ?? 'FT-2026-00031'
}

const preview = (invoiceId: string, over: Partial<CarryPreview> = {}, invoiceNumber = INVOICE_NUMBER('finance')): CarryPreview => ({
  depositRequestId: '0190f0e2-5151-7000-8000-000000000021',
  orderId: ORDER.id,
  orderNumber: ORDER.number,
  currency: 'EUR',
  problem: null,
  amount: 120000,
  steps: [{ allocationId: '0190f0e2-5252-7000-8000-000000000031', paymentId: '0190f0e2-5353-7000-8000-000000000041', invoiceId, invoiceNumber, amount: 120000 }],
  invoices: [{ id: invoiceId, number: invoiceNumber, openAmount: 532896, openAfter: 412896 }],
  ...over,
})

interface CarryCase {
  role: Role
  carry: CarryModel
}

const base = (role: Role, over: Partial<CarryModel> = {}, deposit: Partial<DepositToCarry> = {}): CarryCase => {
  const invoiceId = INVOICE_ID(role)
  return {
    role,
    carry: { invoiceId, invoiceNumber: INVOICE_NUMBER(role), price: role !== 'sales', mayRecord: role !== 'sales', deposits: [{ depositRequestId: '0190f0e2-5151-7000-8000-000000000021', amount: 120000, preview: preview(invoiceId), ...deposit }], problem: null, confirming: null, busy: false, writeProblem: null, notice: null, ...over },
  }
}

function CarryDesign({ model }: { model: CarryCase }) {
  return inShell('/finance/invoices/money', createElement(InvoiceRecordView, { model: { ...record(model.role), tab: 'money' }, depth: { carry: createElement(DepositCarryView, { model: model.carry }) } }), model.role)
}

const waiting = base('finance')

export const designScreen = defineDesignScreen<CarryCase>({
  screen: 'SCR-081-carry',
  title: 'Invoice › Deposits & payments › Deposit to carry: a deposit paid without a deposit invoice placed on its order’s invoice',
  view: CarryDesign,
  cases: [
    { id: 'waiting', label: 'Finance · A deposit of 1,200.00 EUR waits for this invoice: what the carry would do', model: waiting },
    { id: 'confirm', label: 'Finance · Carry onto this invoice: the confirm', model: base('finance', { confirming: waiting.carry.deposits![0]! }) },
    { id: 'refused', label: 'Finance · Refused: carried meanwhile (said in the dialog)', model: base('finance', { confirming: waiting.carry.deposits![0]!, writeProblem: { key: 'problem.write.state' } }) },
    { id: 'cannot', label: 'Finance · It cannot be carried onto this invoice (open for less than the deposit)', model: base('finance', {}, { preview: preview(INVOICE_ID('finance'), { problem: 'The invoice is open for 1,000.00 EUR; the deposit holds 1,200.00 EUR.', amount: 0, steps: [] }) }) },
    { id: 'carried', label: 'Finance · Carried (notice); nothing waits any more', model: base('finance', { deposits: [], notice: { key: 'carried', params: { invoice: INVOICE_NUMBER('finance') } } }) },
    { id: 'previewing', label: 'Finance · Reading what the carry would do', model: base('finance', {}, { preview: null }) },
    { id: 'sales', label: 'Sales · Read only: Carry held with why; no amounts', model: base('sales') },
    { id: 'loading', label: 'Loading', model: base('finance', { deposits: null }) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: base('finance', { deposits: null, problem: 'problem.read.unavailable' }) },
  ],
})
