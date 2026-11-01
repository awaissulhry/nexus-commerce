import { plusDays } from '../../calendars/dates'
import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { Dec } from '../../tax/decimal'

/**
 * Incentive schemes (B-W2b-38; features MES-253 "Incentive scheme settings", MES-257 "Make-up to guaranteed pay", MES-258
 * "Rework and scrap pay rules", MES-259 "Team incentive split"; design people.piecerates "Scheme" and the header's "Scheme
 * settings"; W2b plan §3 GATE-PIECE-PAY). How pay is computed for a company, or for one of its lines (a line's own scheme
 * wins on that line): the kind of scheme, the guaranteed pay piece pay is made up to (c.c. art. 2101 and the CCNL minimum:
 * piece pay is never below it), how a team's pay splits, what rework and scrap pay, how waiting is paid (never unpaid:
 * c.c. art. 2100), and whether a scan pays only while its worker is clocked in. apps/factory-api's modules/people/schemes
 * asks these rules before it writes; the database (…_pay_w2b_guards) holds the same shapes again for every login.
 *
 *   a scheme     DRAFT while it is set (it changes freely, or is deleted); ACTIVE from its first day, frozen but its last
 *                day; RETIRED once a later scheme took over (or it was ended): it still pays on its own days. A scheme
 *                starts only with its guaranteed pay given (the labour consultant's answer, GATE-PIECE-PAY: its basis and
 *                its rate per hour) and never on a day in the past or in a LOCKED pay period.
 *   follows      schemes of one company and line follow each other: the open one before ends the day before the new
 *                first day (RETIRED); one that starts on or after it, or already ends on or after it, is refused.
 *   applies      on a day, the line's own scheme in force, else the company's (`schemeFor`).
 *   a change     shows the pay periods of the company it touches (design "a change shows the periods it affects"):
 *                OPEN accrues under it, PREVIEW / REVIEW are run again, a LOCKED one never changes.
 *
 * No figure here is about one person (Statuto dei Lavoratori art. 4; Owner answers W1, F2): a scheme is the company's
 * rule; the words never carry a pay figure (the rates travel only in `money.pay` fields, HR and the worker).
 */

export const INCENTIVE_KINDS = ['PIECE_RATE', 'STANDARD_MINUTE_BONUS', 'TEAM_INCENTIVE'] as const
export type IncentiveKind = (typeof INCENTIVE_KINDS)[number]
export const GUARANTEED_BASES = ['UNDECIDED', 'CCNL_MINIMUM', 'AGREED_HOURLY'] as const
export type GuaranteedBasis = (typeof GUARANTEED_BASES)[number]
export const TEAM_SPLITS = ['HOURS_PRESENT', 'SKILL_WEIGHT'] as const
export type TeamSplit = (typeof TEAM_SPLITS)[number]
export const OWN_FAULT_PAYS = ['UNPAID', 'REDUCED_RATE', 'FULL_RATE'] as const
export type OwnFaultPay = (typeof OWN_FAULT_PAYS)[number]
/** Time not spent on pieces is always paid (c.c. art. 2100): at the worker's average, or at the guaranteed rate. */
export const PAID_TIME_RATES = ['AVERAGE', 'GUARANTEED'] as const
export type PaidTimeRate = (typeof PAID_TIME_RATES)[number]
export const SCHEME_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const
export type SchemeStatus = (typeof SCHEME_STATUSES)[number]
/** What the screen shows of a scheme's days. */
export const SCHEME_STATES = ['DRAFT', 'TO_COME', 'IN_FORCE', 'ENDING', 'ENDED'] as const
export type SchemeState = (typeof SCHEME_STATES)[number]
export const PERIOD_STATUSES = ['OPEN', 'PREVIEW', 'REVIEW', 'LOCKED'] as const
export type PeriodStatus = (typeof PERIOD_STATUSES)[number]
/** What a scheme's days do to a pay period of its company. */
export const PERIOD_EFFECTS = ['ACCRUES', 'RUN_AGAIN', 'LOCKED'] as const
export type PeriodEffect = (typeof PERIOD_EFFECTS)[number]

