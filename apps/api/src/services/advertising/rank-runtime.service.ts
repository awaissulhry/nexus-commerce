/**
 * RD.P2 — the I/O half of the campaign-grain runtime. The derivation itself is pure and lives in
 * `rank-runtime.ts`; this file only feeds it and rolls the result up.
 *
 * One request answers BOTH grains. The group grain is defined as a roll-up of the campaign grain,
 * so deriving them separately would let an aggregate drift from its own members — and the grain
 * toggle would cost a round-trip for rows the client already holds.
 *
 * 🔴 **The clock is the database's.** `runRankDefendOnce` resolves every window against
 * `SELECT now()` rather than the container clock, because Railway containers have run ~2h behind
 * while Postgres stayed correct. `/advertising/rank-schedule-groups` uses the container clock, so
 * its `Now holding` column is correct only while the skew happens to be zero. This endpoint takes
 * the DB clock, and returns the measured skew so a caller can see when the two would disagree.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  deriveCampaignRuntime, rollUpGroup,
  type RdCampaignRuntime, type RdGroupRollUp, type RdCampaignRuntimeInput,
} from './rank-runtime.js'
import { pickActiveEvents } from '../../jobs/ad-rank-defend.job.js'
import { analyzeTopOfSearch } from './ads-top-of-search.service.js'
import { sqpImpressionShareForAsins } from './sqp.service.js'
import type { ScheduleWindow } from './rank-controller.js'

export type RdSignalKind = 'top-is' | 'sqp' | 'none-by-design' | 'no-signal' | 'no-coverage' | 'not-applicable'

export interface RdSignal {
  kind: RdSignalKind
  /** The lane the ACTIVE target drives — not the group's baseline. */
  lane: string | null
  valuePct: number | null
  ageDays: number | null
  /** Rows behind the number, for P4's volume guard. Null where the lane has no row concept. */
  rows: number | null
  label: string
}

export interface RdCampaignRow extends RdCampaignRuntime {
  campaignName: string
  marketplace: string | null
  portfolioId: string | null
  status: string | null
  groupName: string | null
  scheduleEnabled: boolean
  livePlacement: { top: number | null; rest: number | null; product: number | null }
  signal: RdSignal
  lastEvaluatedAt: string | null
  lastApplied: string | null
}

export interface RdGroupRow extends RdGroupRollUp {
  groupId: string
  /** Signal states across members, as a spread. */
  signalSummary: string
}

export interface RankRuntimePayload {
  resolvedAt: string
  clock: { source: 'database'; skewMinutes: number }
  campaigns: RdCampaignRow[]
  groups: RdGroupRow[]
}

const SHORT_LANE: Record<string, string> = {
  PLACEMENT_TOP: 'Top-IS', PLACEMENT_REST_OF_SEARCH: 'SQP', PLACEMENT_PRODUCT_PAGE: 'Product page',
}

const nowInTz = (tz: string, at: Date): { day: number; hour: number } => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(at)
  const wk = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wk)
  let hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24
  if (Number.isNaN(hour)) hour = 0
  return { day: dayIdx < 0 ? 0 : dayIdx, hour }
}

const daysBetween = (a: Date, b: Date) => Math.max(0, Math.round((a.getTime() - b.getTime()) / 86_400_000))

