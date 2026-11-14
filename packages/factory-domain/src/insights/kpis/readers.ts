import { BOARDS, kpisOfBoard } from '../dashboards/boards'
import { NUMBER_RULES } from '../reports/numbers'
import type { KpiUseKind } from './catalogue'

/**
 * Where each KPI is read (B-W2b-428; ANA-070; design home.kpis › a KPI › Where used), from the readers' own registries — never
 * typed by hand. A use is kept in KpiUse (B-W2b-381) while its KPI is in force; `POST /insights/kpis/sync` adds the uses the
 * registries name and removes the ones a registry no longer names. A registry here owns its readers: a use of a reader no
 * registry owns (made by an earlier step or by hand) is left alone.
 *
 *   DASHBOARD today   Today's key numbers (insights/reports/numbers: a number with `kpi`), the role home dashboard (ANA-001)
 *   DASHBOARD <board> Home › Insights › Dashboards (B-W2b-434; insights/dashboards/boards: each board's numbers and charts)
 *
 * A step that makes a reader of a KPI adds its registry here: dashboards (B-W2b-434), the morning digest and alert routes
 * (B-W2b-435), reports and portal pages that move onto the layer.
 */

export interface KpiReader {
  readonly usedIn: KpiUseKind
  readonly useKey: string
  readonly kpiKey: string
}

/** Today's key numbers, as a dashboard. */
export const TODAY_DASHBOARD = 'today'

/** Every use the registries name, each once, sorted. */
export function kpiReaders(): KpiReader[] {
  const out = new Map<string, KpiReader>()
  for (const rule of NUMBER_RULES) {
    if (rule.kpi) out.set(`${rule.kpi}|DASHBOARD|${TODAY_DASHBOARD}`, { usedIn: 'DASHBOARD', useKey: TODAY_DASHBOARD, kpiKey: rule.kpi })
  }
  // B-W2b-434: every dashboard's numbers (the stand-ins too) and the KPIs of its charts.
  for (const board of BOARDS) for (const kpiKey of kpisOfBoard(board)) out.set(`${kpiKey}|DASHBOARD|${board.key}`, { usedIn: 'DASHBOARD', useKey: board.key, kpiKey })
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, reader]) => reader)
}

/** The readers the registries own (`<usedIn>:<useKey>`): only their uses are removed when no longer named. */
export const ownedReaders = (): ReadonlySet<string> => new Set([`DASHBOARD:${TODAY_DASHBOARD}`, ...BOARDS.map((board) => `DASHBOARD:${board.key}`)])

export interface StoredUse {
  readonly id: string
  readonly kpiKey: string
  readonly usedIn: KpiUseKind
  readonly useKey: string
}

/** What a sync does: add the named uses of KPIs in force that are missing; remove the owned uses no registry names any more. */
export function usesPlan(stored: readonly StoredUse[], wanted: readonly KpiReader[], inForce: ReadonlySet<string>, owned: ReadonlySet<string> = ownedReaders()): { readonly add: KpiReader[]; readonly remove: StoredUse[] } {
  const id = (use: { kpiKey: string; usedIn: string; useKey: string }) => `${use.kpiKey}|${use.usedIn}|${use.useKey}`
  const have = new Set(stored.map(id))
  const want = new Set(wanted.map(id))
  return {
    add: wanted.filter((use) => inForce.has(use.kpiKey) && !have.has(id(use))),
    remove: stored.filter((use) => owned.has(`${use.usedIn}:${use.useKey}`) && !want.has(id(use))),
  }
}
