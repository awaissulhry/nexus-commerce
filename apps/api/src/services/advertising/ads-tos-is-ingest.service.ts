/**
 * Option C — Top-of-Search impression-share ingestion (isolated).
 *
 * Fetches Amazon's true `topOfSearchImpressionShare` (a campaign-level metric of
 * the v3 spCampaigns report) and stores it on the TOP_OF_SEARCH row of
 * AmazonAdsPlacementReport (column topOfSearchIS, normalised to a 0–1 fraction).
 *
 * SAFETY — fully isolated from the main metrics ingestion: it issues its OWN
 * campaigns report with the extra column (opt-in `extraColumns`), so if Amazon
 * rejects the metric this fetch fails on its own and the core campaign / ad-group
 * / keyword ingestion is untouched. It only UPDATES existing rows (never
 * creates), so it can't produce malformed placement rows. Read path for the loop:
 * defendTopOfSearch reads the same TOP rows.
 *
 * Lane 5 (2026-10-10, the free-visibility-numbers audit):
 *   T1  the unit is decided ONCE per report (any value above 1 → the whole report is percentages, else fractions:
 *       ads-reports.service.ts impressionShareUnit), never per value — a 0.8 % share was stored as 80 %.
 *   T3  a campaign-day with a share but no TOP placement row is no longer lost: its AmazonAdsDailyPerformance CAMPAIGN
 *       row is updated instead. A placement row is never created (its impressions would be made up).
 *   T4  the window ends YESTERDAY in the account's time zone (today is not finished); it was "now", today included.
 *   KW  a SEPARATE keyword-grain pass: Amazon's spTargeting report grouped by targeting, asking only
 *       `topOfSearchImpressionShare` and the ids it needs, UPDATES the existing AD_TARGET rows of
 *       AmazonAdsDailyPerformance (never creates one — the core targeting ingest owns those rows). It stays out of the
 *       core targeting report on purpose: one invalid column fails a whole v3 report, and the brain's 48-hour stale-data
 *       brake reads those rows. A failure of this pass never fails the campaign pass; the summary counts both grains.
 * The cron stays behind NEXUS_ENABLE_TOS_IS_INGEST_CRON (ads-tos-is-ingest.job.ts), exactly as before.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { fetchReport, type ClientContext } from './ads-api-client.js'
// One definition of the percentage-vs-fraction normalisation, shared with the
// campaign ingest. Two copies is how the two tables start disagreeing about a unit.
import { impressionShareUnit, toImpressionShareFraction, type ImpressionShareUnit } from './ads-reports.service.js'
import { adsAccountTimeZone } from './ads-market-time.js'
import { isoDayIn } from './ads-local-day.js'

const TOP_REPORT_PLACEMENT = 'Top of Search on-Amazon'
const SP = 'SPONSORED_PRODUCTS'
const DAY_MS = 86_400_000

/**
 * Campaign group-by only allows campaign-level columns — request a clean minimal set (the base set's
 * adGroupId/keywordId/adId/orders* are rejected by the campaigns report). topOfSearchImpressionShare confirmed allowed.
 */
export const CAMPAIGN_TOS_COLUMNS = ['date', 'campaignId', 'impressions', 'topOfSearchImpressionShare']
/**
 * KW — the keyword-grain pass: spTargeting grouped by targeting. `keywordId` carries the id of keywords AND product /
 * auto targets (Amazon reuses the column, as the core targeting ingest reads it). Amazon listed
 * topOfSearchImpressionShare among spTargeting's allowed columns in a captured 400 (audit §1.1); whether it is filled per
 * keyword row, and for auto targets, is what this pass's counts (updated / null) show.
 */
export const TARGETING_TOS_REPORT_TYPE_ID = 'spTargeting'
export const TARGETING_TOS_COLUMNS = ['date', 'campaignId', 'adGroupId', 'keywordId', 'impressions', 'topOfSearchImpressionShare']

