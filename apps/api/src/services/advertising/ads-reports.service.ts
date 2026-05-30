/**
 * Phase 4 — Amazon Ads Reports API v3 ingestion w/ resumable polling.
 *
 * Three-stage async flow:
 *   1. createReportJob() — POST to /reporting/reports. Amazon returns a
 *      reportId; we persist {externalReportId, status=PENDING} to
 *      AmazonAdsReportJob. Idempotent on (profileId, adProduct,
 *      reportTypeId, startDate, endDate) — re-running won't duplicate.
 *   2. pollPendingJobs() — GET /reporting/reports/:id for every job in
 *      PENDING|IN_PROGRESS. Advances status; when COMPLETED, captures
 *      the S3 presigned URL.
 *   3. ingestCompletedJob() — fetches the S3 URL (gzipped JSON),
 *      decompresses, parses, upserts each row to
 *      AmazonAdsDailyPerformance.
 *
 * Designed to be resumable: server restarts mid-poll lose nothing
 * because reportId is persisted. The polling cycle picks up where it
 * left off via lastPolledAt.
 *
 * Currency: report rows include `cost` in currency units; we multiply by
 * 1_000_000 to store as BigInt micros. Every row carries currencyCode
 * from the profile so cross-currency rollup knows what to convert.
 */

import { gunzipSync } from 'node:zlib'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  liveCall,
  type AdsRegion,
} from './ads-api-client.js'

export type AdProduct =
  | 'SPONSORED_PRODUCTS'
  | 'SPONSORED_DISPLAY'
  | 'SPONSORED_BRANDS'

export interface ReportSpec {
  profileId: string
  region: AdsRegion
  marketplace: string
  currencyCode: string
  adProduct: AdProduct
  reportTypeId: string  // INTERNAL identifier — stored on the DB row.
                        // For most reports this matches the Amazon v3
                        // reportTypeId. Placement reports are special:
                        // v3 uses 'spCampaigns' but we store 'spPlacement'
                        // so dispatch + idempotency are distinct from
                        // regular campaign reports.
  /** Optional Amazon-API-side override. When set, sent to Amazon in
   *  configuration.reportTypeId; reportTypeId above is used only for
   *  our DB columns + dispatcher. Defaults to reportTypeId. */
  apiReportTypeId?: string
  startDate: string      // YYYY-MM-DD
  endDate: string        // YYYY-MM-DD
  groupBy: string[]
  columns: string[]
  timeUnit?: 'DAILY' | 'SUMMARY'
}

// ── Column factories per adProduct ────────────────────────────────────
// Each ad product has its own valid column vocabulary. Wrong column for
// the report type returns 400 "configuration format". These are the
// minimal viable sets for campaign-level daily performance.

export const CAMPAIGN_COLUMNS: Record<AdProduct, string[]> = {
  SPONSORED_PRODUCTS: [
    'date', 'campaignId', 'campaignName', 'campaignStatus',
    'impressions', 'clicks', 'cost',
    'sales7d', 'purchases7d', 'unitsSoldClicks7d',
  ],
  SPONSORED_DISPLAY: [
    // Phase G fix: v3 SD reports rejected viewableImpressions. The v3
    // SD vocabulary moved it to viewabilityRate / aggregated metrics
    // accessed via a different report type. Dropping it keeps the
    // base campaign report working; the field stays in the ingest row
    // interface but defaults to 0 when absent from the response.
    'date', 'campaignId', 'campaignName',
    'impressions', 'clicks', 'cost',
    'sales', 'purchases',
  ],
  SPONSORED_BRANDS: [
    // Phase G fix: v3 SB reports rejected attributedSales14d /
    // attributedDetailPageViewsClicks14d. Those names belong to the v2
    // SB Reports API. v3 SB uses unsuffixed metric column names (sales,
    // purchases) consistent with SD; attribution windows are inferred
    // from the report configuration rather than the column suffix.
    'date', 'campaignId', 'campaignName',
    'impressions', 'clicks', 'cost',
    'sales', 'purchases',
  ],
}

export const CAMPAIGN_REPORT_TYPE_ID: Record<AdProduct, string> = {
  SPONSORED_PRODUCTS: 'spCampaigns',
  SPONSORED_DISPLAY: 'sdCampaigns',
  SPONSORED_BRANDS: 'sbCampaigns',
}

