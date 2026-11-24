import type { OpenItem } from '../../../../finance/_shared/api'
import type { Reminder } from '../../../../finance/receivables/api'
import type { ReminderStop } from '../../../../finance/receivables/reminder-stops/api'
import { word, type MoneyWord } from '../../../orders/record/money/word'
import { invoiceHref, orderMoneyHref, recordPaymentOnInvoiceHref, requestRowAnchor } from './doors'
import { daysFrom, isFailed, isReading, type MoneyTabInput } from './model'
import { collectAnchor } from './sections'

/**
 * F-CM-105 (customer page › MONEY tab, 10-design §5.2; 18-lead-settles Z5, Z21, Z25, Z26) — section 2, To collect (#collect): every OPEN
 * deposit / extra deposit / before-shipping request and every OPEN invoice of every order of this customer (GET /payments/open-items:
 * payments.view — without it the section is LEFT OUT), OLDEST DUE FIRST (the read sorts by issue day; the web sorts by the due day, a
 * row with none last). Ten rows, then "Show n more rows" in place.
 *
 * THE customer row: what (the kind's chip · the order, a door to its Money row; an invoice: its number, a door to Finance, "of {order}")
 * · when ("Due {day}" + "3 d late" / "today" / "in 2 d") · words (what the step holds, from the step's KIND, never read — Z26 b;
 * "Part paid: {paid} of {amount} received" with the price grain; on an invoice the stop in force or the newest reminder, joined by the
 * invoice's id in the browser — Z26 c) · amount (open, "of {total}": price grain) · ONE act · ⋯.
 *
 * Acts, by kind and right (hidden without the right; held only by state, with words, inside the ⋯):
 *   a request   Record a payment (the ORDER's own window, in place through the money door: payments.record + price) · ⋯ Send the page…
 *               (payments.record + price) · Move due day… · Change the deposit… (not before shipping) · Accept short (bank charges)… (only
 *               on a row the server's own figures call short: part paid — Z26 f) (orders.moneyPlan + price) · Waive… (orders.waive) ·
 *               Open the order's Money › · Show in the thread · Copy link. NEVER from a row: Open for payment, Ask again…, Undo this
 *               payment…, Stop the page (they stay on the order's Money, one door away).
 *   an invoice  Record payment… (Finance's window with the invoice chosen — a door, as on the order page; euro only: a row in another
 *               currency has no act and "Record payment…" is held by state in its ⋯ — Z21, payments.ts refuses non-EUR) · ⋯ Promise to
 *               pay / dispute… (Finance's own stop form, in place: receivables.reminders.manage) · Credit note… (invoices.manage) ·
 *               Open {number} › · Open the order's Money › · Show in the thread · Copy link.
 * An EXTRA deposit is told apart only when the page's open-orders read says so (`extraOpenDue` on the request's due day: an order that
 * needs no deposit — production does not wait for it); open items name no extra deposit, so any other request is a "Deposit" (Z26 a).
 */

export type CollectKind = 'DEPOSIT' | 'EXTRA' | 'BEFORE_SHIPPING' | 'INVOICE'

/** The acts that open a window IN PLACE (the order's own windows through the money door, Finance's stop form): drawn in cm-w2. */
export const IN_PLACE_ACTS = ['record', 'send', 'MOVE_DUE', 'REPLACE_DEPOSIT', 'ACCEPT_SHORT', 'waive', 'stop'] as const
export type CollectInPlace = (typeof IN_PLACE_ACTS)[number]
export type CollectItemId = CollectInPlace | 'payInvoice' | 'creditNote' | 'openInvoice' | 'openOrder' | 'show' | 'link'

export interface CollectItem {
  readonly id: CollectItemId
  readonly label: MoneyWord
  /** Held by STATE, with its words (never a right's name). */
  readonly held: MoneyWord | null
  /** A door: where it goes (else an act in place, or a page act: Show in the thread, Copy link). */
  readonly href?: string
}

export interface CollectNote {
  readonly word: MoneyWord
  readonly tone: 'warning' | 'danger' | 'neutral'
  readonly icon: 'factory' | 'truck' | 'coins' | 'pause' | 'bell' | 'clock' | 'info'
}

