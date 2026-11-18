import { progressFigure, type ProgressFigure } from '../../../../lib/production/model'
import type { OrderWorkOrder } from '../api'
// F-SA-234b
import { RISK_STATES, type RiskState } from '../depth/api'
import type { Forecast } from '../depth/model'
import type { DepthPart } from '../depth/use-order-depth'
import type { ProductionState } from './overview/model'

/**
 * Lead fix (production-page lane): the order's Production tab showed `sewn ?? 0` — "0 sewn" where the site does not scan
 * sewing. A work order's progress there is ONE figure — the furthest step counted, its words and its bar from the same number
 * (lib/production `progressFigure`, rule R5) — plus the steps its site does not count (a null count: "—" with "Sewing not
 * counted here"), never 0. Not released: no figure, no steps.
 */
export const COUNTED_STEPS = ['cut', 'sewn', 'finished'] as const
export type CountedStep = (typeof COUNTED_STEPS)[number]

export function productionProgress(row: Pick<OrderWorkOrder, 'progress' | 'pieces' | 'status'>): { readonly figure: ProgressFigure; readonly notCounted: readonly CountedStep[] } {
  const released = row.status !== 'DRAFT'
  const figure = progressFigure(row.progress, row.pieces, released)
  const notCounted = released && row.progress ? COUNTED_STEPS.filter((step) => row.progress![step] === null) : []
  return { figure, notCounted }
}

// ── F-SA-234 (sales page plan N2, picks P2, P3, P12; 10-order-page §2.3 P1) ───────────────────────────────────────────────────────
/** What a work order makes for THIS order (the production read's own share: its cells of this order's lines; null where not counted). */
export interface OwnShare {
  readonly cells: number
  readonly pieces: number
  readonly cut: number | null
  readonly sewn: number | null
  readonly checked: number | null
}

/**
 * ONE figure of the order's OWN cells on a work order (never the work order's total): the furthest step reached — cut, sewn, or
 * checked (released by quality) — its words and its bar from the same number (rule R5); a step its site does not count is listed
 * as "not counted here", never 0. Not released: no figure.
 */
export function ownProgress(own: OwnShare, status: string): { readonly figure: ProgressFigure; readonly notCounted: readonly CountedStep[] } {
  const released = status !== 'DRAFT'
  const counts = { cut: own.cut, bundled: null, sewn: own.sewn, finished: own.checked }
  const figure = progressFigure(counts, own.pieces, released)
  const notCounted = released ? COUNTED_STEPS.filter((step) => counts[step] === null) : []
  return { figure, notCounted }
}

/** "Made for this order": its own pieces of the work order's whole (when the whole is read), and what else it makes, in words. */
export function madeForOf(own: OwnShare, total: number | null, also: { readonly orders: readonly { readonly number: string }[]; readonly more: number }, shared: boolean, cutTogether: boolean): { readonly key: string; readonly params: Record<string, string | number> }[] {
  const out: { key: string; params: Record<string, string | number> }[] = [total !== null && total > own.pieces ? { key: 'production.own.of', params: { own: own.pieces, total } } : { key: 'production.own.all', params: { own: own.pieces } }]
  if (also.orders.length > 0) out.push({ key: 'production.own.alsoMakes', params: { number: also.orders.map((order) => order.number).join(', ') } })
  if (also.more > 0) out.push({ key: 'production.own.alsoMore', params: { count: also.more } })
  // A work order made before the one-customer rule: "also makes work of other orders" — no number, no name, no count of theirs.
  if (shared) out.push({ key: 'production.own.alsoOther', params: {} })
  if (cutTogether) out.push({ key: 'production.own.cutTogether', params: {} })
  return out
}
// ── end F-SA-234

// ── F-SA-234b (sales page plan N2, P16; sa-7's follow-up): the by-line finish forecast from the order's OWN production read ─────────
/**
 * The finish forecast per line, from the production read's `dates.forecast` (planning.promise.view; the API reads the plan for this
 * order's own lines only) — no longer a wide read of every site's promise lines. Null: the reader has no promise right (withheld) or
 * the page has not asked the production read; reading / failed as the read is (its one failure is said once on the tab).
 */
export function forecastPart(state: ProductionState | null | undefined): DepthPart<ReadonlyMap<string, Forecast>> | null {
  if (!state) return null
  if (state.status === 'loading') return { value: null, problem: null }
  if (state.status === 'failed') return { value: null, problem: state.problem }
  const forecast = state.read.dates?.forecast ?? null
  if (state.read.withheld.includes('dates.forecast') || forecast === null) return null
  const risks = new Set<string>(RISK_STATES)
  return { value: new Map(forecast.map((line) => [line.lineId, { finish: line.finish, source: line.source, slackDays: line.slackDays, risk: line.risk && risks.has(line.risk) ? (line.risk as RiskState) : null }])), problem: null }
}
