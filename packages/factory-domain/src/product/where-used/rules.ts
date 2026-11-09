import type { Permission } from '../../core/permissions'

/**
 * Where a style is used (B-W2b-227; PRD-021; design products.styles › side panel "Used by … (full where-used W2b)"), pure:
 * the kinds of record that name a style, the permission that reads each (a person sees a kind only with its own view
 * permission, and only the records of the companies and sites it reaches), and which of them are still open (what a
 * change of the style would touch). Never money: no price, cost or charge.
 */

export const WHERE_USED_KINDS = ['QUOTES', 'SALES_ORDERS', 'WORK_ORDERS', 'STOCK', 'PRICE_LISTS', 'SAMPLE_ROUNDS', 'CERTIFICATES'] as const
export type WhereUsedKind = (typeof WHERE_USED_KINDS)[number]

/** The permission each kind is read with (the style itself: product.styles.view). */
export const WHERE_USED_PERMISSION: Readonly<Record<WhereUsedKind, Permission>> = Object.freeze({
  QUOTES: 'quotes.view',
  SALES_ORDERS: 'orders.view',
  WORK_ORDERS: 'workorders.view',
  STOCK: 'inventory.stock.view',
  PRICE_LISTS: 'pricelists.view',
  // The sample rounds of a style are product work; their own module (a later step) may give them a permission.
  SAMPLE_ROUNDS: 'product.styles.view',
  CERTIFICATES: 'compliance.certificates.view',
})

/** The states in which a record still waits on the style (an open quote, an order not yet shipped, …). */
export const OPEN_STATES: Readonly<Record<Exclude<WhereUsedKind, 'STOCK'>, readonly string[]>> = Object.freeze({
  QUOTES: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'],
  SALES_ORDERS: ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'],
  WORK_ORDERS: ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'],
  // A price list version that prices the style now or later (ACTIVE, not ended): see `priceListOpen`.
  PRICE_LISTS: ['ACTIVE'],
  SAMPLE_ROUNDS: ['REQUESTED', 'IN_MAKING', 'SENT', 'UNDER_REVIEW'],
  CERTIFICATES: ['DRAFT', 'VALID', 'SUSPENDED'],
})

export const isOpen = (kind: Exclude<WhereUsedKind, 'STOCK'>, state: string): boolean => OPEN_STATES[kind].includes(state)

/** A price list version is open when ACTIVE and not ended before `day` (YYYY-MM-DD). */
export const priceListOpen = (status: string, validTo: string | null, day: string): boolean => status === 'ACTIVE' && (validTo === null || validTo >= day)

/** How many rows a kind lists at most (the newest first); `more` says there are others. */
export const WHERE_USED_ROWS = 50

/** Open first, then the newest. */
export function byOpenThenNewest<Row extends { readonly open: boolean; readonly at: string | null; readonly number: string }>(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => Number(b.open) - Number(a.open) || (b.at ?? '').localeCompare(a.at ?? '') || b.number.localeCompare(a.number))
}
