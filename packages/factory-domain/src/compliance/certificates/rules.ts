import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { defineMachine, nextStates } from '../../state/machine'

/**
 * The EU type-examination certificate register (QHS-103, PRD-280; Reg. (EU) 2016/425 art. 8, Annex V; EN 17092): what a
 * certificate must say, how its status moves, and when it has expired. Pure: the API loads the facts, these rules
 * decide (the …_product_guards triggers hold the same rules in the database for every login).
 *
 *   DRAFT ──issue──▶ VALID ──suspend──▶ SUSPENDED ──reinstate──▶ VALID
 *     │                │ │                 │ │
 *     └──withdraw──────┼─┴──withdraw───────┘ └──(scheduler)──▶ EXPIRED
 *                      └──(scheduler: past its last valid day)──▶ EXPIRED
 *
 * WITHDRAWN and EXPIRED are final: a renewed or extended certificate is a new row (Annex V 7.4). A draft is typed in
 * and edited freely; once registered, nothing but its status moves.
 */

export const CERTIFICATE_STATUSES = ['DRAFT', 'VALID', 'SUSPENDED', 'WITHDRAWN', 'EXPIRED'] as const
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number]

/** The EN 17092 classes, from the most protective. */
export const EN17092_CLASSES = ['AAA', 'AA', 'A', 'B', 'C'] as const
export type En17092Class = (typeof EN17092_CLASSES)[number]

/** The part of EN 17092 that grants each class (part 1 holds the test methods and grants none). */
export const EN17092_PART_CLASS: Readonly<Record<string, En17092Class>> = Object.freeze({ '2': 'AAA', '3': 'AA', '4': 'A', '5': 'B', '6': 'C' })

/** EN 1621 impact protectors: performance level 1 or 2. */
export const EN1621_LEVELS = ['1', '2'] as const

/** A notified body's identification number in NANDO: four digits. */
export const NOTIFIED_BODY_NUMBER = /^\d{4}$/

/** Annex V 6.1: an EU type-examination certificate is valid for at most five years. */
export const MAX_VALIDITY_YEARS = 5

/** The days before the last valid day on which the scheduler warns (plan A1 cron: 90, 30 and 7 days). */
export const EXPIRY_WARNING_DAYS = [90, 30, 7] as const

/** A harmonised standard with its edition: "EN 17092-4:2020", "EN 1621-1:2012", "EN ISO 13688:2013+A1:2021". */
const STANDARD = /^(?:EN ISO|EN IEC|EN|ISO) \d{3,5}(?:-\d{1,2})*:\d{4}(?:\+A\d{1,2}:\d{4})*$/
const EN17092 = /^EN 17092-(\d{1,2}):/
const EN1621 = /^EN 1621-\d{1,2}:/
const OTHER_CLASS = /^[A-Za-z0-9+ -]{1,10}$/

/** What a certificate says, as stored (dates as calendar days). */
export interface CertificateFields {
  readonly companyId: string | null
  readonly holderPartyId: string | null
  readonly standard: string
  readonly ppeClass: string | null
  readonly number: string
  readonly notifiedBodyName: string
  readonly notifiedBodyNumber: string
  readonly modelReference: string | null
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate
}

const DAY_MS = 24 * 60 * 60 * 1000

function partsOf(date: BusinessDate): [number, number, number] {
  const [year = '', month = '', day = ''] = date.split('-')
  return [Number.parseInt(year, 10), Number.parseInt(month, 10), Number.parseInt(day, 10)]
}

const utcDay = (date: BusinessDate): number => {
  const [year, month, day] = partsOf(date)
  return Date.UTC(year, month - 1, day)
}

const asDate = (time: number): BusinessDate => new Date(time).toISOString().slice(0, 10)

/** The day `days` after (or before, when negative) a calendar day. */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  if (!isBusinessDate(date)) throw new RangeError(`not a calendar day: ${String(date)}`)
  return asDate(utcDay(date) + days * DAY_MS)
}

/**
 * The same day `years` later; 29 February becomes 28 February in a year without it (as PostgreSQL adds an interval,
 * so this and the database's five-year rule agree).
 */
