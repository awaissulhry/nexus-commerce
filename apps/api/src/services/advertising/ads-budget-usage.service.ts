/**
 * ADM-P6 — Current Budget Utilization, OOB Hours and ActBid Hours.
 *
 * The Ad Manager rendered `not measured` on 220 of 220 rows for all three, and the
 * plan to fix them assumed two possible sources. Both were measured on prod
 * 2026-08-22 and a third one won:
 *
 *   AMS budget-usage stream   subscription does not exist; `ingestBudgetUsage()`
 *                             stores nothing; and on the LIVE delivery path
 *                             (the HTTP webhook, not the SQS poll) every
 *                             non-performance record is skipped before it.
 *   hourly performance        real, ±0.5% against the daily report, but covers
 *                             only the 60 campaigns that actually spend, and its
 *                             denominator is OUR stored budget, which drifted on
 *                             3 of 200 campaigns.
 *   ✅ the budget-usage PULL   `POST /sp/campaigns/budget/usage` — synchronous, no
 *                             AWS, no subscription, answers for 200 of 200 SP
 *                             campaigns, and carries Amazon's own budget AND the
 *                             age of its own reading.
 *
 * 🔴 THE DAY BOUNDARY IS 00:00 UTC, AND THAT WAS MEASURED, NOT ASSUMED.
 * Amazon documents a reset at the marketplace's local midnight, and the profiles
 * report `Europe/Paris`. The account's data says otherwise. Over 301 campaign-days
 * of reported spend, matching Amazon's own daily report against both candidate
 * hourly sums:
 *
 *     00:00 UTC       298 of 301 exact, EUR 1.03 absolute error on EUR 764.16
 *     local midnight  204 of 301 exact, EUR 46.74 absolute error
 *
 * And the pull API agrees to the cent: GALE BROAD IT spent EUR 0.36 in UTC hour 22,
 * and Amazon reported 0% used one minute later. Under a local-midnight reset that
 * reading would have been 20.7%. So there is NO `AT TIME ZONE` here and no sixth
 * copy of `nowInTz` — the arithmetic is simpler than the plan budgeted for.
 *
 * 🔴 A STALE READING IS YESTERDAY'S NUMBER, NOT A ZERO.
 * Amazon does not zero the percentage at the reset; it stops updating it. Measured
 * the same morning: DE_Auto_Close read 27.2% stamped 19:59Z the previous day, two
 * hours after the reset. Every reading is therefore classified against the current
 * budget-day start before anything renders it.
 */

import prisma from '../../db.js'
import { Prisma } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { liveCall, adsMode, type AdsRegion } from './ads-api-client.js'

/** Amazon's Sponsored Products budget-usage query. A POST, but a pure read. */
const BUDGET_USAGE_PATH = '/sp/campaigns/budget/usage'
const BUDGET_USAGE_MIME = 'application/vnd.spcampaignbudgetusage.v3+json'
/** Amazon's documented ceiling for this endpoint. */
const MAX_CAMPAIGN_IDS_PER_CALL = 100

/**
 * The endpoint is Sponsored Products only. Measured 2026-08-22: of 219 campaigns
 * asked, the 19 Amazon refused with `campaignId does not exist` were 15 Sponsored
 * Display and 4 Sponsored Brands — every single one. So a non-SP campaign is not a
 * gap in our sampling, it is a question this API does not answer, and the column
 * says `n/a — SP` rather than pretending we failed to measure it.
 */
export const BUDGET_USAGE_AD_PRODUCT = 'SPONSORED_PRODUCTS'

/** 'pull' = this API. 'stream' = AMS budget-usage, which lands in the same table. */
export type BudgetUsageSource = 'pull' | 'stream'

export interface BudgetUsageReading {
  /** A FRACTION (0.5 = 50%), converted from Amazon's percent exactly once, here. */
  fraction: number
  /** Amazon's own budget for that reading, in cents. The denominator moves intraday. */
  budgetCents: number
  /** Amazon's usageUpdatedTimestamp — the age of the reading, never of our poll. */
  asOf: Date
}

