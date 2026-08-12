/**
 * RD.P0 — the row shapes every section of this page reads.
 *
 * Two grains, because the page's structural flaw is that it only has one. The list is
 * group-grained and every defect the study measured is campaign-grained: one row called
 * "IT GALE JACKET" hides eleven campaigns with four different fates.
 *
 * `RdGroupRow` is what the endpoint returns today. `RdCampaignRow` is the seam — its identity half
 * resolves today from data that already exists (measured: 45/45 campaigns resolve name, market,
 * portfolio, line, status and schedule), and its runtime half is `null` until P2 builds the
 * campaign-grain endpoint. Nothing in P0 renders the runtime half.
 */

/** A `RankTarget` as the page needs it: a name and a swatch, keyed by `key`. */
export interface RdTargetMeta {
  key: string
  name: string
  color: string | null
}

/**
 * 🔴 Every scope dimension on a group row is a DERIVED SET, never a stored scalar.
 *
 * Measured on prod 2026-08-12 (`_rd-page-scope.mts`): `RankScheduleGroup.marketplace` is **null on
 * 9 of 16 groups** — all three large IT groups and two DE ones — so a page that filtered on the
 * stored column would hide DE groups from a DE filter. The same reasoning applies to the other
 * three grains, so all four are derived from the member campaigns and all four are sets.
 *
 * A set of one is the common case (0 of 16 groups currently span two markets), but the *contract*
 * is a set: the model permits a portfolio-scoped group to span IT + DE, and collapsing that to a
 * scalar is the bug that is already live on the stored column.
 */
export interface RdGroupScope {
  /** Marketplaces of the member campaigns. */
  marketplaces: string[]
  /** External portfolio ids: the group's own, plus any its member campaigns carry. */
  portfolioIds: string[]
  /** `Product.id` of each product line advertised by a member campaign. */
  productLineIds: string[]
  /** Local `Campaign.id` of every member. */
  campaignIds: string[]
}

export interface RdGroupPerformance {
  costCents: number
  salesCents: number
  orders: number
  clicks: number
  impressions: number
  /** Derived server-side from the SUMS, never averaged across campaigns. Null with no sales. */
  acos: number | null
  windowDays: number
}

export interface RdGroupRow {
  id: string
  name: string
  enabled: boolean
  timezone: string
  /** The rank held outside every window. */
  defaultTargetKey: string
  /** What the schedule resolves to right now, recomputed server-side in the group's own timezone. */
  activeTargetKey: string
  /** The raw window array — kept whole so "save as template" persists the real shape. */
  windowsRaw: unknown[]
  /** Windows that actually name a target. */
  windowCount: number
  /** The group's own portfolio binding, if it was created as a portfolio schedule. */
  portfolioId: string | null
  portfolioName: string | null
  scope: RdGroupScope
  campaignCount: number
  membersTotal: number
  membersEnabled: number
  lastEvaluatedAt: string | null
  lastApplied: string | null
  /** Amazon writes this schedule asked for that ended FAILED in the last 24h, both write paths. */
  failedWrites: number
  /** Members a `ProductRankPlan` governed on its last tick — inside the schedule, not run by it. */
  governedElsewhere: number
  performance: RdGroupPerformance
}

/**
 * The runtime half of a campaign row — **P2 owns every field here.**
 *
 * The names and shapes come from the approved structure doc (§P2 Mode / Goal vs actual, §P4 Signal,
 * §P5 ceiling), so P2 inherits a contract rather than a guess. P2 may WIDEN any member as the
 * endpoint takes shape; renaming one is a change to this file and to whatever reads it.
 *
 * Every field is `null` in P0 and no section renders one. They are computed server-side from
 * `biasBand()` and `cpcCapPct()` — the engine's own pure functions — because a second copy in the
 * web app would drift from the engine that actually decides.
 */
export interface RdCampaignRuntime {
  /** `Holding 150%` · `Chasing 55% IS` · `Capped 0% by €1.50 CPC`. */
  mode: { kind: 'holding' | 'chasing' | 'capped'; label: string } | null
  /** Live placement multipliers. Top and Rest are mutually exclusive search positions. */
  placement: { top: number | null; rest: number | null; product: number | null } | null
  /** The goal and what is achieved — **null where no goal is live**, which is the honest state on
   *  29 of 33 campaigns. Printing a dead goal as live is the lie the page currently tells. */
  goal: { targetPct: number | null; actualPct: number | null; unit: string } | null
  /** Lane, age, and volume against the trailing norm. Age alone is insufficient: the newest SQP
   *  week is a collapsed partial that any pure age guard would pass. */
  signal: { lane: string; ageDays: number | null; rows: number | null; norm: number | null } | null
  /** The CPC ceiling's verdict. `baseAlone` = the base bid alone already exceeds the ceiling, so
   *  no multiplier can rescue it — it deserves its own words on the row. */
  ceiling: { capPct: number | null; baseAlone: boolean; reason: string } | null
}

export const EMPTY_RUNTIME: RdCampaignRuntime = {
  mode: null, placement: null, goal: null, signal: null, ceiling: null,
}

/**
 * One advertised campaign under rank control.
 *
 * The identity half is real today. The runtime half is `EMPTY_RUNTIME` until P2 ships
 * the campaign-grain endpoint (structure doc §4: "one endpoint returning per-campaign: resolved
 * target, mode, band, live placement, signal + age, ceiling state, last run").
 */
export interface RdCampaignRow {
  /** Local `Campaign.id`. */
  campaignId: string
  campaignName: string
  marketplace: string | null
  portfolioId: string | null
  portfolioName: string | null
  productLineIds: string[]
  /** `Campaign.status` — ENABLED / PAUSED / ARCHIVED. */
  status: string | null
  /** The schedule that holds it. A campaign has at most one: `@@unique([campaignId])` on
   *  `AdSchedule` enforces it in the DB. */
  groupId: string | null
  groupName: string | null
  /** The member `AdSchedule` row's own switch, which is not the group's. */
  scheduleEnabled: boolean | null
  runtime: RdCampaignRuntime
}
