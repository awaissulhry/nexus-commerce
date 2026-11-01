import { isMinorUnits, minorPlaces, toMinorUnits, type MinorUnits } from '../../core/money'
import { Dec, type Decimal } from '../../tax/decimal'
import type { IncentiveKind, OwnFaultPay, PaidTimeRate, SchemeRow, TeamSplit } from './rules'

/**
 * How a scheme computes pay (B-W2b-38; MES-257 make-up to guaranteed pay, MES-258 rework and scrap pay, MES-259 team
 * incentive split; c.c. arts. 2100-2101 and the CCNL minimum: piece pay is never below the guaranteed pay). Pure: the
 * period run of B-W2b-43 reads the facts (scans, minutes present, the scheme in force) and writes the earnings ledger
 * with these figures; the "Try the scheme" route shows them on made-up figures. Amounts are minor units of the scheme's
 * currency (integers, the ledger's `amount`), rates are decimal strings (per piece, or per minute: Decimal(18,6)), and
 * every rounding is half up at the minor unit or at six decimals, once.
 *
 *   guaranteed  the minutes present × the guaranteed rate per hour ÷ 60 (a trainee's minutes at their own rate)
 *   make-up     the guaranteed pay − what the period earned, when above 0 (MAKE_UP: the minutes present, the rate per
 *               minute, the amount). What counts as earned: the SCAN, TEAM_SPLIT and OFF_STANDARD entries (reversals
 *               included); never an earlier make-up, and never an ADJUSTMENT (HR's correction is paid on top: a
 *               correction of a scan is a reversal and a new SCAN entry, which counts)
 *   own fault   rework or scrap that was the worker's own fault: unpaid, at a reduced percent of the rate (a SCAN at the
 *               reduced rate) or at the full rate
 *   others      rework or scrap caused by others, and waiting that is not the worker's doing: paid time (OFF_STANDARD),
 *               at the worker's average per minute or at the guaranteed rate; never unpaid. With no average yet (no
 *               minute on standard work) the guaranteed rate is used
 *   team split  a team's pay for a scan shared by each member's hours present or skill weight; the shares add up to the
 *               team's pay exactly (largest remainder, ties to the member listed first)
 *   bonus       STANDARD_MINUTE_BONUS: the guaranteed pay for the minutes present, plus the value of the standard
 *               minutes earned above the threshold (the earned value × the minutes above ÷ the minutes earned)
 *
 * Nothing here names a person: the caller passes one person's figures and keeps them inside that person's record.
 */

/** The pay columns of a scheme. */
export type SchemePay = Pick<
  SchemeRow,
  'kind' | 'efficiencyThresholdPct' | 'guaranteedHourlyRate' | 'traineeHourlyRate' | 'teamSplit' | 'reworkOwnFault' | 'scrapOwnFault' | 'ownFaultRatePct' | 'othersFaultPay' | 'waitingPay' | 'currency'
>

/** The longest period a figure covers: a month of every minute (31 × 24 × 60). */
export const MINUTES_MAX = 44_640
const RATE_SCALE = 6

/** A figure the computation cannot take (a negative minute, a share of nothing): a programming error of the caller. */
export class SchemePayError extends RangeError {
  override name = 'SchemePayError'
}

const minutesOk = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= MINUTES_MAX
function needMinutes(value: number, what: string): void {
  if (!minutesOk(value)) throw new SchemePayError(`${what}: whole minutes from 0 to ${MINUTES_MAX}, not ${String(value)}`)
}
function needMinor(value: number, what: string): void {
  if (!isMinorUnits(value)) throw new SchemePayError(`${what}: an amount in minor units, not ${String(value)}`)
}
const rateText = (value: Decimal): string => value.toDecimalPlaces(RATE_SCALE, Dec.ROUND_HALF_UP).toFixed()
/** Major units (a decimal) to minor units of the currency, half up. */
const minorOf = (value: Decimal, currency: string): MinorUnits => toMinorUnits(value, currency)
/** Minor units to major units. */
const majorOf = (minor: MinorUnits, currency: string): Decimal => new Dec(minor).dividedBy(new Dec(10).pow(minorPlaces(currency)))