/**
 * What the cell is allowed to say. Four absences, each with a different cause, and
 * no fifth word: this reuses ADM-H's vocabulary rather than inventing one.
 *
 *  live        Amazon's own reading, stamped inside the current budget day.
 *  derived     Amazon has not reported today, but our hourly feed has spend today.
 *              A cross-check, not a second opinion — it says so in the cell.
 *  silent      Neither source has anything for today. NOT a zero: Amazon simply has
 *              not spoken since the reset, and absence is not consumption of nought.
 *  unsupported Sponsored Display / Sponsored Brands — this API does not cover them.
 *  unknown     never sampled: the cron has not run for this campaign yet, or failed.
 */
export type BudgetUsageState = 'live' | 'derived' | 'silent' | 'unsupported' | 'unknown'

export interface CurrentBudgetUsage {
  state: BudgetUsageState
  /** FRACTION, or null whenever the state is not `live` / `derived`. Never 0 as a stand-in. */
  fraction: number | null
  /** The denominator the fraction actually used, in cents — Amazon's for `live`, ours for `derived`. */
  budgetCents: number | null
  /** ISO instant the reading belongs to. For `derived`, the newest hourly row we summed. */
  asOf: string | null
}

// ── the day boundary ────────────────────────────────────────────────────────

/**
 * The start of the budget day that `at` falls in: 00:00 UTC.
 *
 * Measured, not assumed — see the header. Deliberately not parameterised by
 * marketplace: making it configurable would invite a future caller to pass a
 * timezone that the data says is wrong, and a wrong day boundary is invisible
 * except in the two hours after local midnight.
 */
export function budgetDayStartUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
}

/** A reading describes TODAY only if Amazon stamped it after today's reset. */
export function isReadingCurrent(asOf: Date, now: Date): boolean {
  return asOf.getTime() >= budgetDayStartUtc(now).getTime()
}

// ── the hour columns ────────────────────────────────────────────────────────

export interface ObservedSpan {
  /** Amazon's percent for this reading: 0-100+, not a fraction. */
  percent: number
  firstSeenAt: Date
  lastSeenAt: Date
}

export interface UsageHours {
  /** UTC hours of the current budget day in which some reading was observed. */
  observed: number
  /** Of those, hours in which a reading of >= 100% was observed. */
  outOfBudget: number
  /** observed − outOfBudget. Hours the campaign was watched and not budget-capped. */
  actBid: number
}

/**
 * Count hours from the observation spans, never from a count of samples.
 *
 * 🔴 The exact instant of exhaustion is unobservable. Amazon pushes the stream at 5%
 * increments and this API is sampled on a cron; both are approximations, and
 * "out of budget at 14:32:07" would be inventing precision Amazon never sent. The
 * honest unit is the hour, and `observed` is reported beside it so a partial day
 * reads as a partial day instead of a quiet one.
 */
export function hoursFromSpans(spans: ObservedSpan[], now: Date, dayStart = budgetDayStartUtc(now)): UsageHours {
  const HOUR = 3_600_000
  const start = dayStart.getTime()
  const hoursElapsed = Math.min(24, Math.floor((now.getTime() - start) / HOUR) + 1)
  let observed = 0
  let outOfBudget = 0
  for (let h = 0; h < hoursElapsed; h++) {
    const from = start + h * HOUR
    const to = from + HOUR
    let seen = false
    let oob = false
    for (const s of spans) {
      // Half-open overlap: a span that ends exactly on the hour boundary belongs to
      // the hour it ran in, not to the next one that had not started.
      if (s.lastSeenAt.getTime() <= from || s.firstSeenAt.getTime() >= to) continue
      seen = true
      if (s.percent >= 100) oob = true
    }
    if (seen) observed++
    if (oob) outOfBudget++
  }
  return { observed, outOfBudget, actBid: observed - outOfBudget }
}

// ── Amazon ──────────────────────────────────────────────────────────────────

interface AmazonUsageRow {
  campaignId?: string
  budget?: number
  budgetUsagePercent?: number
  usageUpdatedTimestamp?: string
}
interface AmazonUsageError { campaignId?: string; code?: string; details?: string }
interface AmazonUsageResponse { success?: AmazonUsageRow[]; error?: AmazonUsageError[] }

export interface FetchedUsage {
  externalCampaignId: string
  percent: number
  budgetCents: number
  usageUpdatedAt: Date
}

/**
 * One call per <= 100 campaign ids. Read-only despite the POST verb: it is a query
 * endpoint, it mutates nothing, and it is not routed through the ads write gate.
 */
