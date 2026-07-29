/**
 * Phase 1 — Amazon Ads Brand Metrics ingest.
 *
 * Brand Metrics is the only Amazon surface that scores our BRAND's funnel
 * against the CATEGORY, and ships a category median + top-performer benchmark
 * alongside nearly every metric. SQP (Brand Analytics, SP-API) answers "how do
 * we do on a QUERY"; this answers "how does the BRAND compare to its category".
 * No overlap.
 *
 * Async three-stage flow:
 *   1. createBrandMetricsJob()  — POST /insights/brandMetrics/report → reportId
 *   2. pollBrandMetricsJobs()   — GET  /insights/brandMetrics/report/{id}
 *   3. ingestBrandMetricsJob()  — download → parse → upsert
 *
 * Job rows live in AmazonAdsReportJob under adProduct='BRAND_METRICS'; no
 * migration needed. The v3 poller in ads-reports.service.ts is explicitly
 * scoped to SP/SD/SB so it will not claim these rows.
 *
 * ── Contract, captured live from the IT profile on 2026-07-29 ──────────
 *
 * Response body:
 *   { "brandBuildingMetrics": [ { "metadata": {...}, "metrics": {...} } ] }
 *
 * Three facts that drive the code below, all verified against real responses
 * rather than documentation:
 *
 *  1. EVERY metric value is a STRING — "12", "0.6668", "417.28". Never a
 *     number. Same trap as the ads console (see reference_ads_console_cbn).
 *
 *  2. `aggregationLevel` on the request is IGNORED. DAILY, WEEKLY and MONTHLY
 *     returned byte-identical 43,873-byte payloads with lookbackPeriod="1w".
 *     The grain is ALWAYS weekly, so we do not expose an aggregation knob that
 *     does nothing — we request WEEKLY and label the data honestly.
 *
 *  3. The signed S3 URL expires in 300 SECONDS, not the hour the v3 Reports
 *     API gives. Poll and download MUST happen in the same pass; a stored URL
 *     ingested by a later cron tick is already dead. This is the same failure
 *     that produced 670 `s3_download_400` rows on AmazonAdsExportJob, so
 *     runBrandMetricsIngestCycle() deliberately polls-then-ingests inline and
 *     ingestBrandMetricsJob() re-polls for a fresh URL if the stored one is
 *     stale rather than failing the job.
 */

import { gunzipSync } from 'node:zlib'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { liveCall, type AdsRegion } from './ads-api-client.js'

// ── Constants ────────────────────────────────────────────────────────

export const BRAND_METRICS_MIME = 'application/vnd.brandmetricsreport.v1+json'
export const BM_AD_PRODUCT = 'BRAND_METRICS'
export const BM_REPORT_TYPE_ID = 'brandMetrics'

/** Amazon's signed download URL lifetime. Anything older is refetched. */
export const BM_URL_TTL_MS = 300_000

// ── Value coercion ───────────────────────────────────────────────────

/**
 * Absent must stay absent. Number(null), Number(''), Number([]) and Number({})
 * are all 0 or NaN-adjacent, so coercing without this guard turns a MISSING
 * metric into a real 0 — and 0 is meaningful for every metric here ("no
 * branded searches" vs "Amazon didn't report branded searches").
 */
function isAbsent(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === 'string' && v.trim() === '') ||
    typeof v === 'boolean' ||
    typeof v === 'object'
  )
}

/** Amazon sends every metric as a string. Returns null when truly absent. */
export function toNum(v: unknown): number | null {
  if (isAbsent(v)) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function toInt(v: unknown): number | null {
  const n = toNum(v)
  return n === null ? null : Math.round(n)
}

/** Parse YYYY-MM-DD (or ISO) into UTC midnight. */
export function parseDay(v: unknown, fallback: Date): Date {
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim())
    if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()))
  }
  return fallback
}

// ── Parsing ──────────────────────────────────────────────────────────

export interface BrandBuildingRow {
  brandName: string
  computationDate: Date
  lookbackPeriod: string
  categoryNodeName: string
  categoryNodeTreeName: string | null
  metrics: Record<string, string>
  /** Part of the uniqueness key — Amazon reports one row per category NODE
   *  per week (6 depths on the IT profile), never a single row per week. */
  awarenessIndex: number | null
  considerationIndex: number | null
  salesIndex: number | null
  brandCustomers: number | null
  highValueCustomers: number | null
  addToCarts: number | null
  viewedDetailPageOnly: number | null
  brandedSearchesOnly: number | null
  brandedSearchesAndDetailPageViews: number | null
  newToBrandCustomerRate: number | null
  customerConversionRate: number | null
}