export const NAME_MAX = 120
export const NOTE_MAX = 2000
export const REASON_MIN = 3
export const REASON_MAX = 500
/** The efficiency threshold of a standard-minute bonus: above 0, at most 200 percent (the guard's bounds). */
export const THRESHOLD_MAX = 200

export const KIND_WORDS: Readonly<Record<IncentiveKind, string>> = Object.freeze({
  PIECE_RATE: 'Pure piece rate: the pieces at the rate of their operation, made up to the guaranteed pay.',
  STANDARD_MINUTE_BONUS: 'Standard-minute bonus: the guaranteed pay for the hours present, and a bonus for the standard minutes earned above the efficiency threshold.',
  TEAM_INCENTIVE: "Team incentive: a team's pieces paid to the team and split among its members, made up to the guaranteed pay.",
})

export const BASIS_WORDS: Readonly<Record<GuaranteedBasis, string>> = Object.freeze({
  UNDECIDED: "Guaranteed pay: not given yet (its basis and rate per hour are the labour consultant's answer); the scheme cannot start.",
  CCNL_MINIMUM: 'Piece pay is made up to the CCNL minimum for the hours present (c.c. art. 2101): never below it.',
  AGREED_HOURLY: "Piece pay is made up to the hourly rate agreed with the workers' representatives, for the hours present: never below it.",
})

export const SPLIT_WORDS: Readonly<Record<TeamSplit, string>> = Object.freeze({
  HOURS_PRESENT: "A team's pay splits in proportion to each member's hours present.",
  SKILL_WEIGHT: "A team's pay splits in proportion to each member's skill weight.",
})

export const PAID_TIME_WORDS: Readonly<Record<PaidTimeRate, string>> = Object.freeze({
  AVERAGE: "at the worker's average earnings per minute in the period",
  GUARANTEED: 'at the guaranteed rate',
})

export const PERIOD_EFFECT_WORDS: Readonly<Record<PeriodEffect, string>> = Object.freeze({
  ACCRUES: 'open: its pay accrues under this scheme',
  RUN_AGAIN: 'computed already: run it again so its make-up and team splits follow this scheme',
  LOCKED: 'locked: never changed (a later period pays any correction)',
})

/** A scheme as the rules read it (decimals as strings, days as YYYY-MM-DD). */
export interface SchemeRow {
  readonly id: string
  readonly name: string
  readonly companyId: string
  readonly lineId: string | null
  readonly kind: IncentiveKind
  readonly efficiencyThresholdPct: string | null
  readonly guaranteedBasis: GuaranteedBasis
  readonly guaranteedHourlyRate: string | null
  readonly traineeHourlyRate: string | null
  readonly teamSplit: TeamSplit | null
  readonly reworkOwnFault: OwnFaultPay
  readonly scrapOwnFault: OwnFaultPay
  readonly ownFaultRatePct: string | null
  readonly othersFaultPay: PaidTimeRate
  readonly waitingPay: PaidTimeRate
  readonly payOnlyWhileClockedIn: boolean
  readonly currency: string
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate | null
  readonly status: SchemeStatus
}

/** What a body sets of a scheme (create, or a DRAFT's edit made whole). */
export interface SchemeTerms {
  readonly name: string
  readonly kind: IncentiveKind
  readonly efficiencyThresholdPct?: string | null | undefined
  readonly guaranteedBasis?: GuaranteedBasis | undefined
  readonly guaranteedHourlyRate?: string | null | undefined
  readonly traineeHourlyRate?: string | null | undefined
  readonly teamSplit?: TeamSplit | null | undefined
  readonly reworkOwnFault?: OwnFaultPay | undefined
  readonly scrapOwnFault?: OwnFaultPay | undefined
  readonly ownFaultRatePct?: string | null | undefined
  readonly othersFaultPay?: PaidTimeRate | undefined
  readonly waitingPay?: PaidTimeRate | undefined
  readonly payOnlyWhileClockedIn?: boolean | undefined
  readonly currency?: string | undefined
  readonly validFrom: BusinessDate
  readonly note?: string | null | undefined
}

