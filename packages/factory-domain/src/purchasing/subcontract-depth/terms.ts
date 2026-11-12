import type { Issue } from '../../core/errors'
import { businessDate, type BusinessDate } from '../../core/time'

/**
 * The written terms with a workshop (B-W2b-331; SCM-049; L. 192/1998 art. 2: a subcontract is made in writing; factory-db
 * suppliers-depth.prisma SubcontractAgreement, B-W2b-287). Pure: per company and workshop a numbered revision with its
 * title, the days it covers and its signed file. DRAFT while written (its terms change; it may be deleted) → SIGNED (both
 * sides signed: title, file, signature and days are fixed; one SIGNED per company and workshop) → SUPERSEDED by the next
 * revision, signed in the same act, or TERMINATED with why. The database holds the same rules
 * (…_suppliers_depth_w2b_guards); these say them first, in words.
 *
 * Every subcontract order is linked to the terms that covered it: the signed revision (SIGNED, or SUPERSEDED or
 * TERMINATED later) of its company and workshop whose days hold the order's date and that had not ended before it. There
 * is no column on the order: the link is read from the order's date (B-W2b-287's note; a frozen link is a schema need).
 * An order without covering terms is not refused (today's terms are on paper); its record says so in words.
 */

export const AGREEMENT_STATUSES = ['DRAFT', 'SIGNED', 'SUPERSEDED', 'TERMINATED'] as const
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number]

/** The workshop must have the terms in writing: what the order's record says when none covers it. */
export const LAW = 'L. 192/1998 art. 2'

/** Titles are one line of 1 to 200 characters; reasons 1 to 2000 (the database's). */
export const TITLE_MAX = 200
export const REASON_MAX = 2000

/** Terms expiring within this many days are flagged on the order and the workshop's list. */
export const EXPIRING_DAYS = 30

export interface AgreementFacts {
  readonly id: string
  readonly revision: number
  readonly status: AgreementStatus
  readonly title: string
  readonly validFrom: BusinessDate
  readonly validUntil: BusinessDate | null
  readonly signedAt: Date | null
  readonly endedAt: Date | null
  readonly termsFileId: string | null
}

const isSigned = (agreement: AgreementFacts): boolean => agreement.status !== 'DRAFT' && agreement.signedAt !== null

/** The day before `day`. */
const dayBefore = (day: BusinessDate): BusinessDate => new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)
const earliest = (a: BusinessDate | null, b: BusinessDate | null): BusinessDate | null => (a === null ? b : b === null ? a : a < b ? a : b)

/**
 * The last day a signed revision covers (null: open-ended): its own last day, and
 *   SUPERSEDED  the day before its successor (the next signed revision) starts: the old terms stay in force until the new
 *               ones begin, even when the new ones were signed in advance (without a successor on record: the day before it
 *               ended)
 *   TERMINATED  the day before it ended (an agreement ended on a day no longer covers that day)
 */
export function coversUntil(agreement: AgreementFacts, agreements: readonly AgreementFacts[]): BusinessDate | null {
  if (agreement.status === 'SUPERSEDED') {
    const successor = agreements.filter((other) => isSigned(other) && other.revision > agreement.revision).sort((a, b) => a.revision - b.revision)[0]
    const end = successor ? dayBefore(successor.validFrom) : agreement.endedAt ? dayBefore(businessDate(agreement.endedAt)) : null
    return earliest(agreement.validUntil, end)
  }
  if (agreement.status === 'TERMINATED' && agreement.endedAt) return earliest(agreement.validUntil, dayBefore(businessDate(agreement.endedAt)))
  return agreement.validUntil
}

/** The terms that covered an order of `day`: a signed revision whose days hold the day (coversUntil); the highest revision first. */
export function inForceOn(agreements: readonly AgreementFacts[], day: BusinessDate): AgreementFacts | null {
  const covering = agreements
    .filter(isSigned)
    .filter((agreement) => {
      const until = coversUntil(agreement, agreements)
      return agreement.validFrom <= day && (until === null || day <= until)
    })
    .sort((a, b) => b.revision - a.revision)
  return covering[0] ?? null
}

/** The next revision's number: one above every revision the company has with the workshop. */
export const nextRevision = (agreements: readonly Pick<AgreementFacts, 'revision'>[]): number => agreements.reduce((top, agreement) => Math.max(top, agreement.revision), 0) + 1

/** Whole days from `from` to `to` (calendar days, either sign). */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const at = (day: BusinessDate) => Date.UTC(Number.parseInt(day.slice(0, 4), 10), Number.parseInt(day.slice(5, 7), 10) - 1, Number.parseInt(day.slice(8, 10), 10))
  return Math.round((at(to) - at(from)) / 86_400_000)
}

