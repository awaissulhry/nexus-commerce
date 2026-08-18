/**
 * ⛔ PARKED 2026-08-18 (U8) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: this page's scope-reach helper.
 * Why it left: the Budget Schedules tab is now Helium 10's shape — the hourly-performance card over
 *   the schedules grid, and nothing else (`BudgetSchedulesTabClient.tsx`; study
 *   `docs/2026-08-16-ra-h10-reference-study.md` §3.7, §7.9).
 * Candidate home: travels with the page shell.
 *
 * ⚠ Nothing here was changed and no endpoint was retired — `/budget-manager*`, `/budget-binding`
 * and `/budget-schedules*` are all still served. The file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */
/**
 * BSP — the client-side scope resolution, lifted out of `BudgetScopeBar` when FB.2 deleted that bar.
 *
 * This page is the one in the section that resolves its own scope: it has no single grid read to
 * ask, and all six sections must agree on the campaign set, so the AND is computed once here and
 * handed to every section through the slot contract rather than re-derived six times.
 *
 * Pure and React-free, so `budget-schedules` keeps its property that the URL and scope rules are
 * unit-testable rather than clickable-only.
 */
import type { ResolvedScope, ScopeOptionsPayload } from './slot-contract'

export interface BspScopeValue {
  portfolio: string
  campaign: string
  line: string
}

export function resolveScope(
  options: ScopeOptionsPayload | null,
  market: string,
  scope: BspScopeValue,
): ResolvedScope {
  const all = options?.campaigns ?? []
  const applied: string[] = []

  let ids = all
  if (market !== 'all') { ids = ids.filter((c) => c.marketplace === market); applied.push('Market') }
  if (scope.portfolio) { ids = ids.filter((c) => c.portfolioId === scope.portfolio); applied.push('Portfolio') }
  if (scope.campaign) { ids = ids.filter((c) => c.id === scope.campaign); applied.push('Campaign') }
  if (scope.line) {
    const line = (options?.productLines ?? []).find((l) => l.id === scope.line)
    const set = new Set(line?.campaigns ?? [])
    ids = ids.filter((c) => set.has(c.id))
    applied.push('Product line')
  }

  // A contradiction is stated only once the options have actually loaded. Before that, zero
  // campaigns means "not known yet", and calling that a contradiction would accuse the operator of
  // an impossible scope every time the page mounts.
  const contradiction = options && applied.length > 1 && ids.length === 0
    ? `No campaign satisfies ${applied.join(' + ')} at the same time. Each of them matches something on its own; together they match nothing.`
    : null

  return { campaignIds: ids.map((c) => c.id), applied, contradiction }
}