/** The terms as stored: every column given, a column of another kind cleared. */
export interface Terms {
  readonly name: string
  readonly kind: IncentiveKind
  readonly efficiencyThresholdPct: string | null
  readonly guaranteedBasis: GuaranteedBasis
  readonly guaranteedHourlyRate: string | null
  readonly traineeHourlyRate: string | null
  readonly teamSplit: TeamSplit | null
  readonly reworkOwnFault: OwnFaultPay
  readonly scrapOwnFault: OwnFaultPay
  readonly ownFaultRatePct: string | null
  readonly othersFaultPay: PaidTimeRate
  readonly waitingPay: PaidTimeRate
  readonly payOnlyWhileClockedIn: boolean
  readonly currency: string
  readonly validFrom: BusinessDate
  readonly note: string | null
}

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''
const textOrNull = (value: string | null | undefined): string | null => (filled(value) ? value.trim() : null)
const includes = <T extends string>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value)

/** A plain decimal string with at most `scale` decimals and 12 integer digits, 0 or more; null otherwise. */
function decimalOf(value: string | null | undefined, scale: number): string | null {
  if (!filled(value) || !/^\d{1,12}(\.\d+)?$/.test(value.trim())) return null
  const number = new Dec(value.trim())
  return number.decimalPlaces() > scale ? null : number.toFixed()
}

/** True when the reduced own-fault rate is used by rework or scrap. */
const usesReduced = (terms: { readonly reworkOwnFault?: OwnFaultPay | undefined; readonly scrapOwnFault?: OwnFaultPay | undefined }): boolean =>
  terms.reworkOwnFault === 'REDUCED_RATE' || terms.scrapOwnFault === 'REDUCED_RATE'

/**
 * The terms made whole and checked: each problem at its field. A column another kind uses is cleared (the threshold of a
 * standard-minute bonus, the team split of a team incentive, the reduced rate when nothing is reduced), so changing the
 * kind on the form leaves nothing behind; a column the kind needs is asked for.
 */