/**
 * Diagnostic capture of the most recent report's real shape, surfaced via
 * GET /advertising/brand-metrics/debug. Mirrors sqpDebugState — it is how a
 * contract drift gets spotted without Railway log access.
 */
export const brandMetricsDebugState: {
  last: { at: string; topKeys: string[]; metricKeys: string[]; rowCountParsed: number; sample: string } | null
} = { last: null }

/**
 * Pure + unit-tested. Accepts the live `{ brandBuildingMetrics: [...] }`
 * envelope and the bare-array / `{rows}` shapes as defensive fallbacks.
 *
 * Rows without a usable brand name are DROPPED rather than stored under a
 * placeholder: brandName is part of the uniqueness key, so a mis-keyed row
 * would silently overwrite a real brand's week.
 */
export function parseBrandBuildingRows(raw: unknown, fallbackDate: Date): BrandBuildingRow[] {
  const container = raw as Record<string, unknown> | null
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : (container?.brandBuildingMetrics as unknown[]) ??
      (container?.rows as unknown[]) ??
      (container?.data as unknown[]) ??
      []

  const out: BrandBuildingRow[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>

    // Live shape nests metadata/metrics. Tolerate a flattened record too.
    const meta = (rec.metadata && typeof rec.metadata === 'object' ? rec.metadata : rec) as Record<string, unknown>
    const metricsRaw = (rec.metrics && typeof rec.metrics === 'object' ? rec.metrics : rec) as Record<string, unknown>

    const brandName = typeof meta.brandName === 'string' ? meta.brandName.trim() : ''
    if (!brandName) continue

    // Preserve the raw map verbatim (values stay strings) so a metric Amazon
    // adds later is captured without a migration.
    const metrics: Record<string, string> = {}
    for (const [k, v] of Object.entries(metricsRaw)) {
      if (v === null || v === undefined) continue
      if (typeof v === 'object') continue
      metrics[k] = String(v)
    }

    out.push({
      brandName,
      computationDate: parseDay(meta.metricsComputationDate, fallbackDate),
      lookbackPeriod: typeof meta.lookbackPeriod === 'string' ? meta.lookbackPeriod : '1w',
      // '' sentinel, never null — it is part of the uniqueness key and
      // Postgres treats NULLs as distinct inside a unique index.
      categoryNodeName: typeof meta.categoryNodeName === 'string' ? meta.categoryNodeName : '',
      categoryNodeTreeName: typeof meta.categoryNodeTreeName === 'string' ? meta.categoryNodeTreeName : null,
      metrics,
      awarenessIndex: toNum(metricsRaw.awarenessIndex),
      considerationIndex: toNum(metricsRaw.considerationIndex),
      salesIndex: toNum(metricsRaw.salesIndex),
      brandCustomers: toInt(metricsRaw.brandCustomers),
      highValueCustomers: toInt(metricsRaw.highValueCustomers),
      addToCarts: toInt(metricsRaw.addToCarts),
      viewedDetailPageOnly: toInt(metricsRaw.viewedDetailPageOnly),
      brandedSearchesOnly: toInt(metricsRaw.brandedSearchesOnly),
      brandedSearchesAndDetailPageViews: toInt(metricsRaw.brandedSearchesAndDetailPageViews),
      newToBrandCustomerRate: toNum(metricsRaw.newToBrandCustomerRate),
      customerConversionRate: toNum(metricsRaw.customerConversionRate),
    })
  }
  return out
}

/** Reports arrive plain or gzipped, JSON or NDJSON. Normalise all four. */
export function decodeReportPayload(buf: Buffer): unknown {
  const body = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf
  const text = body.toString('utf8').trim()
  if (!text) return []
  try {
    return JSON.parse(text)
  } catch {
    const rows: unknown[] = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { rows.push(JSON.parse(t)) } catch { /* skip malformed line */ }
    }
    return rows
  }
}

// ── Stage 1: create ──────────────────────────────────────────────────

export interface BrandMetricsSpec {
  profileId: string
  region: AdsRegion
  startDate: string // YYYY-MM-DD
  endDate: string   // YYYY-MM-DD
}

export interface CreateBrandMetricsResult {
  jobId: string
  externalReportId: string
  status: string
  alreadyExisted?: boolean
}

