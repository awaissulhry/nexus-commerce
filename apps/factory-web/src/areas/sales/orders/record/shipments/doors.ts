import type { Order } from '../../api'
import { createShipmentHref, isFinal, mayCreateShipment, type OrderAbilities, type Phrase } from '../../model'
import type { DeliveryRow } from './delivered/api'
import type { ShipmentRow, WhereModel } from './where'
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

// ── F-OS-202 (order SHIPMENTS tab, 10-design §5 "Row ⋯"; plan D2, D3, D5, D6) ─────────────────────────────────────────────────────────
/**
 * A shipment row's ⋯, by its state: every item opens Warehouse's OWN window in place (one path); HIDDEN without the row's right
 * (`may.*`, B-OS-001: absent — nothing is offered), held with words ONLY by the shipment's state. Pack, the DDT, labels, pickup and
 * the hand-over stay in Warehouse ("Next ›"). Nobody sets a status by hand: Mark delivered / Mark returned type an event (a reason
 * over a carrier's labels, D5). Delivered, returned and cancelled stay final: no held item on a final row but its own last steps.
 */
export type RowActId = 'split' | 'move' | 'merge' | 'takeOff' | 'unpack' | 'arrange' | 'placeHold' | 'releaseHold' | 'ddtOff' | 'ddtBack' | 'cancel' | 'eta' | 'delivered' | 'returned' | 'resolve' | 'proof' | 'receiveBack' | /* F-OS-303 */ AfterSalesKind
export type RowActGroup = 'garments' | 'travel' | 'hold' | 'arrive' | /* F-OS-303 */ 'after' | 'danger'

export interface RowAct {
  readonly id: RowActId
  readonly group: RowActGroup
  readonly label: ShipWord
  /** Held by the shipment's state, in words (null: it opens). */
  readonly held: ShipWord | null
  /** Release: the hold it releases (B-OS-001 `holds[].id`). */
  readonly holdId?: string
}

const OPEN = new Set(['DRAFT', 'PACKED'])
/** Warehouse's own words where the same act has them (never a second word for one thing). */
const SPLIT = wordOf('depth', 'split.menu')
const act = (id: RowActId, group: RowActGroup, label: ShipWord, held: ShipWord | null = null, more: { readonly holdId?: string } = {}): RowAct => ({ id, group, label, held, ...more })
const labelled = (row: ShipmentRow): boolean => (row.parcels ?? []).some((parcel) => parcel.source === 'LABEL')

export function rowActsOf(row: ShipmentRow, orderId: string, delivery: Pick<DeliveryRow, 'openProblems' | 'pod' | 'returned'> | null, can: Pick<OrderAbilities, 'returnsManage' | 'complaintsLog'> = {}): RowAct[] {
  const may = row.may
  // F-OS-303: a shipped row's after-sales doors are the order's rights (Returns', Quality's), whatever the row's own `may` says.
  if (!may) return afterSalesRowActs(row, can)
  const acts: RowAct[] = []
  const live = !!row.ddt
  const nexus = row.origin !== 'ELSEWHERE'
  if (row.status === 'DRAFT' && may.manage) {
    acts.push(act('split', 'garments', SPLIT), act('move', 'garments', word('ships.act.move')), act('merge', 'garments', word('ships.act.merge')))
    // Take this order off: a shared draft, never the order it was made for (salesOrderId never changes: Split… or Move… then cancel).
    const orders = row.orders ?? []
    if (orders.length > 1 && orders[0]?.id !== orderId && orders.some((order) => order.id === orderId)) acts.push(act('takeOff', 'garments', word('ships.act.takeOff')))
  }
  if (row.status === 'PACKED') {
    if (may.manage) acts.push(act('split', 'garments', SPLIT, word('ships.act.held.splitPacked')), act('move', 'garments', word('ships.act.move'), word('ships.act.held.movePacked')), act('merge', 'garments', word('ships.act.merge'), word('ships.act.held.movePacked')))
    if (may.pack) acts.push(act('unpack', 'garments', word('ships.act.unpack'), live ? word('ships.act.held.ddtLive') : labelled(row) ? word('ships.act.held.labelled') : null))
  }
  if (OPEN.has(row.status)) {
    if (may.manage && nexus && row.transportBy !== 'RECIPIENT') acts.push(act('arrange', 'travel', wordOf('depth', 'transport.change'), live ? word('ships.act.held.ddtCarrier') : labelled(row) ? word('ships.act.held.labelled') : null))
    if (may.ddt && may.manage && nexus) {
      if (row.ddtRequired === false) acts.push(act('ddtBack', 'travel', word('ships.act.ddtBack')))
      else if (row.ddtRequired === true) acts.push(act('ddtOff', 'travel', word('ships.act.ddtOff'), live ? word('ships.act.held.ddtLive') : null))
    }
    if (may.holdsManage ?? may.manage) acts.push(act('placeHold', 'hold', wordOf('depth', 'holds.placeMenu')))
    for (const hold of row.holds ?? []) {
      // A money hold or one the system placed is finance's (holds.release); a person's is the warehouse's.
      const finance = hold.bySystem || hold.reason === 'CREDIT' || hold.reason === 'DEPOSIT' || hold.reason === 'BALANCE_UNPAID'
      if (hold.id && (finance ? may.holdsRelease : (may.holdsManage ?? may.manage))) acts.push(act('releaseHold', 'hold', word('ships.act.releaseHold', undefined, { words: { reason: wordOf('depth', `holdReason.${hold.reason}`) } }), null, { holdId: hold.id }))
    }
    if (may.manage) acts.push(act('cancel', 'danger', word('ships.act.cancel'), labelled(row) ? word('ships.act.held.labelled') : live ? word('ships.act.held.ddtLive') : null))
  }
  if (row.status === 'SHIPPED' && may.manage) {
    acts.push(act('delivered', 'arrive', word('ships.act.delivered')), act('returned', 'arrive', word('ships.act.returned')))
    acts.push(act('eta', 'arrive', word('ships.act.eta'), labelled(row) ? word('ships.act.held.carrierFed') : null))
    if (delivery && delivery.openProblems > 0) acts.push(act('resolve', 'arrive', word('ships.act.resolve')))
  }
  if (row.status === 'DELIVERED' && may.manage) {
    const pod = delivery?.pod ?? null
    const kept = !!pod && !!pod.signedBy && !!pod.signedAt && pod.image
    acts.push(act('proof', 'arrive', wordOf('depth', 'pod.record'), kept ? word('ships.act.held.proofKept') : null))
  }
  if (row.status === 'RETURNED' && may.manage) acts.push(act('receiveBack', 'arrive', word('ships.act.receiveBack'), delivery?.returned?.received === true ? word('ships.act.held.received') : null))
  return [...acts, ...afterSalesRowActs(row, can)]
}
// ── end F-OS-202 ──

