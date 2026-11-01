import { Decimal } from 'decimal.js'
import { plusDays } from '../../calendars/dates'
import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'

/**
 * Piece-rate tables in versions (B-W2b-34; features MES-254 "Piece-rate table", MES-255 "Publish rates to workers",
 * MES-262 "Provisional rate with a trial period"; design people.piecerates "Rate table", pop-ups "New rate version" and
 * "Publish rates"; c.c. arts. 2100-2101). The rules apps/factory-api's modules/people/piecerates asks before it writes;
 * the database (…_pay_w2b_guards) holds the same rules for every login.
 *
 *   a version      a table's rates from a first day: DRAFT while written (its rates change freely), then put in force as
 *                  PROVISIONAL (a trial until its last trial day, MES-262) or PUBLISHED; a provisional one is confirmed
 *                  (PUBLISHED) from the last day of its trial, or replaced by a later version; a later version SUPERSEDES
 *                  the one before (its last day = the day before the new first day). From PROVISIONAL on a rate never
 *                  changes: a new rate is a new version with a reason (c.c. art. 2101: rates change when the conditions
 *                  of the work change).
 *   told first     a version is put in force only after a publication of it to the workers dated on or before its first
 *                  day (c.c. art. 2101 c.3: rates are told before they apply), and never with a first day in the past.
 *   a rate         an operation of the library for a size band: SMV × the rate per minute (rounded to six decimals), or a
 *                  fixed rate per piece.
 *   read by n of m the distinct workers a version was published to, and how many of them acknowledged it (on the floor or
 *                  on a signed paper copy). A missing reading never stops pay; it is the employer's proof of telling.
 */

export const CHANGE_REASONS = ['NEW', 'METHOD_CHANGED', 'EQUIPMENT_CHANGED', 'CORRECTION'] as const
export type ChangeReason = (typeof CHANGE_REASONS)[number]
export const VERSION_STATUSES = ['DRAFT', 'PROVISIONAL', 'PUBLISHED', 'SUPERSEDED', 'CANCELLED'] as const
export type VersionStatus = (typeof VERSION_STATUSES)[number]
export const RATE_BASES = ['SMV_RATE', 'FIXED'] as const
export type RateBasis = (typeof RATE_BASES)[number]
/** What the rate table shows as a version's status (design "Provisional until … / Confirmed / Superseded"). */
export const VERSION_STATES = ['DRAFT', 'PROVISIONAL', 'CONFIRMED', 'SUPERSEDED', 'CANCELLED'] as const
export type VersionState = (typeof VERSION_STATES)[number]

/** The statuses of a version whose rates pay (in force on its days). */
export const IN_FORCE_STATUSES: readonly VersionStatus[] = Object.freeze(['PROVISIONAL', 'PUBLISHED', 'SUPERSEDED'])

export const CHANGE_REASON_WORDS: Readonly<Record<ChangeReason, string>> = Object.freeze({
  NEW: 'new style or operation',
  METHOD_CHANGED: 'method changed',
  EQUIPMENT_CHANGED: 'equipment changed',
  CORRECTION: 'correction',
})

export const RATES_MAX = 500
export const TEXT_MAX = 500
export const REASON_MIN = 3
export const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,19}$/
export const SIZE_BAND_PATTERN = /^[A-Z0-9][A-Z0-9 ./-]{0,23}$/
export const SIZE_BAND_ALL = 'ALL'
/** The longest trial of a provisional rate, in days after its first day. */
export const TRIAL_MAX_DAYS = 366
/** The tile "Provisional rates ending trial in 14 days". */
export const TRIAL_ENDING_DAYS = 14

const STANDARD_MINUTES = { scale: 3, max: new Decimal('9999999.999') }
const RATE = { scale: 6, max: new Decimal('999999999999.999999') }

/** A decimal string with at most `scale` decimals, 0 or more, within the column; null otherwise. */
function decimalOf(value: string | null | undefined, scale: number, max: Decimal): Decimal | null {
  if (typeof value !== 'string' || !/^\d{1,13}(\.\d+)?$/.test(value.trim())) return null
  const number = new Decimal(value.trim())
  if (number.decimalPlaces() > scale || number.greaterThan(max)) return null
  return number
}

/** A decimal as the API writes it: the shortest form ("11.58", "0.3", "0"). */
export const decimalText = (value: Decimal | string): string => new Decimal(value).toFixed()

