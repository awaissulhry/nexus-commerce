import { createHash } from 'node:crypto'
import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { addDays, daysBetween, DUE_SOON_DAYS } from '../calendar/rules'
import { inForce, normalName, sameName, type SafetyRole } from '../organisation/rules'

/**
 * The risk assessment, the DVR (B-W2b-122; QHS-230 "DVR document with versions and certain date", QHS-234 "Improvement plan
 * from the DVR"; design plant.risk: Assessments, the record's Versions and Improvement plan tabs, the pop-ups New DVR version,
 * Sign version and Add measure), pure. The tables are factory-db safety.prisma's RiskAssessment, RiskAssessmentVersion,
 * RiskAssessmentSignature (append-only) and RiskMeasure (B-W2b-87); its guards hold the same shape for every login.
 *
 * The consultant keeps the DVR today (SCOPE QHS-230): a version freezes the consultant's PDF with its SHA-256 and the time,
 * and is signed by the employer and, for the proof of its date, by the RSPP, the RLS (or territorial RLS) and the
 * occupational doctor the company has; the certain date is the day of the last of those signatures. A frozen version never
 * changes: a change is a new version. Superseded versions stay; the newest SIGNED one is in force. Structured hazards stay
 * Later. The law is named in words only as the plan and the design name it (D.Lgs. 81/2008 artt. 28-29; art. 28 c.2 for the
 * versions, art. 28 c.2 c-d for the plan, art. 29 c.3 for the review); no interval or deadline of a law is built in: the next
 * review is the day a person sets.
 */

export const DVR_LAW = 'D.Lgs. 81/2008 artt. 28-29'
export const VERSIONS_LAW = 'D.Lgs. 81/2008 art. 28 c.2'
export const PLAN_LAW = 'D.Lgs. 81/2008 art. 28 c.2 c-d'
export const REVIEW_LAW = 'D.Lgs. 81/2008 art. 29 c.3'

/** Who signs a version (factory-db's guard: the employer always; of RSPP, RLS or RLST, DOCTOR those the company has). */
export const DVR_SIGNER_ROLES = ['EMPLOYER', 'RSPP', 'RLS', 'RLST', 'DOCTOR'] as const satisfies readonly SafetyRole[]
export type DvrSignerRole = (typeof DVR_SIGNER_ROLES)[number]
export const DVR_AUTHOR_KINDS = ['CONSULTANT', 'IN_HOUSE'] as const
export type DvrAuthorKind = (typeof DVR_AUTHOR_KINDS)[number]
export const DVR_VERSION_STATUSES = ['AWAITING_SIGNATURES', 'SIGNED', 'WITHDRAWN'] as const
export type DvrVersionStatus = (typeof DVR_VERSION_STATUSES)[number]
/**
 * How a signature was given (factory-db SafetySignMethod). This step writes OFFICE and PAPER; FLOOR_PIN is read. LINK
 * (B-W2b-F13b, wave 23): an outside signer approved our approval request on the version (modules/safety/risk
 * signature-link.ts writes it when the answer settles); a DVR signature only — the other registers never take LINK
 * (safety/records/rules.ts SIGN_METHODS).
 */
export const DVR_SIGN_METHODS = ['OFFICE', 'FLOOR_PIN', 'PAPER', 'LINK'] as const
export type DvrSignMethod = (typeof DVR_SIGN_METHODS)[number]

export const MEASURE_STATUSES = ['PLANNED', 'IN_PROGRESS', 'DONE', 'VERIFIED', 'CANCELLED'] as const
export type MeasureStatus = (typeof MEASURE_STATUSES)[number]
export const OPEN_MEASURE_STATUSES: readonly MeasureStatus[] = Object.freeze(['PLANNED', 'IN_PROGRESS'])
export const MEASURE_SOURCES = ['DVR', 'INCIDENT', 'INSPECTION', 'MEETING', 'OTHER'] as const
export type MeasureSource = (typeof MEASURE_SOURCES)[number]
/**
 * The record a measure may name as its source: an INCIDENT always its Incident (B-W2b-91's protected schema: only its id,
 * site and number are read); an inspection, a meeting or another source may name the typed deadline of the safety calendar
 * it came from (the periodic meeting, an inspection). A DVR measure names its version, never a record.
 */