/** What one grain's pass did. */
export interface GrainCounts {
  /** Rows Amazon sent. */
  rowsFetched: number
  /** Rows with a share (a number in the report's unit). */
  withIS: number
  /** Rows Nexus updated with it. */
  rowsUpdated: number
  /** Rows whose share Amazon sent empty (or not a share): nothing written, never 0. */
  rowsNull: number
  /** Rows with a share and no row of ours to update (never created), or without an id or a day. */
  rowsSkipped: number
}

export interface TosIsIngestResult {
  profiles: number
  /** Campaign grain: rows Amazon sent, rows with a share, TOP placement rows updated (the meaning these three always had). */
  rowsFetched: number
  withIS: number
  rowsUpdated: number
  /** T3 — campaign-days with a share and no TOP placement row: their AmazonAdsDailyPerformance CAMPAIGN row updated instead. */
  campaignRowsUpdated: number
  /** Campaign grain: rows with no share (nothing written). */
  rowsNull: number
  /** Campaign grain: a share and neither row to update, or no id or day. */
  rowsSkipped: number
  /** KW — the keyword-grain pass (AD_TARGET rows), its failures apart: they never fail the campaign pass. */
  keyword: GrainCounts & { errors: string[] }
  /** T4 — each account's window (yesterday in its time zone as the end). */
  windows: Array<{ profileId: string; startDate: string; endDate: string; timeZone: string }>
  sample: Array<{ campaignId: string; date: string; tosIS: number }>
  /** Campaign-pass failures (one per account). */
  errors: string[]
}

const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10)

/**
 * T4 — the report window: `windowDays` days ending YESTERDAY in the account's time zone (null zone: UTC). The start is
 * the one it always had (today − windowDays); only the unfinished today is left out. Pure.
 */
export function tosWindow(now: Date, timeZone: string | null, windowDays: number): { startDate: string; endDate: string } {
  const today = isoDayIn(now, timeZone)
  const days = Math.max(1, Math.min(60, Math.round(windowDays)))
  return { startDate: shiftDay(today, -days), endDate: shiftDay(today, -1) }
}

/** One report row as the passes read it: its id, its day, and its share in the report's unit (null: none). Pure. */
export function shareRowsOf(rows: readonly unknown[], idKey: 'campaignId' | 'keywordId'): { unit: ImpressionShareUnit; rows: Array<{ id: string | null; date: string | null; share: number | null }> } {
  const recs = rows.map((raw) => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}))
  // T1 — the unit, once for the whole report.
  const unit = impressionShareUnit(recs.map((r) => r.topOfSearchImpressionShare))
  return {
    unit,
    rows: recs.map((r) => {
      const id = r[idKey] == null || r[idKey] === '' ? null : String(r[idKey])
      const date = String(r.date ?? '').slice(0, 10)
      return { id, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, share: toImpressionShareFraction(r.topOfSearchImpressionShare, unit) }
    }),
  }
}

const NO_COUNTS = (): GrainCounts => ({ rowsFetched: 0, withIS: 0, rowsUpdated: 0, rowsNull: 0, rowsSkipped: 0 })

