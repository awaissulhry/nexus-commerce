import { words, type Words } from '../queue/shared/depth'
import { REASON_LIMITS } from '../queue/move/model'
import type { Shipment } from '../api'
import type { CarrierReturn } from './doors-api'

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