export const MEASURE_RECORD_TYPES: Readonly<Record<MeasureSource, readonly string[]>> = Object.freeze({
  DVR: [],
  INCIDENT: ['Incident'],
  INSPECTION: ['SafetyDeadline'],
  MEETING: ['SafetyDeadline'],
  OTHER: ['SafetyDeadline'],
})

export const RISK_LIMITS = Object.freeze({
  name: 200,
  label: 60,
  author: 200,
  summary: 2000,
  title: 300,
  risk: 300,
  note: 2000,
  reason: 500,
  evidence: 2000,
  signerName: 200,
  roleSheets: 50,
  /** Minor units: the largest cost one measure takes. */
  cost: 2_000_000_000,
  list: 500,
  /** A day typed (a review, a due date) is at most this many days ahead: a typing guard, not a law's interval. */
  daysAhead: 3660,
})

export const RISK_REFUSALS = [
  'SITE_OTHER_COMPANY',
  'NAME_TAKEN',
  'ARCHIVED',
  'DUE_TOO_FAR',
  'FILE_NOT_READY',
  'NOT_PDF',
  'FROZEN_ALREADY',
  'VERSION_WAITING',
  'NO_EMPLOYER',
  'NOT_AWAITING',
  'NOT_SIGNED',
  'NOT_A_SIGNER',
  'SIGNED_ALREADY',
  'NO_APPOINTMENT',
  'SIGNED_IN_FUTURE',
  'SIGNED_BEFORE_FROZEN',
  'NAME_MISMATCH',
  'NOT_THE_SIGNER',
  'SAME_PERSON',
  'SCAN_MISSING',
  'ROLE_SHEET_OTHER_SITE',
  'OWNER_NOT_ALLOWED',
  'VERSION_OTHER_ASSESSMENT',
  'SOURCE_NOT_FOUND',
  'MEASURE_FINAL',
  'BAD_MOVE',
] as const
export type RiskRefusalCode = (typeof RISK_REFUSALS)[number]
export interface RiskRefusal {
  readonly code: RiskRefusalCode
  readonly message: string
  readonly field?: string
}

/** The roles in words, as the organisation chart says them (the refusals' sentences). */
export const SIGNER_WORDS: Readonly<Record<DvrSignerRole, string>> = Object.freeze({
  EMPLOYER: 'the employer',
  RSPP: 'the RSPP',
  RLS: 'the RLS',
  RLST: 'the territorial RLS',
  DOCTOR: 'the occupational doctor',
})

// ---- signatures ----------------------------------------------------------------------------------------------------------

/** The signature's key in factory-db (unique): one per role per version. */
export const dvrSignatureKey = (versionId: string, role: DvrSignerRole): string => `signature:${versionId}:${role}`

/**
 * The id a version's signature for a role has (and has before it is given): a UUID made from its key (RFC 9562 version 8,
 * SHA-256 of the key), so a signed paper's scan is uploaded as a file of the signature (record type RiskAssessmentSignature)
 * before the signature is recorded, as a paper signature needs (B-W2b-120's rule: the scan is on file first).
 */