// ── Phase 6: Search term + placement column factories ────────────────
// SP and SB support search-term reports (what user queries triggered
// our ads). SD has no equivalent (it's not search-driven). Placement
// reports are SP-only.

export const SEARCH_TERM_COLUMNS: Partial<Record<AdProduct, string[]>> = {
  SPONSORED_PRODUCTS: [
    'date', 'campaignId', 'adGroupId',
    'keywordId', 'keyword', 'matchType', 'searchTerm',
    'impressions', 'clicks', 'cost',
    'sales7d', 'purchases7d',
  ],
  SPONSORED_BRANDS: [
    // Phase G fix: same v2→v3 column rename as CAMPAIGN_COLUMNS above.
    // Backfill fix: SB v3 search-term uses 'keywordText' not 'keyword'
    // (Amazon's "Allowed values" hint listed keywordText, keywordType
    // but rejected the bare 'keyword' name SP accepts).
    'date', 'campaignId', 'adGroupId',
    'keywordId', 'keywordText', 'matchType', 'searchTerm',
    'impressions', 'clicks', 'cost',
    'sales', 'purchases',
  ],
}

export const SEARCH_TERM_REPORT_TYPE_ID: Partial<Record<AdProduct, string>> = {
  SPONSORED_PRODUCTS: 'spSearchTerm',
  SPONSORED_BRANDS: 'sbSearchTerm',
}

export const PLACEMENT_COLUMNS: string[] = [
  'date', 'campaignId',
  'placementClassification', // top of search | rest of search | product pages
  'impressions', 'clicks', 'cost',
  'sales7d', 'purchases7d', 'unitsSoldClicks7d',
]

// v3 has no standalone 'spPlacement' reportTypeId. Placement data comes
// from spCampaigns + groupBy=['campaignPlacement']. To keep our internal
// dispatch + idempotency key distinct from regular campaign reports we
// store 'spPlacement' in the DB but send 'spCampaigns' over the wire.
export const PLACEMENT_REPORT_TYPE_ID = 'spPlacement'         // DB / dispatch
export const PLACEMENT_API_REPORT_TYPE_ID = 'spCampaigns'     // Amazon API

// ── Stage 1: create a report job ─────────────────────────────────────

export interface CreateReportJobResult {
  jobId: string
  externalReportId: string
  status: string
  alreadyExisted?: boolean
}

export async function createReportJob(spec: ReportSpec): Promise<CreateReportJobResult> {
  // Idempotency: if a job for this (profile, adProduct, reportTypeId,
  // date range) is already PENDING|IN_PROGRESS, return it.
  const existing = await prisma.amazonAdsReportJob.findFirst({
    where: {
      profileId: spec.profileId,
      adProduct: spec.adProduct,
      reportTypeId: spec.reportTypeId,
      startDate: new Date(spec.startDate),
      endDate: new Date(spec.endDate),
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    },
    select: { id: true, externalReportId: true, status: true },
  })
  if (existing) {
    return {
      jobId: existing.id,
      externalReportId: existing.externalReportId,
      status: existing.status,
      alreadyExisted: true,
    }
  }

  const apiReportTypeId = spec.apiReportTypeId ?? spec.reportTypeId
  const body = {
    name: `${spec.adProduct.toLowerCase()}-${spec.reportTypeId}-${spec.startDate}-${spec.endDate}-${Date.now()}`,
    startDate: spec.startDate,
    endDate: spec.endDate,
    configuration: {
      adProduct: spec.adProduct,
      groupBy: spec.groupBy,
      columns: spec.columns,
      reportTypeId: apiReportTypeId,
      timeUnit: spec.timeUnit ?? 'DAILY',
      format: 'GZIP_JSON',
    },
  }

  const response = await liveCall<{ reportId: string; status?: string }>({
    profileId: spec.profileId,
    region: spec.region,
    method: 'POST',
    path: '/reporting/reports',
    body,
    contentType: 'application/vnd.createasyncreportrequest.v3+json',
  })

  if (!response.reportId) {
    throw new Error(`[ads-reports] create returned no reportId: ${JSON.stringify(response).slice(0, 200)}`)
  }

  const job = await prisma.amazonAdsReportJob.create({
    data: {
      profileId: spec.profileId,
      adProduct: spec.adProduct,
      reportTypeId: spec.reportTypeId,
      externalReportId: response.reportId,
      startDate: new Date(spec.startDate),
      endDate: new Date(spec.endDate),
      configuration: body as unknown as object,
      status: (response.status ?? 'PENDING').toUpperCase(),
    },
    select: { id: true },
  })

  logger.info('[ads-reports] job created', {
    jobId: job.id,
    externalReportId: response.reportId,
    profileId: spec.profileId,
    adProduct: spec.adProduct,
    reportTypeId: spec.reportTypeId,
  })

  return {
    jobId: job.id,
    externalReportId: response.reportId,
    status: (response.status ?? 'PENDING').toUpperCase(),
  }
}