/** SMV × the rate per minute, rounded half up to six decimals (PostgreSQL's round() on numerics, the guard's rule). */
export function ratePerPieceOf(standardMinutes: string, ratePerMinute: string): string {
  return decimalText(new Decimal(standardMinutes).times(new Decimal(ratePerMinute)).toDecimalPlaces(RATE.scale, Decimal.ROUND_HALF_UP))
}

/** One rate as typed (the "New rate version" pop-up: operation · basis · values). */
export interface RateInput {
  readonly operationId: string
  readonly sizeBand?: string | null | undefined
  readonly basis: RateBasis
  readonly standardMinutes?: string | null | undefined
  readonly ratePerMinute?: string | null | undefined
  readonly ratePerPiece?: string | null | undefined
  readonly note?: string | null | undefined
}

/** One rate as stored: decimals as strings, the rate per piece always there. */
export interface Rate {
  readonly operationId: string
  readonly sizeBand: string
  readonly basis: RateBasis
  readonly standardMinutes: string | null
  readonly ratePerMinute: string | null
  readonly ratePerPiece: string
  readonly note: string | null
}

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''
const textOrNull = (value: string | null | undefined): string | null => (filled(value) ? value.trim() : null)

/** The size band as stored: capitals, "ALL" when none is given. */
export const sizeBandOf = (value: string | null | undefined): string => (filled(value) ? value.trim().toUpperCase() : SIZE_BAND_ALL)

/**
 * The rates of a version, checked and made whole: each problem with its place (`rates/<i>/<field>`), the rate per piece
 * computed for SMV × rate per minute (a typed one must agree), one rate per operation and size band.
 */
export function ratesOf(inputs: readonly RateInput[]): { readonly rates: Rate[]; readonly problems: Issue[] } {
  const problems: Issue[] = []
  const rates: Rate[] = []
  const seen = new Map<string, number>()
  if (inputs.length > RATES_MAX) problems.push({ path: 'rates', message: `A version holds at most ${RATES_MAX} rates.` })
  inputs.forEach((input, index) => {
    const at = (field: string) => `rates/${index}/${field}`
    const sizeBand = sizeBandOf(input.sizeBand)
    if (!SIZE_BAND_PATTERN.test(sizeBand)) problems.push({ path: at('sizeBand'), message: 'A size band is 1 to 24 letters, digits, spaces, dots, slashes or hyphens ("ALL" for every size).' })
    const key = `${input.operationId}|${sizeBand}`
    const earlier = seen.get(key)
    if (earlier !== undefined) problems.push({ path: at('operationId'), message: `This operation and size band are rate ${earlier + 1} already; one rate each.` })
    else seen.set(key, index)
    const note = textOrNull(input.note)
    if (note !== null && note.length > TEXT_MAX) problems.push({ path: at('note'), message: `A note is at most ${TEXT_MAX} characters.` })
    const minutesGiven = filled(input.standardMinutes)
    const minutes = minutesGiven ? decimalOf(input.standardMinutes, STANDARD_MINUTES.scale, STANDARD_MINUTES.max) : null
    if (minutesGiven && minutes === null) problems.push({ path: at('standardMinutes'), message: 'Standard minutes are a number of 0 or more with at most 3 decimals.' })
    if (input.basis === 'SMV_RATE') {
      const perMinute = filled(input.ratePerMinute) ? decimalOf(input.ratePerMinute, RATE.scale, RATE.max) : null
      if (minutes === null || !minutes.greaterThan(0)) {
        if (!minutesGiven || minutes !== null) problems.push({ path: at('standardMinutes'), message: 'SMV × rate per minute needs the standard minutes, above 0.' })
      }
      if (perMinute === null) problems.push({ path: at('ratePerMinute'), message: 'SMV × rate per minute needs the rate per minute: 0 or more, at most 6 decimals.' })
      if (minutes !== null && minutes.greaterThan(0) && perMinute !== null) {
        const ratePerPiece = ratePerPieceOf(minutes.toFixed(), perMinute.toFixed())
        if (filled(input.ratePerPiece)) {
          const typed = decimalOf(input.ratePerPiece, RATE.scale, RATE.max)
          if (typed === null || !typed.equals(ratePerPiece)) problems.push({ path: at('ratePerPiece'), message: `SMV × rate per minute makes ${ratePerPiece} a piece; leave the rate per piece out or send that.` })
        }
        rates.push({ operationId: input.operationId, sizeBand, basis: 'SMV_RATE', standardMinutes: decimalText(minutes), ratePerMinute: decimalText(perMinute), ratePerPiece, note })
      }
      return
    }
    if (filled(input.ratePerMinute)) problems.push({ path: at('ratePerMinute'), message: 'A fixed rate per piece has no rate per minute.' })
    const perPiece = filled(input.ratePerPiece) ? decimalOf(input.ratePerPiece, RATE.scale, RATE.max) : null
    if (perPiece === null) problems.push({ path: at('ratePerPiece'), message: 'A fixed rate needs the rate per piece: 0 or more, at most 6 decimals.' })
    else rates.push({ operationId: input.operationId, sizeBand, basis: 'FIXED', standardMinutes: minutes === null ? null : decimalText(minutes), ratePerMinute: null, ratePerPiece: decimalText(perPiece), note })
  })
  return { rates: problems.length > 0 ? [] : rates, problems }
}