export function dvrSignatureId(versionId: string, role: DvrSignerRole): string {
  const hex = createHash('sha256').update(`factory.dvr-signature|${dvrSignatureKey(versionId, role)}`).digest('hex')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** An appointment of the safety organisation as the signers read it. */
export interface SignerAppointment {
  readonly id: string
  readonly role: SafetyRole
  readonly siteId: string | null
  readonly fromDate: BusinessDate
  readonly untilDate: BusinessDate | null
  readonly employeeId: string | null
  readonly outsideName: string | null
  /** The appointee's name (a person of the company, or the outside contact's). */
  readonly name: string
}

/** Who a person is, for "nobody signs twice": a person of the company by id, an outside contact by name (loosely). */
export const personKeyOf = (appointee: { readonly employeeId: string | null; readonly outsideName: string | null }): string =>
  appointee.employeeId ? `employee:${appointee.employeeId}` : `outside:${normalName(appointee.outsideName ?? '')}`

/** The appointments that hold a role at a site on a day: in force, of the site or the whole company (the site's first). */
export function holdersOf(appointments: readonly SignerAppointment[], role: SafetyRole, siteId: string, day: BusinessDate): SignerAppointment[] {
  return appointments
    .filter((appointment) => appointment.role === role && (appointment.siteId === null || appointment.siteId === siteId) && inForce(appointment, day))
    .sort((a, b) => Number(a.siteId === null) - Number(b.siteId === null) || a.fromDate.localeCompare(b.fromDate) || a.id.localeCompare(b.id))
}

export interface Signer {
  readonly role: DvrSignerRole
  readonly appointmentId: string
  readonly name: string
}

export interface SignersPlan {
  /** Who signs a version frozen now, in the design's order: employer, RSPP, RLS (or RLST), doctor. */
  readonly signers: readonly Signer[]
  /** A role held by a person who signs already under an earlier role (the employer acting as RSPP): signed once. */
  readonly sameAs: readonly { readonly role: DvrSignerRole; readonly as: DvrSignerRole; readonly name: string }[]
  /** No employer in force: no version can be frozen (the employer signs every version). */
  readonly missingEmployer: boolean
}

/**
 * The signers of a new version of a site's assessment, from the safety organisation in force today: the employer always,
 * then the RSPP, the RLS (a territorial RLS where the company has no RLS) and the occupational doctor where one is
 * appointed. Nobody signs twice: a role whose holder signs already under an earlier role is left out (named in `sameAs`).
 */
export function signersFor(appointments: readonly SignerAppointment[], siteId: string, today: BusinessDate): SignersPlan {
  const signers: Signer[] = []
  const sameAs: { role: DvrSignerRole; as: DvrSignerRole; name: string }[] = []
  const persons = new Map<string, DvrSignerRole>()
  const rls = holdersOf(appointments, 'RLS', siteId, today).length > 0 ? 'RLS' : 'RLST'
  for (const role of ['EMPLOYER', 'RSPP', rls, 'DOCTOR'] as const) {
    const holders = holdersOf(appointments, role, siteId, today)
    if (holders.length === 0) continue
    const holder = holders.find((candidate) => !persons.has(personKeyOf(candidate)))
    if (!holder) {
      sameAs.push({ role, as: persons.get(personKeyOf(holders[0]!))!, name: holders[0]!.name })
      continue
    }
    persons.set(personKeyOf(holder), role)
    signers.push({ role, appointmentId: holder.id, name: holder.name })
  }
  return { signers, sameAs, missingEmployer: !signers.some((signer) => signer.role === 'EMPLOYER') }
}

/** Every listed signer signed: the version is SIGNED, its certain date the day of the last of those signatures. */
export function completion(signersRequired: readonly DvrSignerRole[], signatures: readonly { readonly role: DvrSignerRole; readonly signedOn: BusinessDate }[]): { readonly complete: boolean; readonly missing: DvrSignerRole[]; readonly certainDateOn: BusinessDate | null } {
  const ofSigners = signatures.filter((signature) => signersRequired.includes(signature.role))
  const missing = signersRequired.filter((role) => !ofSigners.some((signature) => signature.role === role))
  const complete = missing.length === 0 && signersRequired.length > 0
  return { complete, missing, certainDateOn: complete ? ofSigners.map((signature) => signature.signedOn).sort().at(-1)! : null }
}

export interface SignatureFacts {
  readonly status: DvrVersionStatus
  readonly signersRequired: readonly DvrSignerRole[]
  /** The signatures given so far, each with who signed (person keys: the appointee, and the office user for OFFICE). */
  readonly signed: readonly { readonly role: DvrSignerRole; readonly name: string; readonly persons: readonly string[] }[]
  readonly role: DvrSignerRole
  readonly method: 'OFFICE' | 'PAPER'
  readonly signerName: string
  readonly signedOn: BusinessDate
  readonly today: BusinessDate
  /** The day the version was frozen (Europe/Rome). */
  readonly frozenOn: BusinessDate
  /** The appointment held for the role on the day, with who it is (null: none in force, or not one of the role's). */
  readonly appointment: { readonly name: string; readonly persons: readonly string[] } | null
  /** OFFICE: the signed-in person is the appointee (their linked person, else their own name). */
  readonly isTheSigner: boolean
  /** PAPER: the signed paper's scan is a file of the signature already. */
  readonly scanOnFile: boolean
}

/** Whether this signature may be recorded now (null: it may), in the order a person fixes them. */
export function signatureRefusal(facts: SignatureFacts): RiskRefusal | null {
  if (facts.status !== 'AWAITING_SIGNATURES') return { code: 'NOT_AWAITING', message: facts.status === 'SIGNED' ? 'This version is signed by every signer already: a change is a new version.' : 'This version was withdrawn: it takes no more signatures.' }
  if (!facts.signersRequired.includes(facts.role)) return { code: 'NOT_A_SIGNER', message: `This version is not signed by ${SIGNER_WORDS[facts.role]}: its signers are ${facts.signersRequired.map((role) => SIGNER_WORDS[role]).join(', ')}.`, field: 'role' }
  const done = facts.signed.find((signature) => signature.role === facts.role)
  if (done) return { code: 'SIGNED_ALREADY', message: `${capital(SIGNER_WORDS[facts.role])} signed this version already (${done.name}); a signature is written once.`, field: 'role' }
  if (!facts.appointment) return { code: 'NO_APPOINTMENT', message: `Nobody holds the role of ${SIGNER_WORDS[facts.role]} here on that day: appoint them in the safety organisation first.`, field: 'appointmentId' }
  if (facts.signedOn > facts.today) return { code: 'SIGNED_IN_FUTURE', message: 'A signature is dated today or before.', field: 'signedOn' }
  if (facts.signedOn < facts.frozenOn) return { code: 'SIGNED_BEFORE_FROZEN', message: 'A signature is dated on or after the day the version was frozen.', field: 'signedOn' }
  if (!sameName(facts.signerName, facts.appointment.name)) return { code: 'NAME_MISMATCH', message: `The name signed is not the name of ${SIGNER_WORDS[facts.role]} (${facts.appointment.name}).`, field: 'signerName' }
  if (facts.method === 'OFFICE' && !facts.isTheSigner) return { code: 'NOT_THE_SIGNER', message: `In the office you sign only for a role you hold: ${SIGNER_WORDS[facts.role]} here is ${facts.appointment.name}. Record their signed paper instead.` }
  const twice = facts.signed.find((signature) => signature.persons.some((person) => facts.appointment!.persons.includes(person)))
  if (twice) return { code: 'SAME_PERSON', message: `${twice.name} signed this version already as ${SIGNER_WORDS[twice.role]}: nobody signs a version twice.` }
  if (facts.method === 'PAPER' && !facts.scanOnFile) return { code: 'SCAN_MISSING', message: 'Upload the signed paper first: a paper signature is recorded with its scan.' }
  return null
}

const capital = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1)