/** The guaranteed rate per hour, or a SchemePayError when the scheme has none (it cannot be ACTIVE then). */
function hourlyOf(scheme: Pick<SchemePay, 'guaranteedHourlyRate'>): Decimal {
  if (scheme.guaranteedHourlyRate === null) throw new SchemePayError('the scheme has no guaranteed pay')
  return new Dec(scheme.guaranteedHourlyRate)
}

/** The guaranteed rate per minute (six decimals), as the ledger's MAKE_UP rate shows it. */
export const guaranteedPerMinuteOf = (scheme: Pick<SchemePay, 'guaranteedHourlyRate'>): string => rateText(hourlyOf(scheme).dividedBy(60))

/** The guaranteed pay of the minutes present (a trainee's minutes at their own rate when the scheme has one). */
export function guaranteedPayOf(scheme: Pick<SchemePay, 'guaranteedHourlyRate' | 'traineeHourlyRate' | 'currency'>, input: { readonly minutesPresent: number; readonly traineeMinutes?: number | undefined }): MinorUnits {
  const trainee = input.traineeMinutes ?? 0
  needMinutes(input.minutesPresent, 'minutes present')
  needMinutes(trainee, 'trainee minutes')
  if (trainee > input.minutesPresent) throw new SchemePayError('trainee minutes are part of the minutes present')
  const hourly = hourlyOf(scheme)
  const traineeHourly = scheme.traineeHourlyRate === null ? hourly : new Dec(scheme.traineeHourlyRate)
  const major = hourly.times(input.minutesPresent - trainee).plus(traineeHourly.times(trainee)).dividedBy(60)
  return minorOf(major, scheme.currency)
}

/** One kind of earnings entry and its amount (minor units; a reversal negative). */
export interface EarnedEntry {
  readonly kind: 'SCAN' | 'TEAM_SPLIT' | 'MAKE_UP' | 'OFF_STANDARD' | 'ADJUSTMENT'
  readonly amount: MinorUnits
}

/** What a period earned towards its guaranteed pay: SCAN, TEAM_SPLIT and OFF_STANDARD (no make-up, no adjustment). */
export function earnedForMakeUp(entries: readonly EarnedEntry[]): MinorUnits {
  let total = 0
  for (const entry of entries) {
    needMinor(entry.amount, 'an entry')
    if (entry.kind === 'SCAN' || entry.kind === 'TEAM_SPLIT' || entry.kind === 'OFF_STANDARD') total += entry.amount
  }
  return total
}

/** A period's make-up to guaranteed pay (MES-257): what the MAKE_UP entry carries. */
export interface MakeUp {
  /** The minutes present (the entry's minutes; 0: no make-up entry). */
  readonly minutes: number
  /** The guaranteed rate per minute (the entry's rate). */
  readonly ratePerMinute: string
  readonly guaranteed: MinorUnits
  readonly earned: MinorUnits
  /** The top-up: the guaranteed pay − the earned, when above 0; else 0. */
  readonly makeUp: MinorUnits
}

/** The make-up of one person's period (c.c. art. 2101; the CCNL minimum: piece pay is never below the guaranteed pay). */
export function makeUpOf(scheme: Pick<SchemePay, 'guaranteedHourlyRate' | 'traineeHourlyRate' | 'currency'>, input: { readonly minutesPresent: number; readonly traineeMinutes?: number | undefined; readonly earned: MinorUnits }): MakeUp {
  needMinor(input.earned, 'earned')
  const guaranteed = guaranteedPayOf(scheme, input)
  return { minutes: input.minutesPresent, ratePerMinute: guaranteedPerMinuteOf(scheme), guaranteed, earned: input.earned, makeUp: Math.max(0, guaranteed - input.earned) }
}