export function addYears(date: BusinessDate, years: number): BusinessDate {
  if (!isBusinessDate(date)) throw new RangeError(`not a calendar day: ${String(date)}`)
  const [year, month, day] = partsOf(date)
  const lastOfMonth = new Date(Date.UTC(year + years, month, 0)).getUTCDate()
  return asDate(Date.UTC(year + years, month - 1, Math.min(day, lastOfMonth)))
}

/** Whole days from one calendar day to another (negative when `to` is earlier). */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  if (!isBusinessDate(from) || !isBusinessDate(to)) throw new RangeError(`not a calendar day: ${String(isBusinessDate(from) ? to : from)}`)
  return Math.round((utcDay(to) - utcDay(from)) / DAY_MS)
}

/** True once the certificate's last valid day is behind `today` (a business date, Europe/Rome). */
export function isExpiredOn(validTo: BusinessDate, today: BusinessDate): boolean {
  return daysBetween(validTo, today) > 0
}

/** Days from `today` to the last valid day: 0 on that day, negative once it has expired. */
export function daysToExpiry(validTo: BusinessDate, today: BusinessDate): number {
  return daysBetween(today, validTo)
}

/**
 * The warning the scheduler owes today, in days before the last valid day (EXPIRY_WARNING_DAYS), or null: the smallest
 * threshold the remaining days have reached. A certificate registered with 20 days left is warned at once ("30"), then
 * at 7 days; each threshold is warned once (the scheduler remembers which it sent).
 */
export function expiryWarningDue(validTo: BusinessDate, today: BusinessDate): number | null {
  const left = daysToExpiry(validTo, today)
  if (left < 0) return null
  const reached = EXPIRY_WARNING_DAYS.filter((threshold) => left <= threshold)
  return reached.length === 0 ? null : Math.min(...reached)
}

/** The class EN 17092 grants with this standard's part, or null when the standard is not an EN 17092 part 2 to 6. */
export function en17092ClassOf(standard: string): En17092Class | null {
  const part = EN17092.exec(standard.trim())?.[1]
  return part === undefined ? null : (EN17092_PART_CLASS[part] ?? null)
}

const blank = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === ''

/** What is wrong with a certificate's data (dates, class, notified body number…); empty when nothing. Paths are field names. */
export function certificateProblems(fields: CertificateFields): Issue[] {
  const problems: Issue[] = []
  if (blank(fields.companyId) && blank(fields.holderPartyId)) {
    problems.push({ path: 'holderPartyId', message: 'A company or a brand party holds the certificate (the maker it names).' })
  }
  if (blank(fields.number)) problems.push({ path: 'number', message: "The certificate's number, as the notified body wrote it." })
  if (blank(fields.notifiedBodyName)) problems.push({ path: 'notifiedBodyName', message: "The notified body's name." })
  if (!NOTIFIED_BODY_NUMBER.test(fields.notifiedBodyNumber ?? '')) {
    problems.push({ path: 'notifiedBodyNumber', message: "The notified body's identification number: four digits, as NANDO lists it." })
  }

  const standard = (fields.standard ?? '').trim()
  const ppeClass = blank(fields.ppeClass) ? null : fields.ppeClass!.trim()
  if (!STANDARD.test(standard)) {
    problems.push({ path: 'standard', message: 'The harmonised standard with its edition, for example "EN 17092-4:2020" or "EN 1621-1:2012".' })
  } else if (EN17092.test(standard)) {
    const granted = en17092ClassOf(standard)
    if (granted === null) {
      problems.push({ path: 'standard', message: 'Name the part of EN 17092 that grants the class: EN 17092-2 (AAA) to EN 17092-6 (C); part 1 holds only the test methods.' })
    } else if (ppeClass === null) {
      problems.push({ path: 'ppeClass', message: `${standard.split(':')[0]} grants class ${granted}; write the class the certificate states.` })
    } else if (ppeClass !== granted) {
      problems.push({ path: 'ppeClass', message: `${standard.split(':')[0]} grants class ${granted}, not ${ppeClass} (EN 17092 classes: ${EN17092_CLASSES.join(', ')}).` })
    }
  } else if (EN1621.test(standard)) {
    if (ppeClass === null || !(EN1621_LEVELS as readonly string[]).includes(ppeClass)) {
      problems.push({ path: 'ppeClass', message: 'An EN 1621 protector has performance level 1 or 2.' })
    }
  } else if (ppeClass !== null && !OTHER_CLASS.test(ppeClass)) {
    problems.push({ path: 'ppeClass', message: 'The class or level as the certificate states it, at most 10 letters or digits.' })
  }

  const from = isBusinessDate(fields.validFrom)
  const to = isBusinessDate(fields.validTo)
  if (!from) problems.push({ path: 'validFrom', message: 'The first day it is valid, written YYYY-MM-DD.' })
  if (!to) problems.push({ path: 'validTo', message: 'The last day it is valid, written YYYY-MM-DD.' })
  if (from && to) {
    if (daysBetween(fields.validFrom, fields.validTo) <= 0) {
      problems.push({ path: 'validTo', message: 'The last valid day comes after the first.' })
    } else if (daysBetween(addYears(fields.validFrom, MAX_VALIDITY_YEARS), fields.validTo) > 0) {
      problems.push({ path: 'validTo', message: `An EU type-examination certificate is valid for at most ${MAX_VALIDITY_YEARS} years (Reg. (EU) 2016/425 Annex V): the last day can be ${addYears(fields.validFrom, MAX_VALIDITY_YEARS)} at the latest.` })
    }
  }
  return problems
}

