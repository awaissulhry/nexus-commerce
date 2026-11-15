import type { Issue } from '../../core/errors'
import type { ShipmentStatus, TransportBy } from '../shipments'

/**
 * The customer's own carrier collects (B-W2b-395; LOG-053 "customer collection (ex works)"; Incoterms 2020 EXW and FCA at our
 * premises; factory-db Shipment.collectedByName, vehiclePlate, collectionSignatureFileId, B-W2b-367), pure. A shipment the
 * customer collects travels "a cura del destinatario" (transportBy RECIPIENT: W1's DDT says so):
 *
 *   record   while it waits PACKED at the dock: who collected (the customer's carrier's driver, one line, 1 to 200
 *            characters), the vehicle's plate (capitals, digits, spaces or hyphens, 1 to 20; typed in any case, kept in
 *            capitals) and the DDT signed by the driver (a file of the shipment: the scan or photo of the signed copy, or the
 *            signature drawn on the tablet). Each may be corrected until the goods leave; then fixed (the database's guard).
 *   leave    the goods leave (W1's "Mark handed over", or the DDT issued with it) only with all three: the collection IS
 *            the delivery under EXW / FCA at our premises (the risk passes when the customer's carrier takes the goods), so
 *            the shipment is DELIVERED at that moment, in the same command (a MANUAL tracking event of the whole shipment;
 *            the order follows, as for a delivery typed by hand).
 *   terms    the order's Incoterms rule is read beside it: EXW and FCA fit a collection; another rule (DAP, DDP …) or none
 *            is only a warning in words (the office may agree a collection with the customer anyway).
 *
 * Refusals are 409 with the issue path `refusal/<CODE>`; the screens word the code (`COLLECTION_WORDS`). The driver's name is
 * the customer's carrier's person, read inside this one shipment only (never in a list).
 */

export const COLLECTION_LIMITS = Object.freeze({ name: 200, plate: 20 })

/** A plate as kept (factory-db's guard): capitals and digits first, then capitals, digits, spaces or hyphens. */
export const PLATE = /^[A-Z0-9][A-Z0-9 -]{0,19}$/

/** The Incoterms rules a collection at our premises fits. */
export const COLLECTION_INCOTERMS = ['EXW', 'FCA'] as const

/** What a collection still lacks before the goods may leave. */
export const COLLECTION_PARTS = ['NAME', 'PLATE', 'SIGNATURE'] as const
export type CollectionPart = (typeof COLLECTION_PARTS)[number]

/** Why a collection write (or the goods leaving) is refused (409 `refusal/<CODE>`). */
export const COLLECTION_REFUSALS = ['NOT_COLLECTED', 'NOT_PACKED', 'LEFT', 'CANCELLED', 'INCOMPLETE'] as const
export type CollectionRefusalCode = (typeof COLLECTION_REFUSALS)[number]

export const collectionRefusalPath = (code: CollectionRefusalCode): string => `refusal/${code}`

/** The words of each refusal (English; the screens word the code themselves). */
export const COLLECTION_WORDS: Readonly<Record<CollectionRefusalCode, string>> = Object.freeze({
  NOT_COLLECTED: "The customer's own carrier does not collect these goods (they travel with a carrier or our van): set the transport to the customer collecting first.",
  NOT_PACKED: 'Who collected is recorded once the goods are packed and wait at the dock.',
  LEFT: 'The goods left: who collected, the plate and the signed DDT no longer change.',
  CANCELLED: 'The shipment is cancelled.',
  INCOMPLETE: "The customer's carrier collects these goods: record who collected, the vehicle's plate and the DDT signed by the driver before they leave.",
})

/** The words of the parts a collection lacks. */
export const COLLECTION_PART_WORDS: Readonly<Record<CollectionPart, string>> = Object.freeze({
  NAME: 'who collected',
  PLATE: "the vehicle's plate",
  SIGNATURE: 'the DDT signed by the driver',
})

/** A plate as kept: trimmed, in capitals, spaces run together. */
export const plateOf = (typed: string): string => typed.trim().toUpperCase().replace(/\s+/g, ' ')