export interface CollectRow {
  /** Its address on this tab (`#cm-DepositRequest-<id>`, `#cm-Invoice-<id>`). */
  readonly anchor: string
  readonly target: 'DEPOSIT_REQUEST' | 'INVOICE'
  readonly id: string
  readonly kind: CollectKind
  /** The kind's chip: the order Money's own step word, or the document's type. */
  readonly chip: MoneyWord
  /** An invoice's number and its door (Finance's record). */
  readonly invoice: { readonly number: string; readonly href: string } | null
  /** The order: a door to its Money tab at this request's row, or at its Invoices. */
  readonly order: { readonly id: string; readonly number: string; readonly href: string } | null
  readonly due: string | null
  /** Days late (> 0), today (0), days to go (< 0); null: no due day. */
  readonly late: number | null
  readonly notes: readonly CollectNote[]
  /** The open amount and, when part paid, the whole (price grain; null without it). */
  readonly amount: number | null
  readonly of: number | null
  readonly currency: string
  readonly act: CollectItem | null
  readonly more: readonly CollectItem[]
}

export interface CollectModel {
  readonly reading: boolean
  /** The read failed: an `orders` problem key (the kit's PartFailed with its own Try again). */
  readonly problem: string | null
  readonly rows: readonly CollectRow[]
  /** The head's answer: "6 open: 3 invoices and 3 deposit and before-shipping requests · 2 late · next due 25/11/2026". */
  readonly answer: readonly MoneyWord[]
  /** Any row with an act (else the act column gives its room back to the words). */
  readonly anyAct: boolean
}

/** Ten rows at first (Z25 keeps To collect at 10), then "Show n more rows". */
export const COLLECT_SHOWN = 10

const KIND_WORD: Record<Exclude<CollectKind, 'INVOICE'>, string> = { DEPOSIT: 'orders:moneyTab.plan.kind.DEPOSIT', EXTRA: 'orders:moneyTab.plan.kind.EXTRA', BEFORE_SHIPPING: 'orders:moneyTab.plan.kind.BEFORE_SHIPPING' }

/** A request's kind: its schedule step's (open items' `stepKind`), an EXTRA deposit when the order read says so, else a deposit. */
export function requestKindOf(item: Pick<OpenItem, 'stepKind' | 'orderId' | 'dueDate'>, input: Pick<MoneyTabInput, 'openOrders'>): Exclude<CollectKind, 'INVOICE'> {
  if (item.stepKind === 'BEFORE_SHIPPING') return 'BEFORE_SHIPPING'
  if (item.stepKind === 'DEPOSIT') return 'DEPOSIT'
  const order = (input.openOrders ?? []).find((entry) => entry.id === item.orderId)
  return order?.deposit.extraOpenDue && order.deposit.extraOpenDue === item.dueDate ? 'EXTRA' : 'DEPOSIT'
}

/** "3 d late" · "today" · "in 2 d" (null: no due day). */
export function dayTagOf(late: number | null): { readonly word: MoneyWord; readonly tone: 'danger' | 'warning' | 'neutral' } | null {
  if (late === null) return null
  if (late > 0) return { word: word('cm.tag.late', { params: { count: late } }), tone: 'danger' }
  if (late === 0) return { word: word('cm.tag.today'), tone: 'warning' }
  return { word: word('cm.tag.in', { params: { count: -late } }), tone: 'neutral' }
}

/** The stop in force on an invoice, else its newest reminder (the two reads joined by the invoice's id, in the browser). */
function invoiceNotesOf(item: OpenItem, late: number | null, stops: readonly ReminderStop[], reminders: readonly Reminder[]): CollectNote[] {
  const notes: CollectNote[] = []
  const stop = stops.find((entry) => entry.state === 'holding' && entry.invoice.id === item.id)
  if (stop) {
    const reason = word(`finance-payments-depth:stops.reason.${stop.reason}`)
    notes.push({ word: stop.until ? word('cm.collect.stopUntil', { days: { date: stop.until }, words: { reason } }) : word('cm.collect.stopLifted', { words: { reason } }), tone: 'warning', icon: 'pause' })
  } else {
    const reminder = reminders
      .filter((entry) => entry.status !== 'CANCELLED' && entry.status !== 'SKIPPED' && entry.invoices.some((invoice) => invoice.id === item.id))
      .sort((a, b) => b.preparedAt.localeCompare(a.preparedAt))[0]
    if (reminder?.status === 'SENT' && reminder.sentAt) notes.push({ word: word('cm.collect.reminderSent', { params: { level: reminder.level }, instants: { date: reminder.sentAt } }), tone: 'neutral', icon: 'bell' })
    else if (reminder && (reminder.status === 'PREPARED' || reminder.status === 'APPROVED')) notes.push({ word: word('cm.collect.reminderWaits', { params: { level: reminder.level } }), tone: 'warning', icon: 'bell' })
  }
  if (item.currency !== 'EUR') notes.push({ word: word('cm.collect.notEuro'), tone: 'neutral', icon: 'info' })
  if (notes.length === 0) notes.push({ word: late !== null && late > 0 ? word('cm.collect.noReminder') : word('cm.collect.notDue'), tone: 'neutral', icon: 'clock' })
  return notes
}

