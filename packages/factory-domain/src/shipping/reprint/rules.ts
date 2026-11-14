import type { ShipmentStatus } from '../shipments'
import { isTestLabel } from '../test-mode/rules'

/**
 * Reprint a label with a reason (B-W2b-391; LOG-027 "Audited reprint; W1 downloads the label PDF again"; plan: "Reprint any
 * carrier, SSCC or carton label without buying a new one, logged with who, when and why"; design warehouse.shipments Carrier
 * & label "W2b Reprint with a reason (logged)"), pure.
 *
 * A reprint is a NEW print job of the same parcel that copies the original's ZPL exactly (nothing is bought again, nothing
 * is laid out again), names the job it prints again and why (PrintJob.reprintOfId + reprintReason, B-W2b-367: fixed once
 * queued); who and when are the job's requester and creation time. Only a label that still says what the parcel is may be
 * printed again:
 *
 *   CARRIER   the parcel's carrier label: its tracking number is the parcel's (a voided label is never printed again: buy
 *             a new one) and it was made for the label bought now
 *   MARKS     the carton's shipping marks (B-W2b-384, scan id `<shipment>-<n>`): only while the carton's marks are current
 *             and the job printed them (a carton renumbered since prints its marks again, not an old "1 of 1")
 *   OTHER     any other label job of the parcel (an SSCC once LOG-021/022 keeps them): printed again as it was
 *
 * Not once the goods were delivered or came back, nor for a cancelled shipment: the label would be stuck on nothing.
 *
 * A TEST label of test mode (B-W2b-390: "TEST LABEL - NOT FOR SHIPPING", no barcode) printed again stays TEST: its ZPL is
 * copied as it is and the job is said to be TEST; going live clears the open shipments' TEST labels, so they are refused.
 */

export const REPRINT_REASON_MIN = 3
export const REPRINT_REASON_MAX = 200
/** At most this many labels in one reprint (a selection on the screen). */
export const REPRINT_MAX_JOBS = 50

export const LABEL_JOB_KINDS = ['CARRIER', 'MARKS', 'OTHER'] as const
export type LabelJobKind = (typeof LABEL_JOB_KINDS)[number]

/** Why a label job may not be printed again, as codes the screens word (the API sends the words below). */
export const REPRINT_REFUSALS = ['NOT_A_LABEL', 'GOODS_GONE', 'LABEL_VOIDED', 'MARKS_CHANGED'] as const
export type ReprintRefusal = (typeof REPRINT_REFUSALS)[number]

// One line of a person's words: no line break or other control character.
const CONTROL = /[\u0000-\u001f\u007f]/

/** The reason as kept (trimmed), or the words that refuse it. */
export function reprintReasonOf(reason: string): { readonly reason: string } | { readonly problem: string } {
  const trimmed = reason.trim()
  if (trimmed.length < REPRINT_REASON_MIN || trimmed.length > REPRINT_REASON_MAX) return { problem: `Say why the label is printed again, in ${REPRINT_REASON_MIN} to ${REPRINT_REASON_MAX} characters.` }
  if (CONTROL.test(trimmed)) return { problem: 'Say why on one line.' }
  return { reason: trimmed }
}

/** The carton code its marks carry (`SH-00001-2`), as B-W2b-384 prints it. */
export const marksCode = (shipmentNumber: string, cartonNumber: number): string => `${shipmentNumber}-${cartonNumber}`

/**
 * What a parcel's label job is, from the code printed on it: the carton's marks carry `<shipment>-<n>`; a carrier label
 * (W1's labels print, label kind CARTON) its tracking number, the current one or a voided label's; anything else is OTHER.
 */
export function labelJobKind(job: { readonly scanId: string | null; readonly labelKind: string | null }, shipmentNumber: string): LabelJobKind {
  const scanId = job.scanId
  if (scanId !== null && scanId.startsWith(`${shipmentNumber}-`) && /^\d{1,3}$/.test(scanId.slice(shipmentNumber.length + 1))) return 'MARKS'
  if (scanId !== null && job.labelKind === 'CARTON') return 'CARRIER'
  return 'OTHER'
}

/** The TEST tracking number's prefix (B-W2b-390 testTrackingNumberOf). */
const TEST_TRACKING = 'TEST-'

/** A carrier label job of test mode: the parcel's current TEST label (its provider id), or an older TEST label it carried. */
export function isTestLabelJob(kind: LabelJobKind, job: { readonly scanId: string | null }, parcel: { readonly trackingNumber: string | null; readonly providerId: string | null }): boolean {
  if (kind !== 'CARRIER' || job.scanId === null) return false
  return job.scanId === parcel.trackingNumber ? isTestLabel(parcel.providerId) : job.scanId.startsWith(TEST_TRACKING)
}

export interface ReprintFacts {
  readonly shipmentStatus: ShipmentStatus
  readonly payloadKind: 'ZPL' | 'PDF'
  readonly kind: LabelJobKind
  readonly job: { readonly scanId: string | null; readonly createdAt: Date }
  readonly parcel: {
    readonly seq: number
    readonly trackingNumber: string | null
    readonly labelledAt: Date | null
    readonly cartonNumber: number | null
    readonly marksPrintedAt: Date | null
    /** The carton's marks say what it is now (factory-domain shipping/cartons marksCurrent). */
    readonly marksCurrent: boolean
  }
}

const GONE: readonly ShipmentStatus[] = ['DELIVERED', 'RETURNED', 'CANCELLED']

/** Why this label job may not be printed again (null: it may), with the words. */
export function reprintRefusal(facts: ReprintFacts): { readonly code: ReprintRefusal; readonly message: string } | null {
  const { parcel, job } = facts
  if (facts.payloadKind !== 'ZPL') return { code: 'NOT_A_LABEL', message: `Parcel ${parcel.seq}: this print job is a document, not a label: print the document again from its record.` }
  if (GONE.includes(facts.shipmentStatus)) {
    return { code: 'GOODS_GONE', message: `The shipment is ${facts.shipmentStatus === 'CANCELLED' ? 'cancelled' : facts.shipmentStatus === 'DELIVERED' ? 'delivered' : 'back from the carrier'}: its labels are not printed again.` }
  }
  if (facts.kind === 'CARRIER') {
    const current = parcel.trackingNumber !== null && job.scanId === parcel.trackingNumber && parcel.labelledAt !== null && job.createdAt.getTime() >= parcel.labelledAt.getTime()
    if (!current) return { code: 'LABEL_VOIDED', message: `Parcel ${parcel.seq}: this carrier label was voided or replaced: print the parcel's current label, or buy a new one.` }
  }
  if (facts.kind === 'MARKS') {
    const current = parcel.marksCurrent && parcel.cartonNumber !== null && parcel.marksPrintedAt !== null && job.createdAt.getTime() >= parcel.marksPrintedAt.getTime()
    if (!current) return { code: 'MARKS_CHANGED', message: `Carton ${parcel.seq}: its marks changed since this label (a carton was added or removed): print the marks again from the packing bench.` }
  }
  return null
}
