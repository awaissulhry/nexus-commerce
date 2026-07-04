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

// ═══════════════════════════════════════════════════════════════════════════
// E4 — WRITE endpoints. Callers MUST route through ebay-ads-write.service.ts
// (gate + guardrails + CampaignAction audit); these are thin typed wrappers.
// ═══════════════════════════════════════════════════════════════════════════

async function marketingPost(path: string, token: string, body?: unknown): Promise<Response> {
  return marketingFetch(path, token, { method: 'POST', body })
}

function idFromLocation(r: Response, what: string): string {
  const loc = r.headers.get('location') ?? ''
  const id = loc.split('/').filter(Boolean).pop()
  if (!id) throw new Error(`${what}: no id in Location header`)
  return id
}

async function expectOk(r: Response, what: string): Promise<Response> {
  if (r.status >= 200 && r.status < 300) return r
  throw new Error(`${what} → HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`)
}

export interface CreateCampaignPayload {
  campaignName: string
  marketplaceId: string
  fundingStrategy: {
    fundingModel: 'COST_PER_SALE' | 'COST_PER_CLICK'
    adRateStrategy?: 'FIXED' | 'DYNAMIC'
    bidPercentage?: string
    dynamicAdRatePreferences?: { adRateAdjustmentPercent?: string; adRateCapPercent?: string }[]
    biddingStrategy?: 'FIXED' | 'DYNAMIC'
    bidPreferences?: unknown[]
  }
  campaignTargetingType?: 'MANUAL' | 'SMART'
  channels?: string[]
  budget?: { daily: { amount: { currency: string; value: string } } }
  campaignCriterion?: { criterionType?: string; autoSelectFutureInventory?: boolean; selectionRules: unknown[] }
  startDate: string
  endDate?: string
}

export const createCampaignApi = async (token: string, payload: CreateCampaignPayload): Promise<string> =>
  idFromLocation(await expectOk(await marketingPost('/sell/marketing/v1/ad_campaign', token, payload), 'createCampaign'), 'createCampaign')

export const campaignLifecycleApi = async (token: string, campaignId: string, action: 'pause' | 'resume' | 'end'): Promise<void> => {
  await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/${action}`, token), `campaign ${action}`)
}

export const cloneCampaignApi = async (token: string, campaignId: string, body: { campaignName: string; startDate: string; endDate?: string }): Promise<string> =>
  idFromLocation(await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/clone`, token, body), 'cloneCampaign'), 'cloneCampaign')

export const updateAdRateStrategyApi = async (token: string, campaignId: string, body: { adRateStrategy: 'FIXED' | 'DYNAMIC'; bidPercentage?: string; dynamicAdRatePreferences?: unknown[] }): Promise<void> => {
  await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/update_ad_rate_strategy`, token, body), 'updateAdRateStrategy')
}

export const updateCampaignBudgetApi = async (token: string, campaignId: string, body: { budget: { daily: { amount: { currency: string; value: string } } } }): Promise<void> => {
  await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/update_campaign_budget`, token, body), 'updateCampaignBudget')
}

// ER1 — rename + schedule edits (eBay: updateCampaignIdentification changes
// name and start/end date on an existing campaign).
export const updateCampaignIdentificationApi = async (token: string, campaignId: string, body: { campaignName?: string; startDate?: string; endDate?: string | null }): Promise<void> => {
  await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/update_campaign_identification`, token, body), 'updateCampaignIdentification')
}

/** Bulk per-item results normalized to { key, ok, id?, error? }. */
export interface BulkItemResult { key: string; ok: boolean; id?: string | null; error?: string | null; statusCode?: number }

function parseBulkResponses(items: Array<Record<string, unknown>> | undefined, keyField: string, idField: string): BulkItemResult[] {
  return (items ?? []).map((it) => {
    const status = Number(it.statusCode ?? 200)
    const errors = it.errors as Array<{ errorId?: number; message?: string; longMessage?: string }> | undefined
    const href = typeof it.href === 'string' ? it.href : undefined
    return {
      key: String(it[keyField] ?? ''),
      ok: status >= 200 && status < 300,
      id: (it[idField] as string | undefined) ?? (href ? href.split('/').filter(Boolean).pop() ?? null : null),
      error: errors?.length
        ? errors.map((e) => e.message ?? e.longMessage ?? `error ${e.errorId ?? '?'}`).join('; ').slice(0, 400)
        : status >= 300 ? `HTTP ${status}` : null,
      statusCode: status,
    }
  })
}

// ER4 E4 — adGroupId per ad: required by eBay for MANUAL Priority (CPC)
// campaigns, absent for CPS and Smart Priority.
export const bulkCreateAdsByListingIdApi = async (token: string, campaignId: string, ads: Array<{ listingId: string; bidPercentage?: string; adGroupId?: string }>): Promise<BulkItemResult[]> => {
  const r = await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/bulk_create_ads_by_listing_id`, token, { requests: ads }), 'bulkCreateAds')
  const j = (await r.json().catch(() => ({}))) as { responses?: Array<Record<string, unknown>> }
  return parseBulkResponses(j.responses, 'listingId', 'adId')
}

