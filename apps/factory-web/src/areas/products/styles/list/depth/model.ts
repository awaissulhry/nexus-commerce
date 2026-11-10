import type { StyleRow } from '../../api'
import type { GateSummaryRow } from '../../record/overview/api'

/**
 * The Styles list in depth (B-W2b-237; SCR-343), pure: the completeness column (B-W2b-231's gate summed up per row) and Set
 * season on the selected rows (the season text W1 keeps; W2b-5's seasons list later turns it into a pick).
 */

/** The list's release column: hidden (no right), read for the rows on screen, or why not. */
export type ListGate = { state: 'loading'; byStyle: Record<string, GateSummaryRow> } | { state: 'ready'; byStyle: Record<string, GateSummaryRow> } | { state: 'error'; problem: string; byStyle: Record<string, GateSummaryRow> }

export const NO_GATE: ListGate = { state: 'loading', byStyle: {} }

/** The ids the summary still has to read (rows not yet summed up). */
export const unreadIds = (rows: readonly Pick<StyleRow, 'id'>[], gate: ListGate): string[] => rows.map((row) => row.id).filter((id) => !(id in gate.byStyle))

/** The season W1 stores: at most 20 characters, trimmed; empty clears it. */
export const SEASON_MAX = 20

export function seasonProblem(season: string): string | null {
  if (season.trim().length > SEASON_MAX) return 'season.problem.long'
  if (/[\r\n\t]/.test(season)) return 'season.problem.oneLine'
  return null
}

export interface SeasonPlan {
  /** The rows the season changes (each PATCHed at its version). */
  change: StyleRow[]
  /** Already in that season: nothing to send. */
  same: StyleRow[]
  /** Archived: W1 refuses a change (reactivate first): left out. */
  archived: StyleRow[]
}

export function seasonPlan(rows: readonly StyleRow[], season: string): SeasonPlan {
  const next = season.trim() === '' ? null : season.trim()
  const plan: SeasonPlan = { change: [], same: [], archived: [] }
  for (const row of rows) {
    if (row.status === 'ARCHIVED') plan.archived.push(row)
    else if ((row.season ?? null) === next) plan.same.push(row)
    else plan.change.push(row)
  }
  return plan
}

/** The seasons the rows on screen use, most used first (quick picks: the free text stays the truth). */
export function seasonsInUse(rows: readonly Pick<StyleRow, 'season'>[]): string[] {
  const counts = new Map<string, number>()
  for (const row of rows) if (row.season) counts.set(row.season, (counts.get(row.season) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([season]) => season).slice(0, 6)
}

/** What Set season did: how many changed, and each refused row with its words (a key of `products-styles-depth`). */
export interface SeasonResult {
  done: number
  refused: Array<{ id: string; code: string; key: string }>
}
