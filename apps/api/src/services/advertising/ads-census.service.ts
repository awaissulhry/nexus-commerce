/**
 * ads-census.service.ts — THE COUNTS SEVERAL SCREENS SHOW, FROM ONE PLACE.
 *
 * 7b (review 3.11, I.7, 8.6; 2026-10-04). The same numbers were counted in several places with different filters:
 * "82 of 220 campaigns allowlisted" on the Control Room, in the catalog's auto-bid and top-of-search scope, on the
 * Guardrails tab and on Today; and "45 of 219 campaigns are under rank control" on the Rank & Dayparting coverage
 * strip, whose 219 left out an archived campaign and whose 45 counted schedules that are switched off. Now every
 * campaign count comes from `campaignCensus()` and every hourly-plan count from `rankCensus()`, so two screens can
 * only differ where their labels say why.
 *
 * Read-only.
 */
import prisma from '../../db.js'

export interface CampaignCensus {
  /** Every campaign Nexus holds, archived ones included: the "of 220" the screens state. */
  total: number
  /** Archived at Amazon. Counted in `total`; nothing can change them. */
  archived: number
  /** On the live-write allowlist (`liveBidWritesEnabled`): the campaigns automation may write to. */
  allowlisted: number
  /** Campaigns whose own row sets a minimum bid / a maximum bid (the Guardrails tab's columns). */
  withMinBid: number
  withMaxBid: number
}

/** The campaign counts, in one read. `marketplace` narrows every count to one market. */
export async function campaignCensus(opts: { marketplace?: string | null } = {}): Promise<CampaignCensus> {
  const rows = await prisma.campaign.findMany({
    where: opts.marketplace ? { marketplace: opts.marketplace } : {},
    select: { status: true, liveBidWritesEnabled: true, minBidCents: true, maxBidCents: true },
  })
  return {
    total: rows.length,
    archived: rows.filter((c) => c.status === 'ARCHIVED').length,
    allowlisted: rows.filter((c) => c.liveBidWritesEnabled).length,
    withMinBid: rows.filter((c) => c.minBidCents != null).length,
    withMaxBid: rows.filter((c) => c.maxBidCents != null).length,
  }
}

/** A bid no bound allows, so asking the gate about it answers "is there a maximum?". */
const PROBE_HIGH_CENTS = 1_000_000_000

/**
 * Allowlisted campaigns the write gate holds to no minimum bid: neither their own row nor a bid policy (market,
 * portfolio or product line) sets one; and how many of those have no maximum either. Asked of the gate's own bounds
 * check (`entityBoundsDenial`), so it cannot disagree with it. That costs a policy read per campaign without its own
 * bound, so only the Today board asks, and only when an enabled bid policy exists (else the rows alone decide, as in
 * the gate).
 */
export async function allowlistedBidBounds(): Promise<{ noMinBid: number; noMinBidNoMax: number }> {
  const rows = await prisma.campaign.findMany({
    where: { liveBidWritesEnabled: true, minBidCents: null },
    select: { id: true, marketplace: true, portfolioId: true, minBidCents: true, maxBidCents: true, minBudgetCents: true, maxBudgetCents: true },
  })
  const policies = rows.length ? await prisma.adBidPolicy.count({ where: { enabled: true } }) : 0
  const { entityBoundsDenial } = policies > 0 ? await import('./ads-write-gate.js') : { entityBoundsDenial: null }
  let noMinBid = 0
  let noMinBidNoMax = 0
  for (const c of rows) {
    if (entityBoundsDenial && (await entityBoundsDenial({ campaignId: c.id, campaign: c, field: 'bid', intendedValueCents: 0 }))) continue
    const hasMax = c.maxBidCents != null
      || (!!entityBoundsDenial && (await entityBoundsDenial({ campaignId: c.id, campaign: c, field: 'bid', intendedValueCents: PROBE_HIGH_CENTS })) != null)
    noMinBid++
    if (!hasMax) noMinBidNoMax++
  }
  return { noMinBid, noMinBidNoMax }
}

