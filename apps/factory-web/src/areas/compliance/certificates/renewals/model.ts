import { RENEWAL_WINDOW_MONTHS } from '@nexus/factory-domain/compliance/renewals/rules'
import { daysBetween } from '@nexus/factory-domain/compliance/certificates/rules'
import { isBusinessDate } from '@nexus/factory-domain/core/time'
import type { Read } from '../../../quality/_shared/model'
import type { CertCan } from '../model'
import type { CertificateRef, Renewals, Review, Stage } from './api'

/**
 * The Renewals tab's rules without a screen (SCR-051 `?tab=renewals`; B-W2a-66; QHS-105, PRD-283, PRD-285): where the
 * certificate stands in its five years (the bar's marks: the window 12 to 6 months before the end, the 180 / 90 / 30-day
 * alerts, today), each alert stage in words, the renewal's next step and why a verb is held, the changes to the approved
 * type with what each review may do now, and the waiting counts per certificate for the register. Pure.
 */

export const RENEWAL_ACTS = ['renew', 'applied', 'link'] as const
export type RenewalAct = (typeof RENEWAL_ACTS)[number]

export type RenewalDialog =
  | { kind: 'start' }
  | { kind: 'applied' }
  | { kind: 'link' }
  | { kind: 'notify'; reviewId: string }
  | { kind: 'notNeeded'; reviewId: string }
  | { kind: 'answer'; reviewId: string }

export interface AssigneeOption {
  readonly id: string
  readonly name: string
  readonly me: boolean
}

export interface RenewalDraft {
  /** Start renewal: whose task (`me` by default, `nobody`, or a person's id) and the language of its words. */
  assignee: string
  language: 'it' | 'en'
  /** The application. */
  appliedOn: string
  reference: string
  note: string
  /** The link. */
  successorId: string
  /** A review's decision. */
  reason: string
  decision: 'APPROVED' | 'REFUSED'
  answeredOn: string
  /** The answer's PDF chosen (its bytes stay in the container). */
  fileName: string | null
}

export const blankRenewalDraft = (today: string, language: 'it' | 'en'): RenewalDraft => ({ assignee: 'me', language, appliedOn: today, reference: '', note: '', successorId: '', reason: '', decision: 'APPROVED', answeredOn: today, fileName: null })

export interface RenewalsModel {
  renewals: Read<Renewals>
  reviews: Read<Review[]>
  /** Who the renewal task may be given to (null while unread). */
  people: Read<AssigneeOption[]> | null
  dialog: RenewalDialog | null
  draft: RenewalDraft
  busy: boolean
  /** A `certificates` key for a refused write, and the API's sentences under it. */
  problem: string | null
  lines: readonly string[]
  /** The changes list's selected rows (Export N). */
  selected: readonly string[]
}

// ---- the validity bar --------------------------------------------------------------------------------------------------------

export interface BarMark {
  readonly key: string
  /** Where on the bar, 0 … 100 (from Valid from to Valid to). */
  readonly at: number
  readonly kind: 'stage' | 'today'
  readonly date: string
  readonly days?: number
}

const clampPct = (value: number): number => Math.max(0, Math.min(100, value))

/** The five-year bar: today, the window (opens, closes), the alert stages, where each sits from 0 to 100. */
export function barOf(renewals: Pick<Renewals, 'certificate' | 'window' | 'stages' | 'today'>): { marks: BarMark[]; windowFrom: number; windowTo: number; elapsed: number } {
  const { validFrom, validTo } = renewals.certificate
  const span = Math.max(1, daysBetween(validFrom, validTo))
  const pct = (date: string) => (isBusinessDate(date) ? clampPct((daysBetween(validFrom, date) / span) * 100) : 0)
  const marks: BarMark[] = [
    ...renewals.stages.map((stage) => ({ key: `stage-${stage.ruleId}`, at: pct(stage.fireOn), kind: 'stage' as const, date: stage.fireOn, days: stage.daysBefore })),
    { key: 'today', at: pct(renewals.today), kind: 'today', date: renewals.today },
  ]
  return { marks, windowFrom: pct(renewals.window.opens), windowTo: pct(renewals.window.closes), elapsed: pct(renewals.today) }
}

export type StageState = 'off' | 'waiting' | 'fired' | 'cancelled' | 'notSet'

/** What a stage has done: switched off, waiting for its day, fired (an alert raised or already open), stopped, no timer yet. */
export function stageState(stage: Stage): StageState {
  if (!stage.enabled) return 'off'
  if (!stage.timer) return 'notSet'
  if (stage.timer.status === 'FIRED') return 'fired'
  if (stage.timer.status === 'CANCELLED') return 'cancelled'
  return 'waiting'
}

export const STAGE_TONE: Record<StageState, 'neutral' | 'info' | 'warning' | 'success'> = { off: 'neutral', waiting: 'info', fired: 'warning', cancelled: 'neutral', notSet: 'neutral' }

/** The words' key of the window today. */
export const windowKey = (phase: Renewals['window']['phase']): string => `ren.window.${phase}`
export const WINDOW_MONTHS = RENEWAL_WINDOW_MONTHS

// ---- what may be done -------------------------------------------------------------------------------------------------------