/** The driver's name as kept: trimmed, spaces run together. */
export const collectorOf = (typed: string): string => typed.trim().replace(/[ \t]+/g, ' ')

/** The field problems of what is typed (400); null and undefined are not checked (kept or cleared). */
export function collectionProblems(input: { readonly collectedByName?: string | null | undefined; readonly vehiclePlate?: string | null | undefined }): Issue[] {
  const problems: Issue[] = []
  if (typeof input.collectedByName === 'string') {
    const name = collectorOf(input.collectedByName)
    if (name === '') problems.push({ path: 'body/collectedByName', message: 'Name who collected (or leave it out).' })
    else if (name.length > COLLECTION_LIMITS.name || /[\r\n]/.test(name)) problems.push({ path: 'body/collectedByName', message: `At most ${COLLECTION_LIMITS.name} characters on one line.` })
  }
  if (typeof input.vehiclePlate === 'string' && !PLATE.test(plateOf(input.vehiclePlate))) {
    problems.push({ path: 'body/vehiclePlate', message: `Expected a plate: letters, digits, spaces or hyphens, at most ${COLLECTION_LIMITS.plate}.` })
  }
  return problems
}

/** What the record reads of the shipment. */
export interface CollectionFacts {
  readonly status: ShipmentStatus
  readonly transportBy: TransportBy
  readonly collectedByName: string | null
  readonly vehiclePlate: string | null
  readonly signatureFileId: string | null
}

/** The parts still missing (in their order). */
export function missingParts(facts: Pick<CollectionFacts, 'collectedByName' | 'vehiclePlate' | 'signatureFileId'>): CollectionPart[] {
  return COLLECTION_PARTS.filter((part) => (part === 'NAME' ? facts.collectedByName === null : part === 'PLATE' ? facts.vehiclePlate === null : facts.signatureFileId === null))
}

/** Why the collection cannot be recorded now (null: it can). */
export function recordRefusal(facts: Pick<CollectionFacts, 'status' | 'transportBy'>): { code: CollectionRefusalCode; message: string } | null {
  if (facts.status === 'CANCELLED') return { code: 'CANCELLED', message: COLLECTION_WORDS.CANCELLED }
  if (facts.status === 'SHIPPED' || facts.status === 'DELIVERED' || facts.status === 'RETURNED') return { code: 'LEFT', message: COLLECTION_WORDS.LEFT }
  if (facts.transportBy !== 'RECIPIENT') return { code: 'NOT_COLLECTED', message: COLLECTION_WORDS.NOT_COLLECTED }
  if (facts.status !== 'PACKED') return { code: 'NOT_PACKED', message: COLLECTION_WORDS.NOT_PACKED }
  return null
}

/** Why the goods cannot leave yet (null: they can, as far as the collection goes); only for the customer collecting. */
export function leaveRefusal(facts: CollectionFacts): { code: CollectionRefusalCode; message: string } | null {
  if (facts.transportBy !== 'RECIPIENT') return null
  const missing = missingParts(facts)
  if (missing.length === 0) return null
  return { code: 'INCOMPLETE', message: `${COLLECTION_WORDS.INCOMPLETE} Still missing: ${missing.map((part) => COLLECTION_PART_WORDS[part]).join(', ')}.` }
}

/** The order's terms beside a collection: whether they fit, and the warning when they do not. */
export function incotermFit(incoterm: string | null): { readonly fits: boolean; readonly warning: string | null } {
  if (incoterm === null) return { fits: false, warning: 'The order names no Incoterms rule: a collection by the customer is ex works (EXW) or free carrier (FCA) at our premises: check the terms agreed.' }
  if ((COLLECTION_INCOTERMS as readonly string[]).includes(incoterm)) return { fits: true, warning: null }
  return { fits: false, warning: `The order's terms are ${incoterm}: the goods are to be delivered by us, yet the customer's carrier collects them. Check with the customer before they leave.` }
}

/** The tracking event's words of a collection (no person: the timeline is read beyond this record). */
export const COLLECTED_WORDS = "Collected at our dock by the customer's carrier (ex works): delivered."