// ---- versions ------------------------------------------------------------------------------------------------------------

export interface FreezeFacts {
  readonly archived: boolean
  /** A version still waiting for its signatures (only one waits at a time). */
  readonly waiting: { readonly label: string } | null
  /** The PDF named: an AVAILABLE file of this assessment and company (null: not found as one). */
  readonly file: { readonly status: string; readonly contentType: string } | null
  /** An earlier version froze the same PDF (the same SHA-256). */
  readonly frozenAlready: { readonly label: string } | null
  readonly missingEmployer: boolean
}

/** Whether a new version may be frozen now (null: it may). */
export function freezeRefusal(facts: FreezeFacts): RiskRefusal | null {
  if (facts.archived) return { code: 'ARCHIVED', message: 'This assessment is archived: it takes no new version.' }
  if (facts.waiting) return { code: 'VERSION_WAITING', message: `Version ${facts.waiting.label} still waits for its signatures: have it signed, or withdraw it, before freezing another.` }
  if (!facts.file || facts.file.status !== 'AVAILABLE') return { code: 'FILE_NOT_READY', message: "Upload the consultant's PDF to this assessment first; it is frozen once the upload is complete.", field: 'fileId' }
  if (facts.file.contentType !== 'application/pdf') return { code: 'NOT_PDF', message: 'A DVR version freezes a PDF.', field: 'fileId' }
  if (facts.frozenAlready) return { code: 'FROZEN_ALREADY', message: `This PDF is frozen already as version ${facts.frozenAlready.label}: a new version is a changed document.`, field: 'fileId' }
  if (facts.missingEmployer) return { code: 'NO_EMPLOYER', message: 'Name the employer in the safety organisation first: the employer signs every version.' }
  return null
}