/** One open item as the customer row (pure). `prefix`: `/w/<company>`. */
export function collectRowOf(item: OpenItem, input: MoneyTabInput, prefix: string): CollectRow {
  const can = input.can
  const price = can.price
  const late = item.dueDate ? daysFrom(item.dueDate, input.today) : null
  const amount = price && typeof item.openAmount === 'number' ? item.openAmount : null
  const whole = price && typeof item.amount === 'number' ? item.amount : null
  const partPaid = amount !== null && whole !== null && amount < whole
  const order = item.orderId && item.orderNumber ? { id: item.orderId, number: item.orderNumber } : null
  const anchor = collectAnchor(item.target, item.id)
  const tail: CollectItem[] = [
    ...(order ? [{ id: 'openOrder' as const, label: word('cm.collect.openOrderMoney'), held: null, href: orderMoneyHref(prefix, order.id, item.target === 'INVOICE' ? 'invoices' : requestRowAnchor(item.id)) }] : []),
    ...(order ? [{ id: 'show' as const, label: word('record-frame:discuss.showInThread'), held: null }] : []),
    { id: 'link', label: word('orders:moneyTab.menu.copyLinkRow'), held: null },
  ]
  if (item.target === 'INVOICE') {
    const number = item.number ?? ''
    const euro = item.currency === 'EUR'
    const pay: CollectItem | null = can.paymentsRecord && price ? (euro ? { id: 'payInvoice', label: word('orders:moneyTab.plan.act.payInvoice'), held: null, href: recordPaymentOnInvoiceHref(prefix, item.id) } : { id: 'payInvoice', label: word('orders:moneyTab.plan.act.payInvoice'), held: word('cm.collect.euroOnly', { params: { currency: item.currency } }) }) : null
    const more: CollectItem[] = [
      ...(pay && pay.held ? [pay] : []),
      ...(can.remindersManage && can.receivables ? [{ id: 'stop' as const, label: word('cm.collect.stop'), held: null }] : []),
      ...(can.invoicesManage ? [{ id: 'creditNote' as const, label: word('orders:moneyTab.invoices.door.credit'), held: null, href: `${invoiceHref(prefix, { id: item.id, number: item.number }, input.company?.id ?? null)}?do=credit` }] : []),
      { id: 'openInvoice', label: word('orders:moneyTab.plan.menu.openInvoice', { params: { number } }), held: null, href: invoiceHref(prefix, { id: item.id, number: item.number }, input.company?.id ?? null) },
      ...tail,
    ]
    return {
      anchor,
      target: 'INVOICE',
      id: item.id,
      kind: 'INVOICE',
      chip: word(`orders:docType.${item.docType ?? 'TD01'}`),
      invoice: { number, href: invoiceHref(prefix, { id: item.id, number: item.number }, input.company?.id ?? null) },
      order: order ? { ...order, href: orderMoneyHref(prefix, order.id, 'invoices') } : null,
      due: item.dueDate,
      late,
      notes: invoiceNotesOf(item, late, input.stops?.value ?? [], input.reminders?.value ?? []),
      amount,
      of: partPaid ? whole : null,
      currency: item.currency,
      act: pay && !pay.held ? pay : null,
      more,
    }
  }
  const kind = requestKindOf(item, input)
  const notes: CollectNote[] = []
  // What the step holds — from its kind, never read (Z26 b). An EXTRA deposit (an order that needs none) holds nothing.
  if (kind === 'DEPOSIT' && item.stepKind === 'DEPOSIT') notes.push({ word: word('orders:moneyTab.plan.note.productionWaits'), tone: 'warning', icon: 'factory' })
  if (kind === 'BEFORE_SHIPPING') notes.push({ word: word('orders:moneyTab.plan.note.holdsShipment'), tone: 'neutral', icon: 'truck' })
  if (partPaid && amount !== null && whole !== null) notes.push({ word: word('cm.collect.partPaid', { money: { paid: whole - amount, amount: whole } }), tone: 'neutral', icon: 'coins' })
  const plan = can.moneyPlan && price
  const payer = can.paymentsRecord && price
  const more: CollectItem[] = [
    ...(payer ? [{ id: 'send' as const, label: word('orders:moneyTab.plan.act.send'), held: null }] : []),
    ...(plan ? [{ id: 'MOVE_DUE' as const, label: word('orders:moneyTab.plan.act.MOVE_DUE'), held: null }] : []),
    ...(plan && kind !== 'BEFORE_SHIPPING' ? [{ id: 'REPLACE_DEPOSIT' as const, label: word('orders:moneyTab.plan.act.REPLACE_DEPOSIT'), held: null }] : []),
    ...(plan && partPaid ? [{ id: 'ACCEPT_SHORT' as const, label: word('orders:moneyTab.plan.act.ACCEPT_SHORT'), held: null }] : []),
    ...(can.waive ? [{ id: 'waive' as const, label: word('orders:moneyTab.plan.act.waive'), held: null }] : []),
    ...tail,
  ]
  return {
    anchor,
    target: 'DEPOSIT_REQUEST',
    id: item.id,
    kind,
    chip: word(KIND_WORD[kind]),
    invoice: null,
    order: order ? { ...order, href: orderMoneyHref(prefix, order.id, requestRowAnchor(item.id)) } : null,
    due: item.dueDate,
    late,
    notes,
    amount,
    of: partPaid ? whole : null,
    currency: item.currency,
    act: payer ? { id: 'record', label: word('orders:deposit.record'), held: null } : null,
    more,
  }
}

