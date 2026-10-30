import type { MinorUnits } from '../core/money'
import type { BusinessDate } from '../core/time'
import { amountText } from '../invoicing/invoices'

/**
 * Refunds and the credit balance (B-W2a-61; FIN-127, FIN-122; factory-db receivables.prisma Refund; design
 * finance.payments "Refund" pop-up, tile "Refunds to make", the matcher's "Overpayment → customer credit balance"),
 * pure.
 *
 * A refund pays money back to a customer by one bank transfer. It names exactly one source:
 *   a credit note   an issued TD04 on what was already paid (W1's `invoice.refund_due`): what may be refunded is the
 *                   least of the note's gross less its live refunds, and what its invoice is paid beyond what it is now
 *                   worth less the live refunds of all the invoice's credit notes. A TD02 (a deposit invoice) is paid in
 *                   full through its deposit request, so every credit on it is money to give back (the advance of a
 *                   cancelled order, B-W2a-F2's balance before shipping as the deposit).
 *   a payment       the part of a payment received that pays nothing (an overpayment, a transfer twice, money released
 *                   from a credited invoice): the customer's credit balance. What may be refunded is that part.
 * Life: DUE (owed: "Refunds to make") → PAID (the transfer left the bank: its value date and the bank's reference,
 * unique in the company) | CANCELLED (not paid after all: the customer keeps the credit, with why); PAID → VOIDED (typed
 * by mistake, with why). A refund may also be recorded PAID at once. A live refund (DUE or PAID) holds its money: it
 * can no longer be allocated or refunded twice (the …_money_w2a_guards triggers hold it for every login).
 *
 * The credit balance (FIN-122) is not a column: per customer and currency, the RECEIVED payments' amounts less their
 * allocations less their live refunds. It is used by allocating a payment's unplaced part to a later invoice (the W1
 * allocation), refunded (a refund of the payment), or kept. How a credit balance is carried in the books (a customer
 * advance account, its statement wording) is the accountant's: Nexus only keeps the money where it is.
 *
 * Nothing here reaches a bank: the office makes the transfer in its bank and records it here.
 */

export const REFUND_STATUSES = ['DUE', 'PAID', 'CANCELLED', 'VOIDED'] as const
export type RefundStatus = (typeof REFUND_STATUSES)[number]
/** The statuses that hold the refund's money (DUE or PAID). */
export const LIVE_REFUND_STATUSES = ['DUE', 'PAID'] as const satisfies readonly RefundStatus[]
export const REFUND_SOURCES = ['CREDIT_NOTE', 'PAYMENT'] as const
export type RefundSource = (typeof REFUND_SOURCES)[number]
/** The list's views: due (to make), paid, closed (cancelled or voided), all. */
export const REFUND_VIEWS = ['due', 'paid', 'closed', 'all'] as const
export type RefundView = (typeof REFUND_VIEWS)[number]
export const REFUND_STATUSES_BY_VIEW: Readonly<Record<RefundView, readonly RefundStatus[]>> = Object.freeze({
  due: ['DUE'],
  paid: ['PAID'],
  closed: ['CANCELLED', 'VOIDED'],
  all: [...REFUND_STATUSES],
})

export const isLiveRefund = (status: string): boolean => status === 'DUE' || status === 'PAID'

/** What a credited invoice is paid beyond what it is worth now (before refunds): the money a credit gives back. */
export function overpaidOf(invoice: { readonly docType: string; readonly grossTotal: MinorUnits; readonly creditedGross: MinorUnits; readonly paid: MinorUnits }): MinorUnits {
  if (invoice.docType === 'TD02') return Math.max(0, invoice.creditedGross)
  return Math.max(0, invoice.paid - (invoice.grossTotal - invoice.creditedGross))
}

export interface CreditNoteRefundFacts {
  /** The credit note's gross, and its live refunds. */
  readonly noteGross: MinorUnits
  readonly liveOnNote: MinorUnits
  /** Its invoice's overpayment (overpaidOf) and the live refunds of all the invoice's credit notes. */
  readonly overpaid: MinorUnits
  readonly liveOnInvoice: MinorUnits
}

/** What may still be refunded on a credit note. */
export const refundableOnCreditNote = (facts: CreditNoteRefundFacts): MinorUnits => Math.max(0, Math.min(facts.noteGross - facts.liveOnNote, facts.overpaid - facts.liveOnInvoice))

/** A payment's unplaced part (its share of the customer's credit balance): amount less allocations less live refunds. */
export function unplacedOf(payment: { readonly status: string; readonly amount: MinorUnits; readonly allocated: MinorUnits; readonly refunded: MinorUnits }): MinorUnits {
  if (payment.status !== 'RECEIVED') return 0
  return Math.max(0, payment.amount - payment.allocated - payment.refunded)
}

