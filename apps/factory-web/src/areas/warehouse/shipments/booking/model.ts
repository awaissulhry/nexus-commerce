import { MANUAL_EVENT_STATUSES, OWN_TRANSPORT_LIMITS, OWN_TRANSPORT_REFUSALS } from '@nexus/factory-domain/shipping/own-transport/rules'
import { ETA_LIMITS, ETA_REFUSALS, OVERRIDE_REASON } from '@nexus/factory-domain/shipping/own-transport/rules' // F-OS-203 (B-OS-015, B-OS-016)
// F-OP-135: the typed link's rule, the API's own.
import { TRACKING_URL_PATTERN } from '@nexus/factory-domain/shipping/own-transport/rules'
import { REPRINT_REASON_MAX, REPRINT_REASON_MIN, REPRINT_REFUSALS } from '@nexus/factory-domain/shipping/reprint/rules'
import { PARCEL_TRACKING_LIMITS } from '@nexus/factory-domain/shipping/own-transport/rules' // F-OS-301 (B-OS-022)
import { seenNumbersReasonNeeded } from '@nexus/factory-domain/shipping/own-transport/rules' // F-OS-305 (os-fx3): the consignment number too
import { words, type DepthAbilities, type Read, type Words } from '../queue/shared/depth'
import type { CheckProblem, LabelCheck, LabelJob, LabelJobs, ManualStatus, Reprinted, Transport, TransportMode } from './api'
import type { TrackingBody, TransportParcel } from './api' // F-OS-301

/**
 * Carrier & label in depth, pure (SCR-595; design sh-booking "carrier (…; W2b own van or manual; customer collects ex
 * works)", sh-labels "W2b Reprint with a reason (logged)"; B-W2b-390 LOG-122 / LOG-045, B-W2b-391 LOG-027): the view model
 * of the arrangement card and of the label jobs card, what holds each button and with which words.
 */

export { MANUAL_EVENT_STATUSES, OWN_TRANSPORT_LIMITS, OWN_TRANSPORT_REFUSALS, REPRINT_REASON_MAX, REPRINT_REASON_MIN, REPRINT_REFUSALS }
export { ETA_REFUSALS } // F-OS-203

export type TransportDialog =
  | null
  | { readonly kind: 'arrange'; readonly mode: TransportMode; readonly carrierName: string; readonly trackingNumber: string }
  | {
      readonly kind: 'tracking'
      readonly text: string
      /* F-OP-135: the link typed beside it (optional, https) */ readonly link?: string
      /** F-OS-301 (B-OS-022): each parcel no label tracks, its number and link as typed (a labelled parcel is read only, not here). */
      readonly parcels?: readonly TrackingParcelDraft[]
      /** F-OS-301: why a number the customer saw changes after the goods left (office only). */
      readonly reason?: string
      /** F-OS-301: "Send the shipping notice again" (off by default; only once the goods left). */
      readonly notify?: boolean
    }
  | { readonly kind: 'status'; readonly status: ManualStatus | null; readonly occurredAt: string | null; readonly description: string; readonly location: string; /* F-OS-203 (B-OS-015): why, over a carrier's labels */ readonly reason?: string }
  // F-OS-203 (B-OS-016): the expected arrival typed by hand (a day; empty clears it) and why (optional).
  | { readonly kind: 'eta'; readonly day: string; readonly reason: string }

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
  /** F-OS-203 (B-OS-016): save the expected arrival typed by hand. */
  onEta?: () => void
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

export function trackingProblem(dialog: Extract<TransportDialog, { kind: 'tracking' }>, current: string | null = null, transport?: Pick<Transport, 'shipment' | 'parcels'>): Words | null {
  if (dialog.text.trim().length > OWN_TRANSPORT_LIMITS.trackingNumber || !oneLine(dialog.text)) return words('transport.form.trackingTooLong', { max: OWN_TRANSPORT_LIMITS.trackingNumber })
  // F-OS-301 (B-OS-022): with the read, each parcel's number and link, and the reason a seen number needs.
  if (transport) {
    for (const draft of dialog.parcels ?? []) {
      const problem = parcelProblem(draft)
      if (problem) return problem
    }
    const reason = trackingReasonProblem(dialog, transport)
    if (reason) return reason
  }
  // F-OP-135 (B-OP-034): a link only with its number; https, 1–500 characters, one line, no name or password in it.
  // op-fx4 (B-OP-034: "clearing the number clears it"): the number emptied while the shipment has one (`current`) is Clear it — its
  // link goes with it (trackingBody sends none), so a link left in the box never holds the clear; a link alone, with no number at
  // all, is still held.
  if (dialog.text.trim() === '' && current) return null
  const link = dialog.link?.trim() ?? ''
  if (link !== '' && dialog.text.trim() === '') return words('transport.form.linkNeedsNumber')
  if (link !== '' && (link.length > OWN_TRANSPORT_LIMITS.trackingUrl || !TRACKING_URL_PATTERN.test(link))) return words('transport.form.trackingLink', { max: OWN_TRANSPORT_LIMITS.trackingUrl })
  return null
}