// ── Stage 2: poll pending jobs ──────────────────────────────────────

export interface PollSummary {
  polled: number
  completed: number
  failed: number
  stillPending: number
  errors: string[]
}

export async function pollPendingJobs(limit = 20): Promise<PollSummary> {
  const summary: PollSummary = {
    polled: 0, completed: 0, failed: 0, stillPending: 0, errors: [],
  }

  const jobs = await prisma.amazonAdsReportJob.findMany({
    where: { status: { in: ['PENDING', 'IN_PROGRESS'] } },
    orderBy: [{ lastPolledAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  })

  for (const job of jobs) {
    summary.polled += 1
    try {
      const conn = await prisma.amazonAdsConnection.findUnique({
        where: { profileId: job.profileId },
        select: { region: true },
      })
      const region: AdsRegion = (conn?.region === 'NA' || conn?.region === 'FE')
        ? (conn.region as AdsRegion)
        : 'EU'

      // v3 Reports API status response shape:
      //   status: PENDING | PROCESSING | COMPLETED | FAILED
      //   url: signed S3 download URL when COMPLETED (NOT `location`)
      //   urlExpiresAt: ISO timestamp
      //   fileSize: bytes
      //   failureReason: error message when FAILED
      // Phase G fix: we were reading `location` (v2 field name) instead
      // of `url` (v3 field name). When Amazon returned COMPLETED with
      // a real url, the `if (upper === 'COMPLETED' && status.location)`
      // check failed because location was undefined, falling through to
      // the else branch which wrote status='COMPLETED' but with
      // location=null. Ingest then refused the job ("not ingestable").
      const status = await liveCall<{
        status: string
        url?: string
        urlExpiresAt?: string
        fileSize?: number
        failureReason?: string
      }>({
        profileId: job.profileId,
        region,
        method: 'GET',
        path: `/reporting/reports/${job.externalReportId}`,
      })

      const upper = status.status?.toUpperCase() ?? 'PENDING'

      if (upper === 'COMPLETED' && status.url) {
        await prisma.amazonAdsReportJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            location: status.url,
            fileSize: status.fileSize,
            lastPolledAt: new Date(),
            completedAt: new Date(),
            attempts: job.attempts + 1,
          },
        })
        summary.completed += 1
      } else if (upper === 'FAILURE' || upper === 'FAILED') {
        await prisma.amazonAdsReportJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            errorMessage: status.failureReason ?? 'Amazon returned FAILURE status',
            lastPolledAt: new Date(),
            attempts: job.attempts + 1,
          },
        })
        summary.failed += 1
      } else {
        // PENDING | IN_PROGRESS | PROCESSING (or COMPLETED-without-url race)
        // Phase G fix: if Amazon says COMPLETED but the signed url hasn't
        // materialized yet (a rare race during their report finalization),
        // keep the job in the polling set by writing IN_PROGRESS instead
        // of letting status='COMPLETED' through with location=null.
        const writeStatus =
          upper === 'PROCESSING' ? 'IN_PROGRESS'
          : upper === 'COMPLETED' ? 'IN_PROGRESS' // url missing; re-poll
          : upper
        await prisma.amazonAdsReportJob.update({
          where: { id: job.id },
          data: {
            status: writeStatus,
            lastPolledAt: new Date(),
            attempts: job.attempts + 1,
          },
        })
        summary.stillPending += 1
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`job ${job.id}: ${msg.slice(0, 800)}`)
      logger.warn('[ads-reports] poll failed', { jobId: job.id, error: msg })
      await prisma.amazonAdsReportJob.update({
        where: { id: job.id },
        data: { lastPolledAt: new Date(), attempts: job.attempts + 1, errorMessage: msg.slice(0, 500) },
      }).catch(() => { /* swallow */ })
    }
  }

  return summary
}

// ── Stage 3: ingest a completed job ──────────────────────────────────

export interface IngestResult {
  jobId: string
  rowsIngested: number
  error?: string
}

