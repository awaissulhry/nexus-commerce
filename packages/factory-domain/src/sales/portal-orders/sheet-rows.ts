import type { BusinessDate } from '../../core/time'
import type { CustomerOrderStatus } from './status'

/**
 * The portal orders sheet's rows (owb- order workflow, S1 po1.1; design order-workflow § 5b, § 5zi C, § 5zj A; the S1 build's FIXED
 * Shape "SHEET"): the order as ONE thing — a Draft (a PortalOrderRequest DRAFT), a Sent order not decided yet (REQUEST) and a
 * confirmed order (ORDER) are rows of one sheet, each with the page it opens, its life word, its lines (the C rows), its own columns
 * and what waits for the customer. Pure: the kinds and the waits the web may copy.
 */

export const SHEET_ROW_KINDS = ['ORDER', 'REQUEST', 'DRAFT'] as const
export type SheetRowKind = (typeof SHEET_ROW_KINDS)[number]

/**
 * "Waits · news" (design § 5b): NEW_MESSAGES unread messages of the order's thread for the reader · DESIGN_APPROVAL a design (artwork,
 * proof) waits for the customer's yes · SEND_LABEL the factory's warehouse waits for the customer's shipping label (only once S3's
 * warehouse leg read is on main) · ASKED the customer's asks waiting for the factory's answer · OPEN_DETAILS a draft's Still open
 * items · LATE the promise passed and pieces are still to ship.
 */
export const SHEET_WAITS = ['NEW_MESSAGES', 'DESIGN_APPROVAL', 'SEND_LABEL', 'ASKED', 'OPEN_DETAILS', 'LATE'] as const
export type SheetWait = (typeof SHEET_WAITS)[number]

/** A Draft row's state words (it has no customer status yet: the sheet's `status` is null for it). */
export const DRAFT_ROW_WORDS = Object.freeze({ it: 'Bozza', en: 'Draft' })

/** The approval kinds that are "Design: your yes?" (the design window). */
export const DESIGN_APPROVAL_KINDS = ['ARTWORK', 'PROOF'] as const

/** An order is late for the customer: its promise passed and it still has pieces to ship. */
export function isLate(status: CustomerOrderStatus | null, promiseDate: BusinessDate | null, today: BusinessDate): boolean {
  if (status === null || promiseDate === null || promiseDate >= today) return false
  return status === 'CONFIRMED' || status === 'IN_PRODUCTION' || status === 'READY' || status === 'PARTLY_SHIPPED'
}

/** The waits of a row in the Shape's order, only those that wait (a count, or null when the fact has no number). */
export function waitsOf(facts: Partial<Record<SheetWait, number | boolean>>): { kind: SheetWait; count: number | null }[] {
  const out: { kind: SheetWait; count: number | null }[] = []
  for (const kind of SHEET_WAITS) {
    const fact = facts[kind]
    if (fact === undefined || fact === false || fact === 0) continue
    out.push({ kind, count: fact === true ? null : fact })
  }
  return out
}
