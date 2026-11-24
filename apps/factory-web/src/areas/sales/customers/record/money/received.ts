import type { PaymentRow } from '../../../../finance/_shared/api'
import type { Refund, ToRefund } from '../../../../finance/payments/refunds/api'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { word, type MoneyWord } from '../../../orders/record/money/word'
import type { CreditBalanceRead } from './api'
import { invoiceHref } from './doors'
import { daysFrom, isFailed, isReading, type MoneyTabInput, type Part } from './model'

/**
 * F-CM-203 (customer page › MONEY tab, cm-w2 W2.3; 10-design §5.4; 18-lead-settles Z7, Z18, Z22, Z25) — section 4, Payments & refunds
 * (#received; the box `#on-account`, the block `#give-back`): the money that came in and what goes back (payments.view — without it the
 * section is LEFT OUT).
 *
 *   On account     per currency, the money paid and placed on nothing (the page's open items: their credit balance) — from which payment
 *                  and how long it waits (GET /payments/credit-balance); Refund… (Finance's own window, in place: payments.refund +
 *                  price) · Place it › (the payment's record in Finance). "On account" stays the word (Z22).
 *   To give back   the refunds to make (Mark made… · ⋯ Cancel…) and the credit notes with money left to refund (Refund…) — the refunds
 *                  read; every window is Finance's own (RefundDialogs), opened in place. No "Change…": no such window exists (Z7).
 *   Payments       newest first, the first 3 then "Show n more payments" (Z25): day · method · ref · what each was placed on (no amount
 *   received       without the price grain) · ⋯ Open the payment › (Finance: place more, take back, void, write off) · Copy the reference.
 *   Refunds made   folded; read when the fold opens (made, cancelled, voided): ⋯ Void… on a made one (payments.void).
 */

/** Z25: the first three payments, then "Show n more payments". */
export const PAYMENTS_SHOWN = 3
/** One page of the payments read. */
export const PAYMENTS_READ = 50

export interface PaymentsRead {
  readonly rows: readonly PaymentRow[]
  readonly next: string | null
}

export interface OnAccountBox {
  readonly currency: string
  /** The money on account (price grain; null without it). */
  readonly amount: number | null
  /** The oldest payment that holds it (its record is "Place it ›"); null: not read yet. */
  readonly from: { readonly paymentId: string; readonly receivedOn: string; readonly href: string } | null
  /** Days it waits since that payment. */
  readonly waits: number | null
  /** Refund… (payments.refund + price). */
  readonly refundable: boolean
}

export type GiveBackMove = 'paid' | 'cancel' | 'void'

export interface GiveBackRow {
  readonly kind: 'refund' | 'note'
  readonly id: string
  readonly anchor: string
  readonly chip: { readonly word: MoneyWord; readonly tone: 'warning' | 'success' | 'neutral' }
  readonly title: MoneyWord
  readonly sub: MoneyWord | null
  readonly due: string | null
  readonly late: number | null
  readonly amount: number | null
  readonly currency: string
  /** Its ONE act: a due refund "Mark made…"; a credit note with money left "Refund…" (Finance's windows, in place). */
  readonly act: { readonly id: 'paid' | 'refund'; readonly label: MoneyWord } | null
  /** Its ⋯: Cancel… (a due refund) / Void… (a made one), Open the credit note ›. */
  readonly more: readonly { readonly id: 'cancel' | 'void' | 'openNote'; readonly label: MoneyWord; readonly href?: string }[]
  readonly refund: Refund | null
  readonly note: ToRefund | null
}

export interface PaymentItem {
  readonly id: string
  readonly anchor: string
  readonly day: string
  readonly method: MoneyWord
  readonly reference: string
  /** What it was placed on, and what is not placed (each a chip). */
  readonly placed: readonly { readonly word: MoneyWord; readonly tone: 'neutral' | 'warning' | 'info' }[]
  readonly amount: number | null
  readonly currency: string
  readonly voided: boolean
  /** The payment's record in Finance. */
  readonly href: string
}

export interface ReceivedModel {
  readonly reading: boolean
  readonly problem: string | null
  /** "7 payments · last 14/11/2026 · € 1,200.00 on account · € 610.00 to give back, 1 refund is to make by 28/11/2026". */
  readonly answer: readonly MoneyWord[]
  readonly onAccount: readonly OnAccountBox[]
  readonly giveBack: readonly GiveBackRow[]
  readonly payments: readonly PaymentItem[]
  readonly more: boolean
  /** The head's Refund… (something can be refunded: a credit note with money left, or money on account; payments.refund + price). */
  readonly refundable: boolean
}

