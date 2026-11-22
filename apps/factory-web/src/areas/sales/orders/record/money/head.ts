import type { DepositRequest, Order, Schedule, Settlement } from '../../api'
import { depositGate, stillToPay, type OrderAbilities, type Tone } from '../../model'
import type { Part } from '../record-model'
import { word, type MoneyWord } from './word'

/**
 * F-OM-101 (order MONEY tab, 10-design §3) — the tab's ONE answer, above the sections (no card, no h2): where the money of this order
 * stands, in one line ("Deposit € 3,660.00 open, due 25 Nov · page sent 20 Nov · production waits for it."), and, said ONCE for the
 * tab, what this reader is not shown (the money wall: "Amounts are shown to people who see prices."; without invoices.view "Invoices
 * are shown to people who see invoices."). A closed order says its plan no longer changes. Pure: the view says the words.
 *
 * In this order: cancelled (nothing more is owed) · settled · the deposit gate (the release's own rule, model.ts depositGate: never
 * asked · open / part paid / overdue with its page · paid with an extra deposit open) · the balance before shipping · an open goods
 * invoice (its own sentence replaces "Deposit paid") · nothing to collect yet (the customer pays on the invoice: the terms).
 * Without the price grain the same line without amounts (its own keys: never an amount dropped out of a sentence).
 */

export interface MoneyHead {
  readonly tone: Tone
  /** The plan is still being read: one line, no answer yet. */
  readonly reading: boolean
  /** The answer, its parts said one after the other (" · "), ended with a full stop. */
  readonly parts: readonly MoneyWord[]
  /** The money wall, said ONCE for the tab: each a sentence. */
  readonly wall: readonly MoneyWord[]
  /** A closed order: "its money plan no longer changes". */
  readonly closed: MoneyWord | null
}

/** A goods invoice (not a deposit invoice, not a credit note) that is issued. */
const isGoodsInvoice = (invoice: { readonly docType: string; readonly status: string }): boolean => invoice.docType !== 'TD02' && invoice.docType !== 'TD04' && invoice.status !== 'DRAFT'

/** The deposit requests that gate production (not the balance before shipping, not a cancelled one). */
export const liveDepositsOf = (order: Pick<Order, 'chain'>): DepositRequest[] => order.chain.depositRequests.filter((request) => request.status !== 'CANCELLED' && request.stepKind !== 'BEFORE_SHIPPING')

/**
 * An open deposit request that is an EXTRA deposit (a priced change's, L8): the plan read names its change, or another deposit of the
 * order is paid or waived already.
 */
export function isExtraDeposit(order: Pick<Order, 'chain'>, request: Pick<DepositRequest, 'id'>, schedule: Pick<Schedule, 'requests'> | null): boolean {
  if (schedule?.requests?.find((entry) => entry.id === request.id)?.fromChange) return true
  return liveDepositsOf(order).some((other) => other.id !== request.id && (other.status === 'PAID' || other.status === 'WAIVED'))
}

