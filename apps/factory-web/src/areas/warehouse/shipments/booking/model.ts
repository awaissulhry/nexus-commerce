import { MANUAL_EVENT_STATUSES, OWN_TRANSPORT_LIMITS, OWN_TRANSPORT_REFUSALS } from '@nexus/factory-domain/shipping/own-transport/rules'
import { REPRINT_REASON_MAX, REPRINT_REASON_MIN, REPRINT_REFUSALS } from '@nexus/factory-domain/shipping/reprint/rules'
import { words, type DepthAbilities, type Read, type Words } from '../queue/shared/depth'
import type { CheckProblem, LabelCheck, LabelJob, LabelJobs, ManualStatus, Reprinted, Transport, TransportMode } from './api'

/**
 * Carrier & label in depth, pure (SCR-595; design sh-booking "carrier (…; W2b own van or manual; customer collects ex
 * works)", sh-labels "W2b Reprint with a reason (logged)"; B-W2b-390 LOG-122 / LOG-045, B-W2b-391 LOG-027): the view model
 * of the arrangement card and of the label jobs card, what holds each button and with which words.
 */

export { MANUAL_EVENT_STATUSES, OWN_TRANSPORT_LIMITS, OWN_TRANSPORT_REFUSALS, REPRINT_REASON_MAX, REPRINT_REASON_MIN, REPRINT_REFUSALS }

export type TransportDialog =
  | null
  | { readonly kind: 'arrange'; readonly mode: TransportMode; readonly carrierName: string; readonly trackingNumber: string }
  | { readonly kind: 'tracking'; readonly text: string }
  | { readonly kind: 'status'; readonly status: ManualStatus | null; readonly occurredAt: string | null; readonly description: string; readonly location: string }

export interface TransportModel {
  readonly transport: Read<Transport>
  /** The check before printing (shipping.pack; null: not read for this person). */
  readonly check: Read<LabelCheck> | null
  readonly can: Pick<DepthAbilities, 'manage' | 'pack'>
  readonly dialog: TransportDialog
  readonly busy: boolean
  readonly problem: Words | null
  readonly done: Words | null
}

export interface TransportActions {
  onRetry?: () => void
  onRetryCheck?: () => void
  onDialog?: (dialog: TransportDialog) => void
  onArrange?: () => void
  onTracking?: () => void
  onStatus?: () => void
}

/** A refusal the API sent with `may.*` (the reason a change is held), in this step's words. */
export function mayHeld(allowance: Transport['may']['arrange'], can: boolean): Words | null {
  if (!can) return words('transport.held.noManage')
  if (!allowance.allowed) return allowance.refusal ? words(`transport.refusal.${allowance.refusal.code}`) : words('transport.held.notNow')
  return null
}

/** The arrangement dialog's starting values: what the shipment has now. */
export function arrangeDialogOf(transport: Transport): Extract<TransportDialog, { kind: 'arrange' }> {
  return {
    kind: 'arrange',
    mode: transport.arrangement === 'OWN_VAN' ? 'OWN_VAN' : 'MANUAL_CARRIER',
    carrierName: transport.arrangement === 'MANUAL_CARRIER' ? (transport.shipment.carrierName ?? '') : '',
    trackingNumber: transport.shipment.manualTrackingNumber ?? '',
  }
}

const oneLine = (text: string): boolean => !/[\r\n]/.test(text)

/** What stops the arrangement dialog. */
export function arrangeProblem(dialog: Extract<TransportDialog, { kind: 'arrange' }>): Words | null {
  if (dialog.mode === 'MANUAL_CARRIER') {
    if (dialog.carrierName.trim() === '') return words('transport.form.carrierNeeded')
    if (dialog.carrierName.trim().length > OWN_TRANSPORT_LIMITS.carrierName) return words('transport.form.tooLong', { max: OWN_TRANSPORT_LIMITS.carrierName })
    if (dialog.trackingNumber.trim().length > OWN_TRANSPORT_LIMITS.trackingNumber || !oneLine(dialog.trackingNumber)) return words('transport.form.trackingTooLong', { max: OWN_TRANSPORT_LIMITS.trackingNumber })
  }
  return null
}