interface ReportRow {
  date?: string
  campaignId?: string | number
  campaignName?: string
  campaignStatus?: string
  // Search-term + placement rows add these:
  adGroupId?: string | number
  keywordId?: string | number
  keyword?: string
  matchType?: string
  searchTerm?: string
  placementClassification?: string
  placement?: string
  impressions?: number
  clicks?: number
  cost?: number
  // SP attribution windows
  sales7d?: number
  purchases7d?: number
  unitsSoldClicks7d?: number
  // SD specific
  sales?: number
  purchases?: number
  viewableImpressions?: number
  // SB specific
  attributedSales14d?: number
  attributedDetailPageViewsClicks14d?: number
  [key: string]: unknown
}

function toStrIdOrNull(v: string | number | undefined | null): string | null {
  if (v == null) return null
  return typeof v === 'string' ? v : String(v)
}

function toMicros(amount: number | undefined): bigint {
  if (amount == null) return 0n
  // Multiply with rounding to int micros to avoid float drift.
  return BigInt(Math.round(amount * 1_000_000))
}

function toCents(amount: number | undefined): number {
  if (amount == null) return 0
  return Math.round(amount * 100)
}

export async function ingestCompletedJob(jobId: string): Promise<IngestResult> {
  const job = await prisma.amazonAdsReportJob.findUnique({ where: { id: jobId } })
  if (!job) return { jobId, rowsIngested: 0, error: 'job_not_found' }
  if (job.status !== 'COMPLETED' || !job.location) {
    return { jobId, rowsIngested: 0, error: `job not ingestable: status=${job.status}` }
  }

  const profile = await prisma.amazonAdsProfile.findUnique({
    where: { profileId: job.profileId },
    select: { currencyCode: true, marketplace: true },
  })
  // Fall back to AmazonAdsConnection.marketplace if AmazonAdsProfile not yet populated
  const conn = profile ? null : await prisma.amazonAdsConnection.findUnique({
    where: { profileId: job.profileId },
    select: { marketplace: true },
  })
  const currencyCode = profile?.currencyCode ?? 'EUR'
  const marketplace = profile?.marketplace ?? conn?.marketplace ?? ''

  // Download from S3 presigned URL — no auth header needed.
  let bytes: Buffer
  try {
    const dlRes = await fetch(job.location)
    if (!dlRes.ok) {
      throw new Error(`download failed ${dlRes.status}`)
    }
    const arrayBuf = await dlRes.arrayBuffer()
    bytes = Buffer.from(arrayBuf)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.amazonAdsReportJob.update({
      where: { id: jobId },
      data: { errorMessage: `download: ${msg}`.slice(0, 500) },
    })
    return { jobId, rowsIngested: 0, error: `download: ${msg}` }
  }

  // Decompress gzip → parse JSON array of rows.
  let rows: ReportRow[]
  try {
    const decompressed = gunzipSync(bytes)
    rows = JSON.parse(decompressed.toString('utf8'))
    if (!Array.isArray(rows)) {
      throw new Error('parsed JSON is not an array')
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.amazonAdsReportJob.update({
      where: { id: jobId },
      data: { errorMessage: `parse: ${msg}`.slice(0, 500) },
    })
    return { jobId, rowsIngested: 0, error: `parse: ${msg}` }
  }

  logger.info('[ads-reports] ingesting', {
    jobId, rowsToProcess: rows.length,
    adProduct: job.adProduct, reportTypeId: job.reportTypeId,
  })

  // Dispatch on reportTypeId — each variant writes to a different table.
  let upserted = 0
  if (job.reportTypeId === 'spCampaigns' || job.reportTypeId === 'sdCampaigns' || job.reportTypeId === 'sbCampaigns') {
    upserted = await ingestCampaignRows(job, rows, marketplace, currencyCode)
  } else if (job.reportTypeId === 'spSearchTerm' || job.reportTypeId === 'sbSearchTerm') {
    upserted = await ingestSearchTermRows(job, rows, marketplace, currencyCode)
  } else if (job.reportTypeId === PLACEMENT_REPORT_TYPE_ID) {
    upserted = await ingestPlacementRows(job, rows, marketplace, currencyCode)
  } else {
    logger.warn('[ads-reports] unknown reportTypeId', { jobId, reportTypeId: job.reportTypeId })
  }

  await prisma.amazonAdsReportJob.update({
    where: { id: jobId },
    data: { rowsIngested: upserted },
  })

  return { jobId, rowsIngested: upserted }
}

// ── Per-report-type ingest helpers ───────────────────────────────────

async function ingestCampaignRows(
  job: { id: string; profileId: string; adProduct: string },
  rows: ReportRow[],
  marketplace: string,
  currencyCode: string,
): Promise<number> {
  let upserted = 0
  for (const r of rows) {
    if (!r.date || r.campaignId == null) continue
    const entityId = typeof r.campaignId === 'string' ? r.campaignId : String(r.campaignId)
    const date = new Date(r.date)
    if (Number.isNaN(date.getTime())) continue

    const local = await prisma.campaign.findFirst({
      where: { externalCampaignId: entityId, marketplace },
      select: { id: true },
    })

    // Per-adProduct attribution mapping. Phase G: SB v3 reports return
    // unsuffixed `sales`/`purchases` (same shape as SD v3) rather than
    // the v2 attributedSales14d/attributedConversions14d names. Store
    // SB sales in sales14dCents to preserve the original 14d-window
    // semantic; analytics sums both fields anyway.
    const sales7dCents =
      job.adProduct === 'SPONSORED_PRODUCTS' ? toCents(r.sales7d)
      : job.adProduct === 'SPONSORED_DISPLAY' ? toCents(r.sales)
      : 0
    const sales14dCents =
      job.adProduct === 'SPONSORED_BRANDS' ? toCents(r.sales) : 0
    const orders7d =
      job.adProduct === 'SPONSORED_PRODUCTS' ? (r.purchases7d ?? 0)
      : job.adProduct === 'SPONSORED_DISPLAY' ? (r.purchases ?? 0)
      : job.adProduct === 'SPONSORED_BRANDS' ? (r.purchases ?? 0)
      : 0
    const units7d = r.unitsSoldClicks7d ?? 0
    const viewableImpressions = r.viewableImpressions ?? 0

    try {
      await prisma.amazonAdsDailyPerformance.upsert({
        where: {
          profileId_adProduct_entityType_entityId_date: {
            profileId: job.profileId,
            adProduct: job.adProduct,
            entityType: 'CAMPAIGN',
            entityId,
            date,
          },
        },
        create: {
          profileId: job.profileId, marketplace, adProduct: job.adProduct,
          date, entityType: 'CAMPAIGN', entityId,
          localEntityId: local?.id ?? null,
          impressions: r.impressions ?? 0, clicks: r.clicks ?? 0,
          costMicros: toMicros(r.cost), currencyCode,
          sales7dCents, sales14dCents, orders7d, units7d, viewableImpressions,
          reportRunId: job.id, reportedAt: new Date(),
        },
        update: {
          marketplace, localEntityId: local?.id ?? null,
          impressions: r.impressions ?? 0, clicks: r.clicks ?? 0,
          costMicros: toMicros(r.cost), currencyCode,
          sales7dCents, sales14dCents, orders7d, units7d, viewableImpressions,
          reportRunId: job.id, reportedAt: new Date(),
        },
      })
      upserted += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('[ads-reports] campaign row upsert failed', { jobId: job.id, entityId, error: msg.slice(0, 200) })
    }
  }
  return upserted
}

async function ingestSearchTermRows(
  job: { id: string; profileId: string; adProduct: string },
  rows: ReportRow[],
  marketplace: string,
  currencyCode: string,
): Promise<number> {
  // Search-term ingest: delete any rows previously written by this job
  // (re-ingest idempotency), then bulk-insert fresh. Natural key is wide
  // (profileId, date, campaignId, adGroupId, query, matchType) — clearing
  // by reportRunId avoids needing a composite unique constraint.
  if (rows.length > 0) {
    await prisma.amazonAdsSearchTerm.deleteMany({ where: { reportRunId: job.id } })
  }

  const inserts: Array<Parameters<typeof prisma.amazonAdsSearchTerm.create>[0]['data']> = []
  // Backfill investigation: with groupBy=['searchTerm'] Amazon can
  // return rows aggregated across multiple ad groups, in which case
  // adGroupId is null. Previously we hard-skipped those rows — the
  // spend was real, we just couldn't pin it to one ad-group. Store
  // them with adGroupId='' so the query-level rollups still work;
  // joins on real adGroupIds naturally exclude these aggregated rows.
  let skipped = { noDate: 0, noCampaign: 0, noQuery: 0, badDate: 0, noQueryField: 0 }
  for (const r of rows) {
    if (!r.date) { skipped.noDate += 1; continue }
    if (r.campaignId == null) { skipped.noCampaign += 1; continue }
    // searchTerm OR query — Amazon's v3 spSearchTerm response might
    // use either field name. Check both before giving up.
    const rawQuery = (r.searchTerm ?? (r as Record<string, unknown>).query ?? '')
    const query = String(rawQuery).trim()
    if (!query) { skipped.noQuery += 1; continue }
    const date = new Date(r.date)
    if (Number.isNaN(date.getTime())) { skipped.badDate += 1; continue }

    // Per-adProduct attribution mapping (Phase G: SB v3 uses unsuffixed
    // sales/purchases instead of attributedSales14d).
    const sales7dCents =
      job.adProduct === 'SPONSORED_PRODUCTS' ? toCents(r.sales7d)
      : job.adProduct === 'SPONSORED_BRANDS' ? toCents(r.sales)
      : 0
    const orders7d =
      job.adProduct === 'SPONSORED_PRODUCTS' ? (r.purchases7d ?? 0)
      : job.adProduct === 'SPONSORED_BRANDS' ? (r.purchases ?? 0)
      : 0

    inserts.push({
      profileId: job.profileId,
      marketplace,
      adProduct: job.adProduct,
      date,
      campaignId: toStrIdOrNull(r.campaignId) ?? '',
      adGroupId: toStrIdOrNull(r.adGroupId) ?? '', // '' when aggregated across ad groups
      matchedKeywordId: toStrIdOrNull(r.keywordId),
      matchType: r.matchType ?? null,
      query,
      impressions: r.impressions ?? 0,
      clicks: r.clicks ?? 0,
      costMicros: toMicros(r.cost),
      currencyCode,
      sales7dCents,
      orders7d,
      reportRunId: job.id,
    })
  }

  if (inserts.length === 0) {
    // Log skip diagnostics so we can spot field-shape regressions.
    // If rows came in but all got skipped, this tells us where.
    logger.warn('[ads-reports] search-term ingest produced 0 rows', {
      jobId: job.id, adProduct: job.adProduct,
      rowsIn: rows.length, skipped,
      sampleKeys: rows[0] ? Object.keys(rows[0]).slice(0, 15) : [],
    })
    return 0
  }
  // createMany is faster than per-row create for high-cardinality
  // search-term data (potentially 1K+ rows per profile per day).
  const result = await prisma.amazonAdsSearchTerm.createMany({ data: inserts })
  return result.count
}

async function ingestPlacementRows(
  job: { id: string; profileId: string; adProduct: string },
  rows: ReportRow[],
  marketplace: string,
  currencyCode: string,
): Promise<number> {
  let upserted = 0
  for (const r of rows) {
    if (!r.date || r.campaignId == null) continue
    const placement = r.placementClassification ?? r.placement ?? null
    if (!placement) continue
    const campaignId = typeof r.campaignId === 'string' ? r.campaignId : String(r.campaignId)
    const date = new Date(r.date)
    if (Number.isNaN(date.getTime())) continue

    const local = await prisma.campaign.findFirst({
      where: { externalCampaignId: campaignId, marketplace },
      select: { id: true },
    })

    const sales7dCents = toCents(r.sales7d)
    const orders7d = r.purchases7d ?? 0

    try {
      await prisma.amazonAdsPlacementReport.upsert({
        where: {
          campaignId_date_placement: { campaignId, date, placement },
        },
        create: {
          profileId: job.profileId,
          marketplace,
          adProduct: job.adProduct,
          date,
          campaignId,
          localCampaignId: local?.id ?? null,
          placement,
          impressions: r.impressions ?? 0,
          clicks: r.clicks ?? 0,
          costMicros: toMicros(r.cost),
          currencyCode,
          sales7dCents,
          orders7d,
          reportRunId: job.id,
        },
        update: {
          localCampaignId: local?.id ?? null,
          impressions: r.impressions ?? 0,
          clicks: r.clicks ?? 0,
          costMicros: toMicros(r.cost),
          currencyCode,
          sales7dCents,
          orders7d,
          reportRunId: job.id,
        },
      })
      upserted += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('[ads-reports] placement row upsert failed', { jobId: job.id, campaignId, error: msg.slice(0, 200) })
    }
  }
  return upserted
}

// ── Convenience: full creation cycle across all active profiles ────────

export interface CreationCycleResult {
  jobsCreated: number
  jobsSkipped: number
  errors: string[]
}

export async function runReportCreationCycle(
  args: { startDate: string; endDate: string; adProducts?: AdProduct[] } = { startDate: '', endDate: '' },
): Promise<CreationCycleResult> {
  const result: CreationCycleResult = { jobsCreated: 0, jobsSkipped: 0, errors: [] }
  const adProducts = args.adProducts ?? ['SPONSORED_PRODUCTS', 'SPONSORED_DISPLAY', 'SPONSORED_BRANDS']

  const profiles = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true },
    select: { profileId: true, region: true, marketplace: true },
  })

  for (const profile of profiles) {
    const region: AdsRegion = (profile.region === 'NA' || profile.region === 'FE')
      ? (profile.region as AdsRegion)
      : 'EU'
    // Resolve currency from AmazonAdsProfile if present, else fall back to EUR.
    const meta = await prisma.amazonAdsProfile.findUnique({
      where: { profileId: profile.profileId },
      select: { currencyCode: true },
    })
    const currencyCode = meta?.currencyCode ?? 'EUR'

    for (const adProduct of adProducts) {
      try {
        const out = await createReportJob({
          profileId: profile.profileId,
          region,
          marketplace: profile.marketplace,
          currencyCode,
          adProduct,
          reportTypeId: CAMPAIGN_REPORT_TYPE_ID[adProduct],
          startDate: args.startDate,
          endDate: args.endDate,
          groupBy: ['campaign'],
          columns: CAMPAIGN_COLUMNS[adProduct],
          timeUnit: 'DAILY',
        })
        if (out.alreadyExisted) result.jobsSkipped += 1
        else result.jobsCreated += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`${profile.profileId} ${adProduct}: ${msg.slice(0, 800)}`)
      }
    }
  }

  return result
}

