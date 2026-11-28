import type { PromiseReasonCode } from '@nexus/factory-domain/sales/portal-orders/promise'
import type { FromTheFloor, LateWarning } from '../../api'

/**
 * owb-fl9 step 4 — "From the floor" on the office order's Production tab (design § 5zf D; P/fplus.js floorSec), without React or the
 * network. Office only: the customer never reaches this part (the slot is mounted in the office order page only).
 *
 *   photos     the floor's photos of the order's baskets: **Share with the customer** (sales / owner: today's use-on) or **Keep inside**
 *              (calls nothing); a shared one says so
 *   changes    "Changed on the floor": a move back and a route change, with who, what and why
 *   late       Will be late: **The date holds** (KEPT) or **Change the promise…** (the order's own promise command, then CHANGED)
 *   empty      all three empty → one sentence
 */

export const isEmpty = (read: FromTheFloor): boolean => read.photos.length === 0 && read.changes.length === 0 && read.late.length === 0

/** Share with the customer: the office person who sells (sales, the owner): the use-on route asks files.upload and files.manage. */
export const mayShare = (permissions: readonly string[]): boolean => permissions.includes('files.upload') && permissions.includes('files.manage')

/** The answer to a late warning: the person who keeps the order's promise (orders.manage). */
export const mayAnswerLate = (permissions: readonly string[]): boolean => permissions.includes('orders.manage')

/** A warning still waits for the office's answer. */
export const lateOpen = (late: Pick<LateWarning, 'state'>): boolean => late.state === 'OPEN'

/** Newest first, everywhere in the part. */
export function newestFirst<T extends { readonly at: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.at.localeCompare(a.at))
}

/** The promise's reason that the customer reads, from the floor's reason (the office may pick another in the window). */
export function promiseReasonFor(floorReason: string): PromiseReasonCode {
  switch (floorReason) {
    case 'MATERIAL':
      return 'MATERIAL_LATE'
    case 'REDO':
      return 'QUALITY'
    case 'MACHINE':
    case 'PEOPLE':
      return 'CAPACITY'
    default:
      return 'PLANNING'
  }
}

/** The new promise the window proposes: the promise moved by the warning's days (a day `YYYY-MM-DD`), or empty without a promise. */
export function proposedPromise(promiseDate: string | null, days: number): string {
  if (!promiseDate) return ''
  const day = new Date(`${promiseDate.slice(0, 10)}T12:00:00.000Z`)
  if (Number.isNaN(day.getTime())) return ''
  day.setUTCDate(day.getUTCDate() + days)
  return day.toISOString().slice(0, 10)
}
