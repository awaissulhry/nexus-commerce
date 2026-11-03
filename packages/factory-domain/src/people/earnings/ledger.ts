import { toMinorUnits, type MinorUnits } from '../../core/money'
import { Dec, type Decimal } from '../../tax/decimal'
import { bonusOf, guaranteedPayOf, guaranteedPerMinuteOf, makeUpOf, type MakeUp, type SchemePay } from '../schemes/pay'
import { paysByPiece } from '../schemes/rules'

/**
 * The append-only ledger's bookkeeping (B-W2b-43; MES-256; c.c. art. 2101), pure. A source of pay (a scan, a member's share,
 * a block, a month's make-up) has one base key; what it pays now is its LIVE entry: the latest one nobody reversed. When the
 * facts move, the plan reverses the live entry and adds a new one under the next key (`scan:<id>`, `scan:<id>#2` …), never
 * an edit. A person's correction of an entry (`correct:<id>`) freezes its source: a later run pays it no more, the person's
 * adjustment stands instead.
 *
 * B-W2b-84: a standard-minute bonus scheme's period books its guaranteed pay as the make-up (its pieces pay nothing by the
 * piece, so the make-up to the guaranteed pay is the whole of it) and its bonus as a BONUS entry (`bonus:<period>:<person>`);
 * rework and scrap caused by others are paid time (`others:<scan>:<REWORK|SCRAP>`, OFF_STANDARD), booked by the period too.
 */

export const entryKey = Object.freeze({
  scan: (scanId: string): string => `scan:${scanId}`,
  rework: (scanId: string): string => `rework:${scanId}`,
  scrap: (scanId: string): string => `scrap:${scanId}`,
  team: (scanId: string, workerId: string): string => `team:${scanId}:${workerId}`,
  block: (blockId: string): string => `off:${blockId}`,
  makeUp: (periodId: string, employeeId: string): string => `makeup:${periodId}:${employeeId}`,
  /** A standard-minute bonus scheme's bonus of a person's period. */
  bonus: (periodId: string, employeeId: string): string => `bonus:${periodId}:${employeeId}`,
  /** Rework or scrap of a scan caused by others: paid time. */
  others: (scanId: string, what: 'REWORK' | 'SCRAP'): string => `others:${scanId}:${what}`,
  /** The system's reversal when the facts moved. */
  reverse: (entryId: string): string => `reverse:${entryId}`,
  /** A person's reversal: the source stays as they left it. */
  correct: (entryId: string): string => `correct:${entryId}`,
  /** The new line of a person's correction, or an adjustment of its own (`clientKey`: the idempotent request's). */
  adjust: (clientKey: string): string => `adjust:${clientKey}`,
})

