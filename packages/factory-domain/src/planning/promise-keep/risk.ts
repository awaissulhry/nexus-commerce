import { daysFrom, plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { dayWords } from '../promise/rules'

/**
 * Orders at risk (B-W2b-317; PLN-174; design planning.promise › lines "Planned finish (from the board)", "Slack days",
 * "Risk: On time · At risk · Late"): an open order line's promise against the day the plan says it is ready.
 *
 *   LATE          the promise day has passed and pieces are still open
 *   AT_RISK       the planned finish is after the promise, or nothing says when it is ready (no date within the horizon,
 *                 a size no certificate covers)
 *   NOT_PROMISED  pieces are open and no date was ever promised for them
 *   ON_TIME       the planned finish is on or before the promise
 *
 * The planned finish of a size is the latest of what makes it: stock ready now (today), each open work order at the
 * board's planned finish (its due date when it is not on the board), moved later by the days its material comes after
 * its planned start (a late supplier date replans what it feeds, PLN-200), the plan's planned work orders on their due
 * date, and the promise engine's earliest day for the pieces nothing makes yet (B-W2b-301).
 */

export const RISK_STATES = ['LATE', 'AT_RISK', 'NOT_PROMISED', 'ON_TIME'] as const
export type RiskState = (typeof RISK_STATES)[number]

/** What sets a size's planned finish. */
export const FINISH_SOURCES = ['STOCK', 'BOARD', 'WORK_ORDER_DUE', 'PLANNED_ORDER', 'CAPABLE', 'NONE'] as const
export type FinishSource = (typeof FINISH_SOURCES)[number]

/** The saved-filter tiles of Promise dates (design planning.promise › tiles). */
export const PROMISE_TILES = ['AT_RISK', 'SLIPPED_THIS_MONTH', 'REPROMISE_WAITING', 'NO_CERTIFICATE'] as const
export type PromiseTile = (typeof PROMISE_TILES)[number]

const RANK: Readonly<Record<RiskState, number>> = Object.freeze({ LATE: 0, AT_RISK: 1, NOT_PROMISED: 2, ON_TIME: 3 })

/** The risk of open pieces: `finish` null with `finishKnown` false = nothing says when they are ready. */
export function riskOf(input: { readonly open: number; readonly promise: BusinessDate | null; readonly finish: BusinessDate | null; readonly today: BusinessDate }): RiskState | null {
  if (input.open <= 0) return null
  if (input.promise === null) return 'NOT_PROMISED'
  if (input.promise < input.today) return 'LATE'
  if (input.finish === null || input.finish > input.promise) return 'AT_RISK'
  return 'ON_TIME'
}

/** The worst of several (null: none open). */
export const worstRisk = (risks: readonly (RiskState | null)[]): RiskState | null =>
  risks.reduce<RiskState | null>((worst, risk) => (risk === null ? worst : worst === null || RANK[risk] < RANK[worst] ? risk : worst), null)

/** Days to spare (+) or short (−) between the planned finish and the promise; null without both. */
export const slackDays = (promise: BusinessDate | null, finish: BusinessDate | null): number | null => (promise === null || finish === null ? null : daysFrom(finish, promise))

/** Sorts LATE first, then AT_RISK, NOT_PROMISED, ON_TIME. */
export const riskRank = (risk: RiskState | null): number => (risk === null ? 9 : RANK[risk])

/**
 * A work order's finish when its material comes after its planned start: the planned finish moved by those days (the board
 * did not move the bar yet; PLN-200). `materialStart` is the first day its work may start with every material (B-W2b-312's
 * materialStartOf; null: no day known — the material is not covered).
 */
export function finishWithMaterial(input: { readonly plannedStart: BusinessDate | null; readonly plannedFinish: BusinessDate | null; readonly materialStart: BusinessDate | null; readonly notCovered: boolean }): { finish: BusinessDate | null; delayDays: number } {
  if (input.plannedFinish === null) return { finish: null, delayDays: 0 }
  if (input.notCovered) return { finish: null, delayDays: 0 }
  if (input.materialStart === null || input.plannedStart === null || input.materialStart <= input.plannedStart) return { finish: input.plannedFinish, delayDays: 0 }
  const delay = daysFrom(input.plannedStart, input.materialStart)
  return { finish: plusDays(input.plannedFinish, delay), delayDays: delay }
}

/** "At risk: ready 11 Dec, promised 4 Dec (7 days late)." */
export function riskWords(input: { readonly risk: RiskState | null; readonly promise: BusinessDate | null; readonly finish: BusinessDate | null; readonly today: BusinessDate; readonly label: string }): string {
  const { risk, promise, finish, today, label } = input
  if (risk === null) return `${label} has nothing left to make or ship.`
  if (risk === 'NOT_PROMISED') return `${label} has no promise yet${finish ? `: ready by ${dayWords(finish, today)}.` : '.'}`
  const promised = dayWords(promise!, today)
  if (risk === 'LATE') return `${label} is late: promised ${promised}${finish ? `, ready by ${dayWords(finish, today)}` : ', no ready date yet'}.`
  if (risk === 'AT_RISK') return finish === null ? `${label} is at risk: promised ${promised}, no ready date yet.` : `${label} is at risk: ready by ${dayWords(finish, today)}, promised ${promised} (${daysFrom(promise!, finish)} days late).`
  return `${label} is on time: ready by ${dayWords(finish!, today)}, promised ${promised}.`
}

/** The first and the next first day of the month of `today` (a month's slips). */
export function monthOf(today: BusinessDate): { readonly from: BusinessDate; readonly to: BusinessDate } {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`
  return { from: `${today.slice(0, 7)}-01`, to: next }
}
