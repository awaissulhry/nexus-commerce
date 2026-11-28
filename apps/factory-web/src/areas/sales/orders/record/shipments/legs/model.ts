import { ORDER_WARNING_KINDS, ORDER_WARNING_WORD_KEYS, type OrderWarningKind } from '@nexus/factory-domain/sales/warnings/kinds'
import { isApiError, issuePath } from '../../../../../../lib/api/errors'
import type { Leg } from './api'

/**
 * owb-ss3 (S3 web A; design plan § 7, § 5n; ship.js `arrive`, `sendOn`, `payWarn`, `mayShip`, `maySend`; settles L2, L3, L5) — "to our
 * warehouse first", pure: who may do what (TWO rights: **plan** a shipment = shipping.plan OR shipping.manage; **pack and send** =
 * shipping.manage — sales that only plans never sends on), which act a leg offers now (**It arrived at the warehouse** while it is on
 * its way, once; **Send on to the customer** once it is at our warehouse, once), the leg's chip, the form of Send on (carrier and
 * tracking, both optional; "No label from the customer yet" when the customer sent none: it goes on, and the history keeps it) and the
 * 409 WARNINGS of the base helper (a payment due before shipping is still open: a yellow line in words, no amount; "Send it anyway"
 * sends the same act again with `overrides`). The words are `ship-ways` (the views say them).
 */

/** The two rights of shipping (R38): plan a shipment · pack and send. */
export interface ShipRights {
  /** Plan: which orders go together, where it goes, the carrier, hold, cancel (shipping.plan OR shipping.manage). */
  readonly plan: boolean
  /** Pack and send: packed, it left, it arrived, Send on (shipping.manage). */
  readonly send: boolean
}

export function shipRightsOf(permissions: readonly string[]): ShipRights {
  const held = new Set(permissions)
  const send = held.has('shipping.manage')
  return { plan: send || held.has('shipping.plan'), send }
}

export type LegAct = 'ARRIVED' | 'SEND_ON'

/** The acts a leg offers this reader now: the server's `may` AND the reader's send right (a planner never sees them). */
export function legActsOf(leg: Pick<Leg, 'state' | 'may'>, rights: Pick<ShipRights, 'send'>): readonly LegAct[] {
  if (!rights.send) return []
  if (leg.state === 'ON_THE_WAY' && leg.may.arrived) return ['ARRIVED']
  if (leg.state === 'AT_OUR_WAREHOUSE' && leg.may.sendOn) return ['SEND_ON']
  return []
}

/** The legs an act fits (the window "It arrived at the warehouse" lists those on the way; "Send on" those at our warehouse). */
export function legsForAct(legs: readonly Leg[], act: LegAct, rights: Pick<ShipRights, 'send'>): Leg[] {
  return legs.filter((leg) => legActsOf(leg, rights).includes(act))
}

/** The leg of each shipment (one leg per shipment). */
export const legByShipment = (legs: readonly Leg[] | null | undefined): ReadonlyMap<string, Leg> => new Map((legs ?? []).map((leg) => [leg.shipmentId, leg]))

/** The shipments whose garments sit at our warehouse now (arrived, not sent on): the "At our warehouse" part of the bar. */
export const atWarehouseIds = (legs: readonly Leg[] | null | undefined): ReadonlySet<string> => new Set((legs ?? []).filter((leg) => leg.state === 'AT_OUR_WAREHOUSE').map((leg) => leg.shipmentId))

/**
 * A leg's chip: planned to our warehouse first (the shipment has not left: DRAFT, PACKED) · on its way to the warehouse · at our warehouse
 * (the order life's own chip) · sent on to the customer.
 */
export type LegChip =
  | { readonly kind: 'planned'; readonly place: string }
  | { readonly kind: 'onTheWay'; readonly place: string }
  | { readonly kind: 'atWarehouse'; readonly place: string; readonly label: boolean }
  | { readonly kind: 'sentOn'; readonly withoutLabel: boolean }

/** The shipment states before the goods leave (the leg is made with the DRAFT: settle L5). */
const NOT_LEFT = new Set(['DRAFT', 'PACKED'])

export function legChipOf(leg: Pick<Leg, 'state' | 'warehouse' | 'label' | 'forwardedWithoutLabel'>, shipmentStatus: string | null = null): LegChip {
  if (shipmentStatus !== null && NOT_LEFT.has(shipmentStatus)) return { kind: 'planned', place: leg.warehouse.name }
  if (leg.state === 'ON_THE_WAY') return { kind: 'onTheWay', place: leg.warehouse.name }
  if (leg.state === 'AT_OUR_WAREHOUSE') return { kind: 'atWarehouse', place: leg.warehouse.name, label: leg.label !== null }
  return { kind: 'sentOn', withoutLabel: leg.forwardedWithoutLabel }
}

// ---- Send on to the customer ---------------------------------------------------------------------------------------------------

/** The longest carrier name and tracking number the window takes. */
export const SEND_ON_MAX = 100

export interface SendOnForm {
  readonly carrier: string
  readonly trackingNumber: string
}

export const EMPTY_SEND_ON: SendOnForm = Object.freeze({ carrier: '', trackingNumber: '' })

export interface Said {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** Why Send on waits (null: it may go). Both fields are optional; only their length holds it. */
export function sendOnHeld(form: SendOnForm, busy: boolean): Said | null {
  if (busy) return { key: 'leg.held.busy' }
  if (form.carrier.trim().length > SEND_ON_MAX || form.trackingNumber.trim().length > SEND_ON_MAX) return { key: 'leg.held.long', params: { max: SEND_ON_MAX } }
  return null
}

const blank = (text: string): string | null => (text.trim() === '' ? null : text.trim())

/** The body of Send on: what was typed (blank: null), and the warnings the person goes on with. */
export function sendOnBody(leg: Pick<Leg, 'version'>, form: SendOnForm, overrides: readonly OrderWarningKind[] = []): { version: number; carrier: string | null; trackingNumber: string | null; overrides?: OrderWarningKind[] } {
  return { version: leg.version, carrier: blank(form.carrier), trackingNumber: blank(form.trackingNumber), ...(overrides.length > 0 ? { overrides: [...overrides] } : {}) }
}

/** The lines Send on says before the person presses it: the label (yellow when none) and the payment (yellow, after a 409). */
export function sendOnLines(leg: Pick<Leg, 'label'>, warnings: readonly OrderWarningKind[] | null): Said[] {
  const lines: Said[] = []
  if (leg.label === null) lines.push({ key: 'leg.noLabel' })
  for (const kind of warnings ?? []) lines.push({ key: ORDER_WARNING_WORD_KEYS[kind] })
  return lines
}

// ---- the 409 WARNINGS (apps/factory-api platform/audit/passed-warnings.ts) ----------------------------------------------------------

/**
 * The warnings a refused act names (a 409 `conflict` whose issues are `warning/<KIND>`), in the kinds' order; null: not a warning
 * answer (another refusal, said by its own words).
 */
export function warningsOf(error: unknown): OrderWarningKind[] | null {
  if (!isApiError(error) || error.kind !== 'conflict') return null
  const found = new Set(error.issues.map(issuePath).filter((path) => path.startsWith('warning/')).map((path) => path.slice('warning/'.length)))
  const kinds = ORDER_WARNING_KINDS.filter((kind) => found.has(kind))
  return kinds.length > 0 ? kinds : null
}

/** The act's words: the plain act, or "… anyway" once the person has read the warnings. */
export const sendOnActKey = (warnings: readonly OrderWarningKind[] | null): string => (warnings && warnings.length > 0 ? 'leg.sendOn.anyway' : 'leg.sendOn.act')