const paymentHref = (prefix: string, row: { readonly id: string; readonly externalRef: string }, companyId: string | null): string =>
  `${prefix}${recordAddress({ type: 'Payment', id: row.id, label: row.externalRef, companyId }, OFFICE_PAGES)}`

/** A refund to make, or a credit note with money left to refund, as the customer row. */
function giveBackOf(input: MoneyTabInput, prefix: string): GiveBackRow[] {
  const refunds = input.refunds?.value ?? null
  if (!refunds) return []
  const can = input.can
  const price = can.price
  const mayRefund = can.paymentsRefund && price
  const noteHref = (id: string, number: string | null) => invoiceHref(prefix, { id, number }, input.company?.id ?? null)
  const due: GiveBackRow[] = refunds.refundsDue.map((refund) => ({
    kind: 'refund',
    id: refund.id,
    anchor: `cm-Refund-${refund.id}`,
    chip: { word: word('finance-daily:refunds.state.DUE'), tone: 'warning' },
    title: refund.creditNote ? word('finance-daily:refunds.creditNote', { params: { number: refund.creditNote.number ?? '—' } }) : word('cm.received.ofPayment', { days: { date: refund.payment?.receivedOn ?? input.today } }),
    sub: refund.creditNote?.creditOfNumber ? word('finance-daily:refunds.ofInvoice', { params: { number: refund.creditNote.creditOfNumber } }) : null,
    due: refund.dueDate,
    late: refund.dueDate ? daysFrom(refund.dueDate, input.today) : null,
    amount: price && typeof refund.amount === 'number' ? refund.amount : null,
    currency: refund.currency,
    act: mayRefund ? { id: 'paid', label: word('finance-daily:refunds.move.paid.verb') } : null,
    more: [...(mayRefund ? [{ id: 'cancel' as const, label: word('finance-daily:refunds.move.cancel.verb') }] : []), ...(refund.creditNote ? [{ id: 'openNote' as const, label: word('cm.received.openNote'), href: noteHref(refund.creditNote.id, refund.creditNote.number) }] : [])],
    refund,
    note: null,
  }))
  const notes: GiveBackRow[] = refunds.creditNotesToRefund.map((note) => ({
    kind: 'note',
    id: note.creditNoteId,
    anchor: `cm-CreditNote-${note.creditNoteId}`,
    chip: { word: word('finance-daily:refunds.state.toRefund'), tone: 'warning' },
    title: word('finance-daily:refunds.creditNote', { params: { number: note.number ?? '—' } }),
    sub: note.creditOfNumber ? word('finance-daily:refunds.ofInvoice', { params: { number: note.creditOfNumber } }) : null,
    due: null,
    late: null,
    amount: price && typeof note.refundableAmount === 'number' ? note.refundableAmount : null,
    currency: note.currency,
    act: mayRefund ? { id: 'refund', label: word('finance-daily:refund.open') } : null,
    more: [{ id: 'openNote', label: word('cm.received.openNote'), href: noteHref(note.creditNoteId, note.number) }],
    refund: null,
    note,
  }))
  return [...due, ...notes]
}

/** The payments received, newest first, as rows (no amount and no placed amount without the price grain). */
function paymentItemsOf(rows: readonly PaymentRow[], input: MoneyTabInput, prefix: string): PaymentItem[] {
  const price = input.can.price
  return [...rows]
    .sort((a, b) => b.receivedOn.localeCompare(a.receivedOn) || b.createdAt.localeCompare(a.createdAt))
    .map((row) => {
      const placed: PaymentItem['placed'][number][] = row.placedOn.map((entry) =>
        entry.target === 'DEPOSIT_REQUEST'
          ? { word: word('cm.received.depositOf', { params: { order: entry.orderNumber ?? '—' } }), tone: 'info' as const }
          : { word: price && typeof entry.amount === 'number' ? word('cm.received.placedOn', { params: { number: entry.number ?? '—' }, money: { amount: entry.amount } }) : word('cm.text', { params: { text: entry.number ?? '—' } }), tone: 'neutral' as const },
      )
      if (row.status === 'VOIDED') placed.push({ word: word('finance:placed.VOIDED'), tone: 'neutral' })
      else if (typeof row.unallocated === 'number' ? row.unallocated - (row.refunded ?? 0) > 0 : row.placedOn.length === 0)
        placed.push({ word: price && typeof row.unallocated === 'number' ? word('cm.received.notPlaced', { money: { amount: row.unallocated - (row.refunded ?? 0) } }) : word('finance:placed.NOT_PLACED'), tone: 'warning' })
      return {
        id: row.id,
        anchor: `cm-Payment-${row.id}`,
        day: row.receivedOn,
        method: word(`finance:payments.method.${row.method}`),
        reference: row.externalRef,
        placed,
        amount: price && typeof row.amount === 'number' ? row.amount : null,
        currency: row.currency,
        voided: row.status === 'VOIDED',
        href: paymentHref(prefix, row, row.companyId),
      }
    })
}