/**
 * F-OP-135: the tracking write's body — the link sent with the number (blank: cleared; no number: none). F-OS-301 (B-OS-022): with the
 * read (`transport`), the parcels whose typed number or link changed (each once; a blank number clears it, its link with it), and the
 * reason when a number the customer saw changes after the goods left.
 */
export function trackingBody(dialog: Extract<TransportDialog, { kind: 'tracking' }>, version: number, transport?: Pick<Transport, 'shipment' | 'parcels'>): TrackingBody & { trackingNumber: string | null; trackingUrl: string | null } {
  const text = dialog.text.trim()
  const link = dialog.link?.trim() ?? ''
  const body = { version, trackingNumber: text === '' ? null : text, trackingUrl: text === '' || link === '' ? null : link }
  if (!transport) return body
  const parcels = parcelChangesOf(dialog, transport)
  const reason = (dialog.reason ?? '').trim()
  // F-OS-305 (os-fx3): the reason goes whenever a number the customer saw changes — the consignment number's or a parcel's.
  return { ...body, ...(parcels.length > 0 ? { parcels } : {}), ...(trackingReasonNeeded(dialog, transport) && reason !== '' ? { reason } : {}) }
}

// ── F-OS-301 (order SHIPMENTS tab; Owner D4; 10-design §7 D5; 18-lead-settles L2, L4; B-OS-022): a number per parcel ──────────────
/** One parcel's typed number in the dialog (a parcel no label tracks). */
export interface TrackingParcelDraft {
  readonly id: string
  readonly seq: number
  readonly text: string
  readonly link: string
}

/** A label's number (read only, "From the label") — a TEST label counts as a label: its number is never typed over. */
export const parcelLabelled = (parcel: Pick<TransportParcel, 'label'>): boolean => parcel.label !== null

/** The tracking dialog as it opens: the shipment's number and link, and every parcel no label tracks with its typed number. */
export function trackingDialogOf(transport: Pick<Transport, 'shipment' | 'parcels'>): Extract<TransportDialog, { kind: 'tracking' }> {
  const parcels = [...(transport.parcels ?? [])].filter((parcel) => !parcelLabelled(parcel)).sort((a, b) => a.seq - b.seq)
  return {
    kind: 'tracking',
    text: transport.shipment.manualTrackingNumber ?? '',
    link: transport.shipment.manualTrackingUrl ?? '',
    ...(transport.parcels && transport.parcels.length > 0 ? { parcels: parcels.map((parcel) => ({ id: parcel.id, seq: parcel.seq, text: parcel.typed?.number ?? '', link: parcel.typed?.url ?? '' })) } : {}),
    reason: '',
    notify: false,
  }
}

/** What changes on each parcel (only the typed ones that differ from the read), in the command's shape. */
export function parcelChangesOf(dialog: Extract<TransportDialog, { kind: 'tracking' }>, transport: Pick<Transport, 'parcels'>): { parcelId: string; trackingNumber: string | null; trackingUrl: string | null }[] {
  return (dialog.parcels ?? []).flatMap((draft) => {
    const read = (transport.parcels ?? []).find((parcel) => parcel.id === draft.id)
    if (!read || parcelLabelled(read)) return []
    const number = draft.text.trim() === '' ? null : draft.text.trim()
    const link = number === null || draft.link.trim() === '' ? null : draft.link.trim()
    const before = read.typed
    if ((before?.number ?? null) === number && (before?.url ?? null) === link) return []
    return [{ parcelId: draft.id, trackingNumber: number, trackingUrl: link }]
  })
}

/**
 * After the goods left, a number the customer could read changes or is cleared: the person says why (B-OS-022's rule). F-OS-305
 * (os-fx3): the shipment's own consignment number as well as a parcel's — the domain's one rule (`seenNumbersReasonNeeded`).
 */