/** The days and kind of a version as typed (the "New rate version" pop-up: effective from · why changed · provisional). */
export interface VersionTerms {
  readonly changeReason: ChangeReason
  readonly changeNote?: string | null | undefined
  readonly effectiveFrom: BusinessDate
  readonly provisional?: boolean | undefined
  readonly trialEndsOn?: BusinessDate | null | undefined
}

/** What a version's days and kind break (a DRAFT may start in the past; putting it in force asks for a day to come). */
export function termsProblems(terms: VersionTerms): Issue[] {
  const problems: Issue[] = []
  if (!(CHANGE_REASONS as readonly string[]).includes(terms.changeReason)) problems.push({ path: 'changeReason', message: 'Say why the rates change: new, method changed, equipment changed or correction.' })
  const note = textOrNull(terms.changeNote)
  if (note !== null && note.length > TEXT_MAX) problems.push({ path: 'changeNote', message: `A note is at most ${TEXT_MAX} characters.` })
  if (terms.changeReason === 'CORRECTION' && note === null) problems.push({ path: 'changeNote', message: 'A correction says what was wrong.' })
  if (!isBusinessDate(terms.effectiveFrom)) {
    problems.push({ path: 'effectiveFrom', message: 'The first day is a calendar day written YYYY-MM-DD.' })
    return problems
  }
  const provisional = terms.provisional === true
  const trial = terms.trialEndsOn ?? null
  if (provisional && trial === null) problems.push({ path: 'trialEndsOn', message: 'A provisional rate names the last day of its trial.' })
  if (!provisional && trial !== null) problems.push({ path: 'trialEndsOn', message: 'Only a provisional rate has a trial; tick "provisional" or leave the trial out.' })
  if (provisional && trial !== null) {
    if (!isBusinessDate(trial)) problems.push({ path: 'trialEndsOn', message: 'The last day of the trial is a calendar day written YYYY-MM-DD.' })
    else if (trial <= terms.effectiveFrom) problems.push({ path: 'trialEndsOn', message: 'The trial ends after the first day of the rates.' })
    else if (trial > plusDays(terms.effectiveFrom, TRIAL_MAX_DAYS)) problems.push({ path: 'trialEndsOn', message: `A trial lasts at most ${TRIAL_MAX_DAYS} days.` })
  }
  return problems
}

/** A version as the rules read it. */
export interface VersionRow {
  readonly id: string
  readonly versionNo: number
  readonly status: VersionStatus
  readonly effectiveFrom: BusinessDate
  readonly effectiveTo: BusinessDate | null
  readonly provisional: boolean
  readonly trialEndsOn: BusinessDate | null
}

/** A version's rates pay on `day`. */
export const inForceOn = (version: VersionRow, day: BusinessDate): boolean =>
  IN_FORCE_STATUSES.includes(version.status) && version.effectiveFrom <= day && (version.effectiveTo === null || day <= version.effectiveTo)