/** Why Start renewal is held now (a `certificates` key), or null. */
export function startHeld(renewals: Renewals | null, can: CertCan, busy = false): string | null {
  if (!can.manage) return 'held.manage'
  if (!renewals) return 'held.busy'
  if (renewals.successor) return 'ren.held.renewed'
  if (renewals.certificate.status !== 'VALID' && renewals.certificate.status !== 'SUSPENDED') return 'ren.held.notRenewable'
  if (renewals.renewal?.task?.status === 'OPEN') return 'ren.held.started'
  return busy ? 'held.busy' : null
}

/** Why Record the application is held now, or null. */
export function appliedHeld(renewals: Renewals | null, can: CertCan, draft?: Pick<RenewalDraft, 'appliedOn'>, busy = false): string | null {
  if (!can.manage) return 'held.manage'
  if (!renewals) return 'held.busy'
  if (renewals.successor) return 'ren.held.renewed'
  if (!['VALID', 'SUSPENDED', 'EXPIRED'].includes(renewals.certificate.status)) return 'ren.held.notRenewable'
  if (draft) {
    if (!isBusinessDate(draft.appliedOn)) return 'ren.held.day'
    if (daysBetween(renewals.today, draft.appliedOn) > 0) return 'ren.held.future'
  }
  return busy ? 'held.busy' : null
}

/** Why Link the renewal is held now, or null. */
export function linkHeld(renewals: Renewals | null, can: CertCan, draft?: Pick<RenewalDraft, 'successorId'>, busy = false): string | null {
  if (!can.manage) return 'held.manage'
  if (!renewals) return 'held.busy'
  if (renewals.successor) return 'ren.held.renewed'
  if (!['VALID', 'SUSPENDED', 'EXPIRED'].includes(renewals.certificate.status)) return 'ren.held.notLinkable'
  if (renewals.candidates.length === 0) return 'ren.held.noCandidate'
  if (draft && !renewals.candidates.some((candidate) => candidate.id === draft.successorId)) return 'ren.held.pick'
  return busy ? 'held.busy' : null
}

/** Whether the application day falls in the window (a late one is recorded too: the notified body decides). */
export function inWindow(renewals: Pick<Renewals, 'window'>, day: string): boolean | null {
  if (!isBusinessDate(day)) return null
  return daysBetween(renewals.window.opens, day) >= 0 && daysBetween(day, renewals.window.closes) >= 0
}

export const REVIEW_TONE: Record<Review['status'], 'warning' | 'info' | 'success' | 'danger' | 'neutral'> = { OPEN: 'warning', NOTIFIED: 'info', APPROVED: 'success', REFUSED: 'danger', NOT_NEEDED: 'neutral' }

export type ReviewVerb = 'notify' | 'notNeeded' | 'answer'

/** The verbs a review offers now (OPEN: tell the notified body, or not needed; NOTIFIED: record its answer). */
export function reviewVerbs(review: Pick<Review, 'status'>): ReviewVerb[] {
  if (review.status === 'OPEN') return ['notify', 'notNeeded']
  if (review.status === 'NOTIFIED') return ['answer']
  return []
}

/** Why a review's verb is held (a `certificates` key), or null. */
export function reviewHeld(can: CertCan, verb: ReviewVerb, draft?: Pick<RenewalDraft, 'reason' | 'answeredOn' | 'fileName'>, review?: Pick<Review, 'files' | 'notifiedAt'>, today?: string, busy = false): string | null {
  if (!can.manage) return 'held.manage'
  if (draft && verb === 'notNeeded' && draft.reason.trim() === '') return 'ren.held.reason'
  if (draft && verb === 'notNeeded' && draft.reason.trim().length > 1000) return 'held.long'
  if (draft && verb === 'answer') {
    if (!can.upload && (review?.files.length ?? 0) === 0) return 'ren.held.upload'
    if ((review?.files.length ?? 0) === 0 && !draft.fileName) return 'ren.held.file'
    if (!isBusinessDate(draft.answeredOn)) return 'ren.held.day'
    if (today && daysBetween(today, draft.answeredOn) > 0) return 'ren.held.future'
    if (review?.notifiedAt && daysBetween(review.notifiedAt.slice(0, 10), draft.answeredOn) < 0) return 'ren.held.beforeTold'
  }
  return busy ? 'held.busy' : null
}

/** The waiting reviews (OPEN or NOTIFIED) per certificate: the register's column and its saved view. */
export function waitingByCertificate(reviews: readonly Pick<Review, 'status' | 'certificate'>[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const review of reviews) if (review.status === 'OPEN' || review.status === 'NOTIFIED') out[review.certificate.id] = (out[review.certificate.id] ?? 0) + 1
  return out
}

/** The successor picker's words: number, standard, valid from–to. */
export const candidateLabel = (candidate: CertificateRef): string => `${candidate.number} · ${candidate.standard}`

/** The CSV of the changes list (Export N). */
export function reviewsCsv(reviews: readonly Review[], header: readonly string[], words: { status: (review: Review) => string; kind: (kind: Review['changes'][number]['kind']) => string }): (string | number | null)[][] {
  return [
    [...header],
    ...reviews.flatMap((review) =>
      (review.changes.length ? review.changes : [null]).map((change) => [review.style.code, review.revision.revision, review.comparedRevision?.revision ?? null, change ? words.kind(change.kind) : null, change?.before ?? null, change?.after ?? null, words.status(review), review.answeredOn, review.answerReference]),
    ),
  ]
}
