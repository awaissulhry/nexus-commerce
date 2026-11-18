/**
 * F-SA-262 (sales page plan N4; picks P9, P9', R4, R9; 10-order-page §6.1, §6.2; review C-13, C-14) — the order dock's scope, pure:
 * which ONE conversation the order page's dock shows, as the address keeps it (`?thread=general|project:<id>|wo:<id>|all`; no term
 * or the narrow view's `open`: this order's own), the choices the reader may read, and the work orders grouped per style ×
 * colourway (made-to-measure units: one group per style and colourway, R9). Writing always goes into the ONE conversation shown;
 * All of <customer> is read only.
 *
 *   This order (default)       the order's own thread — shared with the customer (a reply reaches them); Office note first
 *   <Customer> (general)       the customer's general conversation (the Party thread)
 *   Projects ▾                 each project that links this order (GET /projects/of/SalesOrder/:id: the ones the reader may open)
 *   Work orders ▾              office only (workorders.view): the work orders the production read gives this reader (its wall);
 *                              their notes are never shared with a customer; "For the floor" reaches the tablets
 *   All of <Customer>          the read-only merged feed (B-SA-060), "Write in: This order · General"
 *
 * A scope the address names that is not offered (a project not linked, a work order out of reach, no right) shows this order's
 * own conversation, with no word that it existed.
 */

/** The address term the dock's scope lives in (the frame's own: `open` is the narrow view, `new` an arrival). */
export const SCOPE_PARAM = 'thread'

export type OrderScope = { readonly kind: 'order' } | { readonly kind: 'general' } | { readonly kind: 'all' } | { readonly kind: 'project'; readonly id: string } | { readonly kind: 'wo'; readonly id: string }

export const ORDER_SCOPE: OrderScope = Object.freeze({ kind: 'order' })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The scope of an address term; anything else (none, `open`, `new`, a made-up value) is this order's own conversation. */
export function scopeOfParam(value: string | null | undefined): OrderScope {
  if (value === 'general') return { kind: 'general' }
  if (value === 'all') return { kind: 'all' }
  const match = /^(project|wo):(.+)$/.exec(value ?? '')
  if (match && UUID.test(match[2]!)) return { kind: match[1] === 'project' ? 'project' : 'wo', id: match[2]! }
  return ORDER_SCOPE
}

/** The address value of a scope (null: this order's own, no term). */
export function scopeParamOf(scope: OrderScope): string | null {
  if (scope.kind === 'order') return null
  if (scope.kind === 'project') return `project:${scope.id}`
  if (scope.kind === 'wo') return `wo:${scope.id}`
  return scope.kind
}

/**
 * The page's address with the scope set (a replace: Back keeps it, and the customer page may open a scope). The narrow view keeps a
 * value (`open` for this order's own), so the full-width conversation stays open while the person picks; a line of All of <customer>
 * opens its conversation at its message (`message=`), any other move drops it. Every other term kept.
 */
export function scopeAddress(pathname: string, search: string, scope: OrderScope, narrow: boolean, messageId: string | null = null): string {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const value = scopeParamOf(scope)
  if (value) query.set(SCOPE_PARAM, value)
  else if (narrow) query.set(SCOPE_PARAM, 'open')
  else query.delete(SCOPE_PARAM)
  if (messageId) query.set('message', messageId)
  else query.delete('message')
  const text = query.toString()
  return `${pathname}${text ? `?${text}` : ''}`
}

/** What the reader may pick: the customer's conversations, the linked projects, the work orders of its wall. */
export interface ScopeOffer {
  readonly general: boolean
  readonly all: boolean
  readonly projects: readonly string[]
  readonly workOrders: readonly string[]
}

/** The scope shown: the one asked when it is offered, else this order's own (never a hint that another existed). */
export function scopeShown(scope: OrderScope, offer: ScopeOffer): OrderScope {
  if (scope.kind === 'general') return offer.general ? scope : ORDER_SCOPE
  if (scope.kind === 'all') return offer.all ? scope : ORDER_SCOPE
  if (scope.kind === 'project') return offer.projects.includes(scope.id) ? scope : ORDER_SCOPE
  if (scope.kind === 'wo') return offer.workOrders.includes(scope.id) ? scope : ORDER_SCOPE
  return ORDER_SCOPE
}

/** The segments of the pick (one per kind: projects and work orders are one segment each, with a second select). */
export type ScopeChoice = 'order' | 'general' | 'projects' | 'workOrders' | 'all'

export const choiceOfScope = (scope: OrderScope): ScopeChoice => (scope.kind === 'project' ? 'projects' : scope.kind === 'wo' ? 'workOrders' : scope.kind)

/** The segments offered, in their order. */
export function choicesOffered(offer: ScopeOffer): ScopeChoice[] {
  return [
    'order' as const,
    ...(offer.general ? (['general'] as const) : []),
    ...(offer.projects.length > 0 ? (['projects'] as const) : []),
    ...(offer.workOrders.length > 0 ? (['workOrders'] as const) : []),
    ...(offer.all ? (['all'] as const) : []),
  ]
}

/** A segment picked: its scope (projects and work orders: the one last shown, else the first). */
export function scopeOfChoice(choice: ScopeChoice, offer: ScopeOffer, last: { readonly project: string | null; readonly wo: string | null }): OrderScope {
  if (choice === 'projects') {
    const id = last.project && offer.projects.includes(last.project) ? last.project : offer.projects[0]
    return id ? { kind: 'project', id } : ORDER_SCOPE
  }
  if (choice === 'workOrders') {
    const id = last.wo && offer.workOrders.includes(last.wo) ? last.wo : offer.workOrders[0]
    return id ? { kind: 'wo', id } : ORDER_SCOPE
  }
  return choice === 'general' ? { kind: 'general' } : choice === 'all' ? { kind: 'all' } : ORDER_SCOPE
}

/** A work order the dock may show the notes of (from the production read: this reader's wall). */
export interface DockWorkOrder {
  readonly id: string
  readonly number: string
  readonly style: string | null
  readonly colourway: string | null
  /** A made-to-measure unit (one work order per unit). */
  readonly mtm?: boolean
}

/** The work orders grouped per style × colourway (made-to-measure units: one work order per unit, one group per line), in order. */
export function workOrderGroups(rows: readonly DockWorkOrder[]): { readonly key: string; readonly label: string; readonly items: readonly DockWorkOrder[] }[] {
  const groups: { key: string; label: string; items: DockWorkOrder[] }[] = []
  for (const row of rows) {
    const key = `${row.mtm ? 'mtm' : ''}|${row.style ?? ''}|${row.colourway ?? ''}`
    const label = [row.style, row.colourway].filter(Boolean).join(' · ')
    const group = groups.find((one) => one.key === key)
    if (group) group.items.push(row)
    else groups.push({ key, label, items: [row] })
  }
  return groups
}