// ── Phase 6: search term + placement creation cycles ─────────────────

export async function runSearchTermReportCycle(
  args: { startDate: string; endDate: string; adProducts?: AdProduct[] },
): Promise<CreationCycleResult> {
  const result: CreationCycleResult = { jobsCreated: 0, jobsSkipped: 0, errors: [] }
  // SD has no search-term concept; default to SP + SB only.
  const adProducts = (args.adProducts ?? ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS'])
    .filter((p) => SEARCH_TERM_REPORT_TYPE_ID[p] != null)

  const profiles = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true },
    select: { profileId: true, region: true, marketplace: true },
  })

  for (const profile of profiles) {
    const region: AdsRegion = (profile.region === 'NA' || profile.region === 'FE')
      ? (profile.region as AdsRegion) : 'EU'
    const meta = await prisma.amazonAdsProfile.findUnique({
      where: { profileId: profile.profileId },
      select: { currencyCode: true },
    })
    const currencyCode = meta?.currencyCode ?? 'EUR'

    for (const adProduct of adProducts) {
      const reportTypeId = SEARCH_TERM_REPORT_TYPE_ID[adProduct]
      const columns = SEARCH_TERM_COLUMNS[adProduct]
      if (!reportTypeId || !columns) continue

      try {
        const out = await createReportJob({
          profileId: profile.profileId,
          region,
          marketplace: profile.marketplace,
          currencyCode,
          adProduct,
          reportTypeId,
          startDate: args.startDate,
          endDate: args.endDate,
          groupBy: ['searchTerm'],
          columns,
          timeUnit: 'DAILY',
        })
        if (out.alreadyExisted) result.jobsSkipped += 1
        else result.jobsCreated += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`${profile.profileId} ${adProduct} search-term: ${msg.slice(0, 800)}`)
      }
    }
  }
  return result
}

