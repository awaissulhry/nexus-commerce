import type { OrderLife } from '@nexus/factory-domain/sales/order-life'
import { actionFaceOf, ORDER_LOG_ACTIONS, type OrderLogAction } from '@nexus/factory-domain/sales/order-log/faces'

/**
 * owb-b4 w4.4 (design § 8 "Who changed what: one history, three faces", § 5zk C, § 5zl "one icon for each kind of change"; owb-b23
 * "Shapes" OrderLogAnswer) — the ONE change log of an order, its pure side: a row as the server sends it (parsed by api.ts with this
 * web's own zod), who a row shows (drawn from its face ONLY: the server decided the face per door — a name only on PERSON), the
 * words of its action, and the room rule (a table on a PC, a list on a phone: the part's own room, never the window).
 *
 * The wall is on the SERVER: a portal answer carries no worker, no office note, no reason (null), only the customer's allow-list; a
 * floor answer says "You" / "Office" / the department. The part never gets a hidden value to hide: it draws what it got. Owner after
 * the base: S2 (PL-split § 3); S1 draws the portal's face, S5 the floor's. Pure: no React, no API.
 */

/** Who a row shows (owb-b23 "Shapes" `who.face`). */
export const LOG_FACES = ['PERSON', 'THE_FACTORY', 'YOU', 'OFFICE', 'DEPARTMENT', 'SYSTEM'] as const
export type LogFace = (typeof LOG_FACES)[number]

/** A value before or after a change (owb-b23 "Shapes" `LogValue`). */
export type LogValue =
  | { readonly kind: 'LIFE'; readonly life: OrderLife }
  | { readonly kind: 'DEPT'; readonly no: number }
  | { readonly kind: 'DATE'; readonly date: string }
  | { readonly kind: 'TEXT'; readonly text: string }
  | { readonly kind: 'COUNT'; readonly n: number }
  | { readonly kind: 'PICTURE'; readonly fileId: string | null }

/** One row of the log as this web reads it. A face or subject kind it does not know stays a string (drawn neutrally). */
export interface LogRow {
  readonly id: string
  /** ISO time. */
  readonly at: string
  readonly who: { readonly face: string; readonly name: string | null; readonly departmentNo: number | null }
  /** The audit action (`orders.changePromise`) or the log's own key (`PROMISE_MOVED`): both read (actionKeyOf). */
  readonly action: string
  /** ONE lucide icon id (kebab case); an unknown one draws a plain dot. */
  readonly icon: string
  readonly subject: { readonly kind: string; readonly label: string | null }
  readonly from: LogValue | null
  readonly to: LogValue | null
  /** Office only; always null in a portal answer (the server's wall). */
  readonly reason: string | null
}

export interface LogPage {
  readonly rows: readonly LogRow[]
  readonly nextCursor: string | null
}

// ---- who ------------------------------------------------------------------------------------------------------------------------

/** Who a row shows: a name (PERSON only), a word, or a department's chip. */
export type WhoView = { readonly kind: 'name'; readonly name: string } | { readonly kind: 'word'; readonly key: string } | { readonly kind: 'department'; readonly no: number }

/**
 * Who a reader sees, from the face ONLY (design words): PERSON its name · THE_FACTORY "The factory" · YOU "You" · OFFICE "Office" ·
 * DEPARTMENT its chip ("A department" without a number) · SYSTEM "Nexus". A name rides on PERSON alone — any other face's name is
 * never drawn; a PERSON without a name, or a face this web does not know, says "Someone".
 */
export function whoViewOf(who: LogRow['who']): WhoView {
  switch (who.face) {
    case 'PERSON':
      return who.name?.trim() ? { kind: 'name', name: who.name.trim() } : { kind: 'word', key: 'who.someone' }
    case 'DEPARTMENT':
      return who.departmentNo != null ? { kind: 'department', no: who.departmentNo } : { kind: 'word', key: 'who.DEPARTMENT' }
    case 'THE_FACTORY':
    case 'YOU':
    case 'OFFICE':
    case 'SYSTEM':
      return { kind: 'word', key: `who.${who.face}` }
    default:
      return { kind: 'word', key: 'who.someone' }
  }
}

// ---- what -----------------------------------------------------------------------------------------------------------------------

const LOG_KEYS: ReadonlySet<string> = new Set<string>(ORDER_LOG_ACTIONS)

/** The log's key of an action: the key itself, or the audit action's (the domain's ONE map; not named there: OTHER). */
export const actionKeyOf = (action: string): OrderLogAction => (LOG_KEYS.has(action) ? (action as OrderLogAction) : actionFaceOf(action).key)

/** The action's words: `change-log:action.<KEY>`. */
export const actionWordKeyOf = (action: string): string => `action.${actionKeyOf(action)}`

/** The subject's words before its label (`subject.<KIND>`: "Line", "Shipment", "Basket" …), or none for the order itself. */
export function subjectKeyOf(subject: LogRow['subject']): string | null {
  return ['LINE', 'SHIPMENT', 'FILE', 'BASKET', 'REQUEST'].includes(subject.kind) ? `subject.${subject.kind}` : null
}

/** A calendar day (`YYYY-MM-DD`, written at noon UTC so no zone moves it) or an instant, as the day to write. */
export const dayValueOf = (value: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value)

// ---- the room ---------------------------------------------------------------------------------------------------------------------

/** From this room (CSS px of the part's own box) the log is a table; under it a list (change-log.css says the same, in @container). */
export const CHANGE_LOG_WIDE_PX = 720

/** The form the part takes in a room of `width` px: a table (when · who · what · from → to) or a list (a phone, a narrow page). */
export const changeLogFormOf = (width: number): 'table' | 'list' => (width >= CHANGE_LOG_WIDE_PX ? 'table' : 'list')

// ---- the reads' states ------------------------------------------------------------------------------------------------------------

/** The log's state: its rows, the first read, the next page ("Load more"). */
export interface ChangeLogState {
  readonly rows: readonly LogRow[]
  readonly status: 'reading' | 'ready' | 'failed'
  /** `none`: every row is here; `idle`: a next page exists; `reading` / `failed`: the next page's read. */
  readonly more: 'none' | 'idle' | 'reading' | 'failed'
  readonly cursor: string | null
}

export const CHANGE_LOG_START: ChangeLogState = Object.freeze({ rows: [], status: 'reading', more: 'none', cursor: null })

/** A page answered: its rows after the ones already here (a row already here is not drawn twice), and whether more exist. */
export function withPage(state: ChangeLogState, page: LogPage, first: boolean): ChangeLogState {
  const here = first ? [] : state.rows
  const seen = new Set(here.map((row) => row.id))
  return { rows: [...here, ...page.rows.filter((row) => !seen.has(row.id))], status: 'ready', more: page.nextCursor ? 'idle' : 'none', cursor: page.nextCursor }
}