/** What the rate table shows: "Provisional until …", "Confirmed", "Superseded", with its words. */
export function versionStateOf(version: VersionRow, today: BusinessDate): { readonly state: VersionState; readonly words: string } {
  switch (version.status) {
    case 'DRAFT':
      return { state: 'DRAFT', words: 'Draft: not told to the workers, pays nothing.' }
    case 'PROVISIONAL':
      return { state: 'PROVISIONAL', words: version.trialEndsOn !== null && version.trialEndsOn < today ? `Provisional: the trial ended on ${version.trialEndsOn}; confirm it or replace it.` : `Provisional until ${version.trialEndsOn ?? '?'}.` }
    case 'PUBLISHED':
      return { state: 'CONFIRMED', words: version.provisional ? 'Confirmed after its trial.' : 'Confirmed.' }
    case 'SUPERSEDED':
      return { state: 'SUPERSEDED', words: version.effectiveTo !== null && version.effectiveTo >= today ? `Pays until ${version.effectiveTo}; a later version follows.` : `Superseded: paid until ${version.effectiveTo ?? '?'}.` }
    default:
      return { state: 'CANCELLED', words: 'Cancelled: never in force.' }
  }
}

/** The refusals of a version's actions (a 409 with `refusal/<CODE>` and the words). */
export const VERSION_REFUSALS = [
  'NOT_DRAFT',
  'ENDED',
  'NOT_PUBLISHED',
  'STARTS_IN_PAST',
  'NO_RATES',
  'TABLE_ARCHIVED',
  'STARTS_BEFORE_LATEST',
  'OVERLAPS',
  'NOT_PROVISIONAL',
  'TRIAL_RUNNING',
] as const
export type VersionRefusalCode = (typeof VERSION_REFUSALS)[number]
export interface VersionRefusal {
  readonly code: VersionRefusalCode
  readonly message: string
}

const refusal = (code: VersionRefusalCode, message: string): VersionRefusal => ({ code, message })

/** Rates and days change only while a version is a DRAFT. */
export function editRefusal(version: Pick<VersionRow, 'status' | 'versionNo'>): VersionRefusal | null {
  return version.status === 'DRAFT' ? null : refusal('NOT_DRAFT', `Version ${version.versionNo} is ${version.status.toLowerCase()}: its rates never change. A new rate is a new version with a reason.`)
}

/** A version is published to workers while it may still pay: not superseded or cancelled. */
export function publishRefusal(version: Pick<VersionRow, 'status' | 'versionNo'>): VersionRefusal | null {
  return version.status === 'SUPERSEDED' || version.status === 'CANCELLED' ? refusal('ENDED', `Version ${version.versionNo} is ${version.status.toLowerCase()}; it is published no more.`) : null
}

/** What putting a DRAFT in force needs and what it does to the versions in force before it. */
export interface InForcePlan {
  readonly status: 'PROVISIONAL' | 'PUBLISHED'
  /** The versions it supersedes: each gets this last day and SUPERSEDED. */
  readonly supersedes: readonly { readonly id: string; readonly versionNo: number; readonly effectiveTo: BusinessDate }[]
}

/**
 * Putting a DRAFT in force (c.c. art. 2101 c.3): its first day not in the past, at least one rate, the table ACTIVE, a
 * publication of it dated on or before its first day; it follows every version in force of its table (each starts
 * before it; the open one gets the last day before it and is superseded; one that ends on or after its first day cannot
 * be changed, so it is refused).
 */