/** The worker's average earnings per minute on standard work (six decimals, major units), null with no minute. */
export function averagePerMinuteOf(input: { readonly earned: MinorUnits; readonly minutes: number; readonly currency: string }): string | null {
  needMinor(input.earned, 'earned')
  needMinutes(input.minutes, 'minutes on standard work')
  if (input.minutes === 0 || input.earned <= 0) return null
  return rateText(majorOf(input.earned, input.currency).dividedBy(input.minutes))
}

/** Paid time not spent on pieces (OFF_STANDARD): its rate per minute and amount. */
export interface PaidTime {
  readonly basis: PaidTimeRate
  readonly minutes: number
  readonly ratePerMinute: string
  readonly amount: MinorUnits
}

/**
 * Time paid at a scheme's rule (waiting, rework or scrap caused by others): at the average per minute, or at the
 * guaranteed rate (also when the average is not known yet). Never unpaid (c.c. art. 2100).
 */
export function paidTimeOf(scheme: Pick<SchemePay, 'guaranteedHourlyRate' | 'currency'>, input: { readonly rule: PaidTimeRate; readonly minutes: number; readonly averagePerMinute: string | null }): PaidTime {
  needMinutes(input.minutes, 'paid minutes')
  const basis: PaidTimeRate = input.rule === 'AVERAGE' && input.averagePerMinute !== null ? 'AVERAGE' : 'GUARANTEED'
  const perMinute = basis === 'AVERAGE' ? new Dec(input.averagePerMinute!) : hourlyOf(scheme).dividedBy(60)
  const amount = basis === 'AVERAGE' ? minorOf(perMinute.times(input.minutes), scheme.currency) : minorOf(hourlyOf(scheme).times(input.minutes).dividedBy(60), scheme.currency)
  return { basis, minutes: input.minutes, ratePerMinute: rateText(perMinute), amount }
}

/** What rework or scrap pays (MES-258): nothing, pieces at a rate (a SCAN), or paid time (OFF_STANDARD). */
export type DefectPay =
  | { readonly pays: 'NOTHING'; readonly rule: OwnFaultPay; readonly amount: 0 }
  | { readonly pays: 'PIECES'; readonly rule: OwnFaultPay; readonly pieces: number; readonly rate: string; readonly amount: MinorUnits }
  | { readonly pays: 'TIME'; readonly rule: PaidTimeRate; readonly time: PaidTime; readonly amount: MinorUnits }

export const DEFECT_KINDS = ['REWORK', 'SCRAP'] as const
export type DefectKind = (typeof DEFECT_KINDS)[number]
export const FAULTS = ['OWN', 'OTHERS'] as const
export type Fault = (typeof FAULTS)[number]

/**
 * The pay of rework or scrap (MES-258). Own fault: the scheme's rule for rework or scrap (unpaid, the reduced percent of
 * the operation's rate per piece, or the full rate); caused by others: the minutes it took, paid as time off standard at
 * the scheme's rule (average or guaranteed). Who is at fault is the caller's fact (B-W2b-43): the scheme only prices it.
 */
export function defectPayOf(
  scheme: Pick<SchemePay, 'reworkOwnFault' | 'scrapOwnFault' | 'ownFaultRatePct' | 'othersFaultPay' | 'guaranteedHourlyRate' | 'currency'>,
  input: { readonly what: DefectKind; readonly fault: Fault; readonly pieces: number; readonly ratePerPiece: string; readonly minutes: number; readonly averagePerMinute: string | null },
): DefectPay {
  if (!Number.isInteger(input.pieces) || input.pieces < 0) throw new SchemePayError(`pieces: a whole number from 0, not ${String(input.pieces)}`)
  if (input.fault === 'OTHERS') {
    const time = paidTimeOf(scheme, { rule: scheme.othersFaultPay, minutes: input.minutes, averagePerMinute: input.averagePerMinute })
    return { pays: 'TIME', rule: scheme.othersFaultPay, time, amount: time.amount }
  }
  const rule = input.what === 'REWORK' ? scheme.reworkOwnFault : scheme.scrapOwnFault
  if (rule === 'UNPAID') return { pays: 'NOTHING', rule, amount: 0 }
  const full = new Dec(input.ratePerPiece)
  if (full.isNegative()) throw new SchemePayError('a rate per piece is 0 or more')
  if (rule === 'REDUCED_RATE' && scheme.ownFaultRatePct === null) throw new SchemePayError('the scheme reduces the rate but has no percent')
  // The applied rate is rounded first, so the ledger row's pieces × rate is its amount.
  const rate = rule === 'FULL_RATE' ? rateText(full) : rateText(full.times(new Dec(scheme.ownFaultRatePct!)).dividedBy(100))
  return { pays: 'PIECES', rule, pieces: input.pieces, rate, amount: minorOf(new Dec(rate).times(input.pieces), scheme.currency) }
}

