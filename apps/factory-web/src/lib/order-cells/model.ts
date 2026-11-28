import { Check, CheckCheck, Factory, FileText, Mail, Package, Truck, Warehouse, X, type LucideIcon } from 'lucide-react'
import type { SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { groupOf, type CustomerOrderStatus } from '@nexus/factory-domain/sales/portal-orders/status'
// owb-b4 w4.1: the order's life in nine words — the domain's ONE map (web may import pure domain code, as portal/shell does).
import { orderLifeOf, type LifeNote, type LifeNoteKind, type OrderLife, type OrderLifeAnswer } from '@nexus/factory-domain/sales/order-life'
import type { RequestStatus } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { CUSTOMER_GROUP_ICON, type CustomerGroup } from '../order-groups/groups'

/**
 * pg-w1 (portal grid plan § 2; 18-lead-settles Z1, Z4, Z16 P4) — the cells of an order row that the office's sheet and the customer's
 * portal list draw with the SAME parts (lib/order-cells/view): the door of a cell, the status chip, the mark chip, Promised, Shipped,
 * the phone card. Each part draws a NEUTRAL view model typed here — never an office row, never a value to hide (no stage, "by hand",
 * sewn counts, our priority, waiting on, supervisor, office note, cost). The office builds its models from its row (the sheet's own
 * builders stay office: same values → same DOM); the portal from its own read. Pure: no React, no office or portal code.
 */

/** A cell's door: its address, or the reason it is plain text (a right the reader does not hold), or nothing to open. */
export type Door = { readonly href: string; readonly tip: Phrase } | { readonly held: Phrase } | null

/** A word of the host's catalogue (a door's tip is the host's: the door cell is a mechanism, like the list frame). */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** The design system's tones a chip of a row takes. */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** Which face a cell draws: the office's words and look, or the customer's ("was …", "date asked", "wanted"). */
export type CellFace = 'office' | 'customer'

// ---- tones: ONE tone for one status, on every page (Z16 P4) -------------------------------------------------------------------

/** The status chip's tone for each status of a sales order (the office's own table, moved here: the office model reads it). */
export const ORDER_STATUS_TONE: Readonly<Record<SalesOrderStatus, Tone>> = Object.freeze({
  CONFIRMED: 'neutral',
  IN_PRODUCTION: 'info',
  READY: 'info',
  PARTLY_SHIPPED: 'warning',
  SHIPPED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
  PENDING_APPROVAL: 'warning',
  DELIVERED: 'success',
})

/** A customer status' tone: the office's for the same status ("Requested" is the office's "Waiting for a yes"). */
export const customerStatusTone = (status: CustomerOrderStatus): Tone => ORDER_STATUS_TONE[status === 'REQUESTED' ? 'PENDING_APPROVAL' : status]

/** The customer group a customer status counts in (Shipped holds partly shipped and shipped): the domain's ONE rule, the server's too. */
export const customerGroupOf = (status: CustomerOrderStatus): CustomerGroup => groupOf({ kind: 'ROW', status, needsYou: false }) ?? 'REQUESTS'

// ---- the status chip and the mark chip (Z1: shared; the office's Where it is cell draws them inside) ------------------------------

/**
 * The status chip (the DS Pill): the status in words, its tone, its group's mark, and — on the phone card — the shipped pieces after
 * a dot ("Partly shipped · 40 of 114"; in the grid Shipped says them). A closed one is outlined and quiet.
 */
export interface StateChipModel {
  /** The status in words: the office's catalogue words, or the words the customer's read sends (never a code). */
  readonly words: string
  /** ORDER_STATUS_TONE / customerStatusTone: one tone for one status on every page. */
  readonly tone: Tone
  /** The mark of the group the order counts in (lib/order-groups: PHASE_ICON, CUSTOMER_GROUP_ICON). */
  readonly mark: LucideIcon
  /** The shipped pieces in words ("40 of 114"), said after the status; absent: none. */
  readonly tail?: string
  /** A closed one: outlined, quiet (told by its word and mark). */
  readonly line?: boolean
}

/** The customer face's status chip: the read's words, the office's tone for the status, the mark of its group. */
export function customerStateChipOf(status: CustomerOrderStatus, words: string, tail?: string | null): StateChipModel {
  return { words, tone: customerStatusTone(status), mark: CUSTOMER_GROUP_ICON[customerGroupOf(status)], ...(tail ? { tail } : {}) }
}

/**
 * The mark chip (the DS Tag): ONE thing that stops a row or waits on someone — its mark beside its words, its tail after a dot,
 * outlined when neutral (who it waits on), a door when it has one (a real link). `dense`: the head stays whole, the tail and the
 * mark go to its tooltip.
 */
export interface MarkChipModel {
  readonly tone: 'warning' | 'danger' | 'neutral'
  readonly mark: LucideIcon
  readonly head: string
  readonly tail?: string | null
  /** Its door (the record's tab, a review window); absent: no door. */
  readonly href?: string | null
  /** The door's tip, or the chip's own words in full when it has none. */
  readonly tip?: string | null
  readonly dense?: boolean
}

// ---- Promised and Shipped ------------------------------------------------------------------------------------------------------

/**
 * Promised: the promised day as its door. Office: "No promise" when none, the Late tag beside the day (the host leaves it out while
 * Where it is says it). Customer (Z4: one fact, one place): "was 28/11/2026" under a day that moved; with no promise yet the day the
 * customer asked ("date asked"); a request's wanted day ("wanted"); none: "No promise", a request "—".
 */
export interface PromiseCellModel {
  readonly face: CellFace
  /** The day in words ("04/12/2026"); null: none. */
  readonly day: string | null
  /** What the day is: the promise (the default), the day the customer asked (no promise yet), a request's wanted day. */
  readonly of?: 'promise' | 'asked' | 'wanted'
  /** The day's door (its tip in the host's words). */
  readonly door: Door
  /** Office: days late (> 0: the Late tag beside the day); null: none. */
  readonly lateDays?: number | null
  /** Customer: the day promised before it moved, in words; null: it never moved. */
  readonly was?: string | null
}

/** Shipped: the bar and "40 of 114" as its door; the customer's next parcel in words as the cell's tip (D6: named by the order). */
export interface ShippedCellModel {
  readonly shipped: number
  readonly units: number
  /** The record's name for the bar's words ("Pieces of <record> shipped"). */
  readonly record: string
  readonly door: Door
  /** The cell's tip ("Next parcel: Your order 12 · parcel 2 · expected 04/12/2026"); absent: none. */
  readonly tip?: string | null
}

/** The shipped share of the pieces, 0–100 (no pieces: 0). The office's sheet and board read it too. */
export const shippedPercentOf = (shipped: number, units: number): number => (units > 0 ? Math.round((shipped / units) * 100) : 0)

// ---- owb-b4 w4.1: the order's life — the SAME nine words in every door (design word table; R-base A) ------------------------------

/**
 * The nine words: Draft · Sent · Confirmed · In production · Ready to ship · Shipped · At our warehouse (the customer reads "At the
 * factory’s warehouse": outside-words) · Delivered · Withdrawn — the domain's `ORDER_LIFE` / `orderLifeOf`. ONE chip each: its icon,
 * one of the five semantic tones a DS Pill takes (the design's colours said with them: slate → neutral, blue → info, emerald →
 * success, red → danger; In production keeps today's info), and outlined before the work starts and when it went (the design's
 * "line" chips). Never colour alone: the icon and the word say it. Words in `messages/<locale>/order-life.json`.
 */
export const LIFE_TONE: Readonly<Record<OrderLife, Tone>> = Object.freeze({
  DRAFT: 'neutral',
  SENT: 'info',
  CONFIRMED: 'success',
  IN_PRODUCTION: 'info',
  READY_TO_SHIP: 'success',
  SHIPPED: 'success',
  AT_OUR_WAREHOUSE: 'neutral',
  DELIVERED: 'success',
  WITHDRAWN: 'danger',
})

/** Each life's icon (the design's: file, mail, check, factory, package, truck, warehouse, checks, x). */
export const LIFE_ICON: Readonly<Record<OrderLife, LucideIcon>> = Object.freeze({
  DRAFT: FileText,
  SENT: Mail,
  CONFIRMED: Check,
  IN_PRODUCTION: Factory,
  READY_TO_SHIP: Package,
  SHIPPED: Truck,
  AT_OUR_WAREHOUSE: Warehouse,
  DELIVERED: CheckCheck,
  WITHDRAWN: X,
})

/** The lives drawn outlined (before the work starts, and gone). */
export const LIFE_LINE: ReadonlySet<OrderLife> = new Set<OrderLife>(['DRAFT', 'SENT', 'CONFIRMED', 'WITHDRAWN'])

/**
 * How a note joins the word: `word` — the note names the state better and IS the chip's word ("Cancelled", "Refused", "Confirmed:
 * waits for the print", "Printed": the design's names); `tail` — it follows the word after a dot ("Shipped · 40 of 114", "Sent · A
 * quote", "Sent · Waits for approval").
 */
export const NOTE_FORM: Readonly<Record<LifeNoteKind, 'word' | 'tail'>> = Object.freeze({
  PARTLY_SHIPPED: 'tail',
  CANCELLED: 'word',
  REFUSED: 'word',
  QUOTE: 'tail',
  WAITS_FOR_APPROVAL: 'tail',
  WAITS_FOR_PRINT: 'word',
  PRINTED: 'word',
})

/** The note's own words (`order-life:note.<KIND>`, "40 of 114 shipped" with its numbers) — for a host that says it alone. */
export function lifeNotePhrase(note: LifeNote): Phrase {
  return note.kind === 'PARTLY_SHIPPED' ? { key: 'note.PARTLY_SHIPPED', params: { shipped: note.shipped, total: note.total } } : { key: `note.${note.kind}` }
}

/** The life chip: its life, its word, the tail after a dot, its tone, its icon, outlined or not. */
export interface LifeChipModel {
  readonly life: OrderLife
  /** `order-life:life.<LIFE>`, or `note.<KIND>` when the note is the word. */
  readonly word: Phrase
  /** `order-life:tail.<KIND>` / `note.<KIND>` after a dot; absent: none. */
  readonly tail?: Phrase
  readonly tone: Tone
  readonly mark: LucideIcon
  readonly line: boolean
}

/** The chip of a life and its note (the domain's `orderLifeOf` answer, or the life a server's read sends). */
export function lifeChipOf(answer: { readonly life: OrderLife; readonly note?: LifeNote | null }): LifeChipModel {
  const { life } = answer
  const note = answer.note ?? null
  const base = { life, tone: LIFE_TONE[life], mark: LIFE_ICON[life], line: LIFE_LINE.has(life) }
  if (!note) return { ...base, word: { key: `life.${life}` } }
  if (NOTE_FORM[note.kind] === 'word') return { ...base, word: { key: `note.${note.kind}` } }
  const tail: Phrase = note.kind === 'PARTLY_SHIPPED' ? { key: 'tail.PARTLY_SHIPPED', params: { shipped: note.shipped, total: note.total } } : { key: `note.${note.kind}` }
  return { ...base, word: { key: `life.${life}` }, tail }
}

/**
 * Today's status codes a caller may still hold — the office's (SalesOrderStatus), the customer's (CustomerOrderStatus: REQUESTED is
 * a sent request or an order waiting for the office's yes), a portal request's (RequestStatus). The chip maps them through the
 * domain's `orderLifeOf`, so a caller passes its code until it has the facts for `life` (the shipments, the print, the warehouse leg).
 */
export type OrderStatusCode = SalesOrderStatus | CustomerOrderStatus | RequestStatus

const REQUEST_CODES: ReadonlySet<string> = new Set<RequestStatus>(['DRAFT', 'SENT', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'])

/** The life of a status code (`pieces`: shipped of total for a partly shipped one). */
export function lifeOfStatus(code: OrderStatusCode, pieces?: { readonly shipped: number; readonly total: number } | null): OrderLifeAnswer {
  if (code === 'REQUESTED') return orderLifeOf({ request: { status: 'SENT' } })
  if (REQUEST_CODES.has(code)) return orderLifeOf({ request: { status: code as RequestStatus } })
  return orderLifeOf({ order: { status: code as SalesOrderStatus, pieces: pieces ?? null } })
}
