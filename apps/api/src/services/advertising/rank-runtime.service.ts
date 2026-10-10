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
  deriveCampaignRuntime, rollUpGroup, classifySqpFreshness,
  type RdCampaignRuntime, type RdGroupRollUp, type RdCampaignRuntimeInput,
} from './rank-runtime.js'
import { pickActiveEvents } from '../../jobs/ad-rank-defend.job.js'
import { resolveMaxBaseBidByCampaign } from './ads-placement-manual.js'
import { sqpShareForAsins } from './sqp.service.js'
import type { ScheduleWindow } from './rank-controller.js'

export type RdSignalKind = 'top-is' | 'sqp' | 'none-by-design' | 'no-signal' | 'no-coverage' | 'not-applicable'

export interface RdSignal {
  kind: RdSignalKind
  /** The lane the ACTIVE target drives — not the group's baseline. */
  lane: string | null
  valuePct: number | null
  ageDays: number | null
  /** Rows behind the number. Null where the lane has no row concept. */
  rows: number | null
  /**
   * RD.P4 — the BASIS, which is the axis that decides whether this number may be trusted.
   *
   * Not row count. The SQP programme measured it (`2026-08-12-sqp-feed.md` §18): 20 of the 34
   * campaigns with a share are steered by **exactly one ASIN**, and the mean campaign contributes
   * 10% of its ASINs to its own number. A row count cannot see that; a contributor count can.
   * `withData` of `total` advertised ASINs. Null on lanes with no ASIN basis (Top-of-Search IS is
   * a campaign-level metric).
   */
  contributors: { withData: number; total: number } | null
  /** RD.P4 — the three states, never merged. `fresh` | `stale` | `never` | `none`. */
  freshness: 'fresh' | 'stale' | 'never' | 'none'
  /** Why it is stale, when it is. Age, thin basis, or both. */
  staleReason: string | null
  /** Short enough to be a column. */
  label: string
  /** The sentence, for the tooltip. */
  detail: string
}

/**
 * RD.P4 — when is a signal stale?
 *
 * Age alone cannot answer it, and the correction is measured rather than designed. With
 * `NEXUS_SQP_LOOKBACK=2` the SQP feed can never be fresher than ~11 days plus the week length, so
 * any age threshold tighter than ~21 days nulls every campaign permanently (SQP §18, Option C: at
 * 14 days, 0 of 34 keep a signal). An age guard is therefore a STALL ALARM — useful at ~28 days,
 * useless as a quality test.
 *
 * The quality test is the basis. A share computed from one ASIN out of eighteen is not a fresher
 * or staler number, it is a number about a different thing.
 *
 * This page DISPLAYS both and enforces neither. Nulling a signal changes what the engine does —
 * `computeStep` falls through a null IS branch to the ACoS branch, which RAISES — so the guard
 * belongs to the SQP programme that owns the reader, not to a page that renders it.
 */


/**
 * B4 (2026-10-10) — the Rest-of-Search lane's signal from one SQP reading. The words say what the number is:
 * a share computed by Nexus from Amazon's weekly Search Query Performance counts, for a named week — never a
 * rank. The share itself is the SQP programme's (`sqpShareForAsins`); this only words it.
 */
export function sqpLaneSignal(
  lane: string,
  asinCount: number,
  reading: { share: number | null; ageDays: number | null; weekStart: string | null; contributors: { withData: number; total: number } } | null,
): RdSignal {
  const age = reading?.ageDays ?? null
  const week = reading?.weekStart ?? null
  if (!reading || reading.share == null) {
    return {
      kind: 'no-signal', lane, valuePct: null, ageDays: age, rows: null, contributors: { withData: reading?.contributors.withData ?? 0, total: asinCount }, freshness: 'never',
      staleReason: `These ASINs have SQP history, but ${week ? `the week of ${week}` : 'the latest week'} carries no query totals to take a share of.`,
      label: 'no signal',
      detail: `These ASINs have SQP history, but ${week ? `the week of ${week}` : 'the latest week'} carries no query totals to take a share of.`,
    }
  }
  const withData = reading.contributors.withData
  const f = classifySqpFreshness({ withData, total: asinCount, ageDays: age })
  const words = sharePctWords(reading.share)
  return {
    kind: 'sqp', lane, valuePct: valuePctOf(reading.share), ageDays: age, rows: withData,
    contributors: { withData, total: asinCount },
    freshness: f.freshness,
    staleReason: f.staleReason,
    label: `SQP ${words}${week ? ` · week of ${week}` : ''}${f.thin ? ' · thin' : ''}`,
    detail: `Impression share of this campaign's advertised ASINs on their search queries, computed by Nexus from Amazon's weekly `
      + `Brand Analytics Search Query Performance counts (our ASINs' impressions ÷ the total impressions of those queries): ${words}`
      + `${week ? `, week of ${week}` : ''}${age != null ? ` (started ${age} day${age === 1 ? '' : 's'} ago)` : ''}. A share, not a rank. `
      + `Basis: ${withData} of ${asinCount} advertised ASINs.`,
  }
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

/** Whole days since a date (a report date is midnight UTC): read on 10 Oct at noon, a reading of 8 Oct is 2 days old. */
const daysSince = (now: Date, d: Date) => Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000))

