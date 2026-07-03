/**
 * E2 (eBay Ads) — typed Sell Marketing API client: entity reads + the async
 * report-task calls. READ SIDE ONLY plus report-task creation (report tasks
 * change nothing on the live account — they are how reads work). Campaign/
 * ad/keyword WRITES are E4 and do not exist here.
 *
 * Every call is budgeted through the ads-core QuotaLedger against the
 * verified quotas: report methods 200/hr/seller (we reserve under 180),
 * Marketing "Ads" API 10k/day/app. Reads fail OPEN on Redis outage
 * (degraded, logged); report-task creation fails CLOSED.
 *
 * 429 handling reuses channel-batch/rate-limit.ts (Retry-After ladder).
 */

import { logger } from '../../utils/logger.js'
import { EbayAuthService } from '../ebay-auth.service.js'
import prisma from '../../db.js'
import { QuotaLedger, MemoryQuotaStore, RedisQuotaStore, type QuotaStore } from '../ads-core/quota-ledger.js'
import { defaultRateLimitBackoffMs } from '../channel-batch/rate-limit.js'

const API_BASE = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'

// ── Quota ledgers (lazy Redis; memory fallback keeps dev/tests working) ────
let _ledgers: { reads: QuotaLedger; reports: QuotaLedger } | null = null
async function ledgers(): Promise<{ reads: QuotaLedger; reports: QuotaLedger }> {
  if (_ledgers) return _ledgers
  let store: QuotaStore
  try {
    const { redis } = await import('../../lib/queue.js')
    store = new RedisQuotaStore(() => redis.connection)
  } catch {
    store = new MemoryQuotaStore()
  }
  _ledgers = {
    reads: new QuotaLedger(store, { failMode: 'open' }),
    reports: new QuotaLedger(store, { failMode: 'closed' }),
  }
  return _ledgers
}

const READS_BUDGET = { key: 'ebay:mkt:ads-daily', limit: Number(process.env.NEXUS_EBAY_ADS_DAILY_CALL_BUDGET ?? 9000), windowSec: 86_400 }
const REPORTS_BUDGET = { key: 'ebay:mkt:reports-hourly', limit: Number(process.env.NEXUS_EBAY_REPORTS_HOURLY_BUDGET ?? 180), windowSec: 3600 }

export class EbayAdsQuotaError extends Error {
  constructor(public readonly retryAfterSec: number, degraded = false) {
    super(
      degraded
        ? 'eBay ads quota store unavailable (fail-closed for report calls) — check Redis or set NEXUS_EBAY_ADS_QUOTA_MODE=off for a supervised manual run'
        : `eBay ads quota budget exhausted — retry in ${retryAfterSec}s`,
    )
  }
}

/** Ops escape hatch for supervised manual backfills (documented in E2 doc). */
const quotaBypassed = () => process.env.NEXUS_EBAY_ADS_QUOTA_MODE === 'off'

// ── Token per active connection ─────────────────────────────────────────────
export async function getActiveEbayAdsAuth(): Promise<{ connectionId: string; token: string } | null> {
  const conn = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true, managedBy: 'oauth' },
    select: { id: true },
  })
  if (!conn) return null
  const token = await new EbayAuthService().getValidToken(conn.id)
  return { connectionId: conn.id, token }
}

// ── HTTP core ────────────────────────────────────────────────────────────────
async function marketingFetch(
  path: string,
  token: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; kind?: 'read' | 'report' } = {},
): Promise<Response> {
  const kind = opts.kind ?? 'read'
  if (!quotaBypassed()) {
    const l = await ledgers()
    const res = kind === 'report' ? await l.reports.reserve(REPORTS_BUDGET) : await l.reads.reserve(READS_BUDGET)
    if (!res.ok) throw new EbayAdsQuotaError(res.retryAfterSec, res.degraded)
    if (res.degraded) logger.warn('[E2][ebay-ads] quota ledger degraded (store unavailable)')
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    if (r.status !== 429 && r.status < 500) return r
    if (attempt === 3) return r
    const ra = r.headers.get('retry-after')
    const waitMs = ra && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : defaultRateLimitBackoffMs(attempt)
    logger.warn(`[E2][ebay-ads] HTTP ${r.status} on ${path} — backoff ${waitMs}ms (attempt ${attempt + 1})`)
    await new Promise((res2) => setTimeout(res2, waitMs))
  }
  throw new Error('unreachable')
}

