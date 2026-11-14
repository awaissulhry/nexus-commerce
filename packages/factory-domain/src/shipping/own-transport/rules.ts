import type { Issue } from '../../core/errors'
import type { ShipmentStatus, TransportBy } from '../shipments'
import { CARRIER_CODE } from '../settings'
import { isTestLabel } from '../test-mode/rules'

/**
 * A manual carrier or our own van (B-W2b-390; LOG-122 "own van or manual carrier"; factory-db Shipment.transportBy,
 * manualTrackingNumber, B-W2b-367 decision 1; TrackingEvent source MANUAL), pure. The goods still get their DDT (W1: the
 * DDT says who carries them, "trasporto a cura del" mittente or vettore) and their status:
 *
 *   arrangement  OWN_VAN = transportBy SENDER (no carrier, no service, no Sendcloud connection); MANUAL_CARRIER =
 *                transportBy CARRIER booked outside Sendcloud: the carrier's name as the DDT prints it (typed, or from its
 *                code), its tracking number typed (now or later), no service, no Sendcloud connection. Changed while the
 *                goods are planned or packed and nothing declares them (no carrier label, no live DDT)
 *   tracking     the manual carrier's tracking number, typed or corrected until the shipment is cancelled (also after the
 *                goods left: the database lets it change); never on a shipment with a carrier label (a Sendcloud label and a
 *                typed number never both)
 *   status       what the driver or the carrier says, typed by the office once the goods left (TrackingEvent source
 *                MANUAL, the whole shipment): IN_TRANSIT, OUT_FOR_DELIVERY, EXCEPTION as news; DELIVERED and RETURNED move
 *                the SHIPPED shipment (at the time typed: not in the future, not before it left). A shipment whose parcels
 *                carry carrier labels moves by its carrier's tracking (W1), never by hand; a TEST label (test mode) is not
 *                tracked, so it moves by hand too
 *
 * Refusals are 409 with the issue path `refusal/<CODE>`; the screens word the code (`OWN_TRANSPORT_WORDS`).
 */

export const OWN_TRANSPORT_MODES = ['OWN_VAN', 'MANUAL_CARRIER'] as const
export type OwnTransportMode = (typeof OWN_TRANSPORT_MODES)[number]

/**
 * How a shipment travels, as the record reads it: CARRIER = a carrier, its labels bought through Sendcloud (or booked by
 * hand with no tracking number typed yet); MANUAL_CARRIER = booked by hand, its tracking number typed; OWN_VAN; the
 * customer's own carrier collects (B-W2b-395).
 */
export const TRANSPORT_ARRANGEMENTS = ['CARRIER', 'MANUAL_CARRIER', 'OWN_VAN', 'CUSTOMER_COLLECTS'] as const
export type TransportArrangement = (typeof TRANSPORT_ARRANGEMENTS)[number]

/** The statuses the office types for a shipment no carrier tracks. */
export const MANUAL_EVENT_STATUSES = ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'EXCEPTION', 'DELIVERED', 'RETURNED'] as const
export type ManualEventStatus = (typeof MANUAL_EVENT_STATUSES)[number]

export const OWN_TRANSPORT_LIMITS = Object.freeze({ carrierName: 100, trackingNumber: 100, description: 500, location: 200, futureSkewMs: 5 * 60_000 })

/** Why an own-transport write is refused (409 `refusal/<CODE>`). */
export const OWN_TRANSPORT_REFUSALS = ['LEFT', 'LABELLED', 'DECLARED', 'NOT_A_CARRIER', 'CANCELLED', 'NOT_LEFT', 'CARRIER_TRACKED', 'CUSTOMER_COLLECTS', 'ARRIVED'] as const
export type OwnTransportRefusalCode = (typeof OWN_TRANSPORT_REFUSALS)[number]

export const ownTransportRefusalPath = (code: OwnTransportRefusalCode): string => `refusal/${code}`