export async function fetchBudgetUsage(
  profileId: string,
  region: AdsRegion,
  externalCampaignIds: string[],
): Promise<{ rows: FetchedUsage[]; refused: AmazonUsageError[] }> {
  const rows: FetchedUsage[] = []
  const refused: AmazonUsageError[] = []
  for (let i = 0; i < externalCampaignIds.length; i += MAX_CAMPAIGN_IDS_PER_CALL) {
    const chunk = externalCampaignIds.slice(i, i + MAX_CAMPAIGN_IDS_PER_CALL)
    const res = await liveCall<AmazonUsageResponse>({
      profileId,
      region,
      method: 'POST',
      path: BUDGET_USAGE_PATH,
      body: { campaignIds: chunk },
      contentType: BUDGET_USAGE_MIME,
      acceptHeader: BUDGET_USAGE_MIME,
    })
    for (const r of res.success ?? []) {
      const pct = Number(r.budgetUsagePercent)
      const budget = Number(r.budget)
      const stamp = r.usageUpdatedTimestamp ? new Date(r.usageUpdatedTimestamp) : null
      // Every one of the three has to be real. A row missing its timestamp cannot be
      // placed in a day, and a reading that cannot be placed in a day is not a reading.
      if (!r.campaignId || !Number.isFinite(pct) || !Number.isFinite(budget) || !stamp || Number.isNaN(stamp.getTime())) {
        refused.push({ campaignId: r.campaignId, code: 'UnusableRow', details: JSON.stringify(r).slice(0, 120) })
        continue
      }
      rows.push({
        externalCampaignId: String(r.campaignId),
        percent: pct,
        budgetCents: Math.round(budget * 100),
        usageUpdatedAt: stamp,
      })
    }
    for (const e of res.error ?? []) refused.push(e)
  }
  return { rows, refused }
}

// ── the sampler ─────────────────────────────────────────────────────────────

export interface SampleSummary {
  profiles: number
  asked: number
  answered: number
  refused: number
  newReadings: number
  refreshed: number
  errors: string[]
}

/**
 * One tick: ask Amazon for every Sponsored Products campaign it will answer for, and
 * write down what changed.
 *
 * One row per distinct reading. A reading Amazon has not revised is not stored twice;
 * its `lastSeenAt` is pushed forward instead, which is what turns a pile of samples
 * into the observation SPANS the hour columns need.
 */
