/**
 * AR.S0 — the typed seam between this page and the nine sections that follow it.
 *
 * S0 builds the page; S1–S9 fill it. Each later section is meant to be **one new file and one
 * import line**, never a restructuring of `ApplyRulesClient`. That only holds if the props they
 * render against are declared now, before anyone needs them — a contract written after the fact is
 * just a description of whatever the first section happened to do, and by then the second section
 * has to match it.
 *
 * The build order (page study §14, and the brief):
 *
 *   S1  population band       replaces RuleImpactStrip's "0 bids adjusted" grain lie
 *   S2  governance columns    Managed · Bid bounds · Pins            (DISPLAY only)
 *   S3  settings columns      Bidding Strategy · Target ACoS · Bid Automation
 *   S4  performance + time    spend/sales/ACoS/budget/utilisation + the date control
 *   S5  writes                gate · bounds · pins · the confirm sentence · undo
 *   S6  automations column    the Managed / Off-limits verdict, engines included
 *   S7  row drawer            ceilings · write counts · pin note · changes · refusals
 *   S8  views & export        saved views · column sets · smart search · export resolved ids
 *   S9  assignment            bind automations at the grain a selection implies
 *
 * ── Three rules every section inherits ──────────────────────────────────────────────────────────
 *
 *   1. **Hidden, not disabled.** A section whose data does not exist renders nothing. A disabled
 *      button that will never enable is the same lie as a Target ACoS of "30.00%" on 220 campaigns
 *      that have no target set.
 *   2. **Every column renders at all four grains.** A column that only makes sense on a campaign
 *      row must say what it shows on a market row, or it does not ship. `AggregateRow` exists so
 *      that saying it is cheap.
 *   3. **Never render what no executor reads.** Grep for a READER before shipping a control. This
 *      page exists because five columns failed that test — three of them read fields no API returns.
 *
 * 🔴 **S0 is read-only and so is this contract.** `NO_WRITE_ACTIONS` exists so that the grid's
 * write-capable props are passed explicitly as absent rather than omitted — the difference between
 * "this page has not got round to writes" and "this page does not write" is the whole of S0's
 * safety story, and an omitted prop cannot say the second thing. (BID.S0's rule, and its reasoning.)
 */

import type { ReactNode } from 'react'
import type { CampaignRow } from './types'

export type { CampaignRow }

/**
 * The grain switch — the idea this page is built on.
 *
 * A scope bar that only *filters* was built on this surface once and REVERTED (RA §3.0), because
 * no pixel changed that a filter could not have changed. Grain is not a filter: it changes what a
 * row IS. Market is the FILTER and lives in `AdsPageHeader`; grain is the SWITCH and lives in the
 * grid toolbar. They compose — `market=IT & grain=campaign` is 150 rows, `market=all &
 * grain=market` is 4.
 */
export type ApplyRulesGrain = 'campaign' | 'portfolio' | 'line' | 'market'

export const APPLY_RULES_GRAINS: readonly ApplyRulesGrain[] = ['campaign', 'portfolio', 'line', 'market'] as const

export const GRAIN_LABEL: Record<ApplyRulesGrain, string> = {
  campaign: 'Campaigns', portfolio: 'Portfolios', line: 'Product lines', market: 'Markets',
}

/**
 * A non-campaign row: one market, one portfolio or one product line.
 *
 * 🔴 **An aggregate row does not have a `managed` boolean.** A market is not managed; a fraction of
 * its campaigns are. Every governance fact is therefore a count out of `n`, and a later section
 * that wants to render a toggle on one of these rows has to decide what it means for 150 campaigns
 * before it can — which is the point.
 */
export interface AggregateRow {
  key: string
  label: string
  n: number
  live: number
  managed: number
  bounded: number
  pinned: number
  delivering: number
  dailyBudgetCents: number
  /**
   * Why this row cannot reach everything, in the page's own words — "148 campaigns have no
   * portfolio", "campaigns may appear in more than one product line". **Rendered, never dropped.**
   * Line-grain rows overlap (Σ per-line = 224 against 220 campaigns), so a line-grain sum is a
   * double-counting sum and must never be presented as an account total.
   */
  reachNote: string | null
  /** so any later action resolves its own blast radius from the row it was launched from */
  campaignIds: string[]
}