export function trackingReasonNeeded(dialog: Extract<TransportDialog, { kind: 'tracking' }>, transport: Pick<Transport, 'shipment' | 'parcels'>): boolean {
  const text = dialog.text.trim()
  const parcels = parcelChangesOf(dialog, transport).map((change) => ({ before: (transport.parcels ?? []).find((parcel) => parcel.id === change.parcelId)?.typed?.number ?? null, after: change.trackingNumber }))
  return seenNumbersReasonNeeded(transport.shipment.status, { consignment: { before: transport.shipment.manualTrackingNumber ?? null, after: text === '' ? null : text }, parcels })
}

/** "Send the shipping notice again" is offered once the goods left (before, the notice goes when they leave). */
export const noticeOffered = (transport: Pick<Transport, 'shipment'>): boolean => transport.shipment.status === 'SHIPPED' || transport.shipment.status === 'DELIVERED' || transport.shipment.status === 'RETURNED'

/**
 * A soft check of an air waybill (IATA: 3 digits of the airline, 8 of the serial; the last digit is the first seven modulo 7) —
 * words only, never a refusal (L4): null when the number does not look like one.
 */
export function awbCheck(text: string): 'fits' | 'off' | null {
  const digits = /^\s*(\d{3})[\s-]?(\d{8})\s*$/.exec(text)
  if (!digits) return null
  const serial = digits[2]!
  return Number(serial.slice(0, 7)) % 7 === Number(serial[7]) ? 'fits' : 'off'
}

/** What stops one parcel's typed number: the same rules as the shipment's own number and link (one line, the lengths, https only). */
export function parcelProblem(draft: TrackingParcelDraft): Words | null {
  if (draft.text.trim().length > OWN_TRANSPORT_LIMITS.trackingNumber || !oneLine(draft.text)) return words('door.tracking.parcelTooLong', { seq: draft.seq, max: OWN_TRANSPORT_LIMITS.trackingNumber })
  const link = draft.link.trim()
  if (link !== '' && draft.text.trim() === '') return words('door.tracking.parcelLinkNeedsNumber', { seq: draft.seq })
  if (link !== '' && (link.length > OWN_TRANSPORT_LIMITS.trackingUrl || !TRACKING_URL_PATTERN.test(link))) return words('door.tracking.parcelLink', { seq: draft.seq, max: OWN_TRANSPORT_LIMITS.trackingUrl })
  return null
}

/** What stops the reason a seen number needs: 3 to 500 characters. */
export function trackingReasonProblem(dialog: Extract<TransportDialog, { kind: 'tracking' }>, transport: Pick<Transport, 'shipment' | 'parcels'>): Words | null {
  if (!trackingReasonNeeded(dialog, transport)) return null
  const reason = (dialog.reason ?? '').trim()
  if (reason.length < PARCEL_TRACKING_LIMITS.reasonMin) return words('door.tracking.why', { min: PARCEL_TRACKING_LIMITS.reasonMin })
  if (reason.length > PARCEL_TRACKING_LIMITS.reasonMax) return words('transport.form.tooLong', { max: PARCEL_TRACKING_LIMITS.reasonMax })
  return null
}

// ── end F-OS-301 ──

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
  // F-OS-203 (B-OS-015, Owner D5): delivered or came back marked by hand over a carrier's labels says why (3 to 500 characters).
  if (overridesLabels(dialog, transport)) {
    const reason = (dialog.reason ?? '').trim()
    if (reason.length < OVERRIDE_REASON.min) return words('door.status.why', { min: OVERRIDE_REASON.min })
    if (reason.length > OVERRIDE_REASON.max) return words('transport.form.tooLong', { max: OVERRIDE_REASON.max })
  }
  return null
}

// ---- F-OS-203 (order SHIPMENTS tab; B-OS-015, B-OS-016) --------------------------------------------------------------------------
/** Delivered or came back typed over a carrier's labels: the carrier's tracking moves it, so a person says why they know better. */
export const overridesLabels = (dialog: Pick<Extract<TransportDialog, { kind: 'status' }>, 'status'>, transport: Pick<Transport, 'labels'>): boolean => transport.labels.carrier > 0 && (dialog.status === 'DELIVERED' || dialog.status === 'RETURNED')