/** The campaign pass for one account: TOP placement rows, else (T3) the CAMPAIGN row. */
async function campaignPass(ctx: ClientContext, window: { startDate: string; endDate: string }) {
  const out = { ...NO_COUNTS(), campaignRowsUpdated: 0, sample: [] as TosIsIngestResult['sample'], unit: null as ImpressionShareUnit | null }
  // ACR.0.2 — pollMinutes 45, not the 10-minute default.
  //
  // Measured 2026-08-05: this report was still PENDING at the 10-minute ceiling on
  // every profile, every night, which is the entire reason topOfSearchIS is null on
  // all 3,383 placement rows. The request is accepted and the column is valid — a
  // control request without it timed out identically — so the only defect was
  // giving a batch report an interactive deadline.
  //
  // 45 is safe here specifically because profiles run in PARALLEL below, so this is
  // the job's worst-case wall-clock, not 9× it, and it runs at 02:30 with nothing
  // downstream waiting on it. If it still times out, the failure is now a logged
  // 504 with the report id rather than a number in a summary nobody reads.
  const raw = (await fetchReport(ctx, { reportType: 'campaigns', ...window, columnsOverride: CAMPAIGN_TOS_COLUMNS, pollMinutes: 45 })) as unknown[]
  const { unit, rows } = shareRowsOf(raw, 'campaignId')
  out.unit = unit
  for (const r of rows) {
    out.rowsFetched++
    if (!r.id || !r.date) { out.rowsSkipped++; continue }
    if (r.share === null) { out.rowsNull++; continue }
    out.withIS++
    const date = new Date(`${r.date}T00:00:00Z`)
    const res = await prisma.amazonAdsPlacementReport.updateMany({
      where: { campaignId: r.id, date, placement: TOP_REPORT_PLACEMENT },
      data: { topOfSearchIS: r.share },
    })
    if (res.count) out.rowsUpdated += res.count
    else {
      // T3 — no TOP placement row for this campaign-day (the placement report had none): the share goes on the campaign's
      // own daily row. Never a placement row created here: its impressions and spend would be made up.
      const camp = await prisma.amazonAdsDailyPerformance.updateMany({
        where: { profileId: ctx.profileId, adProduct: SP, entityType: 'CAMPAIGN', entityId: r.id, date },
        data: { topOfSearchIS: r.share },
      })
      if (camp.count) out.campaignRowsUpdated += camp.count
      else out.rowsSkipped++
    }
    if (out.sample.length < 3) out.sample.push({ campaignId: r.id, date: r.date, tosIS: Number(r.share.toFixed(4)) })
  }
  return out
}

/** KW — the keyword-grain pass for one account: only existing AD_TARGET rows are updated. */
async function keywordPass(ctx: ClientContext, window: { startDate: string; endDate: string }) {
  const out = { ...NO_COUNTS(), unit: null as ImpressionShareUnit | null }
  const raw = (await fetchReport(ctx, {
    reportType: 'keywords', reportTypeId: TARGETING_TOS_REPORT_TYPE_ID, groupBy: ['targeting'], ...window,
    columnsOverride: TARGETING_TOS_COLUMNS, pollMinutes: 45,
  })) as unknown[]
  const { unit, rows } = shareRowsOf(raw, 'keywordId')
  out.unit = unit
  for (const r of rows) {
    out.rowsFetched++
    if (!r.id || !r.date) { out.rowsSkipped++; continue }
    if (r.share === null) { out.rowsNull++; continue }
    out.withIS++
    const res = await prisma.amazonAdsDailyPerformance.updateMany({
      where: { profileId: ctx.profileId, adProduct: SP, entityType: 'AD_TARGET', entityId: r.id, date: new Date(`${r.date}T00:00:00Z`) },
      data: { topOfSearchIS: r.share },
    })
    // No AD_TARGET row yet (the core targeting ingest has not written that day): skipped, never created — the next
    // night's window reads the day again.
    if (res.count) out.rowsUpdated += res.count
    else out.rowsSkipped++
  }
  return out
}

