import { words, type Words } from '../queue/shared/depth'
import { REASON_LIMITS } from '../queue/move/model'
import type { Shipment } from '../api'
import type { CarrierReturn } from './doors-api'
// owb-ss3 step 3.3: the warehouse leg (to our warehouse first) and the payment warning at the hand-over.
import type { OrderWarningKind } from '@nexus/factory-domain/sales/warnings/kinds'
import { TRANSFER_REASON } from '../api'
import type { DdtForm } from '../model'
import type { Leg } from '../../../sales/orders/record/shipments/legs/api'
import { warningsOf } from '../../../sales/orders/record/shipments/legs/model'

/**
 * F-OS-203 (order SHIPMENTS tab, 10-design §7 D7; 18-lead-settles L3, L13; H3-B11) — the two new small windows of a shipment, pure:
 *
 * - This shipment travels without a DDT… (D6 / O7 B): a DRAFT or PACKED shipment made in Nexus, a reason (3–500); the tick "No DDT
 *   travels with these goods." (L3); reads no country. "Put back the DDT" undoes it before the goods leave. A live DDT refuses it
 *   (the API's word, L13).
 * - Receive the garments back…: a shipment the carrier brought back, not received yet; the finished-goods place (the site's one is
 *   chosen for the person); a note.
 *
 * The words are the lane's (`order-shipments`: door.*).
 */

/**
 * The refusal codes of the travels-without-a-DDT write (B-OS-017), said by code; anything else in the step's words. The domain's own
 * list (factory-domain shipping/ddt DDT_REQUIRED_REFUSALS — a module the browser does not load: a test pins the two equal).
 */
export const DDT_REQUIRED_REFUSAL_CODES = ['ELSEWHERE', 'LEFT', 'CANCELLED', 'DDT_LIVE', 'SAME'] as const

export interface DdtRequiredForm {
  readonly ticked: boolean
  readonly reason: string
}

/** Why the change is held (null: it may go): the shipment's state first, then the tick and the reason. */
export function ddtRequiredHeld(shipment: Pick<Shipment, 'status' | 'origin' | 'ddtRequired'>, form: DdtRequiredForm, busy: boolean): Words | null {
  if (shipment.origin === 'ELSEWHERE') return words('door.ddt.held.elsewhere')
  if (shipment.status !== 'DRAFT' && shipment.status !== 'PACKED') return words('door.ddt.held.left')
  if (busy) return words('door.held.busy')
  // Without a DDT: the tick says it in so many words; back to a DDT needs no tick.
  if (shipment.ddtRequired && !form.ticked) return words('door.ddt.held.tick')
  const reason = form.reason.trim()
  if (reason.length < REASON_LIMITS.min) return words('move.held.reasonShort', { min: REASON_LIMITS.min })
  if (reason.length > REASON_LIMITS.max) return words('move.held.wordsLong', { max: REASON_LIMITS.max })
  return null
}

/** The write's body: the opposite of what the shipment needs now. */
export const ddtRequiredBody = (shipment: Pick<Shipment, 'version' | 'ddtRequired'>, form: DdtRequiredForm): { version: number; required: boolean; reason: string } => ({ version: shipment.version, required: !shipment.ddtRequired, reason: form.reason.trim() })

export interface ReceiveForm {
  readonly locationId: string | null
  readonly note: string
}

/** Why "Receive the garments back" is held (null: it may go). */
export function receiveHeld(read: Pick<CarrierReturn, 'state' | 'garments' | 'places'>, form: ReceiveForm, busy: boolean): Words | null {
  if (read.state === 'RECEIVED') return words('door.receive.held.received')
  if (read.state !== 'AWAITED') return words('door.receive.held.notReturned')
  if (read.garments === 0) return words('door.receive.held.nothing')
  if (read.places.length === 0) return words('door.receive.held.noPlace')
  if (busy) return words('door.held.busy')
  if (!form.locationId) return words('door.receive.held.pickPlace')
  if (form.note.trim().length > REASON_LIMITS.max) return words('move.held.wordsLong', { max: REASON_LIMITS.max })
  return null
}

/** The place chosen for the person: the site's one finished-goods place, else the read's default, else none. */
export const defaultPlaceOf = (read: Pick<CarrierReturn, 'places' | 'defaultLocationId'>): string | null => (read.places.length === 1 ? read.places[0]!.id : read.defaultLocationId)

// ── owb-ss3 step 3.3 (design plan § 7, § 5n R39; settles L2, L5) ──────────────────────────────────────────────────────────────────

/**
 * The DDT reason of a shipment to our own warehouse first: before it arrived there and while no DDT is live, the first leg travels as a
 * TRANSFER (preset, read only: "Goods to our own warehouse travel as a transfer"); after it arrived, Send on travels with a SALE DDT to
 * the customer (the usual choice). Null: no leg — the person chooses as today.
 */
export function legDdtReasonOf(leg: Pick<Leg, 'arrivedAt'> | null, liveDdt: boolean): typeof TRANSFER_REASON | null {
  if (!leg || liveDdt || leg.arrivedAt !== null) return null
  return TRANSFER_REASON
}

/** The DDT form with the leg's reason applied (the form is the person's: only the reason changes, and only to the transfer). */
export function withLegReason(form: DdtForm, leg: Pick<Leg, 'arrivedAt'> | null, liveDdt: boolean): DdtForm {
  const reason = legDdtReasonOf(leg, liveDdt)
  if (reason) return form.reason === reason ? form : { ...form, reason }
  // The leg arrived (or none): a transfer left over from before goes back to the usual reason.
  return form.reason === TRANSFER_REASON ? { ...form, reason: 'SALE' } : form
}

/**
 * Mark handed over refused with the payment warning (the base helper's 409 WARNINGS: a payment due before shipping is still open on an
 * order of the shipment): the kinds, said in a yellow line with no amount; "Ship it anyway" sends the same hand-over with them as
 * `overrides`. Null: another refusal (said as today).
 */
export const handOverWarningsOf = (error: unknown): OrderWarningKind[] | null => warningsOf(error)

/** The hand-over's act: "Mark handed over", or "Ship it anyway" once the warnings are read. */
export const handOverGoKey = (warnings: readonly OrderWarningKind[] | null | undefined): { readonly ns: 'shipments' | 'ship-ways'; readonly key: string } =>
  warnings && warnings.length > 0 ? { ns: 'ship-ways', key: 'handOver.anyway' } : { ns: 'shipments', key: 'step.handOver' }