/**
 * Review fix (2026-10-10) — whether any of a campaign's ASINs was ever measured by Brand Analytics in ITS market (`seen`:
 * the market × ASIN pairs of weekly SQP rows). Another market's rows never cover it; no market known covers nothing. Pure.
 */
export function everCoveredIn(seen: ReadonlyArray<{ marketplace: string; asin: string | null }>, marketplace: string | null, asins: readonly string[]): boolean {
  if (!marketplace || !asins.length) return false
  const mine = new Set(asins)
  return seen.some((r) => r.marketplace === marketplace && !!r.asin && mine.has(r.asin))
}

/** B4 — how far back the Top-of-Search lane reads a campaign's own daily shares. */
export const TOP_IS_WINDOW_DAYS = 30

/**
 * A 0..1 share in words. A non-zero share below 0.01 % reads "<0.01%", never "0%" or "0.0%"; below 1 % it
 * keeps two decimals, above it one.
 */
export function sharePctWords(v: number): string {
  const pct = v * 100
  if (pct > 0 && pct < 0.01) return '<0.01%'
  return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`
}

/** A 0..1 share as the `valuePct` number: three significant digits, so a tiny real share never rounds to 0. */
const valuePctOf = (v: number) => Number((v * 100).toPrecision(3))

export interface TopIsReading {
  /** 0..1 — computed by Nexus: the impression-weighted average of the shares Amazon reported for the campaign */
  share: number
  /** where its daily readings came from (review fix): Amazon's placement report, its campaign report, or both, in words */
  source?: string
  /** days with a reading in the window */
  days: number
  /** the campaign's OWN newest reading */
  newest: Date
}

/**
 * B4 — one campaign's Top-of-Search reading from its own daily rows: impression-weighted (placement-grid's
 * `weightedIS`, passed in so this stays pure), the days that carry a reading, and its own newest date.
 */
export function topIsReadingOf(
  rows: ReadonlyArray<{ date: Date; value: number; weight: number; source?: 'placement' | 'campaign' }>,
  average: (points: Array<{ value: number; weight: number }>) => number | null,
  sourceWords?: (rows: ReadonlyArray<{ source: 'placement' | 'campaign' }>) => string,
): TopIsReading | null {
  const usable = rows.filter((r) => Number.isFinite(r.value))
  if (!usable.length) return null
  const share = average(usable.map((r) => ({ value: r.value, weight: Math.max(0, r.weight) })))
  if (share == null) return null
  const days = new Set(usable.map((r) => r.date.toISOString().slice(0, 10))).size
  const newest = new Date(Math.max(...usable.map((r) => +r.date)))
  const source = sourceWords ? sourceWords(usable.map((r) => ({ source: r.source ?? 'placement' }))) : undefined
  return { share, days, newest, ...(source ? { source } : {}) }
}

/**
 * B4 (2026-10-10) — the Top-of-Search lane's signal. Its age is the CAMPAIGN's own newest reading (it was the
 * market's newest report, which says nothing about this campaign), and its label names the window, the
 * weighting and the days behind it ("Top-IS 30-day avg X%" hid that it is an average at all).
 */
export function topLaneSignal(lane: string, reading: TopIsReading | null, dbNow: Date): RdSignal {
  if (!reading) {
    return {
      kind: 'no-signal', lane, valuePct: null, ageDays: null, rows: null, contributors: null, freshness: 'never',
      staleReason: `No top-of-search impression share was reported for this campaign in the last ${TOP_IS_WINDOW_DAYS} days.`,
      label: 'no signal',
      detail: `This campaign has a Top-of-Search lane but Amazon reported no top-of-search impression share for it in the last ${TOP_IS_WINDOW_DAYS} days.`,
    }
  }
  const age = daysSince(dbNow, reading.newest)
  const newest = reading.newest.toISOString().slice(0, 10)
  const words = sharePctWords(reading.share)
  const dayWord = `${reading.days} day${reading.days === 1 ? '' : 's'}`
  // The Top lane is dense and near-daily — measured 861 of 1,413 rows carrying an IS value,
  // 556 in the last 14 days — so age is the only axis that applies to it.
  const topStale = age > 7
  return {
    kind: 'top-is', lane, valuePct: valuePctOf(reading.share), ageDays: age, rows: reading.days, contributors: null,
    freshness: topStale ? 'stale' : 'fresh',
    staleReason: topStale ? `This campaign's newest top-of-search share is from ${newest}, ${age} days ago; Amazon normally reports it within 1–3 days.` : null,
    label: `Top-IS ${TOP_IS_WINDOW_DAYS}-day wtd avg ${words} (${dayWord})`,
    detail: `The top-of-search impression share Amazon reported for this campaign (campaign level), averaged by Nexus `
      + `(impression-weighted) over the ${dayWord} with a reading in the last ${TOP_IS_WINDOW_DAYS}: ${words}. `
      + `Newest reading ${newest}, ${age} day${age === 1 ? '' : 's'} old.${reading.source ? ` Source: ${reading.source}.` : ''}`,
  }
}

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
    select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, biddingStrategy: true, dynamicBidding: true, externalCampaignId: true },
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

  // ── highest base bid that serves, per campaign — the engine's own reading (resolveMaxBaseBidByCampaign) ──
  const maxBaseBid = await resolveMaxBaseBidByCampaign(campIds)

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
  // Only the lanes actually in play are read. B4 — the Top lane reads each campaign's OWN daily shares
  // over the last TOP_IS_WINDOW_DAYS days in one query (topIsReadingOf): impression-weighted, with the days
  // behind it and its own newest date. It used `analyzeTopOfSearch`'s unweighted window mean and the
  // market's newest report as every campaign's age.
  const topExtByCampaign = new Map<string, string>()
  const restLaneCampaigns: string[] = []
  for (const { campaign, runtime } of runtimes) {
    if (runtime.placement === 'PLACEMENT_TOP' && campaign?.externalCampaignId) topExtByCampaign.set(runtime.campaignId, campaign.externalCampaignId)
    if (runtime.placement === 'PLACEMENT_REST_OF_SEARCH') restLaneCampaigns.push(runtime.campaignId)
  }

  const topIsByCampaign = new Map<string, TopIsReading | null>()
  if (topExtByCampaign.size) {
    const since = new Date(+dbNow - TOP_IS_WINDOW_DAYS * 86_400_000)
    since.setUTCHours(0, 0, 0, 0)
    // Review fix — the placement table is filled only by the TOS ingest cron (off by default): a campaign-day it has no
    // reading for falls back to the campaign report's own row, and the signal says its source.
    const { weightedIS, campaignTopOfSearchReadings, tosSourceWords } = await import('./placement-grid.service.js')
    const rows = await campaignTopOfSearchReadings([...topExtByCampaign.values()], since)
    const byExt = new Map<string, Array<{ date: Date; value: number; weight: number; source: 'placement' | 'campaign' }>>()
    for (const r of rows) {
      const list = byExt.get(r.campaignId) ?? []
      list.push({ date: r.date, value: r.share, weight: r.impressions ?? 0, source: r.source })
      byExt.set(r.campaignId, list)
    }
    for (const [campaignId, ext] of topExtByCampaign) topIsByCampaign.set(campaignId, topIsReadingOf(byExt.get(ext) ?? [], weightedIS, tosSourceWords))
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
  // Review fix — "ever covered" per MARKET and on weekly rows: an ASIN Brand Analytics measured in another market, or only in
  // a MONTH / QUARTER report, does not cover this campaign's weekly Rest-of-search signal (everCoveredIn).
  let everSeen: Array<{ marketplace: string; asin: string | null }> = []
  const allAsins = [...new Set([...asinsByCampaign.values()].flat())]
  if (allAsins.length) {
    const seen = await prisma.searchQueryPerformance.groupBy({ by: ['marketplace', 'asin'], where: { asin: { in: allAsins }, reportPeriod: 'WEEK' }, _count: { _all: true } })
    everSeen = seen.filter((r) => r._count._all > 0).map((r) => ({ marketplace: r.marketplace, asin: r.asin }))
  }
  async function signalFor(runtime: RdCampaignRuntime, marketplace: string | null): Promise<RdSignal> {
    const lane = runtime.placement
    if (!lane || !runtime.activeTargetKey) {
      return { kind: 'not-applicable', lane: null, valuePct: null, ageDays: null, rows: null, contributors: null, freshness: 'none', staleReason: null, label: '—', detail: 'Nothing is held at this hour, so no lane is being driven.' }
    }
    if (lane === 'PLACEMENT_PRODUCT_PAGE') {
      return { kind: 'none-by-design', lane, valuePct: null, ageDays: null, rows: null, contributors: null, freshness: 'none', staleReason: null, label: 'open loop', detail: 'Open loop by design — Amazon exposes no product-page impression share, so this lane cannot be closed.' }
    }
    if (lane === 'PLACEMENT_TOP') return topLaneSignal(lane, topIsByCampaign.get(runtime.campaignId) ?? null, dbNow)
    // Rest of search — SQP, which is the lane with the onboarding problem.
    const asins = asinsByCampaign.get(runtime.campaignId) ?? []
    const covered = everCoveredIn(everSeen, marketplace, asins)
    if (!covered) {
      return { kind: 'no-coverage', lane, valuePct: null, ageDays: null, rows: 0, contributors: { withData: 0, total: asins.length }, freshness: 'never', staleReason: null, label: 'no coverage', detail: `None of this campaign's ${asins.length} advertised ASIN${asins.length === 1 ? ' has' : 's have'} ever appeared in Brand Analytics' weekly report for ${marketplace ?? 'its market'}. That is an onboarding problem, not a stale feed — no recency guard would fix it.` }
    }
    // B4 — the family share, its week, its age and its basis all from ONE reading (`sqpShareForAsins`, the
    // SQP programme's reader), so the label cannot pair a share with another week's age or basis.
    const reading = marketplace ? await sqpShareForAsins(marketplace, asins, dbNow) : null
    return sqpLaneSignal(lane, asins.length, reading)
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
