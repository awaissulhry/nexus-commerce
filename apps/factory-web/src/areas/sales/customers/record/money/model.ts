import type { OpenItem } from '../../../../finance/_shared/api'
import type { OpenRefunds } from '../../../../finance/payments/refunds/api'
import type { AgeingRow, Reminder } from '../../../../finance/receivables/api'
import type { ReminderStop } from '../../../../finance/receivables/reminder-stops/api'
import type { Glance } from '../../depth/api'
import type { Read } from '../../depth/model'
import type { OrderSummary } from '../../../orders/api'
import type { OpenOrderMoney } from '../../money/api'
import { doorCanOf, type DoorCan } from '../../../orders/record/money/door/model' // F-CM-201: a row's acts are the money door's rule
import { stopsCanOf } from '../../../../finance/receivables/reminder-stops/model' // F-CM-201: Finance's own rule decides the stop's door

/**
 * F-CM-101 (customer page › MONEY tab, 10-design §1–§4; 18-lead-settles Z3–Z11, Z18–Z25) — what the customer's Money tab is handed and
 * who may see what. Pure: no read, no word said here (the rules hand MoneyWords; a view says them).
 *
 *   rights    one boolean per right the tab reads (a section without its right is LEFT OUT; an act without its right is HIDDEN)
 *   parts     every read is a Part: reading (value and problem null) · ready · failed (an `orders` problem key, said by the kit's
 *             PartFailed with its own Try again). A read the reader may not make is `null` — left out, never 0.
 *   input     the page-level reads (the ageing of this company and of the others, the open items with the money on account) and the
 *             tab's own reads (refunds, stops, reminders, the orders summary, shipped not invoiced), each naming THIS customer.
 *
 * The money wall: every amount comes from a read that drops it without the price grain (`money.price`); a rule puts an amount in a
 * word only with `can.price` — so `amountsOf` of every word is empty for Sales and Read-only.
 */

/** The `customer-money` catalogue: the tab's own words live under `cm.*` (the old tab's `tab.*` go in cm-w3). */
export const CM = 'customer-money'

/**
 * Every catalogue the tab says words from (the kit and the shared parts say `orders` words; a reused word names its catalogue): the
 * tab's WithMessages loads exactly this list, and a test holds every `namespace:` the rules and views name inside it (Z29: a raw key can
 * never show).
 */
export const MONEY_TAB_NAMESPACES = ['orders', CM, 'sales-customers-depth', 'finance-receivables', 'finance-payments-depth', 'record-frame', 'parties', 'customers-list'] as const

export interface MoneyTabCan {
  /** money.price — every amount (the server drops them without it). */
  readonly price: boolean
  /** money.margin — Margin & cost (cm-w3). */
  readonly margin: boolean
  /** receivables.view — the ageing, reminders, stops, the statement. */
  readonly receivables: boolean
  /** payments.view — open items (deposit requests, money on account), payments, refunds. */
  readonly payments: boolean
  readonly paymentsRecord: boolean
  readonly paymentsRefund: boolean
  readonly paymentsVoid: boolean
  /** invoices.view — the documents, shipped not invoiced. */
  readonly invoices: boolean
  readonly invoicesManage: boolean
  readonly invoicesIssue: boolean
  /** orders.view — the orders summary ("Not invoiced yet"), Price check. */
  readonly orders: boolean
  /** orders.moneyPlan — Move due day…, Change the deposit…, Accept short… (the order's own windows). */
  readonly moneyPlan: boolean
  /** orders.waive — Waive… (the Owner; the window asks a fresh code). */
  readonly waive: boolean
  /** sales.credit.view — the credit standing, Credit & terms' figures. */
  readonly credit: boolean
  /** sales.credit.limits — Change limit… / Set a limit… */
  readonly creditLimits: boolean
  /** receivables.reminders.manage — Promise to pay / dispute…, Lift… */
  readonly remindersManage: boolean
  /** receivables.statements.send — Send statement… */
  readonly statementsSend: boolean
  /** parties.hold — Put on hold… · Release… */
  readonly hold: boolean
  /** F-CM-201 (W2.1): the money door's rights for a To-collect request row, by the order page's own rule (door/model.ts doorCanOf). */
  readonly door: DoorCan
}