/** What the certificate's moves are checked against, loaded by the API inside the command. */
export interface CertificateFacts {
  readonly certificate: CertificateFields
  /** The business date of the move (Europe/Rome). */
  readonly today: BusinessDate
  /** The certificate's PDF from the notified body is on the record (a CERTIFICATE file, application/pdf, AVAILABLE). */
  readonly pdfAvailable: boolean
  /** Why it is suspended or withdrawn, as the notified body (or the person) wrote it. */
  readonly reason: string | null
}

const reasonMissing = (facts: CertificateFacts): string[] => (blank(facts.reason) ? ['a reason (as the notified body wrote it)'] : [])

/** The certificate's machine (A1 §2.5); the same moves as the database trigger allows. */
export const certificateMachine = defineMachine<CertificateStatus, CertificateFacts>({
  name: 'certificate',
  states: CERTIFICATE_STATUSES,
  transitions: {
    DRAFT: ['VALID', 'WITHDRAWN'],
    VALID: ['SUSPENDED', 'WITHDRAWN', 'EXPIRED'],
    SUSPENDED: ['VALID', 'WITHDRAWN', 'EXPIRED'],
  },
  guards: {
    // Registered (issue) or reinstated: complete, its PDF on the record, and not past its last valid day.
    VALID: (facts) => [
      ...(facts.pdfAvailable ? [] : ["the certificate's PDF from the notified body, uploaded on the certificate"]),
      ...certificateProblems(facts.certificate).map((problem) => problem.message),
      ...(isBusinessDate(facts.certificate.validTo) && isExpiredOn(facts.certificate.validTo, facts.today)
        ? [`a validity that has not ended (its last valid day was ${facts.certificate.validTo})`]
        : []),
    ],
    SUSPENDED: reasonMissing,
    WITHDRAWN: reasonMissing,
    EXPIRED: (facts) => (isExpiredOn(facts.certificate.validTo, facts.today) ? [] : [`the end of its validity (its last valid day is ${facts.certificate.validTo})`]),
  },
})

/** The statuses a certificate may move to next (before guards), for the screens. */
export function certificateNextStatuses(status: CertificateStatus): readonly CertificateStatus[] {
  return nextStates(certificateMachine, status)
}

/** Only a draft is edited; a registered certificate changes only its status (a new or extended one is a new row). */
export const isCertificateEditable = (status: CertificateStatus): boolean => status === 'DRAFT'

/** Coverage is recorded on a draft, a valid or a suspended certificate; a withdrawn or expired one covers nothing more. */
export const acceptsCoverage = (status: CertificateStatus): boolean => status === 'DRAFT' || status === 'VALID' || status === 'SUSPENDED'