export async function sampleBudgetUsage(now = new Date()): Promise<SampleSummary> {
  const summary: SampleSummary = { profiles: 0, asked: 0, answered: 0, refused: 0, newReadings: 0, refreshed: 0, errors: [] }
  if (adsMode() === 'sandbox') {
    summary.errors.push('ads mode is sandbox — no live reading available')
    return summary
  }

  const conns = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true },
    select: { profileId: true, region: true, marketplace: true },
  })
  const campaigns = await prisma.campaign.findMany({
    where: { adProduct: BUDGET_USAGE_AD_PRODUCT, externalCampaignId: { not: null } },
    select: { id: true, externalCampaignId: true, marketplace: true },
  })
  const byMarketplace = new Map<string, typeof campaigns>()
  for (const c of campaigns) {
    const list = byMarketplace.get(c.marketplace) ?? []
    list.push(c)
    byMarketplace.set(c.marketplace, list)
  }

  for (const [marketplace, list] of byMarketplace) {
    const conn = conns.find((c) => c.marketplace === marketplace)
    if (!conn) {
      // Visible, not invisible: a marketplace with campaigns and no active connection
      // is a coverage hole the column would otherwise render as a plain absence.
      summary.errors.push(`${marketplace}: no active ads connection`)
      continue
    }
    const region = (conn.region === 'NA' || conn.region === 'FE' ? conn.region : 'EU') as AdsRegion
    const ids = list.map((c) => c.externalCampaignId!).filter(Boolean)
    summary.profiles++
    summary.asked += ids.length
    let fetched: Awaited<ReturnType<typeof fetchBudgetUsage>>
    try {
      fetched = await fetchBudgetUsage(conn.profileId, region, ids)
    } catch (e) {
      summary.errors.push(`${marketplace}: ${(e as Error).message.slice(0, 140)}`)
      continue
    }
    summary.answered += fetched.rows.length
    summary.refused += fetched.refused.length

    const localByExternal = new Map(list.map((c) => [c.externalCampaignId!, c]))
    const readings = fetched.rows
      .map((r) => ({ r, camp: localByExternal.get(r.externalCampaignId) }))
      .filter((x): x is { r: FetchedUsage; camp: (typeof list)[number] } => !!x.camp)
    if (!readings.length) continue

    const existing = await prisma.adBudgetUsageSample.findMany({
      where: {
        source: 'pull',
        campaignId: { in: readings.map((x) => x.camp.id) },
        usageUpdatedAt: { in: readings.map((x) => x.r.usageUpdatedAt) },
      },
      select: { id: true, campaignId: true, usageUpdatedAt: true },
    })
    const seen = new Set(existing.map((e) => `${e.campaignId}|${e.usageUpdatedAt.getTime()}`))
    const fresh = readings.filter((x) => !seen.has(`${x.camp.id}|${x.r.usageUpdatedAt.getTime()}`))
    const known = existing.filter((e) => readings.some((x) => x.camp.id === e.campaignId && x.r.usageUpdatedAt.getTime() === e.usageUpdatedAt.getTime()))

    if (known.length) {
      // The reading has not changed, so the FACT it records has not changed — only the
      // window over which we have watched it hold. That window is the measurement.
      await prisma.adBudgetUsageSample.updateMany({ where: { id: { in: known.map((k) => k.id) } }, data: { lastSeenAt: now } })
      summary.refreshed += known.length
    }
    if (fresh.length) {
      await prisma.adBudgetUsageSample.createMany({
        data: fresh.map((x) => ({
          campaignId: x.camp.id,
          externalCampaignId: x.r.externalCampaignId,
          profileId: conn.profileId,
          marketplace,
          percent: x.r.percent,
          budgetCents: x.r.budgetCents,
          usageUpdatedAt: x.r.usageUpdatedAt,
          firstSeenAt: now,
          lastSeenAt: now,
          source: 'pull',
        })),
        skipDuplicates: true,
      })
      summary.newReadings += fresh.length
    }
  }

  logger.info('[ADM-P6] budget usage sampled', summary)
  return summary
}

// ── readers ─────────────────────────────────────────────────────────────────

interface LatestRow { campaignId: string; percent: number; budgetCents: number; usageUpdatedAt: Date }

/** The newest reading per campaign, whatever day it belongs to — the caller classifies it. */
async function latestReadings(campaignIds: string[]): Promise<Map<string, LatestRow>> {
  if (!campaignIds.length) return new Map()
  const rows = await prisma.$queryRaw<LatestRow[]>`
    SELECT DISTINCT ON ("campaignId")
           "campaignId", "percent", "budgetCents", "usageUpdatedAt"
    FROM "AdBudgetUsageSample"
    WHERE "campaignId" IN (${Prisma.join(campaignIds)})
    ORDER BY "campaignId", "usageUpdatedAt" DESC, "lastSeenAt" DESC
  `
  return new Map(rows.map((r) => [r.campaignId, r]))
}

interface HourlyToday { campaignId: string; spendEur: number; lastRowAt: Date }

/**
 * The cross-check: today's spend from the feed we already ingest, on the same UTC
 * calendar. Only campaigns that were SERVED appear here — Amazon sends an hourly
 * record when there is traffic — so an absence here is not a zero either.
 */
async function hourlySpendToday(campaignIds: string[], dayStart: Date): Promise<Map<string, HourlyToday>> {
  if (!campaignIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ campaignId: string; spendEur: number; lastRowAt: Date }>>`
    SELECT "localEntityId" AS "campaignId",
           (SUM("costMicros") / 1e6)::float8 AS "spendEur",
           MAX("createdAt") AS "lastRowAt"
    FROM "AmazonAdsHourlyPerformance"
    WHERE "entityType" = 'CAMPAIGN'
      AND "localEntityId" IN (${Prisma.join(campaignIds)})
      AND "date" = ${dayStart}::date
    GROUP BY 1
  `
  return new Map(rows.map((r) => [r.campaignId, r]))
}

export interface UsageCampaign {
  id: string
  adProduct: string | null
  /** Our stored daily budget. Prisma Decimal — `Number(dec)`, never a typeof sniff. */
  dailyBudget: Prisma.Decimal | number | null
}