/** One member of a team operation, by a key the caller keeps (a worker id; a letter in an example). */
export interface TeamMember {
  readonly key: string
  /** HOURS_PRESENT: the member's minutes present. */
  readonly minutesPresent?: number | undefined
  /** SKILL_WEIGHT: the member's skill weight (a decimal 0 or more, e.g. their level in the operation's skill). */
  readonly skillWeight?: string | undefined
}

/** One member's share of a team's pay (TEAM_SPLIT: the share in percent and the amount). */
export interface TeamShare {
  readonly key: string
  readonly weight: string
  /** Percent of the team's pay, four decimals (0 for a member who weighs nothing: no entry for them). */
  readonly sharePct: string
  readonly amount: MinorUnits
}

/**
 * A team's pay shared among its members (MES-259): by each member's minutes present or skill weight. The amounts add up
 * to the team's pay exactly: each gets the whole minor units of their part, and the units left go one each to the largest
 * remainders (ties to the member listed first). At least one member must weigh something.
 */
export function teamSplitOf(input: { readonly basis: TeamSplit; readonly pay: MinorUnits; readonly members: readonly TeamMember[] }): TeamShare[] {
  needMinor(input.pay, 'team pay')
  if (input.pay < 0) throw new SchemePayError('a team pay is 0 or more (a correction reverses the entries)')
  if (input.members.length === 0) throw new SchemePayError('a team has members')
  const keys = new Set<string>()
  const weights = input.members.map((member) => {
    if (keys.has(member.key)) throw new SchemePayError(`member ${member.key} is listed twice`)
    keys.add(member.key)
    if (input.basis === 'HOURS_PRESENT') {
      needMinutes(member.minutesPresent ?? -1, `minutes present of ${member.key}`)
      return new Dec(member.minutesPresent!)
    }
    const weight = member.skillWeight === undefined || !/^\d{1,6}(\.\d{1,4})?$/.test(member.skillWeight) ? null : new Dec(member.skillWeight)
    if (weight === null) throw new SchemePayError(`skill weight of ${member.key}: a decimal 0 or more with at most 4 decimals`)
    return weight
  })
  const total = weights.reduce((sum, weight) => sum.plus(weight), new Dec(0))
  if (total.isZero()) throw new SchemePayError('no member of the team weighs anything: nothing to share by')
  const exact = weights.map((weight) => weight.times(input.pay).dividedBy(total))
  const floors = exact.map((value) => value.floor())
  let left = input.pay - floors.reduce((sum, value) => sum + Number.parseInt(value.toFixed(0), 10), 0)
  const order = exact.map((value, index) => ({ index, remainder: value.minus(floors[index]!) })).sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index)
  const extra = new Array<number>(weights.length).fill(0)
  for (const { index } of order) {
    if (left <= 0) break
    extra[index] = 1
    left -= 1
  }
  return input.members.map((member, index) => ({
    key: member.key,
    weight: weights[index]!.toFixed(),
    sharePct: weights[index]!.times(100).dividedBy(total).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(),
    amount: Number.parseInt(floors[index]!.toFixed(0), 10) + extra[index]!,
  }))
}

/** The standard-minute bonus of one person's period. */
export interface Bonus {
  /** Standard minutes earned ÷ minutes present, in percent (two decimals). */
  readonly efficiencyPct: string
  /** The minutes the threshold asks for (three decimals). */
  readonly thresholdMinutes: string
  /** The standard minutes earned above them (three decimals, 0 or more). */
  readonly bonusMinutes: string
  readonly bonus: MinorUnits
}

