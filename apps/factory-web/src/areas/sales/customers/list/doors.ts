import { recordHref, SIDES } from '../../../parties/_shared/model'
import type { OrderPhase } from './api'

/**
 * F-CL-202 (customers list 13-backend §4 table + §8.7, settles T6 / T20): every door a count of the list opens — ONE place, pure. A
 * count and the rows its door shows are one where on the server (the pg tests pin each pair). Two doors depend on a sibling lane's
 * web PR; each waits behind one constant the lead flips when that PR is on main:
 */

/** cq's Quotes & incoming tab reads `group=` (its web PR on main): then "To answer" / "Open quotes" open their own group. */
export const QUOTES_GROUP_DOORS = false
/** cw's Work tab reads `priority=` in its terms (its ExtraTerms change on main): then "Priority: Top / High" open exactly those orders. */
export const PRIORITY_DOORS = false

export type WorkDoorTerm =
  | { readonly kind: 'phase'; readonly phase: OrderPhase }
  | { readonly kind: 'late' }
  | { readonly kind: 'waitsForYes' }
  | { readonly kind: 'deposit' }
  | { readonly kind: 'customerUrgent' }
  | { readonly kind: 'priority'; readonly level: 'URGENT' | 'HIGH' }
  | { readonly kind: 'requests'; readonly firstId: string | null }
  | { readonly kind: 'replies' }
  | { readonly kind: 'quotes'; readonly group: 'TO_ANSWER' | 'OPEN_QUOTES' }
  /** "+n more": the Work tab as it opens. */
  | { readonly kind: 'work' }

/** Which sibling doors are live (the two constants; a test passes its own). */
export interface DoorsLive {
  readonly quotes: boolean
  readonly priority: boolean
}
const LIVE: DoorsLive = { quotes: QUOTES_GROUP_DOORS, priority: PRIORITY_DOORS }

/** The customer page's address for a count: its Work tab on exactly those orders, its quotes, its thread or its review window. */
export function workDoor(prefix: string, partyId: string, term: WorkDoorTerm, live: DoorsLive = LIVE): string {
  const base = recordHref(prefix, SIDES.customers, partyId)
  const query = new URLSearchParams()
  switch (term.kind) {
    case 'phase':
      query.set('tab', 'work')
      query.set('phase', term.phase)
      break
    case 'late':
      query.set('tab', 'work')
      query.set('late', 'true')
      break
    case 'waitsForYes':
      query.set('tab', 'work')
      query.set('status', 'PENDING_APPROVAL')
      break
    case 'deposit':
      query.set('tab', 'work')
      query.set('deposit', 'OPEN')
      break
    case 'customerUrgent':
      query.set('tab', 'work')
      query.set('customerUrgency', 'URGENT')
      break
    case 'priority':
      query.set('tab', 'work')
      if (live.priority) {
        query.set('rows', 'open')
        query.set('priority', term.level)
      }
      break
    case 'requests':
      query.set('tab', 'work')
      if (term.firstId) query.set('open', term.firstId)
      break
    case 'replies':
      query.set('thread', 'all')
      break
    case 'quotes':
      query.set('tab', 'quotes')
      if (live.quotes) query.set('group', term.group)
      break
    case 'work':
      query.set('tab', 'work')
      break
  }
  return `${base}?${query.toString()}`
}
