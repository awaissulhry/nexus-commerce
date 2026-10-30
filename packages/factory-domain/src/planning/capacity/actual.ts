import { businessDate } from '../../core/time'
import { Dec, type Decimal } from '../../tax/decimal'
import type { Bucket } from '../settings/buckets'
import { minutesText } from './available'

/**
 * A line's actual efficiency (PLN-014; B-W2a-16; design planning.settings "Line efficiency": planned % with the last four
 * weeks' actual next to it), pure: earned standard minutes over the minutes its people were planned to work.
 *
 *   earned     the good garments of the standing scans (a REPORT or CORRECTION no later UNDO or CORRECTION voids) of
 *              whole-garment bundles (no `part`; a sleeves bundle is part of a garment, not one) that are ACTIVE, sent from
 *              a station on the line, × the operation's frozen standard minutes; counted in the week the scan reached the
 *              server (the site's day).
 *   available  people × the line's working minutes that week (at 100 %: the actual efficiency is what the planned one
 *              is compared with).
 * Per line only (Statuto dei Lavoratori art. 4; Owner answers W1, F2): a scan's worker is never read, and nothing is kept
 * per station; the station only says which line the work was on.
 */

export interface EarnedScan {
  readonly id: string
  readonly kind: 'REPORT' | 'UNDO' | 'CORRECTION'
  readonly correctsId: string | null
  readonly bundleId: string
  readonly operationId: string
  readonly good: number
  readonly stationId: string | null
  readonly at: Date
}

export interface EarnedFacts {
  readonly scans: readonly EarnedScan[]
  readonly bundles: ReadonlyMap<string, { readonly part: string | null; readonly status: string }>
  /** Per garment, decimal strings. */
  readonly standardMinutes: ReadonlyMap<string, string>
  readonly lineOfStation: ReadonlyMap<string, string | null>
  readonly weeks: readonly Bucket[]
  readonly timeZone: string
}

/** Earned standard minutes per line and week: keys `<lineId>|<weekKey>`. */
export function earnedByLine(facts: EarnedFacts): Map<string, Decimal> {
  const voided = new Set(facts.scans.flatMap((scan) => (scan.correctsId ? [scan.correctsId] : [])))
  const out = new Map<string, Decimal>()
  for (const scan of facts.scans) {
    if (scan.kind === 'UNDO' || voided.has(scan.id) || scan.good <= 0 || scan.stationId === null) continue
    const bundle = facts.bundles.get(scan.bundleId)
    const lineId = facts.lineOfStation.get(scan.stationId) ?? null
    if (!bundle || bundle.part !== null || bundle.status !== 'ACTIVE' || lineId === null) continue
    const date = businessDate(scan.at, facts.timeZone)
    const week = facts.weeks.find((bucket) => date >= bucket.from && date <= bucket.to)
    if (!week) continue
    const key = `${lineId}|${week.key}`
    out.set(key, (out.get(key) ?? new Dec(0)).plus(new Dec(facts.standardMinutes.get(scan.operationId) ?? '0').times(scan.good)))
  }
  return out
}

/** One week of a line: earned, available at 100 % (people × working minutes) and the percent (null: nothing available). */
export function actualWeek(earned: Decimal, people: number, workingMinutes: number): { earnedMinutes: string; availableMinutes: string; pct: string | null } {
  const available = new Dec(workingMinutes).times(people)
  return {
    earnedMinutes: minutesText(earned),
    availableMinutes: minutesText(available),
    pct: available.gt(0) ? earned.div(available).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1) : null,
  }
}