export function moneyHeadOf(input: { readonly order: Order; readonly schedule: Part<Schedule> | null; readonly settlement: Settlement | null; readonly can: Pick<OrderAbilities, 'price' | 'viewInvoices'>; readonly today: string }): MoneyHead {
  const { order, settlement, can, today } = input
  const price = can.price
  const wall = [...(price ? [] : [word('moneyTab.head.wallPrice')]), ...(can.viewInvoices ? [] : [word('money.noInvoiceRight')])]
  const closed = order.status === 'CLOSED' ? word('moneyTab.head.closed') : null
  const done = (tone: Tone, parts: MoneyWord[]): MoneyHead => ({ tone, reading: false, parts, wall, closed })

  if (order.status === 'CANCELLED') return done('neutral', [word('moneyTab.head.cancelled')])
  if (order.settlement.settled) return done('success', [order.closedAt ? word('moneyTab.head.settledOn', { instants: { date: order.closedAt } }) : word('moneyTab.head.settled')])
  const schedule = input.schedule?.value ?? null
  if (!schedule && !input.schedule?.problem) return { tone: 'neutral', reading: true, parts: [word('moneyTab.head.reading')], wall, closed }

  const parts: MoneyWord[] = []
  let tone: Tone = 'info'
  const gate = depositGate(order)
  const request = gate.request
  if (gate.state === 'MISSING' && order.status !== 'CLOSED') {
    parts.push(word('moneyTab.head.depositMissing'), word('moneyTab.head.productionWaits'))
    tone = 'danger'
  } else if (gate.state === 'WAITING' && request) {
    const left = stillToPay(request)
    if (isExtraDeposit(order, request, schedule)) {
      const others = liveDepositsOf(order).filter((other) => other.id !== request.id)
      parts.push(word(others.some((other) => other.status === 'PAID') ? 'moneyTab.head.depositPaid' : 'moneyTab.head.depositWaived'))
      const revision = schedule?.requests?.find((entry) => entry.id === request.id)?.fromChange?.revision ?? null
      const amount = price && request.amount !== undefined ? (left ?? request.amount) : null
      const key = `moneyTab.head.extraOpen${revision !== null ? 'From' : ''}${amount !== null ? '' : 'Words'}`
      parts.push(word(key, { ...(amount !== null ? { money: { amount } } : {}), ...(revision !== null ? { params: { revision } } : {}) }))
      tone = 'warning'
    } else {
      const part = (request.paidAmount ?? 0) > 0 && (left ?? 1) > 0
      const overdue = request.dueDate < today
      if (part) parts.push(price && left !== null ? word('moneyTab.head.depositShort', { money: { amount: left } }) : word('moneyTab.head.depositPartPaid'))
      else {
        const amount = price && request.amount !== undefined ? request.amount : null
        const key = `moneyTab.head.deposit${overdue ? 'Overdue' : 'Open'}${amount !== null ? '' : 'Words'}`
        parts.push(word(key, { days: { date: request.dueDate }, ...(amount !== null ? { money: { amount } } : {}) }))
        parts.push(request.link ? word('moneyTab.head.pageSent', { instants: { date: request.link.sentAt } }) : word('moneyTab.head.pageNotSent'))
      }
      parts.push(word('moneyTab.head.productionWaits'))
      tone = overdue && !part ? 'danger' : 'warning'
    }
  } else if (gate.state === 'PAID') parts.push(word('moneyTab.head.depositPaid'))
  else if (gate.state === 'WAIVED') parts.push(word('moneyTab.head.depositWaived'))

  const balance = schedule?.steps.find((step) => step.kind === 'BEFORE_SHIPPING' && step.status === 'OPEN') ?? null
  if (balance) parts.push(balance.sharePct ? word(balance.dueDate ? 'moneyTab.head.beforeShipping' : 'moneyTab.head.beforeShippingNoDay', { pcts: { share: balance.sharePct }, ...(balance.dueDate ? { days: { date: balance.dueDate } } : {}) }) : word('moneyTab.head.balanceBeforeShipping'))

  // An open goods invoice says where the money stands now (invoices.view): its sentence replaces "Deposit paid / waived". With the
  // price grain the first one still open, by this order's share; without it the settlement's own gap, in words.
  const open = price ? (settlement?.invoices.find((invoice) => isGoodsInvoice(invoice) && !!invoice.number && (invoice.openShare ?? invoice.openAmount ?? 0) > 0) ?? null) : null
  const unpaid = !!open || (!price && !!settlement?.gaps.includes('BALANCE_DUE'))
  if (unpaid && gate.state !== 'WAITING' && gate.state !== 'MISSING') {
    const kept = parts.filter((entry) => entry.key !== 'moneyTab.head.depositPaid' && entry.key !== 'moneyTab.head.depositWaived')
    parts.splice(0, parts.length, ...(settlement?.fullyInvoiced ? [word('moneyTab.head.invoicedAll')] : []), ...kept)
    parts.push(open ? word('moneyTab.head.stillToPayOn', { money: { amount: open.openShare ?? open.openAmount ?? 0 }, params: { number: open.number! } }) : word('moneyTab.head.invoicesOpen'))
    if (tone === 'info') tone = 'warning'
  }

  if (parts.length === 0) {
    const invoiced = order.chain.invoices.some(isGoodsInvoice)
    if (invoiced) return done('info', [word('moneyTab.head.allPaid')])
    return done('neutral', [order.paymentTerms ? word('moneyTab.head.nothingTerms', { params: { terms: order.paymentTerms } }) : word('moneyTab.head.nothing')])
  }
  // Deposit paid and nothing else said: where the rest is paid (on the invoice), when a step says so.
  const restOnInvoice = !balance && !unpaid && (gate.state === 'PAID' || gate.state === 'WAIVED') && (schedule?.steps ?? []).some((step) => (step.kind === 'ON_INVOICE' || step.kind === 'ON_DELIVERY') && step.status === 'OPEN')
  if (restOnInvoice) parts.push(word('moneyTab.head.restOnInvoice'))
  return done(tone, parts)
}
