import type { BusinessDate } from '../../core/time'
import { minutesTo } from './cutoff'

/**
 * What must leave today and what will miss its promise (B-W2b-386; LOG-018 "Ship-today queue with carrier cut-off",
 * LOG-110 "At-risk shipment queue: orders not packed by the cut-off"), pure. Rule 1: the dispatch desk works the queue every
 * day.
 *
 * A shipment's (or an order's) ship-by day is the earliest current promise of its garments (B-W2b-301's promise per size,
 * else the date typed on the line or the order): the day the goods must leave. Against the site's day and its carrier's
 * cut-off (the site's wall clock):
 *
 *   LATE            the ship-by day is past and it has not left
 *   HELD            due (today or before) and a hold is in force: it misses unless the hold is released
 *   MISSED_CUT_OFF  due today, the cut-off passed (or the site does not work today) and it has not left
 *   AT_RISK         due today, not packed yet, and the cut-off comes within the warning window (no shipment drafted yet
 *                   counts as not packed: an order with ready garments due today and none on a shipment)
 *   DUE_TODAY       due today and on track (packed, or time enough before the cut-off)
 *   LATER           due after today
 *   NO_DATE         no promise known
 *
 * "Will miss the promise" = LATE, HELD or MISSED_CUT_OFF. The at-risk queue is those and AT_RISK.
 */

export const QUEUE_RISKS = ['LATE', 'HELD', 'MISSED_CUT_OFF', 'AT_RISK', 'DUE_TODAY', 'LATER', 'NO_DATE'] as const
export type QueueRisk = (typeof QUEUE_RISKS)[number]

export const WILL_MISS: readonly QueueRisk[] = Object.freeze(['LATE', 'HELD', 'MISSED_CUT_OFF'])
export const AT_RISK_QUEUE: readonly QueueRisk[] = Object.freeze(['LATE', 'HELD', 'MISSED_CUT_OFF', 'AT_RISK'])

/** Minutes before the cut-off from which a shipment not packed yet is at risk (the default; a reader may ask another). */
export const AT_RISK_MINUTES = 120
export const AT_RISK_MINUTES_RANGE = Object.freeze({ min: 15, max: 24 * 60 })

export interface RiskInput {
  readonly shipBy: BusinessDate | null
  /** The site's day now. */
  readonly today: BusinessDate
  readonly now: Date
  /** PACKED counts as packed; DRAFT (or no shipment yet: `null`) as not packed. */
  readonly status: 'DRAFT' | 'PACKED' | null
  readonly held: boolean
  /** The site works today (its calendar). */
  readonly siteOpen: boolean
  /** Today's cut-off of its carrier at the site (null: none known; then the end of the site's day counts). */
  readonly cutOffAt: Date | null
  /** The end of the site's day (the next day's start). */
  readonly dayEnd: Date
  readonly warnMinutes?: number | undefined
}

export function riskOf(input: RiskInput): QueueRisk {
  if (input.shipBy === null) return 'NO_DATE'
  if (input.shipBy > input.today) return 'LATER'
  if (input.held) return 'HELD'
  if (input.shipBy < input.today) return 'LATE'
  if (!input.siteOpen) return 'MISSED_CUT_OFF'
  const deadline = input.cutOffAt ?? input.dayEnd
  const left = minutesTo(deadline, input.now)
  if (left < 0) return 'MISSED_CUT_OFF'
  if (input.status !== 'PACKED' && left <= (input.warnMinutes ?? AT_RISK_MINUTES)) return 'AT_RISK'
  return 'DUE_TODAY'
}

/** The order the at-risk queue lists them in: the worst first. */
export const riskRank = (risk: QueueRisk): number => QUEUE_RISKS.indexOf(risk)

export const willMiss = (risk: QueueRisk): boolean => WILL_MISS.includes(risk)

/** The earliest of some days (null: none). */
export function earliestDay(days: readonly (BusinessDate | null)[]): BusinessDate | null {
  return days.reduce<BusinessDate | null>((best, day) => (day !== null && (best === null || day < best) ? day : best), null)
}
