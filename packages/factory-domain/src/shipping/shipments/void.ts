import type { TrackingStatus } from '../labels/tracking'
import type { ShipmentStatus } from '../shipments'

/**
 * Voiding carrier labels every day (B-W2a-48; LOG-028; design warehouse.shipments pop-up "Void labels": "voiding one
 * parcel voids all 3 parcels of this shipment", "fee back if within the window"). W1 voids one parcel's label before the
 * goods leave (Sendcloud cancels it). The rules added here:
 *
 *   collected   a label whose parcel the carrier already has (its latest tracking event is past "label created") is not
 *               voided: Sendcloud would refuse it, and the parcel is on its way (say so before calling the carrier)
 *   all         the office voids every labelled parcel of a shipment in one go (a wrong weight, a wrong service, the
 *               customer changed the address): each parcel is cancelled at the carrier, the labels cancelled are cleared
 *               in one command, and a parcel the carrier refuses keeps its label with the carrier's words
 *   outcome     CANCELLED (the carrier cancelled it now) or QUEUED (it confirms later); whether the fee comes back is the
 *               carrier's window, which the answer names without promising it
 */

/** Tracking statuses that say the carrier has the parcel. */
export const COLLECTED_STATUSES: readonly TrackingStatus[] = Object.freeze(['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'RETURNED'])

export interface VoidParcel {
  readonly parcelId: string
  readonly seq: number
  readonly labelled: boolean
  /** The parcel's latest tracking status (null: no event yet). */
  readonly latest: TrackingStatus | null
}

/** Why this parcel's label cannot be voided because the carrier has it (empty: it can). */
export function collectedProblems(parcel: Pick<VoidParcel, 'seq' | 'latest'>): string[] {
  if (parcel.latest === null || !COLLECTED_STATUSES.includes(parcel.latest)) return []
  return [`The carrier has parcel ${parcel.seq} already (tracking says ${parcel.latest.toLowerCase().replace(/_/g, ' ')}): its label is no longer voided; ask the carrier to stop or return it.`]
}

/** What voiding every label of a shipment needs: a shipment that has not left, with at least one labelled parcel. */
export function voidAllProblems(status: ShipmentStatus, parcels: readonly VoidParcel[]): string[] {
  if (status !== 'DRAFT' && status !== 'PACKED') return [`The shipment is ${status}; labels are voided only before the goods leave.`]
  if (!parcels.some((parcel) => parcel.labelled)) return ['No parcel of this shipment has a carrier label.']
  return []
}

/** The labelled parcels a void-all asks the carrier to cancel, and those it leaves (with why). */
export function voidAllPlan(parcels: readonly VoidParcel[]): { readonly toVoid: readonly VoidParcel[]; readonly kept: readonly { readonly parcelId: string; readonly seq: number; readonly problem: string }[] } {
  const labelled = parcels.filter((parcel) => parcel.labelled).sort((a, b) => a.seq - b.seq)
  const kept = labelled.flatMap((parcel) => collectedProblems(parcel).map((problem) => ({ parcelId: parcel.parcelId, seq: parcel.seq, problem })))
  const keptIds = new Set(kept.map((entry) => entry.parcelId))
  return { toVoid: labelled.filter((parcel) => !keptIds.has(parcel.parcelId)), kept }
}

/** The carrier's answer in words (no promise about the fee: that is the carrier's window). */
export function voidOutcomeWords(outcome: 'CANCELLED' | 'QUEUED' | 'NOT_SENT'): string {
  if (outcome === 'CANCELLED') return "Cancelled at the carrier: the label fee comes back if the carrier's window for it is still open."
  if (outcome === 'QUEUED') return "The carrier queued the cancellation and confirms it later; the fee comes back if it does within the carrier's window."
  return 'The label was never sent to the carrier: cleared here.'
}