/** The arrangement as the API takes it: our van sends no carrier and no number. */
export function arrangeBody(dialog: Extract<TransportDialog, { kind: 'arrange' }>, version: number): { version: number; mode: TransportMode; carrierName?: string | null; trackingNumber?: string | null } {
  if (dialog.mode === 'OWN_VAN') return { version, mode: 'OWN_VAN' }
  const tracking = dialog.trackingNumber.trim()
  return { version, mode: 'MANUAL_CARRIER', carrierName: dialog.carrierName.trim(), trackingNumber: tracking === '' ? null : tracking }
}

export function trackingProblem(dialog: Extract<TransportDialog, { kind: 'tracking' }>): Words | null {
  if (dialog.text.trim().length > OWN_TRANSPORT_LIMITS.trackingNumber || !oneLine(dialog.text)) return words('transport.form.trackingTooLong', { max: OWN_TRANSPORT_LIMITS.trackingNumber })
  return null
}

/** What stops the typed status: a status, a time not in the future and not before the goods left, the lengths. */
export function statusProblem(dialog: Extract<TransportDialog, { kind: 'status' }>, transport: Transport, now: Date = new Date()): Words | null {
  if (!dialog.status) return words('transport.form.pickStatus')
  if (dialog.occurredAt) {
    const at = Date.parse(dialog.occurredAt)
    if (!Number.isFinite(at)) return words('transport.form.when')
    if (at > now.getTime() + OWN_TRANSPORT_LIMITS.futureSkewMs) return words('transport.form.future')
    if (transport.shipment.shippedAt && at < Date.parse(transport.shipment.shippedAt)) return words('transport.form.beforeLeft')
  }
  if (dialog.description.trim().length > OWN_TRANSPORT_LIMITS.description) return words('transport.form.tooLong', { max: OWN_TRANSPORT_LIMITS.description })
  if (dialog.location.trim().length > OWN_TRANSPORT_LIMITS.location) return words('transport.form.tooLong', { max: OWN_TRANSPORT_LIMITS.location })
  return null
}

/** A check problem in words: its code, the parcel, the carrier's limit (the first missing field of an address by name). */
export function checkProblemWords(problem: CheckProblem, carrier: string): Words {
  const p = problem.params
  const field = problem.path.split('/').pop() ?? ''
  switch (problem.code) {
    case 'SENDER_INCOMPLETE':
    case 'RECIPIENT_INCOMPLETE':
      return words(`check.incomplete.${problem.code === 'SENDER_INCOMPLETE' ? 'sender' : 'recipient'}.${['name', 'line1', 'postalCode', 'city', 'country'].includes(field) ? field : 'line1'}`)
    case 'POSTAL_CODE':
      return words(p.who === 'sender' ? 'check.POSTAL_CODE_sender' : 'check.POSTAL_CODE', { value: String(p.value ?? ''), country: String(p.country ?? ''), example: String(p.example ?? '') })
    case 'PHONE_NEEDED':
      return words(p.why === 'OUTSIDE_EU' ? 'check.PHONE_NEEDED_eu' : 'check.PHONE_NEEDED', { carrier })
    case 'PHONE_FORMAT':
      return words('check.PHONE_FORMAT', { value: String(p.value ?? '') })
    case 'NO_SERVICE':
      return words('check.NO_SERVICE')
    case 'NO_WEIGHT':
    case 'SIZES_PARTIAL':
      return words(`check.${problem.code}`, { seq: String(p.seq ?? problem.parcelSeq ?? '') })
    case 'TOO_HEAVY':
      return words('check.TOO_HEAVY', { seq: String(p.seq ?? ''), weight: String(p.weightKg ?? ''), max: String(p.maxKg ?? ''), carrier })
    case 'TOO_LONG':
      return words('check.TOO_LONG', { seq: String(p.seq ?? ''), length: String(p.lengthCm ?? ''), max: String(p.maxCm ?? ''), carrier })
    case 'TOO_BIG':
      return words('check.TOO_BIG', { seq: String(p.seq ?? ''), sum: String(p.sumCm ?? ''), max: String(p.maxCm ?? ''), carrier })
    case 'DOES_NOT_FIT':
      return words('check.DOES_NOT_FIT', { seq: String(p.seq ?? ''), sizes: String(p.sizesCm ?? ''), box: String(p.boxCm ?? ''), carrier })
  }
}

