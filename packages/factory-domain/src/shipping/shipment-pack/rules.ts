import { createHash } from 'node:crypto'

/**
 * One PDF per shipment (B-W2b-391; LOG-031 "Merge carrier label, packing list, DDT and commercial invoice into one print
 * job per shipment"; design floor.pack "Documents: carrier label, packing list and DDT in one print job … W2b: made here"
 * and warehouse.shipments "Other documents: Print all (one merged PDF)"), pure.
 *
 * The pack is the shipment's stored papers, merged page by page into ONE PDF in this order, each part only when it exists:
 *
 *   LABELS               the carrier label of every labelled parcel, as its PDF (a label kept as ZPL only prints on the
 *                        label printer, not here)
 *   PACKING_LIST         the current packing list (made first when the office asks and none matches the parcels)
 *   DDT                  the live DDT's stored PDF (a shipment that needs no DDT has none)
 *   COMMERCIAL_INVOICE   the newest commercial invoice of the shipment (B-W2b-409 makes them)
 *   PROFORMA             the newest proforma of the shipment (customs)
 *
 * The two priced parts go in only for an office caller who sees prices (money.price): a packer's pack never shows a price
 * (LOG-019). A pack is kept as a version (GeneratedDocument SHIPMENT_PACK 1, 2, …) of the shipment; the same parts give the
 * newest back. Nothing is laid out again: the pages are the stored files' own.
 */

export const PACK_PARTS = ['LABELS', 'PACKING_LIST', 'DDT', 'COMMERCIAL_INVOICE', 'PROFORMA'] as const
export type PackPart = (typeof PACK_PARTS)[number]

/** The parts that carry prices. */
export const PRICED_PARTS: readonly PackPart[] = Object.freeze(['COMMERCIAL_INVOICE', 'PROFORMA'])

/** The GeneratedDocument kind of a pack. */
export const PACK_KIND = 'SHIPMENT_PACK' as const

/**
 * A part's state: READY (in the pack), MISSING (expected and not there yet: the words say what to do), NONE (nothing of
 * the kind, and none needed), NOT_SHOWN (it has prices and the caller sees none).
 */
export const PART_STATES = ['READY', 'MISSING', 'NONE', 'NOT_SHOWN'] as const
export type PartState = (typeof PART_STATES)[number]

/** One stored file of a part (its id and SHA-256: the fingerprint is over the files' contents). */
export interface PartFile {
  readonly fileId: string
  readonly sha256: string
}

export interface PackPartFacts {
  readonly kind: PackPart
  readonly state: PartState
  /** The document's number when it has one (the DDT's, the packing list's, the proforma's). */
  readonly number: string | null
  /** Why it is missing or not shown, in words. */
  readonly words: string | null
  readonly files: readonly PartFile[]
}

/** The most bytes the parts of one pack may have together, and the most pages of the merged PDF. */
export const PACK_MAX_BYTES = 30 * 1024 * 1024
export const PACK_MAX_PAGES = 400

/** The parts the caller gets: priced parts only for one who sees prices. */
export const mayHave = (kind: PackPart, seesPrices: boolean): boolean => seesPrices || !PRICED_PARTS.includes(kind)

/**
 * B-W2b-390 (test mode): the labels part holds TEST labels (each says TEST LABEL - NOT FOR SHIPPING, no barcode); the pack says
 * so, its title too, and it is never shared with a customer (no pack is).
 */
export const TEST_PACK_WORDS = 'TEST labels of test mode: marked TEST LABEL - NOT FOR SHIPPING; nothing was sent to a carrier.'

/** The words of a part not shown to the caller. */
export const NOT_SHOWN_WORDS = 'It shows prices: it is printed by someone who sees prices.'

/** The pack's fingerprint: the ready parts, in order, by their files' contents. */
export function packFingerprint(parts: readonly PackPartFacts[]): string {
  const ready = parts.filter((part) => part.state === 'READY').map((part) => `${part.kind}:${part.files.map((file) => file.sha256).join(',')}`)
  return createHash('sha256').update(`shipment-pack/1 ${ready.join(' ')}`).digest('hex')
}

/** What stops the pack (empty when it can be made), in words. */
export function packProblems(status: string, parts: readonly PackPartFacts[]): string[] {
  if (status === 'CANCELLED') return ['The shipment is cancelled: it has no papers to print.']
  if (!parts.some((part) => part.state === 'READY')) {
    const missing = parts.filter((part) => part.state === 'MISSING' && part.words).map((part) => part.words!)
    return [missing.length > 0 ? `Nothing to print yet. ${missing.join(' ')}` : 'Nothing to print yet: the shipment has no stored papers.']
  }
  return []
}

/** The parts in the order they are merged (the input's order may differ). */
export const inPackOrder = <T extends { readonly kind: PackPart }>(parts: readonly T[]): T[] => [...parts].sort((a, b) => PACK_PARTS.indexOf(a.kind) - PACK_PARTS.indexOf(b.kind))
