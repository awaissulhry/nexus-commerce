import type { Prisma } from '@nexus/factory-db'
import type { CustomerUrgencyState } from '@nexus/factory-domain/production-brand/urgency-state' // B-CW-010
import type { Reader } from './store'
// B-PR-22b: the production lane's reader (it imports nothing of the API but types: no cycle back into this module).
import { customerUrgencySource } from '../../production/brand/urgency-of'

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
 *   states B-CW-010 (customer Work tab plan §2), OPTIONAL: each order's urgency as the row's chip says it — the state of four, its
 *          place in the customer's own Urgent list, our lock and the open "Urgent – asked". A reader without it (a test's fake)
 *          leaves `customerUrgencyState` null and the row falls back to `of`.
 */

export const CUSTOMER_URGENCIES = ['URGENT', 'REGULAR'] as const
export type CustomerUrgency = (typeof CUSTOMER_URGENCIES)[number]

// ── B-CW-010: the customer's urgency of ONE order with its place and state (the row's chip; read-only, office only) ──
export interface OrderUrgencyState {
  /** URGENT, ASKED ("Urgent – asked" waits on it), REGULAR, or SET_BACK (its Regular mark is ours: set back or locked by us). */
  readonly state: CustomerUrgencyState
  /** Its place in its customer's OWN Urgent list at the order's company (1 first); null unless URGENT. Never a place in our plan. */
  readonly urgentRank: number | null
  /** We locked it at Regular (the customer cannot mark it Urgent until we unlock it). */
  readonly locked: boolean
  /** The open "Urgent – asked" of the order (its own RUSH request) while the state is ASKED: the chip opens its review; else null. */
  readonly requestId: string | null
}
// ── end B-CW-010 ──

export interface CustomerUrgencySource {
  of(db: Reader, orderIds: readonly string[]): Promise<ReadonlyMap<string, CustomerUrgency>>
  where(urgency: CustomerUrgency): Prisma.SalesOrderWhereInput
  /** B-CW-010: each order's state (an order absent: none counts — no kept order, or its customer's switch off). */
  states?(db: Reader, orderIds: readonly string[]): Promise<ReadonlyMap<string, OrderUrgencyState>>
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

/**
 * B-CW-010: each order's urgency state, by order id; null when no reader is registered or the registered one has no `states` (the
 * row then reads `orderCustomerUrgency`, as before).
 */
export async function orderCustomerUrgencyStates(db: Reader, orderIds: readonly string[]): Promise<ReadonlyMap<string, OrderUrgencyState> | null> {
  const reader = source
  if (!reader?.states) return null
  if (orderIds.length === 0) return new Map()
  return reader.states(db, orderIds)
}

/** The orders of one customer urgency (no order until a reader is registered). */
export function customerUrgencyWhere(urgency: CustomerUrgency): Prisma.SalesOrderWhereInput {
  return source ? source.where(urgency) : { id: { in: [] } }
}

// ── B-PR-22b (agreement T10): the production lane registers its reader here, once, when Sales › Orders loads — so every process
// that reads the orders (the API, the worker's files) has it. It names the urgency that counts (the order in production, its
// customer's switch on); a test may still put a fake in its place and take it away (`useCustomerUrgency`).
useCustomerUrgency(customerUrgencySource)
// ── end B-PR-22b ──