/** The words of each refusal (English; the screens word the code themselves). */
export const OWN_TRANSPORT_WORDS: Readonly<Record<OwnTransportRefusalCode, string>> = Object.freeze({
  LEFT: 'The goods left: how they travel no longer changes.',
  LABELLED: 'A parcel carries a carrier label: void the labels first (a Sendcloud label and a typed tracking number never both).',
  DECLARED: 'The live DDT says how the goods travel: cancel the DDT first, then issue a new one.',
  NOT_A_CARRIER: 'A tracking number is typed only for a carrier booked by hand: our own van and the customer collecting have none.',
  CANCELLED: 'The shipment is cancelled.',
  NOT_LEFT: 'The goods have not left yet: their delivery is typed once they are shipped.',
  CARRIER_TRACKED: "The parcels carry carrier labels: the carrier's tracking moves this shipment, not a typed status.",
  CUSTOMER_COLLECTS: "The customer's own carrier collects these goods: the collection is recorded with the customer's pickup, not as a delivery.",
  ARRIVED: 'The shipment is delivered or came back already: its status no longer changes.',
})

/** A parcel as these rules read it: its label's provider id and tracking number. */
export interface OwnTransportParcel {
  readonly trackingNumber: string | null
  readonly providerId: string | null
}

/** What the rules read of a shipment. */
export interface OwnTransportFacts {
  readonly status: ShipmentStatus
  readonly transportBy: TransportBy
  readonly manualTrackingNumber: string | null
  readonly parcels: readonly OwnTransportParcel[]
  /** DDTs of the shipment that no cancellation names. */
  readonly liveDdts: number
}

const labelled = (parcel: OwnTransportParcel): boolean => parcel.trackingNumber !== null || parcel.providerId !== null
/** A label bought from a carrier (a TEST label is not one). */
const carrierLabelled = (parcel: OwnTransportParcel): boolean => labelled(parcel) && !isTestLabel(parcel.providerId)

/** How the shipment travels now. */
export function arrangementOf(facts: Pick<OwnTransportFacts, 'transportBy' | 'manualTrackingNumber'>): TransportArrangement {
  if (facts.transportBy === 'SENDER') return 'OWN_VAN'
  if (facts.transportBy === 'RECIPIENT') return 'CUSTOMER_COLLECTS'
  return facts.manualTrackingNumber !== null ? 'MANUAL_CARRIER' : 'CARRIER'
}

type Refusal = { readonly code: OwnTransportRefusalCode; readonly message: string } | null
const refusal = (code: OwnTransportRefusalCode): Refusal => ({ code, message: OWN_TRANSPORT_WORDS[code] })

/** Why the arrangement cannot change now (null: it can). */
export function arrangeRefusal(facts: OwnTransportFacts): Refusal {
  if (facts.status === 'CANCELLED') return refusal('CANCELLED')
  if (facts.status !== 'DRAFT' && facts.status !== 'PACKED') return refusal('LEFT')
  if (facts.parcels.some(labelled)) return refusal('LABELLED')
  if (facts.liveDdts > 0) return refusal('DECLARED')
  return null
}

/** Why the manual carrier's tracking number cannot be typed now (null: it can). */
export function trackingRefusal(facts: OwnTransportFacts): Refusal {
  if (facts.status === 'CANCELLED') return refusal('CANCELLED')
  if (facts.transportBy !== 'CARRIER') return refusal('NOT_A_CARRIER')
  if (facts.parcels.some(labelled)) return refusal('LABELLED')
  return null
}

/** Why a status cannot be typed now (null: it can). */
export function eventRefusal(facts: OwnTransportFacts): Refusal {
  if (facts.status === 'CANCELLED') return refusal('CANCELLED')
  if (facts.status === 'DELIVERED' || facts.status === 'RETURNED') return refusal('ARRIVED')
  if (facts.status !== 'SHIPPED') return refusal('NOT_LEFT')
  if (facts.transportBy === 'RECIPIENT') return refusal('CUSTOMER_COLLECTS')
  if (facts.parcels.some(carrierLabelled)) return refusal('CARRIER_TRACKED')
  return null
}