export async function ingestTopOfSearchIS(opts: { windowDays?: number; marketplace?: string; now?: Date } = {}): Promise<TosIsIngestResult> {
  const windowDays = Math.max(1, Math.min(60, opts.windowDays ?? 7))
  const now = opts.now ?? new Date()

  const conns = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true, ...(opts.marketplace ? { marketplace: opts.marketplace } : {}) },
    select: { profileId: true, region: true, marketplace: true },
  })

  // Per-profile reports run in PARALLEL (each is an independent async report) so
  // total wall-clock ≈ the slowest single report, not the sum over all profiles.
  // The two grains of one account run side by side too, each catching its own failure.
  const perProfile = await Promise.all(conns.map(async (conn) => {
    const ctx: ClientContext = { profileId: conn.profileId, region: conn.region as ClientContext['region'] }
    // T4 — yesterday in the account's own time zone (its profile's, else the market's; none known: UTC, said in the window).
    const zone = await adsAccountTimeZone(conn.profileId, conn.marketplace).catch(() => null)
    const window = tosWindow(now, zone?.timeZone ?? null, windowDays)
    const [campaign, keyword] = await Promise.all([
      campaignPass(ctx, window).then((r) => ({ ok: r }), (e: unknown) => ({ error: `${conn.profileId}: ${(e as Error).message}` })),
      keywordPass(ctx, window).then((r) => ({ ok: r }), (e: unknown) => ({ error: `${conn.profileId}: ${(e as Error).message}` })),
    ])
    return { profileId: conn.profileId, window: { ...window, timeZone: zone?.timeZone ?? 'UTC' }, campaign, keyword }
  }))

  const out: TosIsIngestResult = {
    profiles: conns.length, rowsFetched: 0, withIS: 0, rowsUpdated: 0, campaignRowsUpdated: 0, rowsNull: 0, rowsSkipped: 0,
    keyword: { ...NO_COUNTS(), errors: [] }, windows: [], sample: [], errors: [],
  }
  const units: string[] = []
  for (const p of perProfile) {
    out.windows.push({ profileId: p.profileId, ...p.window })
    if ('error' in p.campaign) out.errors.push(p.campaign.error)
    else {
      const c = p.campaign.ok
      out.rowsFetched += c.rowsFetched; out.withIS += c.withIS; out.rowsUpdated += c.rowsUpdated
      out.campaignRowsUpdated += c.campaignRowsUpdated; out.rowsNull += c.rowsNull; out.rowsSkipped += c.rowsSkipped
      for (const s of c.sample) if (out.sample.length < 5) out.sample.push(s)
      if (c.rowsFetched) units.push(`${p.profileId} campaign=${c.unit}`)
    }
    if ('error' in p.keyword) out.keyword.errors.push(p.keyword.error)
    else {
      const k = p.keyword.ok
      out.keyword.rowsFetched += k.rowsFetched; out.keyword.withIS += k.withIS; out.keyword.rowsUpdated += k.rowsUpdated
      out.keyword.rowsNull += k.rowsNull; out.keyword.rowsSkipped += k.rowsSkipped
      if (k.rowsFetched) units.push(`${p.profileId} keyword=${k.unit}`)
    }
  }
  // ACR.0.2 — log the error TEXT, not just its count. Logging `errors: out.errors.length`
  // is why nine identical nightly failures were only ever visible as the number 9.
  if (out.errors.length) {
    logger.error('[tos-is-ingest] profile failures', {
      failed: out.errors.length, ofProfiles: out.profiles, errors: out.errors.slice(0, 5),
    })
  }
  if (out.keyword.errors.length) {
    logger.warn('[tos-is-ingest] keyword-grain pass failures (the campaign pass is not affected)', {
      failed: out.keyword.errors.length, ofProfiles: out.profiles, errors: out.keyword.errors.slice(0, 5),
    })
  }
  logger.info('[tos-is-ingest] done', {
    profiles: out.profiles, rowsFetched: out.rowsFetched, withIS: out.withIS, rowsUpdated: out.rowsUpdated,
    campaignRowsUpdated: out.campaignRowsUpdated, rowsNull: out.rowsNull, rowsSkipped: out.rowsSkipped, errors: out.errors.length,
    keyword: { ...out.keyword, errors: out.keyword.errors.length }, units, windows: out.windows.slice(0, 3),
  })
  return out
}

/** The job's one-line summary of both grains (ads-tos-is-ingest.job.ts). Pure. */
export function tosIsSummaryLine(r: TosIsIngestResult): string {
  const k = r.keyword
  const window = r.windows.length ? ` window=${r.windows[0].startDate}..${r.windows[0].endDate} (${r.windows[0].timeZone}${r.windows.length > 1 ? `, +${r.windows.length - 1} accounts` : ''})` : ''
  return `profiles=${r.profiles}${window}`
    + ` · campaign: rowsFetched=${r.rowsFetched} withIS=${r.withIS} rowsUpdated=${r.rowsUpdated} campaignRowsUpdated=${r.campaignRowsUpdated} rowsNull=${r.rowsNull} rowsSkipped=${r.rowsSkipped} errors=${r.errors.length}`
    + ` · keyword: rowsFetched=${k.rowsFetched} withIS=${k.withIS} rowsUpdated=${k.rowsUpdated} rowsNull=${k.rowsNull} rowsSkipped=${k.rowsSkipped} errors=${k.errors.length}`
}
