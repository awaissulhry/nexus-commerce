import type { Order } from '../../api'
import { createShipmentHref, isFinal, mayCreateShipment, type OrderAbilities, type Phrase } from '../../model'
import type { WhereModel } from './where'
import { word, wordOf, type ShipWord } from './word'

/**
 * F-OS-101 (order SHIPMENTS tab, 10-design §2, §5, §8; plan D2; 18-lead-settles L9, L10) — the tab's doors, pure: a door is HIDDEN
 * when the reader lacks its right (D2 reverses the order page's F-OP-308 for this tab) and HELD WITH WORDS only when the order's or the
 * shipment's state blocks it. Create shipment… is drawn ONCE, on the Shipments head (the band skips its copy on this tab, L10), and it
 * opens only when something is ready now (L9: released and on no shipment; until the server counts it, today's rule) — held otherwise
 * with the true words: everything shipped · still to be made or released · every released garment already on a shipment · the
 * garments that came back are not received yet. W2 adds the rows' acts here (the ⋯ by state).
 */

export type CreateDoor =
  | { readonly kind: 'hidden' }
  /** Opens Warehouse's New shipment in place (the container mounts it), else on Warehouse's page with this order chosen. */
  | { readonly kind: 'open'; readonly inPlace: boolean; readonly href: string }
  | { readonly kind: 'held'; readonly words: ShipWord }

export function createDoorOf(order: Pick<Order, 'id' | 'status' | 'progress'>, can: Pick<OrderAbilities, 'createShipment'>, where: Pick<WhereModel, 'mode' | 'allOut' | 'totals' | 'stillToShip'>, prefix: string, inPlace: boolean): CreateDoor {
  if (!can.createShipment) return { kind: 'hidden' }
  if (mayCreateShipment(order, can)) return { kind: 'open', inPlace, href: createShipmentHref(prefix, order.id) }
  return { kind: 'held', words: createHeldWords(order, where) }
}

/** Why Create shipment… waits, in true words (P0-B1, H2-B2: never "quality releases the garments first" on a shipped order). */
export function createHeldWords(order: Pick<Order, 'status' | 'progress'>, where: Pick<WhereModel, 'mode' | 'allOut' | 'totals' | 'stillToShip'>): ShipWord {
  if (isFinal(order)) return wordOf('orders', 'held.final')
  if (where.allOut) return word('ships.create.held.shipped')
  if (where.mode === 'today') return order.progress.toShip === 0 && order.progress.shipped > 0 ? word('ships.create.held.shipped') : wordOf('orders', 'ship.create.held.nothing')
  if (where.totals.making > 0) return word('ships.create.held.making', { count: where.totals.making })
  if (where.totals.back > 0) return word('ships.create.held.back')
  if (where.totals.packed + where.totals.draft + where.totals.planned > 0) return word('ships.create.held.planned')
  return wordOf('orders', 'ship.create.held.nothing')
}

/**
 * "Record a shipment made elsewhere…" (F-OP-123): hidden without its rights (shipping.manage + shipping.ddt.issue: D2 — the door's own
 * rule says the order's state first, so a reader without shipping.manage is hidden here whatever the state), held with its words by the
 * order's state; null: hidden (not offered here, or no right).
 */
export function elsewhereDoorOf(elsewhere: { readonly held: Phrase | null } | null | undefined, can: Pick<OrderAbilities, 'createShipment'>): { readonly held: Phrase | null } | null {
  if (!elsewhere || !can.createShipment) return null
  if (elsewhere.held?.key === 'elsewhere.held.noRight') return null
  return { held: elsewhere.held }
}
