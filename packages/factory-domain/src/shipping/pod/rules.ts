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

/** How the shipment came to be delivered: the carrier's tracking, or a status typed by a person (our van, a manual carrier). */
export const DELIVERED_VIAS = ['CARRIER', 'TYPED'] as const
export type DeliveredVia = (typeof DELIVERED_VIAS)[number]

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
