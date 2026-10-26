/**
 * The coverage strip's header: how many campaigns are under rank control, out of how many, and whether nothing is open.
 *
 * 6a (2026-10-26) — an hourly plan holds Sponsored Products campaigns only, so a Sponsored Brands or Display campaign no
 * plan holds is not a gap. The API counts those apart (`notForHourlyPlans`); the share leaves them out of the total and
 * the strip names them on their own line. An answer without the count (an older API) is read as before.
 * No React/DB — unit-tested in coverageShare.vitest.test.ts.
 */
export interface CoverageCounts { total: number; covered: number; governed: number; uncovered: number; notForHourlyPlans?: unknown }

export interface CoverageShare {
  /** Campaigns under rank control: a schedule that is on, or a family plan. */
  held: number
  /** The campaigns a plan can hold: every campaign minus Brands/Display ones no plan holds. */
  total: number
  pct: number
  notForHourlyPlans: number
  /** No Sponsored Products campaign is uncovered (the API's `uncovered` counts those only). */
  clean: boolean
}

export function coverageShare(d: CoverageCounts): CoverageShare {
  const raw = d.notForHourlyPlans
  const notForHourlyPlans = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
  const held = d.covered + d.governed
  const total = Math.max(0, d.total - notForHourlyPlans)
  const pct = total > 0 ? Math.min(100, Math.round((held / total) * 100)) : 0
  return { held, total, pct, notForHourlyPlans, clean: d.uncovered === 0 }
}