/**
 * What each campaign's Current Budget Utilization cell may say, and why.
 *
 * Preference order is deliberate: Amazon's own answer beats our arithmetic, because
 * it uses Amazon's own denominator and our stored one drifted on 3 of 200 campaigns
 * (MOSS-Brand / MOSS-Auto / MOSS-Competitor hold EUR 1 against Amazon's EUR 10).
 */
export async function readCurrentBudgetUsage(
  campaigns: UsageCampaign[],
  now = new Date(),
): Promise<Map<string, CurrentBudgetUsage>> {
  const out = new Map<string, CurrentBudgetUsage>()
  const supported = campaigns.filter((c) => c.adProduct === BUDGET_USAGE_AD_PRODUCT)
  for (const c of campaigns) {
    if (c.adProduct !== BUDGET_USAGE_AD_PRODUCT) {
      out.set(c.id, { state: 'unsupported', fraction: null, budgetCents: null, asOf: null })
    }
  }
  if (!supported.length) return out

  const ids = supported.map((c) => c.id)
  const dayStart = budgetDayStartUtc(now)
  const [latest, hourly] = await Promise.all([latestReadings(ids), hourlySpendToday(ids, dayStart)])

  for (const c of supported) {
    const reading = latest.get(c.id)
    if (reading && isReadingCurrent(reading.usageUpdatedAt, now)) {
      out.set(c.id, {
        state: 'live',
        fraction: reading.percent / 100,
        budgetCents: reading.budgetCents,
        asOf: reading.usageUpdatedAt.toISOString(),
      })
      continue
    }
    const h = hourly.get(c.id)
    const ourBudgetCents = c.dailyBudget != null ? Math.round(Number(c.dailyBudget) * 100) : null
    if (h && h.spendEur > 0 && ourBudgetCents && ourBudgetCents > 0) {
      out.set(c.id, {
        state: 'derived',
        fraction: (h.spendEur * 100) / ourBudgetCents,
        budgetCents: ourBudgetCents,
        asOf: h.lastRowAt.toISOString(),
      })
      continue
    }
    out.set(c.id, {
      // A campaign we have never sampled and one Amazon has not spoken about today are
      // different absences, and the cell says different things for them.
      state: reading ? 'silent' : 'unknown',
      fraction: null,
      budgetCents: null,
      asOf: reading ? reading.usageUpdatedAt.toISOString() : null,
    })
  }
  return out
}

export interface UsageHoursResult extends UsageHours {
  /** Null until the sampler has run at all — the columns say so rather than showing 0. */
  supported: boolean
}

/** OOB / ActBid hours for the current budget day, from the observation spans. */
export async function readBudgetUsageHours(
  campaigns: UsageCampaign[],
  now = new Date(),
): Promise<Map<string, UsageHoursResult>> {
  const out = new Map<string, UsageHoursResult>()
  const supported = campaigns.filter((c) => c.adProduct === BUDGET_USAGE_AD_PRODUCT)
  for (const c of campaigns) {
    if (c.adProduct !== BUDGET_USAGE_AD_PRODUCT) out.set(c.id, { observed: 0, outOfBudget: 0, actBid: 0, supported: false })
  }
  if (!supported.length) return out

  const dayStart = budgetDayStartUtc(now)
  const spans = await prisma.adBudgetUsageSample.findMany({
    where: { campaignId: { in: supported.map((c) => c.id) }, lastSeenAt: { gte: dayStart } },
    select: { campaignId: true, percent: true, firstSeenAt: true, lastSeenAt: true },
  })
  const byCampaign = new Map<string, ObservedSpan[]>()
  for (const s of spans) {
    const list = byCampaign.get(s.campaignId) ?? []
    list.push({ percent: s.percent, firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt })
    byCampaign.set(s.campaignId, list)
  }
  for (const c of supported) {
    out.set(c.id, { ...hoursFromSpans(byCampaign.get(c.id) ?? [], now, dayStart), supported: true })
  }
  return out
}

/**
 * The instant sampling began. Both hour columns are bounded by it and must say so:
 * neither Amazon's stream nor this API has any history, so the hours before the
 * first sample are not zero, they are unwatched and unrecoverable.
 */
export async function budgetUsageSamplingSince(): Promise<Date | null> {
  const first = await prisma.adBudgetUsageSample.aggregate({ _min: { firstSeenAt: true } })
  return first._min.firstSeenAt ?? null
}
