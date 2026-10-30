import type { DocumentLanguage } from '../../documents/model'

/**
 * A shipment's packing list, version by version (B-W2a-48; LOG-012; design warehouse.shipments Documents "Other
 * documents: packing list … generated documents with versions; kind · number · version · created"). W1 printed one
 * whenever asked; now each print is a version of the shipment's packing list: the same contents and language print the
 * same file again (no new version), changed contents (a parcel weighed, garments moved, a line added) make version n + 1,
 * numbered `<shipment number>/<n>` from version 2 on. The list says which version matches the shipment as it is now
 * (`current`); an older one is kept (the shipment's history) but no longer what is in the parcels. Pure rules; the API
 * stores the PDF (platform/documents) and records each version with its fingerprint.
 */

export interface PackedContents {
  readonly parcels: readonly { readonly id: string; readonly seq: number; readonly grossWeightKg: string | null; readonly lengthCm?: string | null; readonly widthCm?: string | null; readonly heightCm?: string | null }[]
  readonly lines: readonly { readonly parcelId: string | null; readonly workOrderSizeId: string; readonly quantity: number; readonly serials: readonly string[] }[]
}

/**
 * What a packing list prints, as one string (no hashing here: the API hashes it): each parcel's place and weight, each
 * line's parcel, cell, garments and serials, sorted, so the same packing gives the same fingerprint.
 */
export function contentsKey(contents: PackedContents): string {
  const seqOf = new Map(contents.parcels.map((parcel) => [parcel.id, parcel.seq]))
  const parcels = [...contents.parcels]
    .sort((a, b) => a.seq - b.seq)
    .map((parcel) => [parcel.seq, parcel.grossWeightKg ?? '-', parcel.lengthCm ?? '-', parcel.widthCm ?? '-', parcel.heightCm ?? '-'].join(':'))
  const lines = contents.lines
    .map((line) => [line.parcelId ? (seqOf.get(line.parcelId) ?? '?') : '-', line.workOrderSizeId, line.quantity, [...line.serials].sort().join(',')].join(':'))
    .sort()
  return `parcels=${parcels.join('|')};lines=${lines.join('|')}`
}

export interface PackingListVersion {
  readonly fileId: string
  readonly version: number
  readonly fingerprint: string
  readonly language: DocumentLanguage
}

/** The next print: the version that already has these contents in this language, or a new one after the highest. */
export function nextPackingList<Version extends PackingListVersion>(versions: readonly Version[], fingerprint: string, language: DocumentLanguage): { readonly reuse: Version | null; readonly version: number } {
  const same = versions.find((entry) => entry.fingerprint === fingerprint && entry.language === language)
  if (same) return { reuse: same, version: same.version }
  const sameContents = versions.find((entry) => entry.fingerprint === fingerprint)
  if (sameContents) return { reuse: null, version: sameContents.version }
  return { reuse: null, version: versions.reduce((highest, entry) => Math.max(highest, entry.version), 0) + 1 }
}

/** The number a version prints: the shipment's number, then `/<n>` from version 2 on. */
export const packingListNumber = (shipmentNumber: string, version: number): string => (version <= 1 ? shipmentNumber : `${shipmentNumber}/${version}`)

/** Why a packing list cannot be printed now (empty: it can): not for a cancelled shipment, and every garment packed. */
export function packingListProblems(status: string, lines: number, unpacked: number): string[] {
  if (status === 'CANCELLED') return ['The shipment is CANCELLED: it has no packing list any more.']
  if (lines === 0) return ['The shipment has no lines yet; a packing list lists packed garments.']
  if (unpacked > 0) return [`A packing list says which parcel each garment is in: ${unpacked} garment(s) are not in a parcel yet.`]
  return []
}
