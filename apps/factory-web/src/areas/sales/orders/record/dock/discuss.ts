import type { DiscussAbout, DiscussKind } from '../../../../_shared/record-frame/model'

/**
 * F-SA-266 (sales page plan N2, N4; picks P2, P9; 10-order-page §2 "Doors legend", §6.4) — what a row of the order page discusses,
 * pure: the chip's words for each audience, which rows stay in office notes, and where a message about a part jumps back to (its
 * tab and the row's anchor, "Show on the page").
 *
 *   office note     "SO-2026-0142 · line 2 · JKT-01 Black"             (the office's own number)
 *   to the customer "your order · line 2 · JKT-01 Black"               (its own words: never a price, never a work-order number)
 *   office only     Production's work orders, holds and quality, Money's deposit, invoices and schedule (the stricter money rule),
 *                   a date of the working plan — the chip goes on a reply ("The reference stays in office notes")
 *   no reference    a part the conversation cannot keep (a planned date, an amendment, a payment step): the note's first line
 */

/** The row's anchor on the page (its id: "Show on the page" scrolls to it and gives it the focus). */
export const rowAnchor = (kind: DiscussKind | 'Amendment' | 'Milestone' | 'Step', id: string): string => `about-${kind}-${id}`

/** The tab a part of the order lives on. */
export const ABOUT_TAB: Readonly<Record<DiscussKind, 'lines' | 'production' | 'changes' | 'money' | 'shipments'>> = Object.freeze({
  SalesOrderLine: 'lines',
  Shipment: 'shipments',
  Invoice: 'money',
  DepositRequest: 'money',
  OrderGate: 'production',
  OrderChangeRequest: 'changes',
  WorkOrder: 'production',
})

/** Where a message about a part jumps back to (null: a kind the page does not draw). */
export function aboutPlace(about: { readonly kind: string; readonly id: string }): { readonly tab: string; readonly anchor: string } | null {
  if (!Object.hasOwn(ABOUT_TAB, about.kind)) return null
  const kind = about.kind as DiscussKind
  return { tab: ABOUT_TAB[kind], anchor: rowAnchor(kind, about.id) }
}

/** The words a row hands its Discuss door (already in the page's language). */
export interface DiscussPart {
  /** The part in the office's words ("line 2 · JKT-01 Black", "WO-2026-0311"). */
  readonly part: string
  /** The part in the customer's words when they differ (a shipment's own number is theirs too); absent: the same. */
  readonly customerPart?: string
  /** The part the conversation keeps; null: words only (the note's first line). */
  readonly target: { readonly kind: DiscussKind; readonly id: string } | null
  /** Stays in office notes whatever its kind (a work order, a hold, quality, the money rows, the working plan). */
  readonly officeOnly?: boolean
}

/** The chip a row's Discuss gives the conversation. */
export function discussAboutOf(order: { readonly number: string }, words: { readonly yourOrder: string; readonly firstLine: (thing: string) => string }, input: DiscussPart): DiscussAbout {
  const office = `${order.number} · ${input.part}`
  const customer = input.target && !input.officeOnly ? `${words.yourOrder} · ${input.customerPart ?? input.part}` : null
  return { ref: input.target, office, customer, ...(input.target ? {} : { line: words.firstLine(office) }) }
}