export interface RankScheduleRow { id: string; name: string; enabled: boolean; campaignId: string; lastEvaluatedAt: Date | null }
export interface RankPlanRow {
  id: string
  productId: string
  marketplace: string
  enabled: boolean
  manualOnly: boolean
  pausedAt: Date | null
  maxCampaigns: number | null
  familyDailyBudgetCents: number | null
  familyAcosCapPct: number | null
  lastEvaluatedAt: Date | null
  /** Runs by itself: switched on, not manual-only, not paused. */
  on: boolean
}

export interface RankCensus {
  /** The hourly bid plans engine's schedules (goal mode, one campaign each), by name. */
  schedules: RankScheduleRow[]
  /** Its product plans, by market. */
  plans: RankPlanRow[]
  /** "x of y switched on": the rows above, and how many of them run by themselves. */
  rows: { total: number; on: number }
  /** Campaign ids, each in one bucket at most. */
  campaigns: {
    /** Held by a schedule that is switched on (an hourly bid plan or classic dayparting). */
    bySchedule: Set<string>
    /** Not in `bySchedule`, and a switched-on product plan governed it on its last run. */
    byPlan: Set<string>
    /** Hold a schedule that is switched off, and no plan governs them: nothing runs on them. */
    switchedOff: Set<string>
  }
}

/** The hourly-plan counts: the rows the engine lists, and the campaigns they hold. */
export async function rankCensus(): Promise<RankCensus> {
  const { isGoalMode } = await import('../../jobs/ad-rank-defend.job.js')
  const [schedules, plans] = await Promise.all([
    prisma.adSchedule.findMany({
      select: { id: true, name: true, enabled: true, campaignId: true, windows: true, defaultTargetKey: true, lastEvaluatedAt: true },
      orderBy: { name: 'asc' },
    }),
    prisma.productRankPlan.findMany({
      select: {
        id: true, productId: true, marketplace: true, enabled: true, manualOnly: true, pausedAt: true, maxCampaigns: true,
        familyDailyBudgetCents: true, familyAcosCapPct: true, lastEvaluatedAt: true, lastSummary: true,
      },
      orderBy: { marketplace: 'asc' },
    }),
  ])
  const goal: RankScheduleRow[] = schedules
    .filter((s) => isGoalMode(s.windows, s.defaultTargetKey))
    .map(({ id, name, enabled, campaignId, lastEvaluatedAt }) => ({ id, name, enabled, campaignId, lastEvaluatedAt }))
  const planRows: RankPlanRow[] = plans.map(({ lastSummary: _summary, ...p }) => ({ ...p, on: p.enabled && !p.manualOnly && !p.pausedAt }))

  const bySchedule = new Set(schedules.filter((s) => s.enabled).map((s) => s.campaignId))
  // The campaigns each switched-on plan resolved on its last run, as the schedule list reads them (resolving families
  // live is expensive). The rank tick lets a plan win over a schedule on the same campaign.
  const governed = new Set<string>()
  for (const p of plans) {
    if (!p.enabled) continue
    for (const d of (p.lastSummary as { decisions?: Array<{ campaignId?: string }> } | null)?.decisions ?? []) {
      if (d?.campaignId) governed.add(d.campaignId)
    }
  }
  const byPlan = new Set([...governed].filter((id) => !bySchedule.has(id)))
  const switchedOff = new Set(schedules.filter((s) => !s.enabled && !bySchedule.has(s.campaignId) && !governed.has(s.campaignId)).map((s) => s.campaignId))
  return {
    schedules: goal,
    plans: planRows,
    rows: { total: goal.length + planRows.length, on: goal.filter((s) => s.enabled).length + planRows.filter((p) => p.on).length },
    campaigns: { bySchedule, byPlan, switchedOff },
  }
}
