import { MAX_TEXT } from '@nexus/factory-domain/sales/quotes/quotes' // F-OO-210: the office note's limit
import { BULK_LIMITS } from '@nexus/factory-domain/views/bulk/rules' // F-OO-210
import type { Order } from '../../api'
import { addressLineOf, amendHeld } from '../../daily-model'
import { depthEditHeld, type DepthCan } from '../../depth/model'
import { isFinal, romeToday, type OrderAbilities, type Phrase } from '../../model'
import { INTL_LOCALE, type Locale } from '../../../../../lib/i18n/locales'
import { languageName } from '../../../../_shared/reasons/model'

/**
 * F-OO-209 (order overview 11-design §7; Owner §7) — Order facts: only the facts found nowhere else on the Overview, each changeable
 * one with its real door — the customer PO and Ship to through the ONE edit path (the Lines edit mode with that field focused), the
 * priority and the season through the depth's own dialogs — and the rest said as Fixed (set when the order was made). Pure: the card
 * is view/overview/FactsCard.tsx.
 */

/** The order's language in the reader's words ("German" / "Tedesco"; Intl), its code when the browser has no name for it. */
export const languageOf = (order: Pick<Order, 'language'>, locale: Locale): string => languageName(order.language, INTL_LOCALE[locale])

/**
 * The changeable facts' doors, each null (live) or held with its words — all in the orders catalogue, one wording per meaning on the
 * card (depthEditHeld's two reasons are the orders' held.noManage / held.final too). The customer PO and Ship to: the amendment's own
 * rule (amendHeld, as the band's ⋯ Change ship-to…); the priority and the season: the depth's (depthEditHeld). Null as a whole: a
 * read-only reader, who sees the facts and no door.
 */
export interface FactsDoors {
  readonly customerRef: Phrase | null
  readonly shipTo: Phrase | null
  readonly priority: Phrase | null
  readonly season: Phrase | null
  /** F-OO-210: the office note (noteHeldOf: the sheet's write's own rule). */
  readonly note: Phrase | null
}

export function factsDoorsOf(order: Order, input: { readonly can: OrderAbilities; readonly readOnly: boolean; readonly busy: boolean; readonly depthCan?: Pick<DepthCan, 'manage'> | null }): FactsDoors | null {
  if (input.readOnly) return null
  const busy: Phrase | null = input.busy ? { key: 'held.busy' } : null
  const amend = amendHeld(order, input.can) ?? busy
  const depth = depthEditHeld(order.status, input.depthCan ?? input.can) ?? busy
  return { customerRef: amend, shipTo: amend, priority: depth, season: depth, note: noteHeldOf(order, input.can, input.busy) /* F-OO-210 */ }
}

/** Where the order ships, as one line (the order's own address); null: none written. */
export const shipToOf = (order: Pick<Order, 'shipTo'>): string | null => addressLineOf(order.shipTo as Record<string, unknown> | null | undefined)

/**
 * Made: who made the order (an office person of the read's `people`; null: not named — made by the system or the portal) and, when
 * the order date is another day than the day it was made (Rome), that order date.
 */
export function madeOf(order: Pick<Order, 'createdAt' | 'createdById' | 'people' | 'orderDate'>): { readonly by: string | null; readonly ordered: string | null } {
  const by = order.createdById ? (order.people.find((person) => person.id === order.createdById)?.name ?? null) : null
  return { by, ordered: order.orderDate !== romeToday(new Date(order.createdAt)) ? order.orderDate : null }
}

/**
 * The delivery terms carried from the quote (B-OO-013): the Incoterm, its place, ship complete or as ready. Null: the read does not
 * send them (an older answer) — the row is left out, never a made-up "none".
 */
export function incotermOf(order: Pick<Order, 'incoterm' | 'incotermPlace' | 'shipComplete'>): { readonly code: string | null; readonly place: string | null; readonly ship: 'complete' | 'asReady' | null } | null {
  if (order.incoterm === undefined && order.shipComplete === undefined) return null
  return { code: order.incoterm ?? null, place: order.incotermPlace?.trim() || null, ship: order.shipComplete === undefined ? null : order.shipComplete ? 'complete' : 'asReady' }
}

// ---- F-OO-210 (order overview 11-design §7.3; Owner D4): the office note — Order facts' one row, saved by the Orders sheet's own write ----
/** The sheet's list whose write saves the note (platform/views/bulk targets/sales-orders: the command sales.orders.editCells). */
export const NOTE_LIST = 'sales.orders'
/** The note's limit: the sheet's cell (the API's NOTE_MAX — the order's note within the bulk text limit). */
export const NOTE_MAX = Math.min(MAX_TEXT.internalNote, BULK_LIMITS.text)

/** Why the note's Change… (and the dialog's Save note) waits, or null: the sales right; a closed or cancelled order; a write on its way. */
export function noteHeldOf(order: Pick<Order, 'status'>, can: Pick<OrderAbilities, 'manage'>, busy: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (isFinal(order)) return { key: 'held.final' }
  return busy ? { key: 'held.busy' } : null
}

/** What the sheet's write sends: one row — the order, its version as read, the note (empty: none). */
export const noteBodyOf = (order: Pick<Order, 'id' | 'version'>, note: string) => ({ listKey: NOTE_LIST, rows: [{ id: order.id, version: order.version, changes: { note: note.trim() || null } }] })

/** The dialog's own problem with what is typed, or null: longer than the cell takes; the note it is already. */
export function noteProblem(note: string, current: string | null | undefined): Phrase | null {
  const typed = note.trim()
  if (typed.length > NOTE_MAX) return { key: 'facts.note.long', params: { max: NOTE_MAX } }
  if ((typed || null) === (current?.trim() || null)) return { key: 'facts.note.same' }
  return null
}

/** The page's words for a refusal the write names ('stale' reads the order again; 'held': closed or cancelled; 'forbidden': the right). */
const REFUSED: Readonly<Record<string, string>> = {
  stale: 'problem.write.moved',
  held: 'held.final',
  forbidden: 'held.noManage',
  missing: 'problem.write.not_found',
  invalid: 'problem.write.invalid',
}

/** The row's answer of the sheet's write in the page's words: null when it took; a refusal (or no answer for the row) said. */
export function noteRefusalOf(row: { readonly ok: boolean; readonly refusal: { readonly code: string } | null } | undefined): Phrase | null {
  if (row?.ok) return null
  return { key: (row?.refusal && REFUSED[row.refusal.code]) || 'problem.write.internal' }
}

/** A write that failed as a whole (the list tools' problem: list-frame/tools ToolsProblem) in the page's words. */
export function noteFailureOf(problem: string): Phrase {
  const words: Readonly<Record<string, string>> = { stale: 'problem.write.moved', forbidden: 'held.noManage', notFound: 'problem.write.not_found', invalid: 'problem.write.invalid', offline: 'problem.write.unavailable' }
  return { key: words[problem] ?? 'problem.write.internal' }
}
// ---- end F-OO-210