// ── F-OS-303 (order SHIPMENTS tab, 10-design §5 "SHIPPED, DELIVERED" and §6 head; 18-lead-settles L8) ────────────────────────────────
/**
 * The after-sales doors, each the owning page's OWN window in place: Open a return… (Sales › Returns' New return; from a row, that
 * shipment's lines — L8), Log a complaint… (Quality's Log complaint; from a row, about that shipment), Send a claim link… (a link for
 * the customer). Hidden without the right (D2); held with words only when nothing has left yet (the head; a row has left).
 */
export type AfterSalesKind = 'return' | 'complaint' | 'claim'

const LEFT_STATES = new Set(['SHIPPED', 'DELIVERED'])

/** A shipped (or delivered) row's after-sales doors, by the reader's rights. */
export function afterSalesRowActs(row: Pick<ShipmentRow, 'status'>, can: Pick<OrderAbilities, 'returnsManage' | 'complaintsLog'>): RowAct[] {
  if (!LEFT_STATES.has(row.status)) return []
  return [
    ...(can.returnsManage ? [act('return', 'after', word('ships.act.return'))] : []),
    ...(can.complaintsLog ? [act('complaint', 'after', word('ships.act.complaint'))] : []),
    ...(can.returnsManage ? [act('claim', 'after', word('ships.act.claim'))] : []),
  ]
}

export interface AfterSalesDoor {
  readonly kind: AfterSalesKind
  readonly label: ShipWord
  readonly held: ShipWord | null
}

/** The section head's doors: Open a return… and Log a complaint… as buttons, Send a claim link… in its ⋯ (the order's link). */
export function afterSalesDoorsOf(order: Pick<Order, 'chain'>, can: Pick<OrderAbilities, 'returnsManage' | 'complaintsLog'>): { readonly buttons: readonly AfterSalesDoor[]; readonly claim: AfterSalesDoor | null } {
  // Something has left: a shipment shipped, delivered or brought back by the carrier.
  const left = order.chain.shipments.some((row) => LEFT_STATES.has(row.status) || row.status === 'RETURNED')
  return {
    buttons: [
      ...(can.returnsManage ? [{ kind: 'return' as const, label: word('after.act.return'), held: left ? null : word('after.held.return') }] : []),
      ...(can.complaintsLog ? [{ kind: 'complaint' as const, label: word('after.act.complaint'), held: null }] : []),
    ],
    claim: can.returnsManage ? { kind: 'claim', label: word('after.act.claim'), held: left ? null : word('after.held.claim') } : null,
  }
}
// ── end F-OS-303 ──