/** The four grains AND together, exactly as `ruleMatchesScope()` ANDs them. */
export interface ApplyRulesScope {
  market: string
  line: string
  portfolio: string
  campaign: string
}

/**
 * The account's numbers, in one object, computed once.
 *
 * The first six come straight from `guardrail-grid.totals` — this page does not recount what that
 * endpoint already counts, or the two screens reading it would drift from this one. The rest are
 * derived from the merged rows and are what S1's band states.
 */
export interface ApplyRulesTotals {
  campaigns: number
  managed: number
  withMinBid: number
  withMaxBid: number
  pinned: number
  suppressed: number
  /**
   * 🔴 Counts market-scoped rules as account-wide (`accountWideRules` filters `scopeCampaignId` and
   * `scopePortfolioId` only). True today because all 8 scoped rules are DISABLED; false the day one
   * is enabled. Named here so no section renders it as "rules that govern every campaign" without
   * knowing that.
   */
  accountWideRules: number
  accountWideRulesIncludesMarketScoped: true
  live: number
  paused: number
  archived: number
  delivering: number
  /** ENABLED and NOT_DELIVERING — different facts, and the reason both columns exist */
  liveNotDelivering: number
  liveDailyBudgetCents: number
  pausedDailyBudgetCents: number
}

/**
 * What every section receives. **Additive only**: a section that needs something new adds a field
 * here and `ApplyRulesClient` fills it, rather than the section reaching into the client's
 * internals or fetching its own copy of 220 rows.
 */
export interface ApplyRulesSlotProps {
  scope: ApplyRulesScope
  grain: ApplyRulesGrain
  /** the scope's campaign-grain truth — present at EVERY grain, so aggregates and rows never disagree */
  rows: CampaignRow[]
  /** all 220, unscoped. S1's band needs an account denominator while the grid is filtered. */
  allRows: CampaignRow[]
  /** the rows actually rendered when grain ≠ campaign; `[]` at campaign grain */
  aggregates: AggregateRow[]
  totals: ApplyRulesTotals | null
  loading: boolean
  /** kept rather than swallowed: substrate §5.6 needs "broke" to render differently from "empty" */
  error: string | null
  /** true once the cursor poll sees the server move. See `lastCheckedAt` before believing a false. */
  stale: boolean
  /**
   * 🔴 `null` means the poll has NEVER succeeded — which is the state today, because
   * `GET /advertising/apply-rules/cursor` does not exist yet (see the client's header). A section
   * must not render an "as of" or a "live" claim while this is null; `stale: false` then means
   * "not checked", not "unchanged".
   */
  lastCheckedAt: string | null
  /** write a patch into the URL; '' or a default value deletes the param. The ONLY writer of page state. */
  push: (patch: Record<string, string>) => void
  /** force a refetch — S5 onward call it; S0 never does */
  reload: () => void
  /** ?row= — the inspected row (S7) */
  row: string | null
  /** ?drawer= — a side panel (S7) */
  drawer: string | null
}

/**
 * The grid's write-capable props, explicitly absent.
 *
 * S5 replaces this object; until then every one of these is `null` at the point of use, so a
 * reviewer can see that the read-only property is stated rather than inferred from what is missing.
 * The first section to write **replaces** it — it does not quietly stop passing it.
 */
export interface ApplyRulesWriteActions {
  selectionActions: ((ids: string[], clear: () => void) => ReactNode) | null
  onRowAction: ((row: CampaignRow) => void) | null
  editMode: null
}

export const NO_WRITE_ACTIONS: ApplyRulesWriteActions = {
  selectionActions: null,
  onRowAction: null,
  editMode: null,
}