export async function createBrandMetricsJob(spec: BrandMetricsSpec): Promise<CreateBrandMetricsResult> {
  const existing = await prisma.amazonAdsReportJob.findFirst({
    where: {
      profileId: spec.profileId,
      adProduct: BM_AD_PRODUCT,
      reportTypeId: BM_REPORT_TYPE_ID,
      startDate: new Date(spec.startDate),
      endDate: new Date(spec.endDate),
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    },
    select: { id: true, externalReportId: true, status: true },
  })
  if (existing) {
    return { jobId: existing.id, externalReportId: existing.externalReportId, status: existing.status, alreadyExisted: true }
  }

  // aggregationLevel is sent for forward-compatibility but Amazon ignores it
  // today — see the header note. The grain is always weekly.
  const body = {
    reportStartDate: spec.startDate,
    reportEndDate: spec.endDate,
    aggregationLevel: 'WEEKLY',
  }

  const response = await liveCall<{ reportId?: string; status?: string }>({
    profileId: spec.profileId,
    region: spec.region,
    method: 'POST',
    path: '/insights/brandMetrics/report',
    body,
    contentType: BRAND_METRICS_MIME,
    acceptHeader: BRAND_METRICS_MIME,
  })

  if (!response.reportId) {
    throw new Error(`[brand-metrics] create returned no reportId: ${JSON.stringify(response).slice(0, 200)}`)
  }

  const job = await prisma.amazonAdsReportJob.create({
    data: {
      profileId: spec.profileId,
      adProduct: BM_AD_PRODUCT,
      reportTypeId: BM_REPORT_TYPE_ID,
      externalReportId: response.reportId,
      startDate: new Date(spec.startDate),
      endDate: new Date(spec.endDate),
      configuration: body as unknown as object,
      status: (response.status ?? 'PENDING').toUpperCase(),
    },
    select: { id: true },
  })

  logger.info('[brand-metrics] job created', { jobId: job.id, externalReportId: response.reportId, profileId: spec.profileId })
  return { jobId: job.id, externalReportId: response.reportId, status: (response.status ?? 'PENDING').toUpperCase() }
}

// ── Stage 2: poll ────────────────────────────────────────────────────

const OK_STATES = new Set(['SUCCESSFUL', 'COMPLETED', 'SUCCESS', 'DONE'])
const FAIL_STATES = new Set(['FAILED', 'FAILURE', 'CANCELLED', 'FATAL', 'EXPIRED'])

interface BrandMetricsStatus {
  status?: string
  location?: string
  statusDetails?: string
  brandsInfo?: Array<{ id?: string; name?: string }>
}

/** One status read. Exported so ingest can refresh an expired URL. */
export async function fetchBrandMetricsStatus(
  profileId: string,
  region: AdsRegion,
  externalReportId: string,
): Promise<BrandMetricsStatus> {
  return liveCall<BrandMetricsStatus>({
    profileId,
    region,
    method: 'GET',
    path: `/insights/brandMetrics/report/${externalReportId}`,
    acceptHeader: BRAND_METRICS_MIME,
  })
}

async function regionFor(profileId: string): Promise<AdsRegion> {
  const conn = await prisma.amazonAdsConnection.findUnique({ where: { profileId }, select: { region: true } })
  return conn?.region === 'NA' || conn?.region === 'FE' ? (conn.region as AdsRegion) : 'EU'
}

export interface BrandMetricsPollSummary {
  polled: number
  completed: number
  failed: number
  stillPending: number
  errors: string[]
}

export async function pollBrandMetricsJobs(limit = 20): Promise<BrandMetricsPollSummary> {
  const summary: BrandMetricsPollSummary = { polled: 0, completed: 0, failed: 0, stillPending: 0, errors: [] }

  const jobs = await prisma.amazonAdsReportJob.findMany({
    where: { adProduct: BM_AD_PRODUCT, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    orderBy: [{ lastPolledAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  })

  for (const job of jobs) {
    summary.polled += 1
    try {
      const status = await fetchBrandMetricsStatus(job.profileId, await regionFor(job.profileId), job.externalReportId)
      const upper = (status.status ?? '').toUpperCase()

      if (OK_STATES.has(upper) && status.location) {
        await prisma.amazonAdsReportJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            location: status.location,
            // urlExpiresAt is not on this model; completedAt doubles as the
            // freshness stamp the ingest uses to detect a dead 300s URL.
            completedAt: new Date(),
            lastPolledAt: new Date(),
            attempts: { increment: 1 },
          },
        })
        summary.completed += 1
      } else if (FAIL_STATES.has(upper)) {
        await prisma.amazonAdsReportJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            errorMessage: (status.statusDetails ?? upper).slice(0, 500),
            lastPolledAt: new Date(),
            attempts: { increment: 1 },
          },
        })
        summary.failed += 1
      } else {
        await prisma.amazonAdsReportJob.update({
          where: { id: job.id },
          data: { status: 'IN_PROGRESS', lastPolledAt: new Date(), attempts: { increment: 1 } },
        })
        summary.stillPending += 1
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`${job.id}: ${msg.slice(0, 300)}`)
      await prisma.amazonAdsReportJob
        .update({ where: { id: job.id }, data: { lastPolledAt: new Date(), attempts: { increment: 1 }, errorMessage: msg.slice(0, 500) } })
        .catch(() => {})
    }
  }

  return summary
}