/** The base key of an entry's key. */
export const baseKey = (key: string): string => key.replace(/#\d+$/, '')

/** The families the period run books, and the one scans book as they happen. */
export const isScanFamily = (key: string): boolean => /^(scan|rework|scrap):/.test(key)
export const isPeriodFamily = (key: string): boolean => /^(team|off|makeup|bonus|others):/.test(key)

/** The statement's code of a line of paid time for rework or scrap caused by others (REWORK_OTHERS, SCRAP_OTHERS); else null. */
export function othersCodeOf(key: string): string | null {
  const found = /^others:[^:]+:(REWORK|SCRAP)(#\d+)?$/.exec(key)
  return found ? `${found[1]}_OTHERS` : null
}

/** An entry as the plan reads it (decimals as text). */
export interface LedgerRow {
  readonly id: string
  readonly idempotencyKey: string
  readonly pieces: number | null
  readonly minutes: string | null
  readonly rate: string | null
  readonly amount: MinorUnits
  readonly reversalOfId: string | null
}

/** What a source should pay now. */
export interface Wanted {
  readonly key: string
  readonly pieces: number | null
  readonly minutes: string | null
  readonly rate: string | null
  readonly amount: MinorUnits
}

const sameDecimal = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : new Dec(a).equals(new Dec(b)))

/** The entry already pays this. */
export const samePay = (live: LedgerRow, wanted: Wanted): boolean => live.amount === wanted.amount && live.pieces === wanted.pieces && sameDecimal(live.minutes, wanted.minutes) && sameDecimal(live.rate, wanted.rate)

export interface LedgerPlan<W extends Wanted> {
  /** Entries to reverse, in the order read. */
  readonly reverse: readonly LedgerRow[]
  /** Entries to add, each under its next key. */
  readonly add: readonly (W & { readonly entryKey: string })[]
}

/** The sources a person corrected (`correct:<id>` reversed their entry): they pay no more by themselves. */
export function frozenBases(rows: readonly LedgerRow[]): Set<string> {
  const byId = new Map(rows.map((row) => [row.id, row]))
  return new Set(rows.flatMap((row) => (row.reversalOfId && row.idempotencyKey.startsWith('correct:') && byId.has(row.reversalOfId) ? [baseKey(byId.get(row.reversalOfId)!.idempotencyKey)] : [])))
}

/**
 * What the ledger needs for `wanted`, among `rows` (every entry of the sources concerned, reversals included). A live entry
 * of a family `managed` says is the plan's, and that nothing wants any more, is reversed. A source a person corrected is left
 * alone.
 */
export function planLedger<W extends Wanted>(rows: readonly LedgerRow[], wanted: readonly W[], managed: (key: string) => boolean): LedgerPlan<W> {
  const reversed = new Set(rows.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
  const frozen = frozenBases(rows)
  const live = new Map<string, LedgerRow>()
  const written = new Map<string, number>()
  for (const row of rows) {
    if (row.reversalOfId) continue
    const base = baseKey(row.idempotencyKey)
    written.set(base, (written.get(base) ?? 0) + 1)
    if (!reversed.has(row.id)) live.set(base, row)
  }
  const reverse: LedgerRow[] = []
  const add: (W & { readonly entryKey: string })[] = []
  const wantedKeys = new Set(wanted.map((item) => item.key))
  for (const item of wanted) {
    if (frozen.has(item.key)) continue
    const current = live.get(item.key)
    if (current && samePay(current, item)) continue
    if (current) reverse.push(current)
    const next = (written.get(item.key) ?? 0) + 1
    add.push({ ...item, entryKey: next === 1 ? item.key : `${item.key}#${next}` })
  }
  for (const [base, row] of live) if (managed(base) && !wantedKeys.has(base)) reverse.push(row)
  return { reverse, add }
}

/** pieces × rate per piece, in minor units, half up once. */
export const piecesAmount = (pieces: number, rate: string, currency: string): MinorUnits => toMinorUnits(new Dec(rate).times(pieces), currency)

/** One day's minutes under one scheme (a person's guaranteed pay is counted day by day: a scheme can change in a month). */
export interface PaidDay {
  readonly scheme: Pick<SchemePay, 'kind' | 'efficiencyThresholdPct' | 'guaranteedHourlyRate' | 'traineeHourlyRate' | 'currency'> & { readonly id: string }
  readonly minutes: number
  readonly trainee: boolean
}

interface DayGroup {
  readonly scheme: PaidDay['scheme']
  minutes: number
  trainee: number
}

function groupsOf(days: readonly PaidDay[]): DayGroup[] {
  const groups = new Map<string, DayGroup>()
  for (const day of days) {
    const group = groups.get(day.scheme.id) ?? { scheme: day.scheme, minutes: 0, trainee: 0 }
    group.minutes += day.minutes
    if (day.trainee) group.trainee += day.minutes
    groups.set(day.scheme.id, group)
  }
  return [...groups.values()].filter((group) => group.minutes > 0)
}

/**
 * The make-up of a period's days to their guaranteed pay; null with no minute. Days under a standard-minute bonus scheme
 * are paid their guaranteed pay whole (B-W2b-84): their pieces pay nothing by the piece, and what other days earned never
 * stands in for it. The other days are made up to their guaranteed pay by what was earned.
 */
export function periodMakeUp(days: readonly PaidDay[], earned: MinorUnits): MakeUp | null {
  const parts = groupsOf(days)
  if (parts.length === 0) return null
  const timed = parts.filter((part) => !paysByPiece(part.scheme))
  if (parts.length === 1 && timed.length === 0) return makeUpOf(parts[0]!.scheme, { minutesPresent: parts[0]!.minutes, traineeMinutes: parts[0]!.trainee, earned })
  const guaranteedOf = (part: DayGroup): MinorUnits => guaranteedPayOf(part.scheme, { minutesPresent: part.minutes, traineeMinutes: part.trainee })
  const timePay = timed.reduce((sum, part) => sum + guaranteedOf(part), 0)
  const pieceGuaranteed = parts.filter((part) => paysByPiece(part.scheme)).reduce((sum, part) => sum + guaranteedOf(part), 0)
  const guaranteed = timePay + pieceGuaranteed
  const minutes = parts.reduce((sum, part) => sum + part.minutes, 0)
  const currency = parts[0]!.scheme.currency
  const major = new Dec(guaranteed).dividedBy(new Dec(toMinorUnits('1', currency)))
  const ratePerMinute = parts.length === 1 ? guaranteedPerMinuteOf(parts[0]!.scheme) : major.dividedBy(minutes).toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed()
  return { minutes, ratePerMinute, guaranteed, earned, makeUp: timePay + Math.max(0, pieceGuaranteed - earned) }
}

/** One scan line of a period under a standard-minute bonus scheme (a SCAN, or a member's TEAM_SPLIT share). */
export interface BonusWork {
  readonly scheme: PaidDay['scheme'] & { readonly id: string }
  /** The pieces (a reversal's are negative). */
  readonly pieces: number
  /** The operation's standard minutes per piece. */
  readonly standardMinutes: string
  /** The rate per piece the pieces are worth (they are not paid by it). */
  readonly rate: string
  /** A team member's share, percent; null: their own scan. */
  readonly sharePct: string | null
}

/** A person's standard-minute bonus of a period, as the statement shows it and the BONUS entry books it. */
export interface PeriodBonus {
  readonly minutesPresent: number
  /** The standard minutes earned (three decimals). */
  readonly standardMinutes: string
  /** The minutes the threshold asks for (three decimals). */
  readonly thresholdMinutes: string
  /** Standard minutes earned ÷ minutes present, percent (two decimals). */
  readonly efficiencyPct: string
  /** The standard minutes earned above the threshold (three decimals): the BONUS entry's minutes. */
  readonly bonusMinutes: string
  readonly amount: MinorUnits
}

/**
 * The bonus of a period's days under standard-minute bonus schemes (B-W2b-84; MES-253; factory-domain schemes/pay bonusOf):
 * per scheme, its days' minutes present against the standard minutes its work earned, valued at what those pieces are worth
 * at their rates. Null when no day or work is under such a scheme. The caller passes this month's work only: work of an
 * earlier month paid now never moves this month's bonus.
 */
export function periodBonus(days: readonly PaidDay[], work: readonly BonusWork[]): PeriodBonus | null {
  const schemes = new Map<string, { scheme: BonusWork['scheme']; minutes: number; standard: Decimal; value: Decimal }>()
  const groupFor = (scheme: BonusWork['scheme']) => {
    const found = schemes.get(scheme.id) ?? { scheme, minutes: 0, standard: new Dec(0), value: new Dec(0) }
    schemes.set(scheme.id, found)
    return found
  }
  for (const part of groupsOf(days)) if (!paysByPiece(part.scheme)) groupFor(part.scheme).minutes += part.minutes
  for (const line of work) {
    if (paysByPiece(line.scheme)) continue
    const share = line.sharePct === null ? new Dec(1) : new Dec(line.sharePct).dividedBy(100)
    const group = groupFor(line.scheme)
    group.standard = group.standard.plus(new Dec(line.standardMinutes).times(line.pieces).times(share))
    group.value = group.value.plus(new Dec(line.rate).times(line.pieces).times(share))
  }
  if (schemes.size === 0) return null
  let minutesPresent = 0
  let standard = new Dec(0)
  let threshold = new Dec(0)
  let above = new Dec(0)
  let amount = 0
  for (const group of schemes.values()) {
    const earned = Dec.max(group.standard, 0).toDecimalPlaces(3, Dec.ROUND_HALF_UP)
    const value = Math.max(0, toMinorUnits(group.value, group.scheme.currency))
    const bonus = bonusOf(group.scheme, { minutesPresent: group.minutes, earnedStandardMinutes: earned.toFixed(), earnedValue: value })
    minutesPresent += group.minutes
    standard = standard.plus(earned)
    threshold = threshold.plus(bonus.thresholdMinutes)
    above = above.plus(bonus.bonusMinutes)
    amount += bonus.bonus
  }
  return {
    minutesPresent,
    standardMinutes: standard.toFixed(3),
    thresholdMinutes: threshold.toDecimalPlaces(3, Dec.ROUND_HALF_UP).toFixed(3),
    efficiencyPct: minutesPresent === 0 ? '0.00' : standard.times(100).dividedBy(minutesPresent).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2),
    bonusMinutes: above.toFixed(3),
    amount,
  }
}