export function termsOf(input: SchemeTerms): { readonly terms: Terms | null; readonly problems: Issue[] } {
  const problems: Issue[] = []
  const name = textOrNull(input.name)
  if (name === null) problems.push({ path: 'name', message: 'Give the scheme a name.' })
  else if (name.length > NAME_MAX) problems.push({ path: 'name', message: `A name is at most ${NAME_MAX} characters.` })
  if (!includes(INCENTIVE_KINDS, input.kind)) problems.push({ path: 'kind', message: 'Choose the kind: pure piece rate, standard-minute bonus or team incentive.' })
  const kind = input.kind

  let threshold: string | null = null
  if (kind === 'STANDARD_MINUTE_BONUS') {
    threshold = decimalOf(input.efficiencyThresholdPct, 4)
    if (threshold === null || new Dec(threshold).lessThanOrEqualTo(0) || new Dec(threshold).greaterThan(THRESHOLD_MAX)) {
      problems.push({ path: 'efficiencyThresholdPct', message: `A standard-minute bonus pays above an efficiency threshold: a percent above 0 and at most ${THRESHOLD_MAX}, with at most 4 decimals.` })
      threshold = null
    }
  }
  let teamSplit: TeamSplit | null = null
  if (kind === 'TEAM_INCENTIVE') {
    if (includes(TEAM_SPLITS, input.teamSplit)) teamSplit = input.teamSplit
    else problems.push({ path: 'teamSplit', message: "A team incentive says how the team's pay splits: by hours present or by skill weight." })
  }

  const basis = input.guaranteedBasis ?? 'UNDECIDED'
  if (!includes(GUARANTEED_BASES, basis)) problems.push({ path: 'guaranteedBasis', message: 'The guaranteed pay is the CCNL minimum, an agreed hourly rate, or not decided yet.' })
  const rateOf = (value: string | null | undefined, path: string, what: string): string | null => {
    if (!filled(value)) return null
    const rate = decimalOf(value, 6)
    if (rate === null || new Dec(rate).lessThanOrEqualTo(0)) {
      problems.push({ path, message: `${what} is an amount per hour above 0, with at most 6 decimals.` })
      return null
    }
    return rate
  }
  const guaranteed = rateOf(input.guaranteedHourlyRate, 'guaranteedHourlyRate', 'The guaranteed pay')
  const trainee = rateOf(input.traineeHourlyRate, 'traineeHourlyRate', "A trainee's guaranteed pay")

  const rework = input.reworkOwnFault ?? 'UNPAID'
  const scrap = input.scrapOwnFault ?? 'UNPAID'
  if (!includes(OWN_FAULT_PAYS, rework)) problems.push({ path: 'reworkOwnFault', message: "Rework of the worker's own fault is unpaid, paid at a reduced rate or at the full rate." })
  if (!includes(OWN_FAULT_PAYS, scrap)) problems.push({ path: 'scrapOwnFault', message: "Scrap of the worker's own fault is unpaid, paid at a reduced rate or at the full rate." })
  let reduced: string | null = null
  if (usesReduced({ reworkOwnFault: rework, scrapOwnFault: scrap })) {
    reduced = decimalOf(input.ownFaultRatePct, 4)
    if (reduced === null || new Dec(reduced).lessThanOrEqualTo(0) || new Dec(reduced).greaterThanOrEqualTo(100)) {
      problems.push({ path: 'ownFaultRatePct', message: 'A reduced rate is a percent of the rate above 0 and below 100, with at most 4 decimals.' })
      reduced = null
    }
  }
  const others = input.othersFaultPay ?? 'AVERAGE'
  const waiting = input.waitingPay ?? 'AVERAGE'
  if (!includes(PAID_TIME_RATES, others)) problems.push({ path: 'othersFaultPay', message: 'Rework and scrap caused by others are paid at the average or at the guaranteed rate: never unpaid.' })
  if (!includes(PAID_TIME_RATES, waiting)) problems.push({ path: 'waitingPay', message: "Waiting that is not the worker's doing is paid at the average or at the guaranteed rate: never unpaid (c.c. art. 2100)." })
  const currency = input.currency ?? 'EUR'
  if (!/^[A-Z]{3}$/.test(currency)) problems.push({ path: 'currency', message: 'An ISO 4217 currency code, such as EUR.' })
  if (!isBusinessDate(input.validFrom)) problems.push({ path: 'validFrom', message: 'The first day is a calendar day written YYYY-MM-DD.' })
  const note = textOrNull(input.note)
  if (note !== null && note.length > NOTE_MAX) problems.push({ path: 'note', message: `A note is at most ${NOTE_MAX} characters.` })

  if (problems.length > 0) return { terms: null, problems }
  return {
    terms: {
      name: name!,
      kind,
      efficiencyThresholdPct: threshold,
      guaranteedBasis: basis,
      guaranteedHourlyRate: guaranteed,
      traineeHourlyRate: trainee,
      teamSplit,
      reworkOwnFault: rework,
      scrapOwnFault: scrap,
      ownFaultRatePct: reduced,
      othersFaultPay: others,
      waitingPay: waiting,
      payOnlyWhileClockedIn: input.payOnlyWhileClockedIn ?? true,
      currency,
      validFrom: input.validFrom,
      note,
    },
    problems,
  }
}

/** The first day of a DRAFT: today or later (a scheme never changes pay already worked). */
export function firstDayProblems(validFrom: BusinessDate, today: BusinessDate): Issue[] {
  return isBusinessDate(validFrom) && validFrom < today ? [{ path: 'validFrom', message: `A scheme starts today (${today}) or later: it never changes pay already worked.` }] : []
}

/** A reason a person typed: 3 to 500 characters. */
export function reasonProblems(reason: string | null | undefined, path = 'reason'): Issue[] {
  const text = textOrNull(reason)
  if (text === null || text.length < REASON_MIN) return [{ path, message: 'Say why, in a few words.' }]
  if (text.length > REASON_MAX) return [{ path, message: `At most ${REASON_MAX} characters.` }]
  return []
}

/** The scheme pays on `day` (ACTIVE or RETIRED, between its first and last day). */
export const inForceOn = (scheme: Pick<SchemeRow, 'status' | 'validFrom' | 'validTo'>, day: BusinessDate): boolean =>
  scheme.status !== 'DRAFT' && scheme.validFrom <= day && (scheme.validTo === null || day <= scheme.validTo)

/**
 * The scheme that applies on `day` to work on `lineId` (null: work on no line): the line's own scheme in force, else the
 * company's (a scheme with no line). The schemes are one company's.
 */
