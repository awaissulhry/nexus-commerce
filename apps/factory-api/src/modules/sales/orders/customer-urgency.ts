import type { Prisma } from '@nexus/factory-db'
import type { Reader } from './store'

/**
 * B-TH-059 (threads plan TH-4; agreement T10 with the production lane, 00-production-lane-agreements.md): Sales › Orders'
 * read-only "Customer urgency" column and filter. The customer marks its own orders Urgent or Regular on its portal's My
 * production page; the production lane keeps that mark (B-PR-15 BrandOrderProduction.urgency) and exports `customerUrgencyOf`
 * (B-PR-22, modules/production/brand/urgency.ts). The office's own "Priority" (SalesOrder.priorityLevel) stays the office's:
 * this column never writes it, and nothing here writes at all.
 *
 * The resolver hook: until the production lane registers its reader with `useCustomerUrgency` (one call, in a block marked
 * B-PR-22, beside its `customerUrgencyOf`), no order has a customer urgency — the column is null on every row and the filter
 * keeps no order (an honest "none", never a guess of the production lane's data).
 *
 *   of     each order's urgency, by order id (an order absent: none known)
 *   where  the orders of one urgency as a filter of SalesOrder, so the list, the board's counts, the overall view's totals and
 *          the file keep exactly the same rows
 */

export const CUSTOMER_URGENCIES = ['URGENT', 'REGULAR'] as const
export type CustomerUrgency = (typeof CUSTOMER_URGENCIES)[number]

export interface CustomerUrgencySource {
  of(db: Reader, orderIds: readonly string[]): Promise<ReadonlyMap<string, CustomerUrgency>>
  where(urgency: CustomerUrgency): Prisma.SalesOrderWhereInput
}

let source: CustomerUrgencySource | null = null

/** Registers the production lane's reader (a test's fake); `undefined` takes it away again. */
export function useCustomerUrgency(next: CustomerUrgencySource | undefined): void {
  source = next ?? null
}

/** Each order's customer urgency (an empty map until a reader is registered). */
export async function orderCustomerUrgency(db: Reader, orderIds: readonly string[]): Promise<ReadonlyMap<string, CustomerUrgency>> {
  if (!source || orderIds.length === 0) return new Map()
  return source.of(db, orderIds)
}

/** The orders of one customer urgency (no order until a reader is registered). */
export function customerUrgencyWhere(urgency: CustomerUrgency): Prisma.SalesOrderWhereInput {
  return source ? source.where(urgency) : { id: { in: [] } }
}