export const bulkUpdateAdsBidApi = async (token: string, campaignId: string, updates: Array<{ listingId: string; bidPercentage: string }>): Promise<BulkItemResult[]> => {
  const r = await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/bulk_update_ads_bid_by_listing_id`, token, { requests: updates }), 'bulkUpdateAdsBid')
  const j = (await r.json().catch(() => ({}))) as { responses?: Array<Record<string, unknown>> }
  return parseBulkResponses(j.responses, 'listingId', 'adId')
}

export const bulkDeleteAdsApi = async (token: string, campaignId: string, listingIds: string[]): Promise<BulkItemResult[]> => {
  const r = await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/bulk_delete_ads_by_listing_id`, token, { requests: listingIds.map((listingId) => ({ listingId })) }), 'bulkDeleteAds')
  const j = (await r.json().catch(() => ({}))) as { responses?: Array<Record<string, unknown>> }
  return parseBulkResponses(j.responses, 'listingId', 'adId')
}

export const createAdGroupApi = async (token: string, campaignId: string, body: { name: string; defaultBid?: { currency: string; value: string } }): Promise<string> =>
  idFromLocation(await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/ad_group`, token, body), 'createAdGroup'), 'createAdGroup')

export const bulkCreateKeywordApi = async (token: string, campaignId: string, keywords: Array<{ adGroupId: string; keywordText: string; matchType: string; bid?: { currency: string; value: string } }>): Promise<BulkItemResult[]> => {
  const r = await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/bulk_create_keyword`, token, { requests: keywords }), 'bulkCreateKeyword')
  const j = (await r.json().catch(() => ({}))) as { responses?: Array<Record<string, unknown>> }
  return parseBulkResponses(j.responses, 'keywordText', 'keywordId')
}

export const bulkUpdateKeywordApi = async (token: string, campaignId: string, updates: Array<{ keywordId: string; bid?: { currency: string; value: string }; keywordStatus?: string }>): Promise<BulkItemResult[]> => {
  const r = await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/bulk_update_keyword`, token, { requests: updates }), 'bulkUpdateKeyword')
  const j = (await r.json().catch(() => ({}))) as { responses?: Array<Record<string, unknown>> }
  return parseBulkResponses(j.responses, 'keywordId', 'keywordId')
}

export const bulkCreateNegativeKeywordApi = async (token: string, negatives: Array<{ campaignId: string; adGroupId: string; negativeKeywordText: string; negativeKeywordMatchType: string }>): Promise<BulkItemResult[]> => {
  const r = await expectOk(await marketingPost('/sell/marketing/v1/bulk_create_negative_keyword', token, { requests: negatives }), 'bulkCreateNegativeKeyword')
  const j = (await r.json().catch(() => ({}))) as { responses?: Array<Record<string, unknown>> }
  return parseBulkResponses(j.responses, 'negativeKeywordText', 'negativeKeywordId')
}

// ER2 — campaign budget suggestion (verified to exist in the method index;
// response shape handled defensively at the caller: best-effort passthrough).
export const suggestBudgetApi = async (token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const r = await expectOk(await marketingPost('/sell/marketing/v1/ad_campaign/suggest_budget', token, body), 'suggestBudget')
  return (await r.json().catch(() => ({}))) as Record<string, unknown>
}

// Suggestion endpoints (read-side; require full sell.marketing — verified)
export const suggestMaxCpcApi = async (token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const r = await expectOk(await marketingPost('/sell/marketing/v1/ad_campaign/suggest_max_cpc', token, body), 'suggestMaxCpc')
  return (await r.json()) as Record<string, unknown>
}
export const suggestKeywordsApi = async (token: string, campaignId: string, adGroupId: string, listingIds: string[]): Promise<Record<string, unknown>> => {
  const r = await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/ad_group/${adGroupId}/suggest_keywords`, token, { listingIds }), 'suggestKeywords')
  return (await r.json()) as Record<string, unknown>
}
export const suggestBidsApi = async (token: string, campaignId: string, adGroupId: string, keywords: Array<{ keywordText: string; matchType: string }>): Promise<Record<string, unknown>> => {
  const r = await expectOk(await marketingPost(`/sell/marketing/v1/ad_campaign/${campaignId}/ad_group/${adGroupId}/suggest_bids`, token, { keywords }), 'suggestBids')
  return (await r.json()) as Record<string, unknown>
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