export async function runPlacementReportCycle(
  args: { startDate: string; endDate: string },
): Promise<CreationCycleResult> {
  // Placement reports are SP-only.
  const result: CreationCycleResult = { jobsCreated: 0, jobsSkipped: 0, errors: [] }
  const profiles = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true },
    select: { profileId: true, region: true, marketplace: true },
  })

  for (const profile of profiles) {
    const region: AdsRegion = (profile.region === 'NA' || profile.region === 'FE')
      ? (profile.region as AdsRegion) : 'EU'
    const meta = await prisma.amazonAdsProfile.findUnique({
      where: { profileId: profile.profileId },
      select: { currencyCode: true },
    })
    const currencyCode = meta?.currencyCode ?? 'EUR'

    try {
      const out = await createReportJob({
        profileId: profile.profileId,
        region,
        marketplace: profile.marketplace,
        currencyCode,
        adProduct: 'SPONSORED_PRODUCTS',
        reportTypeId: PLACEMENT_REPORT_TYPE_ID,
        apiReportTypeId: PLACEMENT_API_REPORT_TYPE_ID,
        startDate: args.startDate,
        endDate: args.endDate,
        groupBy: ['campaignPlacement'],
        columns: PLACEMENT_COLUMNS,
        timeUnit: 'DAILY',
      })
      if (out.alreadyExisted) result.jobsSkipped += 1
      else result.jobsCreated += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`${profile.profileId} placement: ${msg.slice(0, 800)}`)
    }
  }
  return result
}

