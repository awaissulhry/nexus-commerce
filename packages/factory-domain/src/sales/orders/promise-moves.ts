import { isUuid } from '../../core/ids'
import { isBusinessDate, type BusinessDate } from '../../core/time'

/**
 * B-PT-011 (order production tab R11): ONE rule for what an order's `orders.changePromise` audit row is — the order's FIRST promise
 * (SET: it had none, the row's `before.originalPromiseDate` is null — sales/orders moves.ts writes it so for the order's change and
 * the lines' alike) or a MOVE of it — so the production read's "moved N×" and the order read's promise history never disagree; and
 * a lines' move's own day per line before it (`before.lines`), so a move of lines on different days reads each line's day, never
 * "— → 19 Dec". A row that does not say counts as a move, as before. Pure.
 */

export const PROMISE_MOVE_KINDS = ['SET', 'MOVED'] as const
export type PromiseMoveKind = (typeof PROMISE_MOVE_KINDS)[number]

/** The row set the order's first promise (its `before` says the order had none). */
export function isFirstPromise(before: unknown): boolean {
  return before !== null && typeof before === 'object' && 'originalPromiseDate' in before && (before as { readonly originalPromiseDate: unknown }).originalPromiseDate === null
}

/** SET for the first promise, MOVED for every other row. */
export const promiseMoveKindOf = (before: unknown): PromiseMoveKind => (isFirstPromise(before) ? 'SET' : 'MOVED')

/**
 * A lines' move: each line it moved with its day before (the line's own promise, else the order's; null: none), in the row's order;
 * null for a move of the whole order (its `before` names no lines). A key that is not a line id is left out; a day that is not one
 * reads null.
 */
export function fromByLineOf(before: unknown): { lineId: string; from: BusinessDate | null }[] | null {
  if (before === null || typeof before !== 'object' || !('lines' in before)) return null
  const lines = (before as { readonly lines: unknown }).lines
  if (lines === null || typeof lines !== 'object' || Array.isArray(lines)) return null
  return Object.entries(lines as Readonly<Record<string, unknown>>).flatMap(([lineId, from]) => (isUuid(lineId) ? [{ lineId, from: isBusinessDate(from) ? from : null }] : []))
}