export function schemeFor<S extends Pick<SchemeRow, 'lineId' | 'status' | 'validFrom' | 'validTo'>>(schemes: readonly S[], lineId: string | null, day: BusinessDate): S | null {
  const own = lineId === null ? undefined : schemes.find((scheme) => scheme.lineId === lineId && inForceOn(scheme, day))
  return own ?? schemes.find((scheme) => scheme.lineId === null && inForceOn(scheme, day)) ?? null
}

/** What the screen shows of a scheme's days, with its words. */
export function schemeStateOf(scheme: Pick<SchemeRow, 'status' | 'validFrom' | 'validTo'>, today: BusinessDate): { readonly state: SchemeState; readonly words: string } {
  if (scheme.status === 'DRAFT') return { state: 'DRAFT', words: `Draft from ${scheme.validFrom}: pays nothing until it is started.` }
  if (scheme.validFrom > today) return { state: 'TO_COME', words: scheme.validTo === null ? `Starts on ${scheme.validFrom}.` : `Starts on ${scheme.validFrom}, ends on ${scheme.validTo}.` }
  if (scheme.validTo !== null && scheme.validTo < today) return { state: 'ENDED', words: `Applied from ${scheme.validFrom} to ${scheme.validTo}.` }
  if (scheme.validTo !== null) return { state: 'ENDING', words: `In force until ${scheme.validTo}.` }
  return { state: 'IN_FORCE', words: `In force since ${scheme.validFrom}.` }
}