export function moneyTabCanOf(permissions: readonly string[]): MoneyTabCan {
  const held = new Set(permissions)
  return {
    price: held.has('money.price'),
    margin: held.has('money.margin'),
    receivables: held.has('receivables.view'),
    payments: held.has('payments.view'),
    paymentsRecord: held.has('payments.record'),
    paymentsRefund: held.has('payments.refund'),
    paymentsVoid: held.has('payments.void'),
    invoices: held.has('invoices.view'),
    invoicesManage: held.has('invoices.manage'),
    invoicesIssue: held.has('invoices.issue'),
    orders: held.has('orders.view'),
    moneyPlan: held.has('orders.moneyPlan'),
    waive: held.has('orders.waive'),
    credit: held.has('sales.credit.view'),
    creditLimits: held.has('sales.credit.limits'),
    remindersManage: stopsCanOf(permissions).manage, // F-CM-201: Finance's stop rule (receivables.reminders.manage)
    statementsSend: held.has('receivables.statements.send'),
    hold: held.has('parties.hold'),
    door: doorCanOf(permissions), // F-CM-201
  }
}

/** A read of the tab: reading (both null) · ready (value) · failed (an `orders` problem key). */
export interface Part<T> {
  readonly value: T | null
  readonly problem: string | null
}
export const READING: Part<never> = { value: null, problem: null }
export const partReady = <T>(value: T): Part<T> => ({ value, problem: null })
export const partFailed = (problem: string): Part<never> => ({ value: null, problem })
export const isReading = (part: Part<unknown> | null): boolean => part !== null && part.value === null && part.problem === null
export const isFailed = (part: Part<unknown> | null): boolean => part !== null && part.problem !== null

/** The customer's shipped goods not invoiced yet (GET /invoicing/shipped-not-invoiced?partyId: one customer's row, or none). */
export interface ShippedNotInvoiced {
  /** DDTs and shipments that left without a DDT, not invoiced. */
  readonly shipments: number
  /** Their value (price grain; absent without it). */
  readonly value: number | null
  readonly currency: string | null
  /** The nearest legal deadline to invoice them (a day), if any. */
  readonly invoiceBy: string | null
  /** F-CM-202: the DDTs not invoiced — Finance's "Invoice shipped goods" window opens with them chosen (`?new=1&ddts=…&party=`). */
  readonly ddtIds: readonly string[]
}

/** The open items answer (GET /payments/open-items?partyId): every open request and invoice, and the money on account per currency. */
export interface OpenItemsRead {
  readonly items: readonly OpenItem[]
  readonly creditBalance: readonly { readonly currency: string; readonly amount?: number | undefined }[]
}

/** The page-level problem keys (the customer page's own `problem.*`) as the kit's `orders` keys (`problem.read.*`). */
export function orderProblemOf(problem: string): string {
  if (problem.startsWith('problem.read.')) return problem
  const kind = problem.replace(/^problem\./, '')
  return ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited'].includes(kind) ? `problem.read.${kind}` : 'problem.read.internal'
}

/**
 * Everything the tab's rules read. Each read names THIS customer on the server (`partyId`); no rule filters a list by customer — the one
 * split is the ageing BY COMPANY (this company's rows, the others' rows: one customer's own rows).
 */
