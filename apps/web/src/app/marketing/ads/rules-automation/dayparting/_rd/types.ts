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
 * The runtime half of a campaign row — **filled by P2's `GET /advertising/rank-runtime`.**
 *
 * P0 declared these five members with the names the approved structure doc uses and left them
 * null, saying P2 may WIDEN a member but not rename one. That is what happened: the shapes below
 * are the endpoint's, the five names are P0's.
 *
 * Every value is derived SERVER-SIDE from the engine's own functions (`biasBand`, `cpcCapPct`,
 * `applyTargetOverrides`, `toSpec`) against the DATABASE clock, so a column here cannot disagree
 * with the loop that actually decides.
 */
export type RdModeKind =
  | 'not-running' | 'governed-elsewhere' | 'nothing-held' | 'dangling-target'
  | 'min-bid' | 'capped-base' | 'capped-floor' | 'all-out' | 'chasing' | 'holding'

export interface RdMode { kind: RdModeKind; label: string; detail: string }

export interface RdCeiling {
  capPct: number | null
  /** The base bid alone already exceeds the ceiling — no multiplier can rescue it. */
  baseAlone: boolean
  /** True when the ceiling, not the target, is deciding the placement. */
  binding: boolean
  maxCpcCents: number | null
  maxBaseBidCents: number | null
  label: string
}

export interface RdGoal {
  targetPct: number | null
  actualPct: number | null
  /** False when the controller never reads this goal — two causes, and `deadReason` says which. */
  live: boolean
  deadReason: string | null
}

export type RdSignalKind = 'top-is' | 'sqp' | 'none-by-design' | 'no-signal' | 'no-coverage' | 'not-applicable'

export interface RdSignal {
  kind: RdSignalKind
  /** The lane the ACTIVE target drives, not the group's baseline. */
  lane: string | null
  valuePct: number | null
  ageDays: number | null
  rows: number | null
  /**
   * RD.P4 — the BASIS, and the axis that decides whether this number may be trusted.
   * `withData` of `total` advertised ASINs appear in the week the reader chose. Null on lanes with
   * no ASIN basis (Top-of-Search IS is a campaign-level metric).
   */
  contributors?: { withData: number; total: number } | null
  /** RD.P4 — three states, never merged. */
  freshness?: 'fresh' | 'stale' | 'never' | 'none'
  /** Why it is stale: age, a thin basis, or both. */
  staleReason?: string | null
  /** Short enough to be a column. */
  label: string
  /** The sentence, for the tooltip. */
  detail?: string
}

export interface RdCampaignRuntime {
  mode: RdMode | null
  /** Live placement multipliers off `Campaign.dynamicBidding`. */
  placement: { top: number | null; rest: number | null; product: number | null } | null
  goal: RdGoal | null
  signal: RdSignal | null
  ceiling: RdCeiling | null
  /** What the schedule resolves to at this hour, and the band the controller would move in. */
  activeTargetKey: string | null
  band: { floor: number; ceiling: number } | null
  canChase: boolean
  /** False when this campaign can never reach its own goal. Drives Health's new state. */
  canConverge: boolean
  cannotConvergeReason: string | null
  /** Set while a dated event is overriding the weekly plan. */
  eventName: string | null
}

export const EMPTY_RUNTIME: RdCampaignRuntime = {
  mode: null, placement: null, goal: null, signal: null, ceiling: null,
  activeTargetKey: null, band: null, canChase: false, canConverge: true,
  cannotConvergeReason: null, eventName: null,
}

/** The group grain, rolled up from its members — a SPREAD, never an average. */
export interface RdGroupRuntime {
  groupId: string
  members: number
  modeCounts: Array<{ kind: RdModeKind; count: number }>
  /** `8 capped · 2 all-out`, or one word when every member agrees. */
  modeSummary: string
  mixed: boolean
  cannotConverge: number
  goalsLive: number
  signalSummary: string
}

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
  /** Last engine tick for THIS campaign, and the key it stamped. */
  lastEvaluatedAt: string | null
  lastApplied: string | null
  runtime: RdCampaignRuntime
}