export async function getRankRuntime(): Promise<RankRuntimePayload> {
  // ── the clock ─────────────────────────────────────────────────────────────────────────────
  const nowRows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() as now`
  const raw = nowRows?.[0]?.now
  const dbNow = raw instanceof Date ? raw : raw ? new Date(raw as unknown as string) : new Date()
  const skewMinutes = Math.round((Date.now() - dbNow.getTime()) / 60_000)

  const [schedules, targets, groups] = await Promise.all([
    prisma.adSchedule.findMany(),
    prisma.rankTarget.findMany(),
    prisma.rankScheduleGroup.findMany({ select: { id: true, name: true } }),
  ])
  const targetByKey = new Map(targets.map((t) => [t.key, t as never]))
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const campIds = [...new Set(schedules.map((s) => s.campaignId))]

  const camps = await prisma.campaign.findMany({
    where: { id: { in: campIds } },
    select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, biddingStrategy: true, dynamicBidding: true },
  })
  const campById = new Map(camps.map((c) => [c.id, c]))

  // ── events override the weekly plan, exactly as the engine loads them ─────────────────────
  let activeEvents = new Map<string, { windows: unknown; defaultTargetKey: string | null; name: string }>()
  try {
    const evRows = await prisma.rankScheduleEvent.findMany({ where: { enabled: true } })
    activeEvents = pickActiveEvents(evRows.map((e) => ({ ...e, enabled: true })) as never, dbNow) as never
  } catch (e) {
    // Logged, never swallowed into a zero: an event lookup that fails must not silently render
    // the weekly plan as though it were authoritative.
    logger.warn('[rank-runtime] event lookup failed — weekly plans shown as authoritative', { error: (e as Error).message })
  }

  // ── a family plan takes precedence; the schedule loop SKIPS those campaigns ───────────────
  const governed = new Set<string>()
  const plans = await prisma.productRankPlan.findMany({ where: { enabled: true }, select: { lastSummary: true } })
  for (const p of plans) {
    for (const d of ((p.lastSummary as { decisions?: Array<{ campaignId?: string }> } | null)?.decisions) ?? []) {
      if (d?.campaignId) governed.add(d.campaignId)
    }
  }

  // ── highest live base bid per campaign — grouped, because one campaign holds 141 targets ──
  const maxBaseBid = new Map<string, number>()
  const [agRows, agIndex] = await Promise.all([
    prisma.adGroup.groupBy({ by: ['campaignId'], where: { campaignId: { in: campIds } }, _max: { defaultBidCents: true, suppressedFromBidCents: true } }),
    prisma.adGroup.findMany({ where: { campaignId: { in: campIds } }, select: { id: true, campaignId: true } }),
  ])
  for (const r of agRows) {
    const v = Math.max(r._max.defaultBidCents ?? 0, r._max.suppressedFromBidCents ?? 0)
    if (v > 0) maxBaseBid.set(r.campaignId, v)
  }
  const campByAdGroup = new Map(agIndex.map((g) => [g.id, g.campaignId]))
  const tgRows = await prisma.adTarget.groupBy({ by: ['adGroupId'], where: { adGroup: { campaignId: { in: campIds } }, isNegative: false }, _max: { bidCents: true, suppressedFromBidCents: true } })
  for (const r of tgRows) {
    const cid = campByAdGroup.get(r.adGroupId); if (!cid) continue
    const v = Math.max(r._max.bidCents ?? 0, r._max.suppressedFromBidCents ?? 0)
    if (v > (maxBaseBid.get(cid) ?? 0)) maxBaseBid.set(cid, v)
  }

  // ── the derivation ────────────────────────────────────────────────────────────────────────
  const runtimes = schedules.map((s) => {
    const c = campById.get(s.campaignId)
    const ev = s.groupId ? activeEvents.get(s.groupId) : undefined
    const input: RdCampaignRuntimeInput = {
      scheduleId: s.id, campaignId: s.campaignId, groupId: s.groupId,
      scheduleEnabled: s.enabled,
      windows: s.windows as ScheduleWindow[] | null,
      defaultTargetKey: s.defaultTargetKey,
      timezoneNow: nowInTz(s.timezone || 'Europe/Rome', dbNow),
      event: ev ? { windows: ev.windows as ScheduleWindow[] | null, defaultTargetKey: ev.defaultTargetKey, name: ev.name } : null,
      targetByKey,
      targetOverrides: s.targetOverrides as never,
      maxBaseBidCents: maxBaseBid.get(s.campaignId) ?? null,
      biddingStrategy: c?.biddingStrategy ?? null,
      governed: governed.has(s.campaignId),
    }
    return { schedule: s, campaign: c, runtime: deriveCampaignRuntime(input) }
  })

  // ── signals, keyed to each row's ACTIVE lane ──────────────────────────────────────────────
  //
  // Only the lanes actually in play are read. `analyzeTopOfSearch` groups over the whole
  // marketplace (62 campaigns for IT+DE, not 33), so it is called once per market and memoised —
  // per row it would be 33 full-marketplace aggregations per page load.
  const topLaneMarkets = new Set<string>()
  const restLaneCampaigns: string[] = []
  for (const { campaign, runtime } of runtimes) {
    if (runtime.placement === 'PLACEMENT_TOP' && campaign?.marketplace) topLaneMarkets.add(campaign.marketplace)
    if (runtime.placement === 'PLACEMENT_REST_OF_SEARCH') restLaneCampaigns.push(runtime.campaignId)
  }

  const topIsByCampaign = new Map<string, number | null>()
  const topAgeByMarket = new Map<string, number | null>()
  for (const m of topLaneMarkets) {
    const tos = await analyzeTopOfSearch({ marketplace: m })
    for (const r of tos.rows) topIsByCampaign.set(r.campaignId, r.topIS ?? null)
    const newest = await prisma.amazonAdsPlacementReport.findFirst({
      where: { marketplace: m, placement: 'Top of Search on-Amazon', topOfSearchIS: { not: null } },
      orderBy: { date: 'desc' }, select: { date: true },
    })
    topAgeByMarket.set(m, newest ? daysBetween(dbNow, newest.date) : null)
  }

  // ASINs per campaign — needed for the SQP lane and for "has this ASIN set EVER been covered".
  const asinsByCampaign = new Map<string, string[]>()
  if (restLaneCampaigns.length) {
    const ads = await prisma.adProductAd.findMany({
      where: { adGroup: { campaignId: { in: restLaneCampaigns } }, asin: { not: null } },
      select: { asin: true, adGroup: { select: { campaignId: true } } },
    })
    for (const a of ads) {
      const cid = a.adGroup?.campaignId; if (!cid || !a.asin) continue
      const list = asinsByCampaign.get(cid) ?? []
      if (!list.includes(a.asin)) list.push(a.asin)
      asinsByCampaign.set(cid, list)
    }
  }
  const everCovered = new Set<string>()
  const allAsins = [...new Set([...asinsByCampaign.values()].flat())]
  if (allAsins.length) {
    const seen = await prisma.searchQueryPerformance.groupBy({ by: ['asin'], where: { asin: { in: allAsins } }, _count: { _all: true } })
    for (const r of seen) if (r._count._all > 0) everCovered.add(r.asin)
  }
  const sqpAgeByMarket = new Map<string, number | null>()

  async function signalFor(runtime: RdCampaignRuntime, marketplace: string | null): Promise<RdSignal> {
    const lane = runtime.placement
    if (!lane || !runtime.activeTargetKey) {
      return { kind: 'not-applicable', lane: null, valuePct: null, ageDays: null, rows: null, label: '—' }
    }
    if (lane === 'PLACEMENT_PRODUCT_PAGE') {
      return { kind: 'none-by-design', lane, valuePct: null, ageDays: null, rows: null, label: 'Open loop by design — Amazon exposes no product-page impression share' }
    }
    if (lane === 'PLACEMENT_TOP') {
      const v = marketplace ? topIsByCampaign.get(runtime.campaignId) ?? null : null
      const age = marketplace ? topAgeByMarket.get(marketplace) ?? null : null
      if (v == null) return { kind: 'no-signal', lane, valuePct: null, ageDays: age, rows: null, label: 'no signal' }
      return { kind: 'top-is', lane, valuePct: Math.round(v * 1000) / 10, ageDays: age, rows: null, label: `Top-IS ${Math.round(v * 1000) / 10}%${age != null ? ` · ${age}d` : ''}` }
    }
    // Rest of search — SQP, which is the lane with the onboarding problem.
    const asins = asinsByCampaign.get(runtime.campaignId) ?? []
    const covered = asins.some((a) => everCovered.has(a))
    if (!covered) {
      return { kind: 'no-coverage', lane, valuePct: null, ageDays: null, rows: 0, label: 'no coverage — these ASINs have never appeared in Brand Analytics' }
    }
    if (marketplace && !sqpAgeByMarket.has(marketplace)) {
      const newest = await prisma.searchQueryPerformance.findFirst({ where: { marketplace }, orderBy: { startDate: 'desc' }, select: { startDate: true } })
      sqpAgeByMarket.set(marketplace, newest ? daysBetween(dbNow, newest.startDate) : null)
    }
    const share = marketplace ? await sqpImpressionShareForAsins(marketplace, asins) : null
    const age = marketplace ? sqpAgeByMarket.get(marketplace) ?? null : null
    if (share == null) return { kind: 'no-signal', lane, valuePct: null, ageDays: age, rows: null, label: 'no signal' }
    return { kind: 'sqp', lane, valuePct: Math.round(share * 1000) / 10, ageDays: age, rows: null, label: `SQP ${Math.round(share * 1000) / 10}%${age != null ? ` · ${age}d` : ''}` }
  }

  const campaignRows: RdCampaignRow[] = []
  for (const { schedule, campaign, runtime } of runtimes) {
    const dyn = (campaign?.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
    const pb = dyn.placementBidding ?? []
    const pct = (p: string) => pb.find((x) => x.placement === p)?.percentage ?? null
    const signal = await signalFor(runtime, campaign?.marketplace ?? null)
    campaignRows.push({
      ...runtime,
      goal: { ...runtime.goal, actualPct: runtime.goal.live ? signal.valuePct : runtime.goal.actualPct },
      campaignName: campaign?.name ?? runtime.campaignId,
      marketplace: campaign?.marketplace ?? null,
      portfolioId: campaign?.portfolioId ?? null,
      status: campaign?.status ?? null,
      groupName: runtime.groupId ? groupName.get(runtime.groupId) ?? null : null,
      scheduleEnabled: schedule.enabled,
      livePlacement: { top: pct('PLACEMENT_TOP'), rest: pct('PLACEMENT_REST_OF_SEARCH'), product: pct('PLACEMENT_PRODUCT_PAGE') },
      signal,
      lastEvaluatedAt: schedule.lastEvaluatedAt ? schedule.lastEvaluatedAt.toISOString() : null,
      lastApplied: schedule.lastApplied ?? null,
    })
  }

  // ── the group grain, rolled up from the rows above ────────────────────────────────────────
  const groupRows: RdGroupRow[] = []
  for (const g of groups) {
    const rows = campaignRows.filter((r) => r.groupId === g.id)
    if (!rows.length) continue
    const up = rollUpGroup(rows)
    const sigCounts = new Map<string, number>()
    for (const r of rows) sigCounts.set(r.signal.kind, (sigCounts.get(r.signal.kind) ?? 0) + 1)
    const sigWord: Record<string, string> = { 'top-is': 'Top-IS', sqp: 'SQP', 'no-signal': 'no signal', 'no-coverage': 'no coverage', 'none-by-design': 'open loop', 'not-applicable': '—' }
    const signalSummary = sigCounts.size === 1
      ? sigWord[[...sigCounts.keys()][0]] ?? '—'
      : [...sigCounts.entries()].map(([k, n]) => `${n} ${sigWord[k] ?? k}`).join(' · ')
    groupRows.push({ ...up, groupId: g.id, signalSummary })
  }

  return {
    resolvedAt: dbNow.toISOString(),
    clock: { source: 'database', skewMinutes },
    campaigns: campaignRows,
    groups: groupRows,
  }
}