// ── Phase 6: 90-day rolling cleanup ──────────────────────────────────
// Amazon's own retention for search-term data is ~60 days. We keep 90
// days to give analytics enough trailing window for trends.

export async function cleanupOldSearchTerms(
  daysToKeep = 90,
): Promise<{ deletedSearchTerms: number; cutoffDate: string }> {
  const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000)
  cutoff.setUTCHours(0, 0, 0, 0)
  const result = await prisma.amazonAdsSearchTerm.deleteMany({
    where: { date: { lt: cutoff } },
  })
  return {
    deletedSearchTerms: result.count,
    cutoffDate: cutoff.toISOString().slice(0, 10),
  }
}

// ── Phase 6: negative keyword candidates ─────────────────────────────
// Queries that have spent $X+ in the last 30 days with zero attributed
// orders are prime candidates for negative-keyword addition. Returns
// the top N candidates sorted by wasted spend.

export interface NegativeKeywordCandidate {
  query: string
  matchType: string | null
  campaignId: string
  adGroupId: string
  marketplace: string
  adProduct: string
  // Aggregated over the lookback window
  totalImpressions: number
  totalClicks: number
  totalCostMicros: bigint
  totalCostUnits: number  // for display (cost in currency units)
  currencyCode: string
}

export async function findNegativeKeywordCandidates(args: {
  /** Lookback window in days (default 30) */
  lookbackDays?: number
  /** Minimum spend in currency units to qualify (default 5) */
  minSpend?: number
  /** Max rows returned (default 100) */
  limit?: number
  /** Optional profile filter */
  profileId?: string
  /** Optional marketplace filter */
  marketplace?: string
  /** Optional campaign filter (external Amazon campaign id) */
  externalCampaignId?: string
} = {}): Promise<NegativeKeywordCandidate[]> {
  const lookbackDays = args.lookbackDays ?? 30
  const minSpend = args.minSpend ?? 5
  const limit = args.limit ?? 100
  const minMicros = BigInt(Math.round(minSpend * 1_000_000))

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
  since.setUTCHours(0, 0, 0, 0)

  // Aggregate per (query, campaignId, adGroupId, matchType). Rows with
  // any orders/sales are filtered out — these are non-converting queries.
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'matchType', 'campaignId', 'adGroupId', 'marketplace', 'adProduct', 'currencyCode'],
    where: {
      date: { gte: since },
      ...(args.profileId ? { profileId: args.profileId } : {}),
      ...(args.marketplace ? { marketplace: args.marketplace } : {}),
      ...(args.externalCampaignId ? { campaignId: args.externalCampaignId } : {}),
    },
    _sum: {
      impressions: true,
      clicks: true,
      costMicros: true,
      orders7d: true,
      sales7dCents: true,
    },
    having: {
      costMicros: { _sum: { gte: minMicros } },
      orders7d: { _sum: { equals: 0 } },
    },
    orderBy: { _sum: { costMicros: 'desc' } },
    take: limit,
  })

  return rows.map((r) => {
    const costMicros = r._sum.costMicros ?? 0n
    return {
      query: r.query,
      matchType: r.matchType,
      campaignId: r.campaignId,
      adGroupId: r.adGroupId,
      marketplace: r.marketplace,
      adProduct: r.adProduct,
      totalImpressions: r._sum.impressions ?? 0,
      totalClicks: r._sum.clicks ?? 0,
      totalCostMicros: costMicros,
      totalCostUnits: Number(costMicros) / 1_000_000,
      currencyCode: r.currencyCode,
    }
  })
}