/** Why this amount cannot be refunded (null: it can). `source` in words: "credit note FT-2026-00012", "payment of 3 Nov". */
export function refundAmountProblem(amount: MinorUnits, refundable: MinorUnits, currency: string, source: string): string | null {
  if (refundable <= 0) return `Nothing is left to refund on the ${source}.`
  if (!Number.isSafeInteger(amount) || amount <= 0) return 'A refund of more than 0, in minor units (cents).'
  if (amount > refundable) return `The ${source} has ${amountText(refundable, currency)} left to refund: refund at most that.`
  return null
}

/** Why the bank's value date of a refund made is wrong (null: fine). */
export function paidOnProblem(paidOn: BusinessDate, today: BusinessDate): string | null {
  if (paidOn > today) return 'The transfer left the bank on a day that has not come yet: check the value date.'
  return null
}

/** Why a refund cannot move from its status (null: it can). */
export function refundMoveProblem(status: RefundStatus, to: 'PAID' | 'CANCELLED' | 'VOIDED' | 'CHANGED'): string | null {
  if (to === 'VOIDED') return status === 'PAID' ? null : status === 'VOIDED' ? 'The refund is voided already.' : `The refund is ${status}: only a refund recorded as paid by mistake is voided.`
  if (status === 'DUE') return null
  if (status === 'PAID') return to === 'CHANGED' ? 'The refund is paid: what was paid never changes. Void it if it was typed by mistake.' : 'The refund is paid already.'
  return `The refund is ${status}: it never changes again.`
}

/** The refund's status in words (the office reads them). */
export const REFUND_STATUS_WORDS: Readonly<Record<RefundStatus, { readonly it: string; readonly en: string }>> = Object.freeze({
  DUE: { it: 'Da rimborsare', en: 'To refund' },
  PAID: { it: 'Rimborsato', en: 'Refunded' },
  CANCELLED: { it: 'Annullato', en: 'Cancelled' },
  VOIDED: { it: 'Stornato (errore)', en: 'Voided' },
})

// ---- FIN-122: one payment to many invoices -----------------------------------------------------------------------------

export interface OpenItem {
  readonly id: string
  /** What the item is still open for (minor units). */
  readonly open: MinorUnits
}

/**
 * The matcher's "Suggest" (design finance.payments rec allocation "'Suggest' fills oldest first"): what is left of a
 * payment spread over the open items in their order (the caller sorts them oldest first), each up to what it is open
 * for. What is left after the last one stays on the payment: the customer's credit balance.
 */
export function suggestOldestFirst(left: MinorUnits, items: readonly OpenItem[]): { readonly suggested: ReadonlyMap<string, MinorUnits>; readonly left: MinorUnits } {
  let rest = Math.max(0, left)
  const suggested = new Map<string, MinorUnits>()
  for (const item of items) {
    const amount = Math.min(Math.max(0, item.open), rest)
    suggested.set(item.id, amount)
    rest -= amount
  }
  return { suggested, left: rest }
}

/** A live allocation of a credited invoice (an allocation not reversed), newest last. */
export interface LiveAllocation {
  readonly id: string
  readonly paymentId: string
  readonly amount: MinorUnits
}

export interface ReleaseStep {
  readonly allocationId: string
  readonly paymentId: string
  /** The allocation's whole amount, taken back by a reversal row. */
  readonly reversed: MinorUnits
  /** What is placed again on the invoice (the part that still fits; 0: none). */
  readonly placedAgain: MinorUnits
}

/**
 * "Carry the credit" (FIN-122 credit balance): an invoice paid beyond what it is worth after a credit note gives the
 * excess back to its payments' unplaced part, the newest allocations first. The ledger is append-only and a reversal
 * takes an allocation back whole (the …_money_guards trigger), so each allocation touched is reversed and the part that
 * still fits is placed again.
 */
export function releasePlan(allocations: readonly LiveAllocation[], excess: MinorUnits): { readonly steps: readonly ReleaseStep[]; readonly released: MinorUnits } {
  let rest = Math.max(0, excess)
  const steps: ReleaseStep[] = []
  for (const allocation of [...allocations].reverse()) {
    if (rest <= 0) break
    if (allocation.amount <= 0) continue
    const take = Math.min(allocation.amount, rest)
    steps.push({ allocationId: allocation.id, paymentId: allocation.paymentId, reversed: allocation.amount, placedAgain: allocation.amount - take })
    rest -= take
  }
  return { steps, released: Math.max(0, excess) - rest }
}