/** Why an order of `day` has no written terms, in words, or null when terms cover it. */
export function termsWords(agreements: readonly AgreementFacts[], day: BusinessDate, workshop: string): string | null {
  if (inForceOn(agreements, day)) return null
  const draft = agreements.find((agreement) => agreement.status === 'DRAFT')
  const signed = agreements.filter(isSigned)
  const base = `No signed written terms with ${workshop} cover ${day} (${LAW} asks for the subcontract in writing).`
  if (draft) return `${base} Revision ${draft.revision} is written and waits for its signature.`
  if (signed.length === 0) return `${base} Write them under the workshop's written terms and sign them.`
  return `${base} The signed terms cover other days: write a new revision for these.`
}

/** The terms in force expire within EXPIRING_DAYS of `today` (null: open-ended or not in force). */
export function expiresInDays(agreement: AgreementFacts | null, today: BusinessDate): number | null {
  if (!agreement || agreement.validUntil === null || agreement.status !== 'SIGNED') return null
  const days = daysBetween(today, agreement.validUntil)
  return days <= EXPIRING_DAYS ? days : null
}

const words = (value: string | null | undefined, max: number): boolean => value !== null && value !== undefined && value.trim().length >= 1 && value.trim().length <= max
const oneLine = (value: string): boolean => !/[\r\n]/.test(value)

/** A draft's title and days (path `body/…`). */
export function draftProblems(input: { readonly title?: string | undefined; readonly validFrom?: BusinessDate | undefined; readonly validUntil?: BusinessDate | null | undefined }): Issue[] {
  const problems: Issue[] = []
  if (input.title !== undefined && (!words(input.title, TITLE_MAX) || !oneLine(input.title))) problems.push({ path: 'body/title', message: `The title is one line of 1 to ${TITLE_MAX} characters.` })
  if (input.validFrom !== undefined && input.validUntil !== undefined && input.validUntil !== null && input.validUntil < input.validFrom) {
    problems.push({ path: 'body/validUntil', message: 'The terms cover until a day not before their first day.' })
  }
  return problems
}

/** Why a revision's draft may not change or be deleted now, or null. */
export function draftHeld(agreement: Pick<AgreementFacts, 'status' | 'revision'>): string | null {
  return agreement.status === 'DRAFT' ? null : `Revision ${agreement.revision} is ${agreement.status.toLowerCase()}: its terms are fixed (write a new revision).`
}

export interface SignFacts {
  /** The signed file: AVAILABLE, a file of the agreement or of its workshop, of the agreement's company or tenant-wide. */
  readonly file: { readonly status: string; readonly companyId: string | null; readonly recordType: string; readonly recordId: string } | null
  readonly companyId: string
  readonly partyId: string
}

/** Why the revision may not be signed at `signedAt` (now `now`), with paths `body/…`. */
export function signProblems(agreement: AgreementFacts, signedAt: Date, facts: SignFacts, now: Date): Issue[] {
  const held = draftHeld(agreement)
  if (held) return [{ path: 'body/version', message: held }]
  const problems: Issue[] = []
  if (signedAt.getTime() > now.getTime()) problems.push({ path: 'body/signedAt', message: 'The terms were signed now or before, not later.' })
  const file = facts.file
  if (!file) problems.push({ path: 'body/termsFileId', message: 'Attach the signed terms (a file of this revision or of the workshop) first.' })
  else if (file.status !== 'AVAILABLE') problems.push({ path: 'body/termsFileId', message: 'The signed file is not available yet: finish its upload first.' })
  else if (file.companyId !== null && file.companyId !== facts.companyId) problems.push({ path: 'body/termsFileId', message: 'The signed file belongs to another company.' })
  else if (!((file.recordType === 'SubcontractAgreement' && file.recordId === agreement.id) || (file.recordType === 'Party' && file.recordId === facts.partyId))) {
    problems.push({ path: 'body/termsFileId', message: 'The signed file is a file of this revision or of its workshop.' })
  }
  return problems
}

/** Why the signed revision may not end at `endedAt` with `reason` (now `now`). */
export function terminateProblems(agreement: AgreementFacts, endedAt: Date, reason: string, now: Date): Issue[] {
  if (agreement.status !== 'SIGNED') return [{ path: 'body/version', message: `Revision ${agreement.revision} is ${agreement.status.toLowerCase()}: only the signed revision in force is ended.` }]
  const problems: Issue[] = []
  if (!words(reason, REASON_MAX)) problems.push({ path: 'body/reason', message: `Say why the terms end (1 to ${REASON_MAX} characters).` })
  if (endedAt.getTime() > now.getTime()) problems.push({ path: 'body/endedAt', message: 'The terms ended now or before, not later.' })
  if (agreement.signedAt && endedAt.getTime() < agreement.signedAt.getTime()) problems.push({ path: 'body/endedAt', message: 'The terms end after they were signed.' })
  return problems
}

/** The reason written on the revision a newer one supersedes. */
export const supersededReason = (revision: number, title: string): string => `Replaced by revision ${revision}: ${title}`.slice(0, REASON_MAX)
