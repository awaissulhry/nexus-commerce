import type { Order } from '../../api'
import { addressLineOf, amendHeld } from '../../daily-model'
import { depthEditHeld, type DepthCan } from '../../depth/model'
import { romeToday, type OrderAbilities, type Phrase } from '../../model'
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
}

export function factsDoorsOf(order: Order, input: { readonly can: OrderAbilities; readonly readOnly: boolean; readonly busy: boolean; readonly depthCan?: Pick<DepthCan, 'manage'> | null }): FactsDoors | null {
  if (input.readOnly) return null
  const busy: Phrase | null = input.busy ? { key: 'held.busy' } : null
  const amend = amendHeld(order, input.can) ?? busy
  const depth = depthEditHeld(order.status, input.depthCan ?? input.can) ?? busy
  return { customerRef: amend, shipTo: amend, priority: depth, season: depth }
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
