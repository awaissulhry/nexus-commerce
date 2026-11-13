import { accidentNeeded, intakeProblems, SAFETY_LIMITS, type IntakeFacts } from '@nexus/factory-domain/sales/safety-reports/rules'
import { issuePath, isApiError } from '../api/errors'

/**
 * A product-safety report as a person types it (B-W2b-357 on B-W2b-351's API; SAL-414, SAL-415; design links.doc "Report a
 * problem", portal.customer.returns "Report a safety incident", the office's report from a call or a mail), pure and shared by
 * the three doors: the public DoC page (Links), the customer's portal (Portal) and the office (Office) — no view may import
 * another's files, so the form lives here. The rules are factory-domain's own `intakeProblems` (the API says the same in
 * English): this file only names each problem by a key of the `safety-reports` catalogue and builds the body every door sends.
 *
 * The injury words are health data (GDPR art. 9): the field appears only after the explicit consent tick, and they are sent
 * only when someone was hurt AND the tick is on. Unticking keeps what was typed on this page but sends none of it.
 */

export const NS = 'safety-reports'

/** Was it worn as intended (the design's question): yes, no, or the reporter does not know. */
export type Worn = 'yes' | 'no' | 'unsure'

export interface IntakeDraft {
  readonly serial: string
  readonly batchNumber: string
  readonly size: string
  readonly whatHappened: string
  /** The day it happened, `YYYY-MM-DD` ('' unknown). */
  readonly occurredOn: string
  readonly place: string
  readonly worn: Worn | null
  /** It happened in an accident or a fall (it goes in the accident log, like anyone hurt). */
  readonly accident: boolean
  /** Was anyone hurt: required from outside (the public page and the portal); the office may leave it unsaid. */
  readonly injured: boolean | null
  /** The explicit consent to keep the injury words. */
  readonly consent: boolean
  readonly injuryWords: string
  readonly name: string
  readonly email: string
  readonly phone: string
}

export const EMPTY_INTAKE: IntakeDraft = Object.freeze({
  serial: '',
  batchNumber: '',
  size: '',
  whatHappened: '',
  occurredOn: '',
  place: '',
  worn: null,
  accident: false,
  injured: null,
  consent: false,
  injuryWords: '',
  name: '',
  email: '',
  phone: '',
})

/** The doors: the public DoC page, the customer's portal, the office (a call, a visit or a mail). */
export type Door = 'public' | 'portal' | 'office'

/** What every door sends (`intakeShape` of the API's contract). */
export interface IntakeBody {
  serial: string | null
  batchNumber: string | null
  size: string | null
  occurredOn: string | null
  place: string | null
  whatHappened: string
  wornAsIntended: boolean | null
  accident: boolean
  injured: boolean | null
  injuryConsent: boolean | null
  injuryWords: string | null
  reporter: { name: string | null; email: string | null; phone: string | null } | null
}

const text = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The injury words go only when someone was hurt and the consent is ticked. */
export const sendsInjuryWords = (draft: Pick<IntakeDraft, 'injured' | 'consent' | 'injuryWords'>): boolean => draft.injured === true && draft.consent && draft.injuryWords.trim() !== ''

/** The day and place are asked: an accident, or anyone hurt (the accident log's columns). */
export const asksDayAndPlace = (draft: Pick<IntakeDraft, 'accident' | 'injured'>): boolean => accidentNeeded({ accident: draft.accident, injured: draft.injured })

/**
 * The body every door sends. `door` decides the reporter (the portal's person is known: no reporter); `fixedBatch` is the
 * batch the public page's QR names (the API takes the QR's batch whatever is typed).
 */
export function intakeBodyOf(draft: IntakeDraft, door: Door, fixedBatch: string | null = null): IntakeBody {
  const injured = draft.injured
  const words = sendsInjuryWords(draft)
  const reporter = door === 'portal' ? null : { name: text(draft.name), email: text(draft.email), phone: text(draft.phone) }
  return {
    serial: text(draft.serial),
    batchNumber: fixedBatch ?? text(draft.batchNumber),
    size: text(draft.size),
    occurredOn: draft.occurredOn === '' ? null : draft.occurredOn,
    place: text(draft.place),
    whatHappened: draft.whatHappened.trim(),
    wornAsIntended: draft.worn === 'yes' ? true : draft.worn === 'no' ? false : null,
    accident: draft.accident,
    injured,
    injuryConsent: injured === true && draft.consent ? true : null,
    injuryWords: words ? draft.injuryWords.trim() : null,
    reporter: reporter && (reporter.name || reporter.email || reporter.phone) ? reporter : null,
  }
}

/** The fields of the form (where a problem is shown). */
export const INTAKE_FIELDS = ['serial', 'batchNumber', 'size', 'whatHappened', 'occurredOn', 'place', 'injured', 'consent', 'injuryWords', 'name', 'email', 'phone'] as const
export type IntakeField = (typeof INTAKE_FIELDS)[number]

/** A field's problem, as a key of the catalogue. */
export type FieldProblems = Partial<Record<IntakeField, string>>

/** The API's issue path → the form's field. */
const FIELD_OF: Readonly<Record<string, IntakeField>> = Object.freeze({
  'body/serial': 'serial',
  'body/batchNumber': 'batchNumber',
  'body/size': 'size',
  'body/whatHappened': 'whatHappened',
  'body/occurredOn': 'occurredOn',
  'body/place': 'place',
  'body/injured': 'injured',
  'body/injuryConsent': 'consent',
  'body/injuryWords': 'injuryWords',
  'body/reporter/name': 'name',
  'body/reporter/email': 'email',
  'body/reporter/phone': 'phone',
})

