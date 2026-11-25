import { Archive, Ban, CircleCheck, Hourglass, Inbox, Package, Scissors, Send, Truck, type LucideIcon } from 'lucide-react'
import { ORDER_PHASES, type OrderPhase } from '@nexus/factory-domain/production-brand/stages'

/**
 * pg-w1 (portal grid plan § 2; 18-lead-settles Z1–Z3, Z6) — the groups of a customer's orders, pure: the ONE set per face, one mark
 * per group, the words of each group (where they live), and which groups stand apart (closed). The office face is the domain's seven
 * phases (`ORDER_PHASES`: the customer page's Work band); the customer face is the portal's eight groups (the sheet answer's
 * `groups`, counted by the server: Requests · Confirmed · In production · Ready to ship · Shipped · Delivered, then Cancelled and
 * Closed requests apart). Counts are never made here: the host hands the ones its read gave. No React, no office or portal code.
 */

export type GroupFace = 'office' | 'customer'

/** The office face: the domain's seven phases, in their order (Cancelled apart). */
export const OFFICE_GROUPS: readonly OrderPhase[] = ORDER_PHASES

/** The customer face: the portal's eight groups (the sheet answer's `groups`), in their order (the last two apart). */
export const CUSTOMER_GROUPS = ['REQUESTS', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'CLOSED_REQUESTS'] as const
export type CustomerGroup = (typeof CUSTOMER_GROUPS)[number]

/** A group of either face (the office's phases and the customer's groups share four names: the face says which set). */
export type OrderGroup = OrderPhase | CustomerGroup

export const isCustomerGroup = (value: unknown): value is CustomerGroup => typeof value === 'string' && (CUSTOMER_GROUPS as readonly string[]).includes(value)

/**
 * F-CW-101 (customer Work tab; 10-design §2: "groups are told apart by word, icon and place, never by colour alone") — the ONE mark
 * of each phase: the customer page's band draws it on its group, the sheet's Where it is cell on its first chip (the stage of an
 * order in production carries its group's mark). Lucide, as every other mark of the sheet; always beside the phase's words.
 * pg-w1: moved here from the Orders sheet (sheet/phase-icon.ts), typed by the domain's phase.
 */
export const PHASE_ICON: Readonly<Record<OrderPhase, LucideIcon>> = Object.freeze({
  NOT_SENT: Inbox,
  NOT_STARTED: Hourglass,
  IN_PRODUCTION: Scissors,
  READY: Package,
  SHIPPED: Truck,
  DONE: CircleCheck,
  CANCELLED: Ban,
})

/**
 * The customer face's marks (10-design § 1.2): one per group, drawn in the groups' window and on the status chip, never in a tile.
 * Confirmed shares the hourglass with "Production not started" (both: not started yet).
 */
export const CUSTOMER_GROUP_ICON: Readonly<Record<CustomerGroup, LucideIcon>> = Object.freeze({
  REQUESTS: Send,
  CONFIRMED: Hourglass,
  IN_PRODUCTION: Scissors,
  READY: Package,
  SHIPPED: Truck,
  DELIVERED: CircleCheck,
  CANCELLED: Ban,
  CLOSED_REQUESTS: Archive,
})

/** The groups that stand apart, quiet (closed): the office's Cancelled; the customer's Cancelled and Closed requests. */
export const CLOSED_GROUPS: Readonly<{ office: readonly OrderPhase[]; customer: readonly CustomerGroup[] }> = Object.freeze({
  office: Object.freeze(['CANCELLED'] as const),
  customer: Object.freeze(['CANCELLED', 'CLOSED_REQUESTS'] as const),
})

/** Every group of a face, in its order. */
export const groupsOf = (face: GroupFace): readonly OrderGroup[] => (face === 'office' ? OFFICE_GROUPS : CUSTOMER_GROUPS)

/** Whether a group of this face stands apart (closed). */
export const isClosedGroup = (face: GroupFace, group: OrderGroup): boolean => (CLOSED_GROUPS[face] as readonly string[]).includes(group)

/** A group's mark on its face (null: not a group of that face). */
export function groupMarkOf(face: GroupFace, group: OrderGroup): LucideIcon | null {
  if (face === 'customer') return isCustomerGroup(group) ? CUSTOMER_GROUP_ICON[group] : null
  return (ORDER_PHASES as readonly string[]).includes(group) ? PHASE_ICON[group as OrderPhase] : null
}

// ---- the words: one source, read where they live (Z2) -------------------------------------------------------------------------

/** The catalogue of the shared list parts' own words (`messages/<locale>/order-list.json`: the customer face's `customer.*`). */
export const ORDER_LIST_NS = 'order-list'

/** A word of a group: its namespace and key (the office's stay in their catalogues; the customer's new ones in `order-list`). */
export interface GroupWords {
  readonly ns: string
  readonly key: string
}

/**
 * F-CW-101 (customer Work tab; lead settles S2, S3, S17; 10-design §2): the phase's words — ONE word for one thing. A phase in words,
 * for its chip above the sheet, the band's group and its door: the approved rows words where they exist (In production, Ready to
 * ship, Shipped, Cancelled: the `orders` catalogue's `rows.*`, `orders: true`), and the `orders-sheet` catalogue's own for the three
 * new groups (Not sent to the factory, Production not started, Done). SHIPPED holds partly shipped and shipped; DONE holds delivered
 * and closed (the domain's PHASE_STATUSES). pg-w1: moved here from the Orders sheet's model (it re-exports it), unchanged.
 */
export function phasePhrase(phase: OrderPhase): { readonly key: string; readonly orders?: true } {
  if (phase === 'IN_PRODUCTION' || phase === 'READY' || phase === 'SHIPPED' || phase === 'CANCELLED') return { key: `rows.${phase}`, orders: true }
  return { key: `phase.${phase}` }
}

/**
 * A group's name on its face. Office: the phase's words (phasePhrase: `orders` or `orders-sheet`). Customer: the `orders` catalogue's
 * `rows.*` for the six that are a status of the order (read in place, the office's own words), the `order-list` catalogue's
 * `customer.group.*` for Requests and Closed requests.
 */
export function groupNameOf(face: GroupFace, group: OrderGroup): GroupWords {
  if (face === 'office') {
    const words = phasePhrase(group as OrderPhase)
    return { ns: words.orders ? 'orders' : 'orders-sheet', key: words.key }
  }
  if (group === 'REQUESTS' || group === 'CLOSED_REQUESTS') return { ns: ORDER_LIST_NS, key: `customer.group.${group}` }
  return { ns: 'orders', key: `rows.${group}` }
}

/** What a group holds, said in the groups' window under its name: the office's `orders-sheet` `phase.note.*`; the customer's `customer.note.*`. */
export function groupNoteOf(face: GroupFace, group: OrderGroup): GroupWords {
  return face === 'office' ? { ns: 'orders-sheet', key: `phase.note.${group}` } : { ns: ORDER_LIST_NS, key: `customer.note.${group}` }
}

/** The catalogues a face's band reads (the band's own words: `parties` for both — the ⓘ and the failed read — then the group words). */
export const GROUPS_NAMESPACES: Readonly<Record<GroupFace, readonly string[]>> = Object.freeze({
  office: Object.freeze(['parties', 'orders', 'orders-sheet']),
  customer: Object.freeze(['parties', 'orders', ORDER_LIST_NS]),
})