/** The arrangement as sent. */
export interface ArrangementInput {
  readonly mode: OwnTransportMode
  readonly carrierName?: string | null | undefined
  readonly carrierCode?: string | null | undefined
  readonly trackingNumber?: string | null | undefined
}

const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}
const oneLine = (value: string): boolean => !/[\r\n\t\u0000-\u001f\u007f]/.test(value)

/** A typed tracking number: 1 to 100 characters on one line (the database's rule). */
export function trackingNumberProblems(value: string | null | undefined, at = 'body/trackingNumber'): Issue[] {
  const number = clean(value)
  if (number === null) return []
  if (number.length > OWN_TRANSPORT_LIMITS.trackingNumber || !oneLine(number)) return [{ path: at, message: `A tracking number is 1 to ${OWN_TRANSPORT_LIMITS.trackingNumber} characters on one line.` }]
  return []
}

/** The field problems of an arrangement (400). */
export function arrangementProblems(input: ArrangementInput): Issue[] {
  const problems: Issue[] = []
  const name = clean(input.carrierName)
  const code = clean(input.carrierCode)
  if (input.mode === 'OWN_VAN') {
    for (const key of ['carrierName', 'carrierCode', 'trackingNumber'] as const) {
      if (clean(input[key]) !== null) problems.push({ path: `body/${key}`, message: 'Our own van has no carrier and no tracking number.' })
    }
    return problems
  }
  if (name === null && code === null) problems.push({ path: 'body/carrierName', message: 'Name the carrier (DPR 472/1996: the DDT prints who carries the goods).' })
  if (name !== null && (name.length > OWN_TRANSPORT_LIMITS.carrierName || !oneLine(name))) problems.push({ path: 'body/carrierName', message: `The carrier's name is 1 to ${OWN_TRANSPORT_LIMITS.carrierName} characters on one line.` })
  if (code !== null && !CARRIER_CODE.test(code)) problems.push({ path: 'body/carrierCode', message: "Expected a carrier code: lower-case letters, digits, '_', '.', '-'." })
  problems.push(...trackingNumberProblems(input.trackingNumber))
  return problems
}

/** What the arrangement writes on the shipment. `carrierNameOf` names a carrier from its code (labels.ts carrierNameFor). */
export function arrangementData(input: ArrangementInput, carrierNameOf: (code: string) => string | null) {
  if (input.mode === 'OWN_VAN') {
    return { transportBy: 'SENDER' as const, carrierCode: null, carrierName: null, serviceCode: null, integrationAccountId: null, manualTrackingNumber: null }
  }
  const code = clean(input.carrierCode)
  return {
    transportBy: 'CARRIER' as const,
    carrierCode: code,
    carrierName: clean(input.carrierName) ?? (code ? carrierNameOf(code) : null),
    serviceCode: null,
    integrationAccountId: null,
    manualTrackingNumber: clean(input.trackingNumber),
  }
}

/** The typed time of a status: not in the future (a few minutes' clock skew), not before the goods left. */
export function eventTimeProblems(occurredAt: Date, shippedAt: Date | null, now: Date, at = 'body/occurredAt'): Issue[] {
  if (occurredAt.getTime() > now.getTime() + OWN_TRANSPORT_LIMITS.futureSkewMs) return [{ path: at, message: 'The time is in the future.' }]
  if (shippedAt !== null && occurredAt.getTime() < shippedAt.getTime()) return [{ path: at, message: 'The time is before the goods left.' }]
  return []
}

/** The move a typed status makes: DELIVERED and RETURNED end the journey; the others are news. */
export const moveOfStatus = (status: ManualEventStatus): 'DELIVERED' | 'RETURNED' | null => (status === 'DELIVERED' || status === 'RETURNED' ? status : null)
