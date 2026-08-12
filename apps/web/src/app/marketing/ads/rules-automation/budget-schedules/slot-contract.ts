/**
 * BSP.0 — the typed seam between this page's shell and its six sections.
 *
 * Same shape as `bid/slot-contract.ts` and `negative-targeting/slot-contract.ts`, for the same
 * reason: seven sessions add content to this page after this one, and each of them should be one
 * new file plus one import line. Nobody restructures the client, and nobody re-derives what scope
 * means.
 *
 * The rule this file exists to enforce: **a section never reads the URL and never fetches its own
 * scope.** It receives the resolved scope and the campaign ids that scope reaches, and it writes
 * back through `push`. Two sections asking the same question of `useSearchParams` is how eleven
 * pages ended up with eleven vocabularies for one filter.
 */
import type { BspMetric, BspOpen, BspUrlState } from './urlState'
import type { CalendarDay } from './planMath'

/** The `GET /advertising/budget-manager` row, verbatim from `ads-budget-manager.service.ts`. */
export interface BudgetPlanRow {
  /** 🔴 null means "this market has spend but no plan" — the service unions both sources. */
  id: string | null
  marketplace: string
  tag: string | null
  month: string
  monthlyBudgetCents: number
  autoPacing: boolean
  stopOverSpend: boolean
  calendar: Array<{ day: number; pct: number }>
  campaignLimitCount: number
  spendCents: number | null
  /** spend / budget. null when there is no budget to divide by. */
  pct: number | null
  /** pace-to-date, calendar-weighted when a calendar exists. */
  expectedPct: number
  status: 'on-track' | 'over' | 'under' | 'no-budget'
  /** cents per day, index 0 = day 1 of the month. */
  daily: number[]
  forecastSpendCents: number | null
  projectedOverspend: boolean
  lastMonth: { month: string; budgetCents: number; spendCents: number | null; pct: number | null; daily: number[] }
  nextMonthBudgetCents: number | null
}

export interface BudgetManagerResult {
  month: string
  prevMonth: string
  nextMonth: string
  daysInMonth: number
  dayOfMonth: number
  rows: BudgetPlanRow[]
  totals: {
    budgetCents: number
    spendCents: number
    pct: number
    lastMonthSpendCents: number
    nextMonthBudgetCents: number
  }
}

/** `GET /advertising/scope-options`, narrowed to the three fields the spine needs. */
export interface ScopeOptionsPayload {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  portfolios: Array<{ externalPortfolioId: string; name: string }>
  productLines: Array<{ id: string; sku: string; name: string; variations: number; campaigns: string[] }>
}

/**
 * What the spine resolved, computed client-side from `scope-options` using the same intersection
 * `ruleMatchesScope` ANDs server-side — so the reach a section shows and the reach a rule scoped
 * this way would cover are the same set.
 *
 * ⚠ This is the honest preview, not the authority. `resolveScopeReach()` on the server remains the
 * thing that refuses a write. BID.S0's page gets `applied`/`notes`/`contradiction` back from its
 * own grid endpoint; this page has no server payload to carry them and BSP.0 adds no route, so it
 * computes the same intersection here. Whoever extracts the shared bar must keep both paths.
 */
export interface ResolvedScope {
  /** Campaign ids the current scope reaches, after every grain is ANDed. */
  campaignIds: string[]
  /** Which grains actually narrowed, in the order they did, for the sentence under the spine. */
  applied: string[]
  /** Set when the combination can never resolve — e.g. a line with no campaign in this market. */
  contradiction: string | null
}

/**
 * The props every section receives. Additive only: a later session may add a field, never rename
 * one, because six sections and a rail read this type.
 */
export interface BspSlotProps {
  /** The whole normalised URL state. A section reads it; it never parses the URL itself. */
  url: BspUrlState
  /** market · portfolio · campaign · line, already resolved to the campaigns they reach. */
  scope: ResolvedScope
  metric: BspMetric
  weeks: number
  /** The single URL writer. `''` clears a param. */
  push: (patch: Record<string, string>) => void
  /** Open the inspector rail on a given entity. */
  openRail: (open: BspOpen) => void
  /** Pacing, shared with the pinned band so the page reads one number from one fetch. */
  pacing: { data: BudgetManagerResult | null; loading: boolean; error: string | null }
}

/** `GET /advertising/budget-manager/campaigns?marketplace=&month=` */
export interface BmCampaignRow {
  id: string
  name: string
  status: string
  dailyBudgetCents: number
  minCents: number | null
  maxCents: number | null
}
export interface BmCampaignsResult {
  marketplace: string
  month: string
  planId: string | null
  campaigns: BmCampaignRow[]
}

/**
 * `GET /advertising/budget-manager/enforcement?month=` — what the LIVE pacing engine would do right
 * now, from the same pure function the cron runs every 30 minutes.
 *
 * ⚠ The endpoint takes **`month` only** — no `marketplace` (`advertising.routes.ts:7585-7590`
 * passes `{ month: q.month }`). It returns every plan, so the page fetches once and filters by
 * marketplace client-side.
 *
 * ⚠ It returns plans only where `autoPacing || stopOverSpend`, and `pacingNeeded` is false unless
 * `projected > cap`. An absent plan therefore means "nothing armed", and an armed plan with no
 * campaign changes means "ran and would do nothing" — two different sentences, neither of them
 * "no data".
 */
export interface EnforcementCampaign {
  id: string
  name: string
  currentDailyCents: number
  targetDailyCents: number | null
  deltaCents: number
  clamp: 'min' | 'max' | 'floor' | null
  suppress: boolean
  restore: boolean
  currentlySuppressed: boolean
}
export interface EnforcementPlan {
  marketplace: string
  month: string
  capCents: number
  mtdSpendCents: number
  remainingBudgetCents: number
  remainingDays: number
  dayOfMonth: number
  daysInMonth: number
  autoPacing: boolean
  stopOverSpend: boolean
  capReached: boolean
  todayTargetCents: number | null
  campaigns: EnforcementCampaign[]
}
export interface EnforcementResult {
  month: string
  plans: EnforcementPlan[]
  totals: { plans: number; budgetChanges: number; suppressing: number; restoring: number; netDeltaCents: number }
}

/** `GET /advertising/ads-mode` — whether a downstream campaign write reaches Amazon at all. */
export interface AdsMode {
  mode: string
  liveWriteCount: number
}

/** The body `POST /advertising/budget-manager/plans` accepts. Idempotent by `(marketplace, month, tag)`. */
export interface UpsertPlanBody {
  id?: string
  marketplace: string
  month: string
  tag?: string | null
  monthlyBudgetCents?: number
  autoPacing?: boolean
  stopOverSpend?: boolean
  calendar?: CalendarDay[]
}

/**
 * How a write ended. `refused` is NOT `broke` — see `SectionShell`'s EmptyKind note.
 *
 * A 4xx is the server declining a value it understood; a 5xx or a thrown fetch is the system
 * failing. Rendering the first as the second is what makes a working product look broken, which is
 * the defect this programme exists to remove.
 */
export type WriteOutcome =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; at: number }
  | { state: 'refused'; message: string }
  | { state: 'broke'; message: string }
