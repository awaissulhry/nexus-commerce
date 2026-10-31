import type { AgeingRow } from '../../../finance/receivables/api'
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
}

export function customerMoneyCanOf(permissions: readonly string[]): CustomerMoneyCan {
  const held = new Set(permissions)
  return { receivables: held.has('receivables.view'), price: held.has('money.price'), returns: held.has('sales.returns.view'), complaints: held.has('quality.complaints.view') }
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