/** Withdrawing a version (null: it may be). */
export function withdrawRefusal(status: DvrVersionStatus): RiskRefusal | null {
  return status === 'AWAITING_SIGNATURES' ? null : { code: 'NOT_AWAITING', message: status === 'SIGNED' ? 'A signed version is never withdrawn: it stays as the record of its date; a change is a new version.' : 'This version is withdrawn already.' }
}

/** The version's shape before it is frozen (the paths are body fields). */
export function versionProblems(input: { readonly label: string; readonly authorName: string; readonly changeSummary?: string | null | undefined }): Issue[] {
  const problems: Issue[] = []
  if (input.label.trim() === '' || input.label.trim().length > RISK_LIMITS.label) problems.push({ path: 'label', message: `A version has a label ("v4", "2026 review") of at most ${RISK_LIMITS.label} characters.` })
  if (input.authorName.trim() === '' || input.authorName.trim().length > RISK_LIMITS.author) problems.push({ path: 'authorName', message: `Name the consultant or the in-house author (at most ${RISK_LIMITS.author} characters).` })
  if (input.changeSummary !== undefined && input.changeSummary !== null && input.changeSummary.trim().length > RISK_LIMITS.summary) problems.push({ path: 'changeSummary', message: `A summary has at most ${RISK_LIMITS.summary} characters.` })
  return problems
}

/** A day typed for later (a review, a measure's due date): at most RISK_LIMITS.daysAhead days ahead. */
export function farRefusal(day: BusinessDate | null | undefined, today: BusinessDate, field: string): RiskRefusal | null {
  return day && day > addDays(today, RISK_LIMITS.daysAhead) ? { code: 'DUE_TOO_FAR', message: `A day is at most ${RISK_LIMITS.daysAhead} days ahead.`, field } : null
}

// ---- the improvement plan ------------------------------------------------------------------------------------------------

export interface MeasureInput {
  readonly title?: string | undefined
  readonly risk?: string | null | undefined
  readonly roleSheetIds?: readonly string[] | undefined
  readonly cost?: number | null | undefined
  readonly source?: MeasureSource | undefined
  readonly versionId?: string | null | undefined
  readonly sourceRecordType?: string | null | undefined
  readonly sourceRecordId?: string | null | undefined
}

/** A measure's own shape (the paths are body fields). */
export function measureProblems(input: MeasureInput): Issue[] {
  const problems: Issue[] = []
  if (input.title !== undefined && (input.title.trim() === '' || input.title.trim().length > RISK_LIMITS.title)) problems.push({ path: 'title', message: `A measure says what is to be done, in at most ${RISK_LIMITS.title} characters.` })
  if (input.risk !== undefined && input.risk !== null && input.risk.trim().length > RISK_LIMITS.risk) problems.push({ path: 'risk', message: `The risk or area has at most ${RISK_LIMITS.risk} characters.` })
  if (input.roleSheetIds !== undefined && (new Set(input.roleSheetIds).size !== input.roleSheetIds.length || input.roleSheetIds.length > RISK_LIMITS.roleSheets)) problems.push({ path: 'roleSheetIds', message: `Each role at most once (at most ${RISK_LIMITS.roleSheets}).` })
  if (input.cost !== undefined && input.cost !== null && (!Number.isInteger(input.cost) || input.cost < 0 || input.cost > RISK_LIMITS.cost)) problems.push({ path: 'cost', message: 'A cost is a whole amount in minor units, from 0.' })
  if (input.source !== undefined) {
    const types = MEASURE_RECORD_TYPES[input.source]
    const type = input.sourceRecordType ?? null
    const id = input.sourceRecordId ?? null
    if ((type === null) !== (id === null)) problems.push({ path: type === null ? 'sourceRecordType' : 'sourceRecordId', message: 'A source record is named by its type and its id together.' })
    else if (type !== null && !types.includes(type)) problems.push({ path: 'sourceRecordType', message: types.length === 0 ? 'A measure from the DVR names its version, not a record.' : `A measure from this source names a ${types.join(' or ')}.` })
    if (input.source === 'INCIDENT' && type === null) problems.push({ path: 'sourceRecordId', message: 'A measure from an incident names the incident.' })
    if (input.source !== 'DVR' && input.versionId) problems.push({ path: 'versionId', message: 'Only a measure from the DVR names a version.' })
  }
  return problems
}