// ── Stage 3: ingest ──────────────────────────────────────────────────

export interface BrandMetricsIngestResult {
  jobId: string
  rowsParsed: number
  rowsUpserted: number
  urlRefreshed: boolean
}

export async function ingestBrandMetricsJob(jobId: string): Promise<BrandMetricsIngestResult> {
  const job = await prisma.amazonAdsReportJob.findUnique({ where: { id: jobId } })
  if (!job) throw new Error(`[brand-metrics] no job ${jobId}`)
  if (job.adProduct !== BM_AD_PRODUCT) throw new Error(`[brand-metrics] job ${jobId} is not a brand-metrics job`)
  if (job.status !== 'COMPLETED') throw new Error(`[brand-metrics] job ${jobId} not ingestable (status=${job.status})`)

  const conn = await prisma.amazonAdsConnection.findUnique({
    where: { profileId: job.profileId },
    select: { marketplace: true, region: true },
  })
  const marketplace = conn?.marketplace ?? 'UNKNOWN'
  const region: AdsRegion = conn?.region === 'NA' || conn?.region === 'FE' ? (conn.region as AdsRegion) : 'EU'

  // The signed URL dies after 300s. If the stored one is at/near expiry,
  // re-poll for a fresh one instead of burning the job on a 400.
  let url = job.location
  let urlRefreshed = false
  const ageMs = job.completedAt ? Date.now() - job.completedAt.getTime() : Number.POSITIVE_INFINITY
  if (!url || ageMs > BM_URL_TTL_MS * 0.8) {
    const status = await fetchBrandMetricsStatus(job.profileId, region, job.externalReportId)
    if (!status.location) throw new Error(`[brand-metrics] job ${jobId}: no download URL after refresh (status=${status.status})`)
    url = status.location
    urlRefreshed = true
    await prisma.amazonAdsReportJob.update({ where: { id: jobId }, data: { location: url, completedAt: new Date() } })
  }

  const res = await fetch(url)
  if (!res.ok) {
    const msg = `download failed ${res.status}${urlRefreshed ? ' (after URL refresh)' : ' — URL likely expired'}`
    await prisma.amazonAdsReportJob.update({ where: { id: jobId }, data: { errorMessage: msg } })
    throw new Error(`[brand-metrics] ${msg}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const raw = decodeReportPayload(buf)
  const rows = parseBrandBuildingRows(raw, job.startDate)

  const firstMetrics = rows[0]?.metrics ?? {}
  brandMetricsDebugState.last = {
    at: new Date().toISOString(),
    topKeys: raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw as object).slice(0, 30) : ['(array)'],
    metricKeys: Object.keys(firstMetrics).slice(0, 60),
    rowCountParsed: rows.length,
    sample: JSON.stringify(raw).slice(0, 1500),
  }
  if (rows.length === 0) {
    logger.warn('[brand-metrics] report parsed to ZERO rows — contract may have drifted', {
      jobId, topKeys: brandMetricsDebugState.last.topKeys,
    })
  }

  let upserted = 0
  for (const r of rows) {
    const data = {
      marketplace,
      brandId: null as string | null,
      categoryNodeTreeName: r.categoryNodeTreeName,
      metrics: r.metrics as unknown as object,
      awarenessIndex: r.awarenessIndex,
      considerationIndex: r.considerationIndex,
      salesIndex: r.salesIndex,
      brandCustomers: r.brandCustomers,
      highValueCustomers: r.highValueCustomers,
      addToCarts: r.addToCarts,
      viewedDetailPageOnly: r.viewedDetailPageOnly,
      brandedSearchesOnly: r.brandedSearchesOnly,
      brandedSearchesAndDetailPageViews: r.brandedSearchesAndDetailPageViews,
      newToBrandCustomerRate: r.newToBrandCustomerRate,
      customerConversionRate: r.customerConversionRate,
      reportedAt: new Date(),
    }
    await prisma.amazonAdsBrandBuildingMetric.upsert({
      where: {
        profileId_brandName_computationDate_lookbackPeriod_categoryNodeName: {
          profileId: job.profileId,
          brandName: r.brandName,
          computationDate: r.computationDate,
          lookbackPeriod: r.lookbackPeriod,
          categoryNodeName: r.categoryNodeName,
        },
      },
      create: {
        profileId: job.profileId,
        brandName: r.brandName,
        computationDate: r.computationDate,
        lookbackPeriod: r.lookbackPeriod,
        categoryNodeName: r.categoryNodeName,
        ...data,
      },
      update: data,
    })
    upserted += 1
  }

  await prisma.amazonAdsReportJob.update({
    where: { id: jobId },
    data: { rowsIngested: upserted, fileSize: buf.byteLength },
  })

  logger.info('[brand-metrics] ingested', { jobId, rowsParsed: rows.length, rowsUpserted: upserted, urlRefreshed })
  return { jobId, rowsParsed: rows.length, rowsUpserted: upserted, urlRefreshed }
}

// ── Cycle drivers ────────────────────────────────────────────────────

export interface BrandMetricsCycleResult {
  jobsCreated: number
  jobsSkipped: number
  errors: string[]
}

/**
 * One job per PRODUCTION profile. Sandbox profiles are skipped — they carry no
 * brand data and would burn quota returning nothing.
 */
export async function runBrandMetricsCycle(args: {
  startDate: string
  endDate: string
}): Promise<BrandMetricsCycleResult> {
  const result: BrandMetricsCycleResult = { jobsCreated: 0, jobsSkipped: 0, errors: [] }

  const profiles = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true, mode: 'production' },
    select: { profileId: true, region: true },
  })

  for (const profile of profiles) {
    const region: AdsRegion = profile.region === 'NA' || profile.region === 'FE' ? (profile.region as AdsRegion) : 'EU'
    try {
      const out = await createBrandMetricsJob({
        profileId: profile.profileId,
        region,
        startDate: args.startDate,
        endDate: args.endDate,
      })
      if (out.alreadyExisted) result.jobsSkipped += 1
      else result.jobsCreated += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`${profile.profileId}: ${msg.slice(0, 500)}`)
    }
  }

  return result
}

/**
 * Poll then ingest IN THE SAME PASS. Deliberately not split across two crons:
 * the download URL is valid for 300s, so a separate ingest tick would always
 * arrive to a dead link (the 670 `s3_download_400` failures on
 * AmazonAdsExportJob are exactly that bug).
 */
export async function runBrandMetricsIngestCycle(): Promise<{
  poll: BrandMetricsPollSummary
  ingested: number
  errors: string[]
}> {
  const poll = await pollBrandMetricsJobs()
  const errors: string[] = [...poll.errors]
  let ingested = 0

  const ready = await prisma.amazonAdsReportJob.findMany({
    where: { adProduct: BM_AD_PRODUCT, status: 'COMPLETED', rowsIngested: 0, location: { not: null } },
    select: { id: true },
    orderBy: { completedAt: 'desc' },
    take: 20,
  })
  for (const job of ready) {
    try {
      const out = await ingestBrandMetricsJob(job.id)
      ingested += out.rowsUpserted
    } catch (err) {
      errors.push(`${job.id}: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`)
    }
  }

  return { poll, ingested, errors }
}

// ── Entitlement probe ────────────────────────────────────────────────

export interface BrandMetricsProbeResult {
  available: boolean
  profileId: string
  detail: string
}

export async function probeBrandMetricsAccess(profileId?: string): Promise<BrandMetricsProbeResult> {
  const conn = profileId
    ? await prisma.amazonAdsConnection.findUnique({ where: { profileId }, select: { profileId: true, region: true } })
    : await prisma.amazonAdsConnection.findFirst({
        where: { isActive: true, mode: 'production' },
        select: { profileId: true, region: true },
      })
  if (!conn) return { available: false, profileId: profileId ?? '(none)', detail: 'no active production ads connection' }

  const region: AdsRegion = conn.region === 'NA' || conn.region === 'FE' ? (conn.region as AdsRegion) : 'EU'
  const end = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10)
  const start = new Date(Date.now() - 16 * 86400000).toISOString().slice(0, 10)

  try {
    await createBrandMetricsJob({ profileId: conn.profileId, region, startDate: start, endDate: end })
    return { available: true, profileId: conn.profileId, detail: 'report request accepted' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const denied = /401|403|unauthorized|forbidden|not authorized|access.*denied/i.test(msg)
    return { available: !denied, profileId: conn.profileId, detail: msg.slice(0, 300) }
  }
}