export function inForcePlan(input: {
  readonly version: VersionRow
  readonly today: BusinessDate
  readonly rateCount: number
  readonly tableActive: boolean
  /** The Europe/Rome days of its PUBLISHED publications. */
  readonly publishedOn: readonly BusinessDate[]
  /** The other versions of the table. */
  readonly others: readonly VersionRow[]
}): { readonly plan: InForcePlan | null; readonly refusal: VersionRefusal | null } {
  const { version, today } = input
  const refused = (value: VersionRefusal) => ({ plan: null, refusal: value })
  const notDraft = editRefusal(version)
  if (notDraft) return refused(notDraft)
  if (version.effectiveFrom < today) return refused(refusal('STARTS_IN_PAST', `Version ${version.versionNo} starts on ${version.effectiveFrom}, in the past: rates are told before they apply. Give it a first day from today on.`))
  if (input.rateCount === 0) return refused(refusal('NO_RATES', `Version ${version.versionNo} has no rate yet.`))
  if (!input.tableActive) return refused(refusal('TABLE_ARCHIVED', 'Its table is archived: an archived table puts no rate in force.'))
  if (!input.publishedOn.some((day) => day <= version.effectiveFrom)) {
    return refused(refusal('NOT_PUBLISHED', `Publish version ${version.versionNo} to its workers first: rates are told before they apply, on or before ${version.effectiveFrom} (c.c. art. 2101).`))
  }
  const supersedes: { id: string; versionNo: number; effectiveTo: BusinessDate }[] = []
  for (const other of input.others) {
    if (other.id === version.id || !IN_FORCE_STATUSES.includes(other.status)) continue
    if (other.effectiveTo !== null && other.effectiveTo < version.effectiveFrom) continue
    if (other.effectiveFrom >= version.effectiveFrom) {
      return refused(refusal('STARTS_BEFORE_LATEST', `Version ${other.versionNo} is in force from ${other.effectiveFrom}; a new version starts after it (versions follow each other).`))
    }
    if (other.effectiveTo !== null) {
      return refused(refusal('OVERLAPS', `Version ${other.versionNo} pays until ${other.effectiveTo}; start this one after that day.`))
    }
    supersedes.push({ id: other.id, versionNo: other.versionNo, effectiveTo: plusDays(version.effectiveFrom, -1) })
  }
  return { plan: { status: version.provisional ? 'PROVISIONAL' : 'PUBLISHED', supersedes }, refusal: null }
}

/** Confirming a provisional rate (MES-262): from the last day of its trial on (before, the trial runs; replace it instead). */
export function confirmRefusal(version: Pick<VersionRow, 'status' | 'versionNo' | 'trialEndsOn'>, today: BusinessDate): VersionRefusal | null {
  if (version.status !== 'PROVISIONAL') return refusal('NOT_PROVISIONAL', `Version ${version.versionNo} is ${version.status.toLowerCase()}, not provisional: there is nothing to confirm.`)
  if (version.trialEndsOn !== null && today < version.trialEndsOn) {
    return refusal('TRIAL_RUNNING', `The trial of version ${version.versionNo} runs until ${version.trialEndsOn}; it is confirmed from that day. To change the rates before, make a new version.`)
  }
  return null
}

/** A DRAFT is cancelled (with why); anything else stands. */
export function cancelRefusal(version: Pick<VersionRow, 'status' | 'versionNo'>): VersionRefusal | null {
  return version.status === 'DRAFT' ? null : refusal('NOT_DRAFT', `Version ${version.versionNo} is ${version.status.toLowerCase()}; only a draft is cancelled.`)
}

/** "Read by n of m": the distinct workers of the version's PUBLISHED publications, and how many acknowledged it. */
export function readByOf(
  publications: readonly { readonly id: string; readonly status: string; readonly workerIds: readonly string[] }[],
  receipts: readonly { readonly publicationId: string; readonly workerId: string }[],
): { readonly read: number; readonly of: number } {
  const live = publications.filter((publication) => publication.status === 'PUBLISHED')
  const told = new Set(live.flatMap((publication) => publication.workerIds))
  const liveIds = new Set(live.map((publication) => publication.id))
  const read = new Set(receipts.filter((receipt) => liveIds.has(receipt.publicationId) && told.has(receipt.workerId)).map((receipt) => receipt.workerId))
  return { read: read.size, of: told.size }
}

/** The tile "Provisional rates ending trial in 14 days" (and those whose trial ended unconfirmed). */
export function trialTiles(versions: readonly Pick<VersionRow, 'status' | 'trialEndsOn'>[], today: BusinessDate): { readonly endingSoon: number; readonly ended: number } {
  const until = plusDays(today, TRIAL_ENDING_DAYS)
  let endingSoon = 0
  let ended = 0
  for (const version of versions) {
    if (version.status !== 'PROVISIONAL' || version.trialEndsOn === null) continue
    if (version.trialEndsOn < today) ended += 1
    else if (version.trialEndsOn <= until) endingSoon += 1
  }
  return { endingSoon, ended }
}

/** A reason a person typed: 3 to 500 characters. */
export function reasonProblems(reason: string | null | undefined, path = 'reason'): Issue[] {
  const text = textOrNull(reason)
  if (text === null || text.length < REASON_MIN) return [{ path, message: 'Say why, in a few words.' }]
  if (text.length > TEXT_MAX) return [{ path, message: `At most ${TEXT_MAX} characters.` }]
  return []
}
