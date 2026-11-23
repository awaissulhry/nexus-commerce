import { recordHref, SIDES } from '../../../parties/_shared/model'
import { THREAD_TERM } from '../../../_shared/record-frame/address' // F-CL-301: the frame's thread term
import type { OrderPhase } from './api'

/** F-CL-301: the customer page's dock term (`dock=`, cu/record's DOCK_PARAM — the test reads the door back with its own parser). */
const DOCK_TERM = 'dock'

/**
 * F-CL-202 (customers list 13-backend §4 table + §8.7, settles T6 / T20): every door a count of the list opens — ONE place, pure. A
 * count and the rows its door shows are one where on the server (the pg tests pin each pair). The sibling lanes' doors are on main:
 * the Work tab reads `phase=` and `priority=` (cw W1, #1910), the Quotes & incoming tab reads `group=` (cq W1, #1911).
 */

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

/** The customer page's address for a count: its Work tab on exactly those orders, its quotes, its thread or its review window. */
export function workDoor(prefix: string, partyId: string, term: WorkDoorTerm): string {
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
      query.set('rows', 'open')
      query.set('priority', term.level)
      break
    case 'requests':
      query.set('tab', 'work')
      if (term.firstId) query.set('open', term.firstId)
      break
    case 'replies':
      // F-CL-301 (walk W-3): `thread=all` is the order page's scope and opened the customer's General. The customer page's own term
      // docks All of <customer> (`dock=all`, every conversation, the waiting reply's among them), the frame's `thread=open` shows the
      // thread (on a phone its full view), on the Work tab where the reply's order says "Reply waits".
      query.set('tab', 'work')
      query.set(DOCK_TERM, 'all')
      query.set(THREAD_TERM, 'open')
      break
    case 'quotes':
      query.set('tab', 'quotes')
      query.set('group', term.group)
      break
    case 'work':
      query.set('tab', 'work')
      break
  }
  return `${base}?${query.toString()}`
}
