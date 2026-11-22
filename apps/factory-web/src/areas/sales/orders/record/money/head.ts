import type { DepositRequest, Order, Schedule, Settlement } from '../../api'
import { askedOutsideGate, depositGate, stillToPay, type OrderAbilities, type Tone } from '../../model' // F-OM-fx5w (N1): + askedOutsideGate
import type { Part } from '../record-model'
import { word, type MoneyWord } from './word'

/**
 * F-OM-101 (order MONEY tab, 10-design §3) — the tab's ONE answer, above the sections (no card, no h2): where the money of this order
 * stands, in one line ("Deposit € 3,660.00 open, due 25 Nov · page sent 20 Nov · production waits for it."), and, said ONCE for the
 * tab, what this reader is not shown (the money wall: "Amounts are shown to people who see prices."; without invoices.view "Invoices
 * are shown to people who see invoices."). A closed order says its plan no longer changes. Pure: the view says the words.
 *
 * In this order: cancelled (nothing more is owed) · settled · the deposit gate (the release's own rule, model.ts depositGate: never
 * asked · open / part paid / overdue with its page · paid with an extra deposit open; F-OM-fx5w: no deposit needed with an extra deposit
 * open, which production does not wait for) · the balance before shipping · an open goods invoice (its own sentence replaces "Deposit
 * paid"; named for every invoices.view reader, else the order read's own gaps) · nothing to collect yet (the customer pays on the
 * invoice: the terms).
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
 * order is paid or waived already. F-OM-fx5w (N1): or the order needs no deposit (its terms ask none: any deposit asked is extra).
 */
export function isExtraDeposit(order: Pick<Order, 'chain'> & { readonly depositRequired?: boolean }, request: Pick<DepositRequest, 'id'>, schedule: Pick<Schedule, 'requests'> | null): boolean {
  if (schedule?.requests?.find((entry) => entry.id === request.id)?.fromChange) return true
  if (order.depositRequired === false) return true // F-OM-fx5w (N1)
  return liveDepositsOf(order).some((other) => other.id !== request.id && (other.status === 'PAID' || other.status === 'WAIVED'))
}

// ---- F-OM-fx5w (N3, N9, walk 31-A): the first goods invoice still open, as THIS reader may know it — with the price grain by this
// order's open share (else its open amount); without it by the settlement's word-code (B-OM-023: Open · Part paid, every invoices.view
// reader, no amount). A rejected invoice counts for nothing. Null: none open, or no settlement read (no invoices.view: the order read's
// own gaps say the rest, in words). Money's head, Totals' "What is left" and Payments' answer name the same one.
export interface OpenGoods {
  readonly number: string
  /** This order's open part of it (price grain); null: not shown to this reader. */
  readonly amount: number | null
  /** Money came in on it already (Part paid). */
  readonly part: boolean
}

export function openGoodsOf(settlement: Pick<Settlement, 'invoices'> | null, price: boolean): OpenGoods | null {
  for (const invoice of settlement?.invoices ?? []) {
    if (!isGoodsInvoice(invoice) || invoice.status === 'REJECTED' || !invoice.number) continue
    const amount = price ? (invoice.openShare ?? invoice.openAmount ?? null) : null
    const coded = invoice.paymentState ?? null
    if (!(amount !== null ? amount > 0 : coded === 'OPEN' || coded === 'PART_PAID')) continue
    return { number: invoice.number, amount, part: coded === 'PART_PAID' || (price && (invoice.paidAmount ?? 0) > 0) }
  }
  return null
}

/** F-OM-fx5w (N2): the order read's own gaps (every orders.view reader — Totals' "What is left") say the invoices are not paid in full. */
export const balanceDueOf = (order: Pick<Order, 'settlement'>): boolean => order.settlement.missing.some((gap) => gap.code === 'BALANCE_DUE')
// ---- end F-OM-fx5w

/** "Extra deposit € 43.92 open (change rev 1)": its amount with the price grain, its change when the plan read names it. */
function extraOpenWord(request: DepositRequest, schedule: Pick<Schedule, 'requests'> | null, price: boolean): MoneyWord {
  const left = stillToPay(request)
  const revision = schedule?.requests?.find((entry) => entry.id === request.id)?.fromChange?.revision ?? null
  const amount = price && request.amount !== undefined ? (left ?? request.amount) : null
  const key = `moneyTab.head.extraOpen${revision !== null ? 'From' : ''}${amount !== null ? '' : 'Words'}`
  return word(key, { ...(amount !== null ? { money: { amount } } : {}), ...(revision !== null ? { params: { revision } } : {}) })
}

