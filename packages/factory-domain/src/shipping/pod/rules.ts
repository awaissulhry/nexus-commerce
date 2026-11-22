import type { Issue } from '../../core/errors'

/**
 * The carrier's proof of delivery on the shipment (B-W2b-398; LOG-065 "Proof of delivery on the shipment"; design
 * warehouse.shipments Tracking & delivery › "Proof of delivery": signer, time, image, Download for a dispute), pure.
 * factory-db keeps it on the Shipment (podSignedBy, podAt, podFileId: only on a DELIVERED shipment, each set once; the
 * signer 1-200 characters on one line; the time not in the future and not before the goods left; the image a file of the
 * shipment), the …_delivery_customs_w2b_guards trigger holds it for every login.
 *
 *   from the carrier   when tracking moves a shipment DELIVERED, the worker asks the carrier (through the gateway; the
 *                      FAKE locally) for the parcel's proof: who signed, when, the signature or photo; a TEST label
 *                      (B-W2b-390) is never asked: no carrier ever had it
 *   by hand            a person records it from the carrier's paper or mail (shipping.manage): our own van, a carrier booked
 *                      by hand, a carrier that gave none; what is set stays (the image may follow later, once)
 *
 * The signer is the customer's person inside one record (like a collection's collectedByName): shown on the shipment and
 * the order, never in a list, a filter or a total.
 */

export const POD_LIMITS = Object.freeze({ signer: 200 })

/**
 * How the shipment came to be delivered: the carrier's tracking, or a status typed by a person (our van, a manual carrier).
 * B-OS-003 (order shipments tab, H3-B1): COLLECTED — the customer's own carrier collected it (transportBy RECIPIENT: its collection
 * is its delivery). The order's deliveries read says it; Warehouse's proof read keeps CARRIER / TYPED.
 */
export const DELIVERED_VIAS = ['CARRIER', 'TYPED', /* B-OS-003 */ 'COLLECTED'] as const
export type DeliveredVia = (typeof DELIVERED_VIAS)[number]

// ── B-OS-003 (order shipments tab; H3-B1, O6; 13-backend §1) ──
/** One tracking event that ends a journey (DELIVERED or RETURNED), as the delivery rule reads it. */
export interface EndEvent {
  readonly id: string
  readonly status: string
  readonly source: 'WEBHOOK' | 'POLL' | 'MANUAL'
  readonly description: string | null
  readonly recordedAt: Date
}

export interface DeliveryFacts {
  /** The shipment's status now. */
  readonly status: string
  readonly transportBy: string
  /** A parcel carries a label bought from a carrier (a TEST label is not one): its carrier's tracking follows it. */
  readonly carrierLabelled: boolean
  /** Its DELIVERED and RETURNED events, in any order. */
  readonly events: readonly EndEvent[]
}

export interface DeliveryWay {
  /** A DELIVERED shipment: how it came (null otherwise, or with no event to say it). */
  readonly deliveredVia: DeliveredVia | null
  /** Moved to DELIVERED or RETURNED by a person: the words typed with it, and whether that overrode a carrier's labels. */
  readonly byHand: { readonly reason: string | null; readonly overrode: boolean } | null
  /** Moved by hand, then the carrier said otherwise or the same later: what it said last ("the carrier later said…"). */
  readonly carrierLater: 'DELIVERED' | 'RETURNED' | null
}

const ENDS = ['DELIVERED', 'RETURNED'] as const
const recorded = (a: EndEvent, b: EndEvent): number => a.recordedAt.getTime() - b.recordedAt.getTime() || a.id.localeCompare(b.id)

/**
 * How a shipment's journey ended, pure. The event that moved it is the FIRST recorded one of its final status (a shipment moves only
 * from SHIPPED, once; a later event only appends). DELIVERED: COLLECTED when the customer collects (its collection is its delivery,
 * never "by hand"), TYPED when a person typed it, else CARRIER. A move typed by a person is `byHand` (its words; `overrode` when the
 * parcels carry a carrier's labels, B-OS-015); a carrier event recorded after it is `carrierLater`.
 */
export function deliveryWayOf(facts: DeliveryFacts): DeliveryWay {
  const none: DeliveryWay = { deliveredVia: null, byHand: null, carrierLater: null }
  if (!(ENDS as readonly string[]).includes(facts.status)) return none
  const ends = facts.events.filter((event) => (ENDS as readonly string[]).includes(event.status)).sort(recorded)
  const mover = ends.find((event) => event.status === facts.status)
  if (!mover) return none
  const collected = facts.transportBy === 'RECIPIENT'
  const typed = mover.source === 'MANUAL'
  const deliveredVia: DeliveredVia | null = facts.status !== 'DELIVERED' ? null : collected ? 'COLLECTED' : typed ? 'TYPED' : 'CARRIER'
  if (!typed || collected) return { deliveredVia, byHand: null, carrierLater: null }
  const words = mover.description?.trim() ?? ''
  const later = ends.filter((event) => event.source !== 'MANUAL' && recorded(event, mover) > 0).at(-1)
  return { deliveredVia, byHand: { reason: words === '' ? null : words, overrode: facts.carrierLabelled }, carrierLater: later ? (later.status as 'DELIVERED' | 'RETURNED') : null }
}
// ── end B-OS-003 ──

export interface PodInput {
  readonly signedBy: string | null
  readonly signedAt: Date | null
  readonly fileId: string | null
}

export interface PodFacts {
  readonly status: string
  readonly shippedAt: Date | null
  readonly kept: { readonly signedBy: string | null; readonly signedAt: Date | null; readonly fileId: string | null }
}

/** The signer as kept: trimmed, one line; null when empty. */
export function signerOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * What stops recording the proof (400 at the field, 409 `refusal/<CODE>` for the state): a DELIVERED shipment only; each
 * part set once (a part already kept may be sent again unchanged); the signer one line of at most 200 characters; the
 * time not in the future and not before the goods left.
 */
export function podProblems(input: PodInput, facts: PodFacts, now: Date): Issue[] {
  const problems: Issue[] = []
  if (facts.status !== 'DELIVERED') return [{ path: 'refusal/NOT_DELIVERED', message: `The shipment is ${facts.status}: the proof of delivery is recorded once it is delivered.` }]
  const signer = signerOf(input.signedBy)
  if (input.signedBy !== null && signer === null) problems.push({ path: 'body/signedBy', message: 'Type who signed for the goods.' })
  if (signer !== null && (signer.length > POD_LIMITS.signer || /[\r\n]/.test(signer))) problems.push({ path: 'body/signedBy', message: `Who signed: one line of at most ${POD_LIMITS.signer} characters.` })
  if (input.signedAt !== null) {
    if (input.signedAt.getTime() > now.getTime()) problems.push({ path: 'body/signedAt', message: 'The time of the delivery cannot be in the future.' })
    else if (facts.shippedAt && input.signedAt.getTime() < facts.shippedAt.getTime()) problems.push({ path: 'body/signedAt', message: 'The time of the delivery cannot be before the goods left.' })
  }
  if (signer === null && input.signedAt === null && input.fileId === null) problems.push({ path: 'body', message: 'Give who signed, when, or the image of the proof.' })
  const changes = (kept: unknown, given: unknown) => kept !== null && given !== null && kept !== given
  if (changes(facts.kept.signedBy, signer) || (facts.kept.signedAt && input.signedAt && facts.kept.signedAt.getTime() !== input.signedAt.getTime()) || changes(facts.kept.fileId, input.fileId)) {
    problems.push({ path: 'refusal/KEPT', message: 'The proof of delivery is kept as it was first recorded: a part set once never changes.' })
  }
  return problems
}