/**
 * STANDARD_MINUTE_BONUS: the bonus for the standard minutes earned above the threshold (percent of the minutes present),
 * at the value those minutes earned at the rates (the value of all the standard minutes earned, pro rata).
 */
export function bonusOf(scheme: Pick<SchemePay, 'efficiencyThresholdPct' | 'currency'>, input: { readonly minutesPresent: number; readonly earnedStandardMinutes: string; readonly earnedValue: MinorUnits }): Bonus {
  needMinutes(input.minutesPresent, 'minutes present')
  needMinor(input.earnedValue, 'earned value')
  if (scheme.efficiencyThresholdPct === null) throw new SchemePayError('a standard-minute bonus has a threshold')
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(input.earnedStandardMinutes)) throw new SchemePayError('standard minutes: a decimal 0 or more with at most 3 decimals')
  const earned = new Dec(input.earnedStandardMinutes)
  const threshold = new Dec(input.minutesPresent).times(new Dec(scheme.efficiencyThresholdPct)).dividedBy(100)
  const above = earned.minus(threshold)
  const bonusMinutes = above.greaterThan(0) ? above : new Dec(0)
  const bonus = earned.isZero() || input.earnedValue <= 0 ? 0 : minorOf(majorOf(input.earnedValue, scheme.currency).times(bonusMinutes).dividedBy(earned), scheme.currency)
  return {
    efficiencyPct: input.minutesPresent === 0 ? '0' : earned.times(100).dividedBy(input.minutesPresent).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(),
    thresholdMinutes: threshold.toDecimalPlaces(3, Dec.ROUND_HALF_UP).toFixed(),
    bonusMinutes: bonusMinutes.toDecimalPlaces(3, Dec.ROUND_HALF_UP).toFixed(),
    bonus,
  }
}

/** One person's period under a scheme, as the statement shows it. */
export interface PeriodPay {
  readonly kind: IncentiveKind
  readonly guaranteed: MinorUnits
  /** What the pieces, team shares and paid time earned (PIECE_RATE, TEAM_INCENTIVE); the time pay (BONUS). */
  readonly earned: MinorUnits
  readonly bonus: Bonus | null
  readonly makeUp: MakeUp | null
  readonly total: MinorUnits
}

/**
 * One person's pay of a period under a scheme. PIECE_RATE and TEAM_INCENTIVE: the earned (pieces, team shares, paid time)
 * made up to the guaranteed pay. STANDARD_MINUTE_BONUS: the guaranteed pay for the minutes present (the paid time is in
 * those minutes) and the bonus.
 */
export function periodPayOf(
  scheme: SchemePay,
  input: {
    readonly minutesPresent: number
    readonly traineeMinutes?: number | undefined
    /** SCAN entries, TEAM_SPLIT shares and OFF_STANDARD time (earnedForMakeUp). */
    readonly earned: MinorUnits
    /** STANDARD_MINUTE_BONUS: the standard minutes earned and their value at the rates. */
    readonly earnedStandardMinutes?: string | undefined
    readonly earnedValue?: MinorUnits | undefined
  },
): PeriodPay {
  if (scheme.kind === 'STANDARD_MINUTE_BONUS') {
    const guaranteed = guaranteedPayOf(scheme, input)
    const bonus = bonusOf(scheme, { minutesPresent: input.minutesPresent, earnedStandardMinutes: input.earnedStandardMinutes ?? '0', earnedValue: input.earnedValue ?? 0 })
    return { kind: scheme.kind, guaranteed, earned: guaranteed, bonus, makeUp: null, total: guaranteed + bonus.bonus }
  }
  const makeUp = makeUpOf(scheme, input)
  return { kind: scheme.kind, guaranteed: makeUp.guaranteed, earned: input.earned, bonus: null, makeUp, total: input.earned + makeUp.makeUp }
}
