import type { AgeingRow } from '../../../finance/receivables/api'
import type { OpenOrderMoney } from './api' // F-SA-273
import { OPEN_RETURN_STATUSES, type CustomerComplaint, type CustomerReturn } from './api'

/**
 * The customer's money and after-sales numbers (B-W2a-81): who sees them (Overdue: receivables.view and the price grain
 * for the amount; returns: sales.returns.view; complaints: quality.complaints.view), what a customer owes late per
 * currency, its returns this year and what is open. Pure: the tests hold it.
 */

export const CUSTOMER_MONEY_NAMESPACE = 'customer-money'

export interface CustomerMoneyCan {
  readonly receivables: boolean
  readonly price: boolean
  readonly returns: boolean
  readonly complaints: boolean
  // F-SA-273: the Money tab's cards — the open orders' deposits and balances (orders.view), the credit (sales.credit.view), its one editor (sales.credit.limits).
  readonly orders?: boolean
  readonly credit?: boolean
  readonly creditLimits?: boolean
}

export function customerMoneyCanOf(permissions: readonly string[]): CustomerMoneyCan {
  const held = new Set(permissions)
  return {
    receivables: held.has('receivables.view'),
    price: held.has('money.price'),
    returns: held.has('sales.returns.view'),
    complaints: held.has('quality.complaints.view'),
    orders: held.has('orders.view'), // F-SA-273
    credit: held.has('sales.credit.view'), // F-SA-273
    creditLimits: held.has('sales.credit.limits'), // F-SA-273
  }
}

/** What one customer owes late: an amount per currency (absent without the price grain), the oldest days late, the invoices. */
export interface Overdue {
  readonly amounts: readonly { readonly currency: string; readonly amount: number | null }[]
  readonly daysLate: number | null
  readonly invoices: number
}

/** The ageing rows (one per company × customer × currency) summed per customer and currency: only money late counts. */
export function overdueByParty(rows: readonly AgeingRow[]): Map<string, Overdue> {
  const out = new Map<string, { amounts: Map<string, number | null>; daysLate: number | null; invoices: number }>()
  for (const row of rows) {
    if (row.daysLate === null && (row.overdue ?? 0) <= 0) continue
    const entry = out.get(row.customer.id) ?? { amounts: new Map<string, number | null>(), daysLate: null, invoices: 0 }
    const before = entry.amounts.get(row.currency)
    const amount = typeof row.overdue === 'number' ? row.overdue : null
    entry.amounts.set(row.currency, before === undefined ? amount : before === null || amount === null ? null : before + amount)
    entry.daysLate = Math.max(entry.daysLate ?? 0, row.daysLate ?? 0) || null
    entry.invoices += row.invoices
    out.set(row.customer.id, entry)
  }
  return new Map(
    [...out].map(([id, entry]) => [
      id,
      { amounts: [...entry.amounts].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency)), daysLate: entry.daysLate, invoices: entry.invoices },
    ]),
  )
}

/** One customer's ageing rows as its Overdue (null: nothing late). */
export const overdueOf = (rows: readonly AgeingRow[], partyId: string): Overdue | null => overdueByParty(rows.filter((row) => row.customer.id === partyId)).get(partyId) ?? null

/** The returns requested this year (Europe/Rome year of the request), how many units, and how many are still open. */
export function returnsThisYear(returns: readonly CustomerReturn[], year: string): { readonly count: number; readonly units: number; readonly open: number } {
  const ofYear = returns.filter((entry) => entry.requestedAt.slice(0, 4) === year)
  return { count: ofYear.length, units: ofYear.reduce((sum, entry) => sum + entry.units, 0), open: returns.filter(isOpenReturn).length }
}

export const isOpenReturn = (entry: Pick<CustomerReturn, 'status'>): boolean => OPEN_RETURN_STATUSES.includes(entry.status)

/** Open returns and claims, newest first (the record's "Now" shows the first five of each). */
export function openAfterSales(returns: readonly CustomerReturn[], complaints: readonly CustomerComplaint[]): { readonly returns: CustomerReturn[]; readonly complaints: CustomerComplaint[] } {
  return {
    returns: returns.filter(isOpenReturn).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    complaints: complaints.filter((entry) => entry.status !== 'CLOSED').sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
  }
}

/** Finance › Receivables & credit filtered to the customer (the API's own `partyId`). */
export const receivablesOfCustomer = (prefix: string, partyId: string): string => `${prefix}/finance/receivables?party=${encodeURIComponent(partyId)}`

// ── F-SA-273 (sales page plan N5, pick P10; 11-customer-page §5): the Money tab ──
/** What the customer still owes, per currency (the ageing rows of every company summed): open, overdue, the five buckets, invoices. */
export interface OpenToPay {
  readonly currency: string
  readonly open: number
  readonly overdue: number
  readonly buckets: Readonly<Record<string, number>>
  readonly invoices: number
  readonly daysLate: number | null
  /** The company each statement opens at (the first row's of the currency). */
  readonly companyId: string
}

export function openToPayOf(rows: readonly AgeingRow[], partyId: string): OpenToPay[] {
  const out = new Map<string, { currency: string; open: number; overdue: number; buckets: Record<string, number>; invoices: number; daysLate: number | null; companyId: string }>()
  for (const row of rows.filter((entry) => entry.customer.id === partyId)) {
    const now = out.get(row.currency) ?? { currency: row.currency, open: 0, overdue: 0, buckets: {}, invoices: 0, daysLate: null, companyId: row.company.id }
    now.open += row.open ?? 0
    now.overdue += row.overdue ?? 0
    for (const [bucket, amount] of Object.entries(row.buckets ?? {})) now.buckets[bucket] = (now.buckets[bucket] ?? 0) + (amount ?? 0)
    now.invoices += row.invoices
    if (row.daysLate !== null && (now.daysLate === null || row.daysLate > now.daysLate)) now.daysLate = row.daysLate
    out.set(row.currency, now)
  }
  return [...out.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}

/** Finance › Receivables & credit's statement of the customer for a company and a currency. */
export const statementOf = (prefix: string, partyId: string, companyId: string, currency: string): string =>
  `${prefix}/finance/receivables?statement=${encodeURIComponent(partyId)}&company=${encodeURIComponent(companyId)}&currency=${encodeURIComponent(currency)}`

/** The open orders that owe money, the largest balance first (no balance without the price grain: then by number), the first 10. */
export const DEPOSITS_SHOWN = 10
export function depositsAndBalances(orders: readonly OpenOrderMoney[]): { readonly rows: OpenOrderMoney[]; readonly owing: number; readonly depositsWaiting: number } {
  const owing = orders.filter((order) => (order.balance ?? 0) > 0 || order.deposit.state === 'OPEN' || order.deposit.state === 'MISSING')
  const sorted = [...owing].sort((a, b) => (b.balance ?? -1) - (a.balance ?? -1) || a.number.localeCompare(b.number))
  return { rows: sorted.slice(0, DEPOSITS_SHOWN), owing: owing.length, depositsWaiting: orders.filter((order) => order.deposit.state === 'OPEN').length }
}
// ── end F-SA-273 ──
