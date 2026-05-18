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
  reportTypeId: string  // spCampaigns | sdCampaigns | sbCampaigns | ...
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
    'date', 'campaignId', 'campaignName',
    'impressions', 'clicks', 'cost',
    'sales', 'purchases', 'viewableImpressions',
  ],
  SPONSORED_BRANDS: [
    'date', 'campaignId', 'campaignName',
    'impressions', 'clicks', 'cost',
    'attributedSales14d', 'attributedDetailPageViewsClicks14d',
  ],
}

export const CAMPAIGN_REPORT_TYPE_ID: Record<AdProduct, string> = {
  SPONSORED_PRODUCTS: 'spCampaigns',
  SPONSORED_DISPLAY: 'sdCampaigns',
  SPONSORED_BRANDS: 'sbCampaigns',
}

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

  const body = {
    name: `${spec.adProduct.toLowerCase()}-${spec.reportTypeId}-${spec.startDate}-${spec.endDate}-${Date.now()}`,
    startDate: spec.startDate,
    endDate: spec.endDate,
    configuration: {
      adProduct: spec.adProduct,
      groupBy: spec.groupBy,
      columns: spec.columns,
      reportTypeId: spec.reportTypeId,
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

      const status = await liveCall<{
        status: string
        location?: string
        fileSize?: number
        failureReason?: string
      }>({
        profileId: job.profileId,
        region,
        method: 'GET',
        path: `/reporting/reports/${job.externalReportId}`,
      })

      const upper = status.status?.toUpperCase() ?? 'PENDING'

      if (upper === 'COMPLETED' && status.location) {
        await prisma.amazonAdsReportJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            location: status.location,
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
        // PENDING | IN_PROGRESS | PROCESSING
        await prisma.amazonAdsReportJob.update({
          where: { id: job.id },
          data: {
            status: upper === 'PROCESSING' ? 'IN_PROGRESS' : upper,
            lastPolledAt: new Date(),
            attempts: job.attempts + 1,
          },
        })
        summary.stillPending += 1
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`job ${job.id}: ${msg.slice(0, 200)}`)
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

  logger.info('[ads-reports] ingesting', { jobId, rowsToProcess: rows.length, adProduct: job.adProduct })

  let upserted = 0
  for (const r of rows) {
    if (!r.date || r.campaignId == null) continue
    const entityId = typeof r.campaignId === 'string' ? r.campaignId : String(r.campaignId)
    const date = new Date(r.date)
    if (Number.isNaN(date.getTime())) continue

    // Resolve local Campaign.id if we have it (best-effort join).
    const local = await prisma.campaign.findFirst({
      where: { externalCampaignId: entityId, marketplace },
      select: { id: true },
    })

    // Per-adProduct attribution mapping. SP uses sales7d; SD uses bare
    // `sales` which we store in sales7dCents for cross-product comparability;
    // SB uses attributedSales14d → sales14dCents.
    const sales7dCents =
      job.adProduct === 'SPONSORED_PRODUCTS' ? toCents(r.sales7d)
      : job.adProduct === 'SPONSORED_DISPLAY' ? toCents(r.sales)
      : 0
    const sales14dCents =
      job.adProduct === 'SPONSORED_BRANDS' ? toCents(r.attributedSales14d) : 0
    const orders7d =
      job.adProduct === 'SPONSORED_PRODUCTS' ? (r.purchases7d ?? 0)
      : job.adProduct === 'SPONSORED_DISPLAY' ? (r.purchases ?? 0)
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
          profileId: job.profileId,
          marketplace,
          adProduct: job.adProduct,
          date,
          entityType: 'CAMPAIGN',
          entityId,
          localEntityId: local?.id ?? null,
          impressions: r.impressions ?? 0,
          clicks: r.clicks ?? 0,
          costMicros: toMicros(r.cost),
          currencyCode,
          sales7dCents,
          sales14dCents,
          orders7d,
          units7d,
          viewableImpressions,
          reportRunId: jobId,
          reportedAt: new Date(),
        },
        update: {
          marketplace,
          localEntityId: local?.id ?? null,
          impressions: r.impressions ?? 0,
          clicks: r.clicks ?? 0,
          costMicros: toMicros(r.cost),
          currencyCode,
          sales7dCents,
          sales14dCents,
          orders7d,
          units7d,
          viewableImpressions,
          reportRunId: jobId,
          reportedAt: new Date(),
        },
      })
      upserted += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('[ads-reports] row upsert failed', { jobId, entityId, error: msg.slice(0, 200) })
    }
  }

  await prisma.amazonAdsReportJob.update({
    where: { id: jobId },
    data: { rowsIngested: upserted },
  })

  return { jobId, rowsIngested: upserted }
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
        result.errors.push(`${profile.profileId} ${adProduct}: ${msg.slice(0, 200)}`)
      }
    }
  }

  return result
}