/** The rules of a scheme in words, one per line, never with a pay figure (the rates are `money.pay` fields). */
export function rulesInWords(scheme: Pick<SchemeRow, 'kind' | 'efficiencyThresholdPct' | 'guaranteedBasis' | 'traineeHourlyRate' | 'teamSplit' | 'reworkOwnFault' | 'scrapOwnFault' | 'ownFaultRatePct' | 'othersFaultPay' | 'waitingPay' | 'payOnlyWhileClockedIn'>): string[] {
  const own = (what: string, rule: OwnFaultPay): string =>
    rule === 'UNPAID'
      ? `${what} of the worker's own fault is not paid.`
      : rule === 'FULL_RATE'
        ? `${what} of the worker's own fault is paid at the full rate.`
        : `${what} of the worker's own fault is paid at ${scheme.ownFaultRatePct ?? '?'}% of the rate.`
  const words = [KIND_WORDS[scheme.kind], BASIS_WORDS[scheme.guaranteedBasis]]
  if (scheme.traineeHourlyRate !== null) words.push('Trainees are made up to their own guaranteed rate.')
  if (scheme.kind === 'STANDARD_MINUTE_BONUS') words.push(`The bonus pays the standard minutes earned above ${scheme.efficiencyThresholdPct ?? '?'}% of the minutes present.`)
  if (scheme.kind === 'TEAM_INCENTIVE' && scheme.teamSplit !== null) words.push(SPLIT_WORDS[scheme.teamSplit])
  words.push(own('Rework', scheme.reworkOwnFault), own('Scrap', scheme.scrapOwnFault))
  words.push(`Rework and scrap caused by others are paid as time off standard, ${PAID_TIME_WORDS[scheme.othersFaultPay]}.`)
  words.push(`Waiting that is not the worker's doing is paid ${PAID_TIME_WORDS[scheme.waitingPay]}: never unpaid (c.c. art. 2100).`)
  words.push(scheme.payOnlyWhileClockedIn ? 'A scan pays only while its worker is clocked in; any other scan is held for HR.' : 'A scan pays whether or not its worker is clocked in.')
  return words
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

/** The refusals of a scheme's actions (a 409 with `refusal/<CODE>` and the words). */
export const SCHEME_REFUSALS = [
  'NOT_DRAFT',
  'NO_GUARANTEE',
  'STARTS_IN_PAST',
  'PERIOD_LOCKED',
  'STARTS_BEFORE_LATEST',
  'OVERLAPS',
  'NOT_ACTIVE',
  'ENDS_SET',
  'ENDS_IN_PAST',
  'ENDS_BEFORE_START',
  'IN_USE',
  'NAMED_BY_SWITCH',
] as const
export type SchemeRefusalCode = (typeof SCHEME_REFUSALS)[number]
export interface SchemeRefusal {
  readonly code: SchemeRefusalCode
  readonly message: string
}

const refusal = (code: SchemeRefusalCode, message: string): SchemeRefusal => ({ code, message })

/** A scheme changes only while it is a DRAFT: from ACTIVE on, a change is a later scheme. */
export function editRefusal(scheme: Pick<SchemeRow, 'status' | 'name'>): SchemeRefusal | null {
  return scheme.status === 'DRAFT' ? null : refusal('NOT_DRAFT', `"${scheme.name}" is ${scheme.status.toLowerCase()}: it never changes. Make the scheme that follows it instead.`)
}

/** The guaranteed pay is given: its basis and its rate per hour (the labour consultant's answer). */
export function guaranteeRefusal(scheme: Pick<SchemeRow, 'guaranteedBasis' | 'guaranteedHourlyRate'>): SchemeRefusal | null {
  return scheme.guaranteedBasis === 'UNDECIDED' || scheme.guaranteedHourlyRate === null
    ? refusal('NO_GUARANTEE', "The guaranteed pay is not given yet: its basis (the CCNL minimum or an agreed hourly rate) and its rate per hour are the labour consultant's answer. Piece pay is never below it (c.c. art. 2101), so a scheme starts only with it.")
    : null
}

/** A pay period of the company, as the rules read it. */
export interface PeriodRow {
  readonly id: string
  readonly periodStart: BusinessDate
  readonly periodEnd: BusinessDate
  readonly status: PeriodStatus
}

/** What starting a DRAFT does to the scheme before it: it ends the day before and is RETIRED. */
export interface ActivationPlan {
  readonly retires: readonly { readonly id: string; readonly name: string; readonly validTo: BusinessDate }[]
}

/**
 * Starting a DRAFT (DRAFT → ACTIVE): its guaranteed pay given, its first day today or later and in no LOCKED pay period,
 * and it follows the schemes of its company and line (each starts before it; the open one ends the day before its first
 * day and is RETIRED; one that already ends on or after its first day cannot change, so it is refused).
 */
export function activationPlan(input: {
  readonly scheme: SchemeRow
  readonly today: BusinessDate
  /** The other ACTIVE or RETIRED schemes of the same company and line. */
  readonly others: readonly Pick<SchemeRow, 'id' | 'name' | 'status' | 'validFrom' | 'validTo'>[]
  /** The company's pay periods. */
  readonly periods: readonly PeriodRow[]
}): { readonly plan: ActivationPlan | null; readonly refusal: SchemeRefusal | null } {
  const { scheme, today } = input
  const refused = (value: SchemeRefusal) => ({ plan: null, refusal: value })
  const notDraft = editRefusal(scheme)
  if (notDraft) return refused(notDraft)
  const noGuarantee = guaranteeRefusal(scheme)
  if (noGuarantee) return refused(noGuarantee)
  if (scheme.validFrom < today) return refused(refusal('STARTS_IN_PAST', `"${scheme.name}" starts on ${scheme.validFrom}, in the past: a scheme never changes pay already worked. Give it a first day from today (${today}) on.`))
  const locked = input.periods.find((period) => period.status === 'LOCKED' && period.periodEnd >= scheme.validFrom)
  if (locked) return refused(refusal('PERIOD_LOCKED', `The pay period of ${locked.periodStart.slice(0, 7)} is locked: a scheme starts after its last day (${locked.periodEnd}).`))
  const retires: { id: string; name: string; validTo: BusinessDate }[] = []
  for (const other of input.others) {
    if (other.id === scheme.id || other.status === 'DRAFT') continue
    if (other.validTo !== null && other.validTo < scheme.validFrom) continue
    if (other.validFrom >= scheme.validFrom) {
      return refused(refusal('STARTS_BEFORE_LATEST', `"${other.name}" applies from ${other.validFrom}; a new scheme starts after it (schemes follow each other).`))
    }
    if (other.validTo !== null) return refused(refusal('OVERLAPS', `"${other.name}" applies until ${other.validTo}; start this one after that day.`))
    retires.push({ id: other.id, name: other.name, validTo: plusDays(scheme.validFrom, -1) })
  }
  return { plan: { retires }, refusal: null }
}

/**
 * Ending an ACTIVE scheme that no later scheme follows (its last day, set once; RETIRED): the last day today or later
 * and not before its first day; refused while piece pay is ON at a site with it (stop piece pay there first, or start
 * the scheme that follows: a later scheme takes over without a gap).
 */
export function endRefusal(input: {
  readonly scheme: Pick<SchemeRow, 'name' | 'status' | 'validFrom' | 'validTo'>
  readonly lastDay: BusinessDate
  readonly today: BusinessDate
  /** The sites whose piece pay is ON with this scheme. */
  readonly onAt: readonly string[]
}): SchemeRefusal | null {
  const { scheme, lastDay, today } = input
  if (scheme.status !== 'ACTIVE') return refusal('NOT_ACTIVE', `"${scheme.name}" is ${scheme.status.toLowerCase()}: only a scheme in force is ended (a draft is deleted).`)
  if (scheme.validTo !== null) return refusal('ENDS_SET', `"${scheme.name}" ends on ${scheme.validTo} already: its last day is set once.`)
  if (lastDay < today) return refusal('ENDS_IN_PAST', `A scheme ends today (${today}) or later: it never changes pay already worked.`)
  if (lastDay < scheme.validFrom) return refusal('ENDS_BEFORE_START', `"${scheme.name}" starts on ${scheme.validFrom}: its last day is that day or later.`)
  if (input.onAt.length > 0) {
    return refusal('IN_USE', `Piece pay is on at ${input.onAt.join(', ')} with "${scheme.name}": stop piece pay there first, or start the scheme that follows it (it takes over without a gap).`)
  }
  return null
}

/** Deleting a scheme: only a DRAFT, and only while no site's piece-pay switch names it. */
export function deleteRefusal(scheme: Pick<SchemeRow, 'name' | 'status'>, namedAt: readonly string[]): SchemeRefusal | null {
  const notDraft = scheme.status === 'DRAFT' ? null : refusal('NOT_DRAFT', `"${scheme.name}" is ${scheme.status.toLowerCase()}: it is kept for good (end it instead).`)
  if (notDraft) return notDraft
  return namedAt.length > 0 ? refusal('NAMED_BY_SWITCH', `The piece-pay switch of ${namedAt.join(', ')} names "${scheme.name}": name another scheme there first.`) : null
}

// ---- the pay periods a change touches -----------------------------------------------------------------------------------

/**
 * The company's pay periods a scheme's days touch (design "a change shows the periods it affects"): each period that
 * overlaps [from, to] with what the scheme does to it.
 */
export function affectedPeriods(periods: readonly PeriodRow[], from: BusinessDate, to: BusinessDate | null): { readonly id: string; readonly month: string; readonly status: PeriodStatus; readonly effect: PeriodEffect; readonly words: string }[] {
  return [...periods]
    .filter((period) => period.periodEnd >= from && (to === null || period.periodStart <= to))
    .sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0))
    .map((period) => {
      const effect: PeriodEffect = period.status === 'LOCKED' ? 'LOCKED' : period.status === 'OPEN' ? 'ACCRUES' : 'RUN_AGAIN'
      return { id: period.id, month: period.periodStart.slice(0, 7), status: period.status, effect, words: PERIOD_EFFECT_WORDS[effect] }
    })
}

/** The periods a scheme touches, in one sentence (no figure). */
export function periodsInWords(from: BusinessDate, to: BusinessDate | null, periods: readonly { readonly month: string; readonly effect: PeriodEffect }[]): string {
  const days = to === null ? `from ${from}` : `from ${from} to ${to}`
  if (periods.length === 0) return `Applies ${days}: no pay period of these days is made yet.`
  const again = periods.filter((period) => period.effect === 'RUN_AGAIN').map((period) => period.month)
  const open = periods.filter((period) => period.effect === 'ACCRUES').map((period) => period.month)
  const parts = [open.length > 0 ? `accrues in ${open.join(', ')}` : null, again.length > 0 ? `run ${again.join(', ')} again` : null].filter((part): part is string => part !== null)
  return `Applies ${days}: ${parts.length > 0 ? parts.join('; ') : 'no open pay period'}.`
}