/** Oldest due first; a row with no due day last; then requests before invoices, then by id (a stable order). */
const byDue = (a: CollectRow, b: CollectRow): number =>
  (a.due === null ? 1 : 0) - (b.due === null ? 1 : 0) || (a.due ?? '').localeCompare(b.due ?? '') || a.target.localeCompare(b.target) || a.id.localeCompare(b.id)

/** The section's model (pure). Left out (null) without payments.view. */
export function collectOf(input: MoneyTabInput, prefix: string): CollectModel | null {
  if (!input.can.payments || !input.openItems) return null
  const part = input.openItems
  if (isReading(part)) return { reading: true, problem: null, rows: [], answer: [word('cm.collect.reading')], anyAct: false }
  if (isFailed(part) || !part.value) return { reading: false, problem: part.problem ?? 'problem.read.internal', rows: [], answer: [], anyAct: false }
  const rows = part.value.items.map((item) => collectRowOf(item, input, prefix)).sort(byDue)
  const invoices = rows.filter((row) => row.target === 'INVOICE').length
  const requests = rows.length - invoices
  const late = rows.filter((row) => row.late !== null && row.late > 0).length
  const next = rows.find((row) => row.late !== null && row.late <= 0)
  const what =
    invoices > 0 && requests > 0
      ? word('cm.collect.both', { words: { invoices: word('cell.invoices', { params: { count: invoices } }), requests: word('cm.collect.requests', { params: { count: requests } }) } })
      : invoices > 0
        ? word('cell.invoices', { params: { count: invoices } })
        : word('cm.collect.requests', { params: { count: requests } })
  const answer =
    rows.length === 0
      ? []
      : [word('cm.collect.open', { params: { count: rows.length }, words: { what } }), late > 0 ? word('cm.answer.lateCount', { params: { count: late } }) : word('cm.collect.nothingLate'), ...(next?.due ? [word('cm.collect.nextDue', { days: { date: next.due } })] : [])]
  return { reading: false, problem: null, rows, answer, anyAct: rows.some((row) => row.act !== null) }
}