/** The key a field's problem is said with (the draft tells which of the rule's sentences it was). */
export function problemKeyOf(field: IntakeField, draft: IntakeDraft, door: Door): string {
  switch (field) {
    case 'whatHappened':
      return draft.whatHappened.trim() === '' ? 'problem.whatHappened' : 'problem.whatHappenedLong'
    case 'serial':
      return door !== 'office' && draft.serial.trim() === '' && draft.batchNumber.trim() === '' ? 'problem.serialOrBatch' : 'problem.label'
    case 'occurredOn':
      return draft.occurredOn === '' ? 'problem.occurredOnNeeded' : 'problem.occurredOnFuture'
    case 'place':
      return draft.place.trim() === '' ? 'problem.placeNeeded' : 'problem.placeLine'
    case 'batchNumber':
      return 'problem.label'
    case 'size':
      return 'problem.size'
    case 'injured':
      return 'problem.injured'
    case 'consent':
      return 'problem.consent'
    case 'injuryWords':
      return draft.injured !== true ? 'problem.injuryNotHurt' : 'problem.injuryWords'
    case 'name':
      return 'problem.name'
    case 'email':
      return 'problem.email'
    case 'phone':
      return 'problem.phone'
  }
}

/** factory-domain's facts of a draft (what the API checks), the QR's batch counted as given. */
export function factsOf(draft: IntakeDraft, door: Door, fixedBatch: string | null = null): IntakeFacts {
  return intakeBodyOf(draft, door, fixedBatch)
}

/**
 * The form's problems before it is sent, field by field (factory-domain's `intakeProblems`: outside, whether anyone was hurt
 * and the serial or batch are required; an accident or anyone hurt asks the day and the place).
 */
export function intakeFieldProblems(draft: IntakeDraft, door: Door, today: string, fixedBatch: string | null = null): FieldProblems {
  const problems: FieldProblems = {}
  for (const issue of intakeProblems(factsOf(draft, door, fixedBatch), today, door !== 'office')) {
    const field = FIELD_OF[issue.path]
    if (field && !problems[field]) problems[field] = problemKeyOf(field, draft, door)
  }
  return problems
}

/** The fields an API refusal names (400 `body/<field>`), in the form's keys. */
export function refusedFields(error: unknown, draft: IntakeDraft, door: Door): FieldProblems {
  if (!isApiError(error)) return {}
  const problems: FieldProblems = {}
  for (const issue of error.issues) {
    const field = FIELD_OF[issuePath(issue)]
    if (field && !problems[field]) problems[field] = problemKeyOf(field, draft, door)
  }
  return problems
}

/** Why a send failed, as a key of the catalogue: the door closed (`held/OFF`), a wait, an unknown code, the form, or a failure. */
export type SendRefusal = { key: string; waitSeconds: number | null; fields: FieldProblems; challenge: boolean }

export function sendRefusalOf(error: unknown, draft: IntakeDraft, door: Door): SendRefusal {
  const none = { waitSeconds: null, fields: {}, challenge: false }
  if (!isApiError(error)) return { key: 'refused.failed', ...none }
  const paths = error.issues.map(issuePath)
  if (paths.includes('held/OFF')) return { key: door === 'portal' ? 'refused.offPortal' : 'refused.off', ...none }
  if (error.kind === 'rate_limited') {
    if (paths.includes('challenge')) return { key: 'refused.check', ...none, challenge: true }
    const seconds = Number(error.issues.find((issue) => issuePath(issue) === 'retryAfter')?.message)
    return { key: 'refused.wait', ...none, waitSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60 }
  }
  if (error.kind === 'invalid') {
    const fields = refusedFields(error, draft, door)
    return { key: Object.keys(fields).length > 0 ? 'refused.fields' : 'refused.failed', ...none, fields }
  }
  if (error.kind === 'not_found') return { key: door === 'public' ? 'refused.unknownCode' : 'refused.failed', ...none }
  if (error.kind === 'forbidden') return { key: 'refused.forbidden', ...none }
  if (error.kind === 'unavailable') return { key: 'refused.network', ...none }
  return { key: 'refused.failed', ...none }
}

/** The wait in words' units: seconds under a minute, else whole minutes rounded up. */
export function waitOf(seconds: number): { unit: 'seconds' | 'minutes'; count: number } {
  return seconds < 60 ? { unit: 'seconds', count: Math.max(1, seconds) } : { unit: 'minutes', count: Math.ceil(seconds / 60) }
}

/** Something typed (close asks Discard / Stay first). */
export function intakeDirty(draft: IntakeDraft): boolean {
  return (Object.keys(EMPTY_INTAKE) as (keyof IntakeDraft)[]).some((key) => draft[key] !== EMPTY_INTAKE[key])
}

/** A change to the draft, with what the change implies (no consent without anyone hurt; no hurt, no words). */
export function patchIntake(draft: IntakeDraft, patch: Partial<IntakeDraft>): IntakeDraft {
  const next = { ...draft, ...patch }
  if (next.injured !== true) return { ...next, consent: false }
  return next
}

export const PHOTO_MAX = SAFETY_LIMITS.photos
export const LIMITS = Object.freeze({ whatHappened: SAFETY_LIMITS.whatHappened, injuryWords: SAFETY_LIMITS.injuryWords, place: SAFETY_LIMITS.place, label: SAFETY_LIMITS.label, size: SAFETY_LIMITS.size, name: SAFETY_LIMITS.reporterName, email: SAFETY_LIMITS.email })

/** Today in Rome (the site's day), `YYYY-MM-DD`: the latest day a report may name. */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