/** The typed status's body: the reason only where the labels need it (kept as the event's words). */
export function statusBody(dialog: Extract<TransportDialog, { kind: 'status' }>, transport: Transport, status: ManualStatus): { version: number; status: ManualStatus; occurredAt?: string; description: string | null; location: string | null; reason?: string } {
  const reason = (dialog.reason ?? '').trim()
  return {
    version: transport.shipment.version,
    status,
    ...(dialog.occurredAt ? { occurredAt: new Date(dialog.occurredAt).toISOString() } : {}),
    description: dialog.description.trim() || null,
    location: dialog.location.trim() || null,
    ...(overridesLabels(dialog, transport) && reason !== '' ? { reason } : {}),
  }
}

/**
 * What stops the expected arrival: a day (or empty: cleared), not before the goods left, at most a year ahead; why at most 500.
 * F-OS-306 (os-fx6) — the server's own rule (etaProblems): the day's noon (what is sent) not before the goods left (no day's grace);
 * and changing or clearing an expected arrival the customer already reads says why (3 to 500).
 */
export function etaProblem(dialog: Extract<TransportDialog, { kind: 'eta' }>, transport: Pick<Transport, 'shipment'>, now: Date = new Date()): Words | null {
  if (dialog.reason.trim().length > ETA_LIMITS.reasonMax) return words('transport.form.tooLong', { max: ETA_LIMITS.reasonMax })
  if (dialog.day === '' && !transport.shipment.expectedDeliveryAt) return words('door.eta.pickDay')
  if (dialog.day !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dialog.day)) return words('door.eta.notADay')
    const at = Date.parse(`${dialog.day}T12:00:00Z`)
    if (transport.shipment.shippedAt && at < Date.parse(transport.shipment.shippedAt)) return words('door.eta.beforeLeft')
    if (at > now.getTime() + ETA_LIMITS.aheadDays * 86_400_000) return words('door.eta.tooFar')
  }
  if (etaReasonNeeded(dialog, transport) && dialog.reason.trim().length < ETA_LIMITS.reasonMin) return words('door.eta.why', { min: ETA_LIMITS.reasonMin })
  return null
}

// ── F-OS-306 (os-fx6): the dialog keeps the server's ETA rule ──
/** The first day the picker offers: the first whose noon (what is sent) is not before the goods left; none before they left. */
export function etaMinDayOf(shippedAt: string | null | undefined): string | undefined {
  const left = shippedAt ? Date.parse(shippedAt) : Number.NaN
  if (!Number.isFinite(left)) return undefined
  const day = new Date(left).toISOString().slice(0, 10)
  return Date.parse(`${day}T12:00:00.000Z`) >= left ? day : new Date(left + 86_400_000).toISOString().slice(0, 10)
}

/** Changing or clearing an expected arrival the customer already reads (the portal shows it) says why — as the server asks. */
export function etaReasonNeeded(dialog: Pick<Extract<TransportDialog, { kind: 'eta' }>, 'day'>, transport: Pick<Transport, 'shipment'>): boolean {
  const before = transport.shipment.expectedDeliveryAt ? Date.parse(transport.shipment.expectedDeliveryAt) : null
  if (before === null) return false
  return dialog.day === '' || Date.parse(`${dialog.day}T12:00:00.000Z`) !== before
}
// ── end F-OS-306 ──

/** The expected arrival's body: the day at noon Rome-safe (UTC noon keeps the day in every zone), or null to clear it. */
export const etaBody = (dialog: Extract<TransportDialog, { kind: 'eta' }>, transport: Pick<Transport, 'shipment'>): { version: number; expectedDeliveryAt: string | null; reason?: string } => {
  const reason = dialog.reason.trim()
  return { version: transport.shipment.version, expectedDeliveryAt: dialog.day === '' ? null : `${dialog.day}T12:00:00.000Z`, ...(reason !== '' ? { reason } : {}) }
}

/** The expected arrival's dialog as it opens: the day the shipment has now. */
export const etaDialogOf = (transport: Pick<Transport, 'shipment'>): Extract<TransportDialog, { kind: 'eta' }> => ({ kind: 'eta', day: transport.shipment.expectedDeliveryAt ? transport.shipment.expectedDeliveryAt.slice(0, 10) : '', reason: '' })

/** An expected-arrival refusal (B-OS-016) in the lane's words. */
export const etaHeld = (eta: Transport['may']['eta'], can: boolean): Words | null => {
  if (!can) return words('transport.held.noManage')
  if (!eta) return words('transport.held.notNow')
  if (!eta.allowed) return eta.refusal ? words(`door.eta.refusal.${eta.refusal.code}`) : words('transport.held.notNow')
  return null
}
// ---- end F-OS-203

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
