import { toMinorUnits, type MinorUnits } from '../../core/money'
import { Dec } from '../../tax/decimal'
import { guaranteedPayOf, makeUpOf, type MakeUp, type SchemePay } from '../schemes/pay'

/**
 * The append-only ledger's bookkeeping (B-W2b-43; MES-256; c.c. art. 2101), pure. A source of pay (a scan, a member's share,
 * a block, a month's make-up) has one base key; what it pays now is its LIVE entry: the latest one nobody reversed. When the
 * facts move, the plan reverses the live entry and adds a new one under the next key (`scan:<id>`, `scan:<id>#2` …), never
 * an edit. A person's correction of an entry (`correct:<id>`) freezes its source: a later run pays it no more, the person's
 * adjustment stands instead.
 */

export const entryKey = Object.freeze({
  scan: (scanId: string): string => `scan:${scanId}`,
  rework: (scanId: string): string => `rework:${scanId}`,
  scrap: (scanId: string): string => `scrap:${scanId}`,
  team: (scanId: string, workerId: string): string => `team:${scanId}:${workerId}`,
  block: (blockId: string): string => `off:${blockId}`,
  makeUp: (periodId: string, employeeId: string): string => `makeup:${periodId}:${employeeId}`,
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
export const isPeriodFamily = (key: string): boolean => /^(team|off|makeup):/.test(key)

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
  readonly scheme: Pick<SchemePay, 'guaranteedHourlyRate' | 'traineeHourlyRate' | 'currency'> & { readonly id: string }
  readonly minutes: number
  readonly trainee: boolean
}

/** The make-up of a period's days to their guaranteed pay; null with no minute. */
export function periodMakeUp(days: readonly PaidDay[], earned: MinorUnits): MakeUp | null {
  const groups = new Map<string, { scheme: PaidDay['scheme']; minutes: number; trainee: number }>()
  for (const day of days) {
    const group = groups.get(day.scheme.id) ?? { scheme: day.scheme, minutes: 0, trainee: 0 }
    group.minutes += day.minutes
    if (day.trainee) group.trainee += day.minutes
    groups.set(day.scheme.id, group)
  }
  const parts = [...groups.values()].filter((group) => group.minutes > 0)
  if (parts.length === 0) return null
  if (parts.length === 1) return makeUpOf(parts[0]!.scheme, { minutesPresent: parts[0]!.minutes, traineeMinutes: parts[0]!.trainee, earned })
  const guaranteed = parts.reduce((sum, part) => sum + guaranteedPayOf(part.scheme, { minutesPresent: part.minutes, traineeMinutes: part.trainee }), 0)
  const minutes = parts.reduce((sum, part) => sum + part.minutes, 0)
  const currency = parts[0]!.scheme.currency
  const major = new Dec(guaranteed).dividedBy(new Dec(toMinorUnits('1', currency)))
  return { minutes, ratePerMinute: major.dividedBy(minutes).toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed(), guaranteed, earned, makeUp: Math.max(0, guaranteed - earned) }
}