/** The moves a measure makes (factory-db's guard): PLANNED ↔ IN_PROGRESS, either → DONE | CANCELLED, DONE → VERIFIED | IN_PROGRESS. */
export const MEASURE_MOVES: Readonly<Record<MeasureStatus, readonly MeasureStatus[]>> = Object.freeze({
  PLANNED: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
  IN_PROGRESS: ['PLANNED', 'DONE', 'CANCELLED'],
  DONE: ['VERIFIED', 'IN_PROGRESS'],
  VERIFIED: [],
  CANCELLED: [],
})
/** What the measure's owner moves without safety.risk.manage: started, back to planned, done, and back from done. */
export const OWNER_MOVES: readonly MeasureStatus[] = Object.freeze(['PLANNED', 'IN_PROGRESS', 'DONE'])

export const isFinal = (status: MeasureStatus): boolean => status === 'VERIFIED' || status === 'CANCELLED'

/** The states a caller may move a measure to now: a manager every allowed move, its owner the owner's moves, others none. */
export function movesFor(status: MeasureStatus, who: { readonly manager: boolean; readonly owner: boolean }): MeasureStatus[] {
  if (who.manager) return [...MEASURE_MOVES[status]]
  return who.owner ? MEASURE_MOVES[status].filter((to) => OWNER_MOVES.includes(to)) : []
}

/** A move of a measure (null: it may be made). */
export function moveRefusal(from: MeasureStatus, to: MeasureStatus): RiskRefusal | null {
  if (isFinal(from)) return { code: 'MEASURE_FINAL', message: `This measure is ${from === 'VERIFIED' ? 'verified' : 'cancelled'}: only its note changes.` }
  if (!MEASURE_MOVES[from].includes(to)) return { code: 'BAD_MOVE', message: `A measure ${from === 'DONE' ? 'done is verified, or goes back in progress' : 'not done yet is started, planned again, done or cancelled'}.`, field: 'status' }
  return null
}

/** Where a measure stands today: late, due within 30 days, later, done (or verified), cancelled; null: open with no due day. */
export type MeasureDueState = 'OVERDUE' | 'DUE_SOON' | 'PLANNED' | 'DONE' | 'CANCELLED'
export function measureDueState(measure: { readonly status: MeasureStatus; readonly dueOn: BusinessDate | null }, today: BusinessDate): MeasureDueState | null {
  if (measure.status === 'DONE' || measure.status === 'VERIFIED') return 'DONE'
  if (measure.status === 'CANCELLED') return 'CANCELLED'
  if (measure.dueOn === null) return null
  if (measure.dueOn < today) return 'OVERDUE'
  return daysBetween(today, measure.dueOn) <= DUE_SOON_DAYS ? 'DUE_SOON' : 'PLANNED'
}

/** The next review's state: late, within 30 days, later; null: no day set. */
export function reviewState(nextReviewOn: BusinessDate | null, today: BusinessDate): 'OVERDUE' | 'DUE_SOON' | 'PLANNED' | null {
  if (nextReviewOn === null) return null
  if (nextReviewOn < today) return 'OVERDUE'
  return daysBetween(today, nextReviewOn) <= DUE_SOON_DAYS ? 'DUE_SOON' : 'PLANNED'
}

/**
 * "Open measures over time" (the plan tab's burn-down): how many measures were open at the end of each step from `from` to
 * `to` (both included, the last point is `to`). A measure is open from the day it was added until the day it was done or
 * cancelled (a measure sent back from done counts as open throughout: its done day is cleared).
 */
export function burnDown(measures: readonly { readonly addedOn: BusinessDate; readonly closedOn: BusinessDate | null }[], from: BusinessDate, to: BusinessDate, stepDays = 7): { on: BusinessDate; open: number }[] {
  const points: { on: BusinessDate; open: number }[] = []
  const days: BusinessDate[] = []
  for (let day = to; day >= from; day = addDays(day, -stepDays)) days.unshift(day)
  for (const on of days) points.push({ on, open: measures.filter((measure) => measure.addedOn <= on && (measure.closedOn === null || measure.closedOn > on)).length })
  return points
}