export function moneyHeadOf(input: { readonly order: Order; readonly schedule: Part<Schedule> | null; readonly settlement: Settlement | null; readonly can: Pick<OrderAbilities, 'price' | 'viewInvoices'>; readonly today: string; /** F-OM-303: the settlement read failed (its section says so with Try again). */ readonly settlementFailed?: boolean }): MoneyHead {
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
      parts.push(extraOpenWord(request, schedule, price))
      tone = 'warning'
    } else {
      // F-OM-fx3 (B-OM-024, W-01 / W-02): "Deposit € 15.00 short — probably bank charges" only when the plan read says the company's
      // write-off tolerance covers it (price grain); any other part payment is "the deposit is part paid" — never "short".
      const short = schedule?.requests?.find((entry) => entry.id === request.id)?.short ?? null
      const part = ((request.paidAmount ?? 0) > 0 && (left ?? 1) > 0) || !!short
      const overdue = request.dueDate < today
      const missing = short?.amount ?? left
      if (part) parts.push(price && short?.withinTolerance && missing !== null ? word('moneyTab.head.depositShort', { money: { amount: missing } }) : word('moneyTab.head.depositPartPaid'))
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
  // F-OM-fx5w (N1): no deposit needed, an extra deposit asked all the same — money to collect, named; production does not wait for it.
  const asked = gate.state === 'NOT_NEEDED' ? askedOutsideGate(order) : null
  if (asked) {
    parts.push(extraOpenWord(asked, schedule, price))
    tone = 'warning'
  }

  const balance = schedule?.steps.find((step) => step.kind === 'BEFORE_SHIPPING' && step.status === 'OPEN') ?? null
  if (balance) parts.push(balance.sharePct ? word(balance.dueDate ? 'moneyTab.head.beforeShipping' : 'moneyTab.head.beforeShippingNoDay', { pcts: { share: balance.sharePct }, ...(balance.dueDate ? { days: { date: balance.dueDate } } : {}) }) : word('moneyTab.head.balanceBeforeShipping'))

  // An open goods invoice says where the money stands now: its sentence replaces "Deposit paid / waived". With invoices.view the first
  // one still open, named (its amount with the price grain: by this order's share); F-OM-fx5w (N2): without the settlement read (no
  // invoices.view) the order read's own gaps — the source Totals draws — so the head and Totals never disagree (never a false "paid").
  const open = openGoodsOf(settlement, price)
  const unpaid = !!open || balanceDueOf(order) || !!settlement?.gaps.includes('BALANCE_DUE')
  if (unpaid && gate.state !== 'WAITING' && gate.state !== 'MISSING') {
    const kept = parts.filter((entry) => entry.key !== 'moneyTab.head.depositPaid' && entry.key !== 'moneyTab.head.depositWaived')
    parts.splice(0, parts.length, ...(settlement?.fullyInvoiced ? [word('moneyTab.head.invoicedAll')] : []), ...kept)
    // F-OM-fx5w (N9): a reader without prices is told which invoice too ("still to pay on FT-…"), never only "not paid in full".
    parts.push(open ? (open.amount !== null ? word('moneyTab.head.stillToPayOn', { money: { amount: open.amount }, params: { number: open.number } }) : word('moneyTab.head.stillToPayOnWords', { params: { number: open.number } })) : word('moneyTab.head.invoicesOpen'))
    if (tone === 'info') tone = 'warning'
  }

  if (parts.length === 0) {
    // F-OM-303: a failed part never says "nothing" or "all paid": the head says a part could not be read (its section has Try again).
    if (input.schedule?.problem || input.settlementFailed) return done('warning', [word('moneyTab.head.partFailed')])
    const invoiced = order.chain.invoices.some(isGoodsInvoice)
    if (invoiced) return done('info', [word('moneyTab.head.allPaid')])
    return done('neutral', [order.paymentTerms ? word('moneyTab.head.nothingTerms', { params: { terms: order.paymentTerms } }) : word('moneyTab.head.nothing')])
  }
  // Deposit paid and nothing else said: where the rest is paid (on the invoice), when a step says so (F-OM-fx5w, N1: an extra deposit
  // asked on an order that needs none, too).
  const restOnInvoice = !balance && !unpaid && (gate.state === 'PAID' || gate.state === 'WAIVED' || !!asked) && (schedule?.steps ?? []).some((step) => (step.kind === 'ON_INVOICE' || step.kind === 'ON_DELIVERY') && step.status === 'OPEN')
  if (restOnInvoice) parts.push(word('moneyTab.head.restOnInvoice'))
  return done(tone, parts)
}
