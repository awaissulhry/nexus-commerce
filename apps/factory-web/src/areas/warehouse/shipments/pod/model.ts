import { EXCEPTION_REFUSALS } from '@nexus/factory-domain/shipping/exceptions/rules'
import { words, type DepthAbilities, type Read, type Words } from '../queue/shared/depth'
import type { Pod, ShipmentProblems } from './api'

/**
 * Tracking & delivery in depth, pure (SCR-597; design sh-pod "W2b stores signer, time and image (LOG-065)", sh-track "no
 * event for 3 days: a warning line (W2b task, LOG-063)"): the proof of delivery's view model, what may still be typed (each
 * part once), the image's type and size, the tracking problems and Resolve.
 */

export { EXCEPTION_REFUSALS }
/** The image the proof takes: a photo or a scan (PDF), at most 15 MB. */
export const POD_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const
export const POD_MAX_BYTES = 15 * 1024 * 1024
export const NOTE_MAX = 500

export type DeliveryDialog = null | { readonly kind: 'pod'; readonly signedBy: string; readonly signedAt: string | null; readonly file: { readonly name: string; readonly type: string; readonly size: number } | null } | { readonly kind: 'resolve'; readonly problemId: string; readonly note: string }

export interface DeliveryModel {
  readonly pod: Read<Pod>
  readonly problems: Read<ShipmentProblems>
  readonly can: Pick<DepthAbilities, 'manage' | 'readFiles' | 'uploadFiles'>
  /** What the record's tracking read says beside the proof: the carrier's expected day, when it came back. */
  readonly facts: { readonly expectedAt: string | null; readonly returnedAt: string | null }
  readonly dialog: DeliveryDialog
  readonly busy: boolean
  readonly problem: Words | null
  readonly done: Words | null
}

export interface DeliveryActions {
  onRetry?: () => void
  onDialog?: (dialog: DeliveryDialog) => void
  /** The picked image (the container keeps the File; the model only its name, type and size). */
  onPick?: (file: File | null) => void
  onRecord?: () => void
  onDownload?: () => void
  onResolve?: () => void
}

/** What the proof still lacks, part by part (each is set once). */
export function openParts(pod: Pod): { signer: boolean; time: boolean; image: boolean } {
  return { signer: !pod.pod?.signedBy, time: !pod.pod?.signedAt, image: !pod.pod?.file }
}

/** Why "Record the proof" is held (null: a part may still be typed). */
export function recordHeld(pod: Pod, can: DeliveryModel['can'], busy: boolean): Words | null {
  if (pod.recordHeld === 'NO_RIGHT' || !can.manage) return words('pod.held.noManage')
  if (pod.recordHeld === 'NOT_DELIVERED') return words('pod.held.notDelivered')
  if (pod.recordHeld === 'KEPT') return words('pod.held.kept')
  if (busy) return words('pod.held.busy')
  return null
}

/** What stops the dialog: at least one part, the signer's length, the time after the goods left and not in the future, the file. */
export function podProblem(dialog: Extract<DeliveryDialog, { kind: 'pod' }>, pod: Pod, can: DeliveryModel['can'], now: Date = new Date()): Words | null {
  const parts = openParts(pod)
  const signer = parts.signer ? dialog.signedBy.trim() : ''
  const time = parts.time ? dialog.signedAt : null
  const file = parts.image ? dialog.file : null
  if (signer === '' && !time && !file) return words('pod.form.nothing')
  if (signer.length > pod.signerMax) return words('pod.form.signerLong', { max: pod.signerMax })
  if (/[\r\n]/.test(signer)) return words('pod.form.oneLine')
  if (time) {
    const at = Date.parse(time)
    if (!Number.isFinite(at)) return words('pod.form.when')
    if (at > now.getTime() + 5 * 60_000) return words('pod.form.future')
    if (pod.shipment.shippedAt && at < Date.parse(pod.shipment.shippedAt)) return words('pod.form.beforeLeft')
  }
  if (file) {
    if (!can.uploadFiles) return words('pod.form.noUpload')
    if (!(POD_TYPES as readonly string[]).includes(file.type)) return words('pod.form.type')
    if (file.size > POD_MAX_BYTES) return words('pod.form.size')
  }
  return null
}

/** Why "Download" of the proof is held. */
export function downloadHeld(pod: Pod, can: DeliveryModel['can'], busy: boolean): Words | null {
  if (!pod.pod?.file) return words('pod.held.noImage')
  if (!can.readFiles) return words('pod.held.noFiles')
  if (busy) return words('pod.held.busy')
  return null
}

/** Why "Resolve" of a problem is held. */
export function resolveHeld(problem: ShipmentProblems['problems'][number], can: DeliveryModel['can'], busy: boolean): Words | null {
  if (problem.resolvedAt) return words('problems.held.resolved')
  if (!can.manage) return words('pod.held.noManage')
  if (busy) return words('pod.held.busy')
  return null
}

export const PROBLEM_TONE = { DELAYED: 'warning', ADDRESS_PROBLEM: 'danger', FAILED_DELIVERY: 'danger', NO_SCAN: 'warning' } as const