/** Every problem once: the shipment's own, then each parcel's (the API lists a parcel's problems in both places). */
export function allProblems(check: LabelCheck): CheckProblem[] {
  const seen = new Set<string>()
  return [...check.problems, ...check.parcels.flatMap((parcel) => parcel.problems)].filter((problem) => {
    const key = `${problem.code}|${problem.parcelSeq ?? ''}|${problem.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---- the label jobs and a reprint with a reason ----------------------------------------------------------------------------------

export interface ReprintModel {
  readonly jobs: Read<LabelJobs>
  readonly can: Pick<DepthAbilities, 'pack' | 'printLabels'>
  /** The jobs ticked for a reprint. */
  readonly picked: readonly string[]
  readonly dialog: null | { readonly reason: string }
  readonly busy: boolean
  readonly problem: Words | null
  readonly done: Reprinted | null
}

export interface ReprintActions {
  onRetry?: () => void
  onPick?: (jobIds: string[]) => void
  onDialog?: (dialog: ReprintModel['dialog']) => void
  onReprint?: () => void
}

/** Why a job may not be printed again now (its refusal), else null. */
export function jobHeld(job: LabelJob): Words | null {
  if (job.reprintable) return null
  return job.refusal ? words(`reprint.refusal.${job.refusal.code}`) : words('reprint.held.notNow')
}

/** Who asked for a print: an office person by name; the floor's device (the worker only where the site's gate allows). */
export function requesterWords(job: LabelJob): Words {
  if (job.requestedBy.by === 'SYSTEM') return words('reprint.by.system')
  if (job.requestedBy.by === 'FLOOR') return job.requestedBy.name ? words('reprint.by.floorNamed', { device: job.requestedBy.device ?? '—', name: job.requestedBy.name }) : words('reprint.by.floor', { device: job.requestedBy.device ?? '—' })
  return words('reprint.by.office', { name: job.requestedBy.name ?? '—' })
}

/** Why "Reprint" of the picked jobs is held. */
export function reprintHeld(model: Pick<ReprintModel, 'can' | 'picked' | 'busy' | 'jobs'>): Words | null {
  if (!model.can.pack || !model.can.printLabels) return words('reprint.held.noRight')
  if (model.picked.length === 0) return words('reprint.held.pickOne')
  if (model.jobs.state === 'ready') {
    const all = model.jobs.value.parcels.flatMap((parcel) => parcel.jobs)
    if (model.picked.some((id) => !all.find((job) => job.jobId === id)?.reprintable)) return words('reprint.held.notReprintable')
  }
  if (model.busy) return words('reprint.held.busy')
  return null
}

/** What stops the reason (3 to 200 characters on one line). */
export function reasonProblem(reason: string): Words | null {
  const typed = reason.trim()
  if (typed.length < REPRINT_REASON_MIN) return words('reprint.form.reasonShort', { min: REPRINT_REASON_MIN })
  if (typed.length > REPRINT_REASON_MAX) return words('reprint.form.reasonLong', { max: REPRINT_REASON_MAX })
  if (!oneLine(reason)) return words('reprint.form.oneLine')
  return null
}

export const PRINT_TONE = { QUEUED: 'neutral', SENT: 'info', PRINTED: 'success', FAILED: 'danger' } as const