async function pagedGet<T>(pathBase: string, token: string, itemsKey: string, limit = 200, hardCap = 50): Promise<T[]> {
  const out: T[] = []
  let offset = 0
  for (let page = 0; page < hardCap; page++) {
    const sep = pathBase.includes('?') ? '&' : '?'
    const r = await marketingFetch(`${pathBase}${sep}limit=${limit}&offset=${offset}`, token)
    if (!r.ok) throw new Error(`GET ${pathBase} → HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
    const body = (await r.json()) as Record<string, unknown>
    const items = (body[itemsKey] as T[] | undefined) ?? []
    out.push(...items)
    if (items.length < limit) break
    offset += limit
  }
  return out
}

// ── Entity DTOs (defensive — only fields we read) ───────────────────────────
export interface EbayCampaignDTO {
  campaignId: string
  campaignName?: string
  campaignStatus?: string
  campaignTargetingType?: string
  channels?: string[]
  marketplaceId?: string
  startDate?: string
  endDate?: string
  fundingStrategy?: {
    fundingModel?: string
    bidPercentage?: string
    adRateStrategy?: string
    dynamicAdRatePreferences?: Record<string, unknown>
    biddingStrategy?: string
    bidPreferences?: unknown[]
  }
  budget?: { daily?: { amount?: { value?: string; currency?: string } } }
  campaignCriterion?: { autoSelectFutureInventory?: boolean; criterionType?: string; selectionRules?: unknown[] }
}
export interface EbayAdDTO {
  adId?: string
  listingId?: string
  inventoryReference?: { inventoryReferenceId?: string; inventoryReferenceType?: string }
  inventoryReferenceId?: string
  inventoryReferenceType?: string
  bidPercentage?: string
  adStatus?: string
  adGroupId?: string
}
export interface EbayAdGroupDTO { adGroupId: string; name?: string; adGroupStatus?: string; defaultBid?: { value?: string; currency?: string } }
export interface EbayKeywordDTO { keywordId: string; adGroupId?: string; keywordText?: string; matchType?: string; bid?: { value?: string }; keywordStatus?: string }
export interface EbayNegativeKeywordDTO { negativeKeywordId: string; adGroupId?: string; campaignId?: string; negativeKeywordText?: string; negativeKeywordMatchType?: string; negativeKeywordStatus?: string }

// ── Entity reads ─────────────────────────────────────────────────────────────
export const fetchCampaigns = (token: string) =>
  pagedGet<EbayCampaignDTO>('/sell/marketing/v1/ad_campaign', token, 'campaigns', 100)

export const fetchAds = (token: string, campaignId: string) =>
  pagedGet<EbayAdDTO>(`/sell/marketing/v1/ad_campaign/${campaignId}/ad`, token, 'ads', 500)

export const fetchAdGroups = (token: string, campaignId: string) =>
  pagedGet<EbayAdGroupDTO>(`/sell/marketing/v1/ad_campaign/${campaignId}/ad_group`, token, 'adGroups', 200)

export const fetchKeywords = (token: string, campaignId: string) =>
  pagedGet<EbayKeywordDTO>(`/sell/marketing/v1/ad_campaign/${campaignId}/keyword`, token, 'keywords', 200)

// eBay requires the ad-group scope on this endpoint (error 36329 without it).
export const fetchNegativeKeywords = (token: string, campaignId: string, adGroupId: string) =>
  pagedGet<EbayNegativeKeywordDTO>(`/sell/marketing/v1/negative_keyword?campaign_ids=${campaignId}&ad_group_ids=${adGroupId}`, token, 'negativeKeywords', 200)

// ── Report tasks ─────────────────────────────────────────────────────────────
export interface CreateReportTaskSpec {
  reportType: string
  fundingModel: string
  dateFrom: string // YYYY-MM-DD
  dateTo: string
  marketplaceIds: string[]
  campaignIds: string[]
  dimensions: { dimensionKey: string; annotationKeys?: string[] }[]
  metricKeys: string[]
}

/** POST /ad_report_task → returns the eBay task id (Location header). */
export async function createReportTask(token: string, spec: CreateReportTaskSpec): Promise<string> {
  const body = {
    reportType: spec.reportType,
    reportFormat: 'TSV_GZIP', // required (error 35118); only supported value
    fundingModels: [spec.fundingModel],
    dateFrom: `${spec.dateFrom}T00:00:00.000Z`,
    dateTo: `${spec.dateTo}T23:59:59.999Z`,
    marketplaceId: spec.marketplaceIds[0],
    campaignIds: spec.campaignIds,
    dimensions: spec.dimensions,
    metricKeys: spec.metricKeys,
  }
  const r = await marketingFetch('/sell/marketing/v1/ad_report_task', token, { method: 'POST', body, kind: 'report' })
  if (r.status !== 201 && r.status !== 202) {
    throw new Error(`createReportTask → HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`)
  }
  const loc = r.headers.get('location') ?? ''
  const id = loc.split('/').filter(Boolean).pop()
  if (!id) throw new Error(`createReportTask: no task id in Location header (${loc})`)
  return id
}

export interface EbayReportTaskDTO { reportTaskId: string; reportTaskStatus?: string; reportHref?: string; reportTaskStatusMessage?: string }

export async function getReportTask(token: string, taskId: string): Promise<EbayReportTaskDTO> {
  const r = await marketingFetch(`/sell/marketing/v1/ad_report_task/${taskId}`, token, { kind: 'report' })
  if (!r.ok) throw new Error(`getReportTask ${taskId} → HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return (await r.json()) as EbayReportTaskDTO
}

/** Download the finished report (.tsv.gz) — returns the raw bytes. */
export async function downloadReport(token: string, reportHref: string): Promise<Buffer> {
  // eBay hands the href back as http:// — Node fetch drops Authorization on
  // the 301 to https ("Missing access token"). Normalize the scheme first.
  const url = (reportHref.startsWith('http') ? reportHref : `${API_BASE}${reportHref}`).replace(/^http:\/\//, 'https://')
  if (!quotaBypassed()) {
    const l = await ledgers()
    const res = await l.reports.reserve(REPORTS_BUDGET)
    if (!res.ok) throw new EbayAdsQuotaError(res.retryAfterSec, res.degraded)
  }
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`downloadReport → HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

/** GET /ad_report_metadata/{reportType} — valid dimensions/metrics. Cached 6h. */
const _metaCache = new Map<string, { at: number; meta: Record<string, unknown> }>()
export async function getReportMetadata(token: string, reportType: string): Promise<Record<string, unknown>> {
  const hit = _metaCache.get(reportType)
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.meta
  const r = await marketingFetch(`/sell/marketing/v1/ad_report_metadata/${reportType}`, token, { kind: 'report' })
  if (!r.ok) throw new Error(`getReportMetadata ${reportType} → HTTP ${r.status}`)
  const meta = (await r.json()) as Record<string, unknown>
  _metaCache.set(reportType, { at: Date.now(), meta })
  return meta
}