/** The section's model (pure). Left out (null) without payments.view. */
export function receivedOf(input: MoneyTabInput, payments: Part<PaymentsRead> | null, credit: Part<CreditBalanceRead> | null, prefix: string): ReceivedModel | null {
  if (!input.can.payments || !payments) return null
  const can = input.can
  const price = can.price
  const giveBack = giveBackOf(input, prefix)
  const balance = input.openItems?.value?.creditBalance ?? []
  const onAccount: OnAccountBox[] = balance
    .filter((entry) => entry.amount === undefined || entry.amount > 0)
    .map((entry) => {
      const holders = (credit?.value?.payments ?? []).filter((payment) => payment.currency === entry.currency).sort((a, b) => a.receivedOn.localeCompare(b.receivedOn))
      const first = holders[0] ?? null
      return {
        currency: entry.currency,
        amount: price && typeof entry.amount === 'number' ? entry.amount : null,
        from: first ? { paymentId: first.id, receivedOn: first.receivedOn, href: paymentHref(prefix, first, input.company?.id ?? null) } : null,
        waits: first ? Math.max(0, daysFrom(first.receivedOn, input.today)) : null,
        refundable: can.paymentsRefund && price,
      }
    })
  const refundable = can.paymentsRefund && price && (onAccount.length > 0 || (input.refunds?.value?.creditNotesToRefund.length ?? 0) > 0)
  if (isReading(payments)) return { reading: true, problem: null, answer: [word('cm.received.reading')], onAccount, giveBack, payments: [], more: false, refundable }
  const value = payments.value
  if (isFailed(payments) || !value) return { reading: false, problem: payments.problem ?? 'problem.read.internal', answer: [], onAccount, giveBack, payments: [], more: false, refundable }
  const items = paymentItemsOf(value.rows, input, prefix)
  const more = value.next !== null
  const answer: MoneyWord[] = []
  if (items.length > 0) answer.push(word(more ? 'cm.received.countMore' : 'cm.received.count', { params: { count: items.length } }))
  const last = items.find((item) => !item.voided)
  if (last) answer.push(word('cm.received.last', { days: { date: last.day } }))
  for (const box of onAccount) answer.push(box.amount !== null ? word('cm.answer.onAccount', { money: { amount: box.amount } }) : word('cm.answer.onAccountWords'))
  const due = giveBack.filter((row) => row.kind === 'refund')
  if (giveBack.length > 0) {
    const amounts = giveBack.map((row) => row.amount)
    const total = price && amounts.every((amount) => amount !== null) && new Set(giveBack.map((row) => row.currency)).size === 1 ? amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) : null
    const back = total !== null ? word('cm.answer.giveBack', { money: { amount: total } }) : word('cm.answer.refundsWords', { params: { count: giveBack.length } })
    const firstDay = due.map((row) => row.due).filter((day): day is string => !!day).sort()[0] ?? null
    answer.push(due.length > 0 && firstDay ? word('cm.answer.pair', { words: { first: back, second: word('cm.needs.refundsBy', { params: { count: due.length }, days: { date: firstDay } }) } }) : back)
  }
  return { reading: false, problem: null, answer, onAccount, giveBack, payments: items, more, refundable }
}

/** A refund made, cancelled or voided (the fold's rows): its state, the day, and Void… on a made one (payments.void + price). */
export interface MadeRow {
  readonly refund: Refund
  readonly state: { readonly word: MoneyWord; readonly tone: 'success' | 'neutral' }
  readonly title: MoneyWord
  readonly day: string | null
  readonly amount: number | null
  readonly voidable: boolean
}

export function refundsMadeOf(rows: readonly Refund[], input: MoneyTabInput): MadeRow[] {
  return rows
    .filter((refund) => refund.status !== 'DUE')
    .map((refund) => ({
      refund,
      state: { word: word(`finance-daily:refunds.state.${refund.status}`), tone: refund.status === 'PAID' ? ('success' as const) : ('neutral' as const) },
      title: refund.creditNote ? word('finance-daily:refunds.creditNote', { params: { number: refund.creditNote.number ?? '—' } }) : word('cm.received.ofPayment', { days: { date: refund.payment?.receivedOn ?? refund.createdAt.slice(0, 10) } }),
      day: refund.paidOn,
      amount: input.can.price && typeof refund.amount === 'number' ? refund.amount : null,
      voidable: refund.status === 'PAID' && input.can.paymentsVoid && input.can.price,
    }))
}