export interface MoneyTabInput {
  readonly party: { readonly id: string; readonly name: string; readonly currency: string | null; readonly paymentTerms: string | null }
  /** The company the page works in (the session's). */
  readonly company: { readonly id: string; readonly name: string } | null
  /** How many companies the reader reaches ("With {company}." only when more than one). */
  readonly companies: number
  readonly can: MoneyTabCan
  /** Today, YYYY-MM-DD (Europe/Rome). */
  readonly today: string
  /** The ageing of this customer in this company (receivables.view; null without it). */
  readonly ageing: Part<readonly AgeingRow[]> | null
  /** The ageing of this customer in the OTHER companies the reader reaches (the same read without the company term). */
  readonly ageingElsewhere: Part<readonly AgeingRow[]> | null
  /** Open deposit requests and invoices, money on account (payments.view; null without it). */
  readonly openItems: Part<OpenItemsRead> | null
  /** Refunds to make and credit notes with money left (payments.view). */
  readonly refunds: Part<OpenRefunds> | null
  /** Stops in force (receivables.view). */
  readonly stops: Part<readonly ReminderStop[]> | null
  /** Reminders, every state (receivables.view). */
  readonly reminders: Part<readonly Reminder[]> | null
  /** The customer's open orders' figures (orders.view): "Not invoiced yet: N orders". */
  readonly summary: Part<OrderSummary> | null
  /** Shipped, not invoiced (invoices.view). */
  readonly shipped: Part<ShippedNotInvoiced | null> | null
  /** The customer at a glance (the hold, the credit standing): the page's read, through the depth provider; null: not handed. */
  readonly glance: Read<Glance> | null
  /** The open orders' money (the page's read): tells an EXTRA deposit apart (`extraOpenDue`). */
  readonly openOrders: readonly OpenOrderMoney[] | null
  /** Prices differ on N orders (the page's price counts; the price grain). */
  readonly priceDiffer: number | null
}

// ---- days ----------------------------------------------------------------------------------------------------------------
const dayMs = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
/** Whole days from `from` to `to` (both YYYY-MM-DD): negative when `to` is before `from`. */
export const daysFrom = (from: string, to: string): number => Math.round((dayMs(to) - dayMs(from)) / 86_400_000)
/** Days late on a due day (0 or less: not late). */
export const daysLateOf = (due: string | null, today: string): number => (due ? daysFrom(due, today) : 0)

/** The currencies of the customer's money, the party's own first, then by code (never added across). */
export function currenciesOf(found: Iterable<string>, own: string | null): string[] {
  const set = new Set(found)
  return [...set].sort((a, b) => (a === own ? -1 : b === own ? 1 : a.localeCompare(b)))
}

// ---- F-CM-103 (13-backend §5.2): the live rule — is a money event this customer's? ------------------------------------------

/** Money events (payments, refunds, invoices, deposit requests, credit, reminders and stops). */
const MONEY_EVENT = /^(payment\.|refund\.|invoice\.|deposit_request\.|credit_|receivables\.|reminder)/
/** The events that never carry the customer's id to the browser (a finished lane's pin, B-SA-004): matched by the ids the tab holds. */
const MATCHED_BY_ID: ReadonlySet<string> = new Set(['payment.allocated', 'payment.allocation_reversed', 'payment.voided', 'refund.changed'])
const ID_FIELDS = ['paymentId', 'targetId', 'refundId', 'invoiceId', 'depositRequestId'] as const

/**
 * Ours when the event names THIS customer (`partyId`, S1 of cm-s; an order event of this customer moves its plan too) · or it is one
 * of the four events that never name a customer and one of its ids is an id the tab holds · or (until cm-s lands) a money event that
 * names no customer at all ("may be ours": the glance's own rule). Pure; the hooks coalesce what it lets through into ONE re-read.
 */
export function moneyChangeIsOurs(change: { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }, partyId: string, held: ReadonlySet<string>): boolean {
  const about = change.fields.partyId ?? change.fields.customerId
  const money = MONEY_EVENT.test(change.type)
  if (typeof about === 'string') return about === partyId && (money || change.type.startsWith('sales_order.'))
  if (!money) return false
  if (MATCHED_BY_ID.has(change.type)) return ID_FIELDS.some((field) => typeof change.fields[field] === 'string' && held.has(change.fields[field] as string))
  return true
}

/** The live re-read waits this long after the last event (one burst for many events). */
export const LIVE_COALESCE_MS = 800

/** The tab's own reads (use-customer-money-tab.ts), each with its Try again. */
export const TAB_READS = ['refunds', 'stops', 'reminders', 'summary', 'shipped'] as const
export type TabRead = (typeof TAB_READS)[number]
/** F-CM-202: the tab's reads made only when their section nears the room (13-backend §1.4 "scrolling to the end"). */
export const LAZY_READS = ['documents'] as const
export type LazyRead = (typeof LAZY_READS)[number]
/** What a section's Try again reads again: the page's money reads (the ageing, the open items) or one of the tab's own. */
export type MoneyRead = 'page' | TabRead | LazyRead
