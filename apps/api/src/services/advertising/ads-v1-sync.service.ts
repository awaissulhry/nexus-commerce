/**
 * H.2 — Amazon Ads API v1 unified sync service.
 *
 * Replaces the per-product list endpoints (Phase B's /sp/campaigns/list,
 * /sb/v4/campaigns/list, /sd/campaigns) with the v1 unified export flow:
 *   1. createExportJob() → POST /{resource}/export → externalExportId
 *   2. pollPendingExports() → GET /exports/{id} → status / url
 *   3. ingestCompletedExport() → fetch signed S3 URL → gunzip → JSON
 *      → upsert into Campaign / AdGroup / AdTarget / AdProductAd
 *
 * Phase H.1 confirmed:
 *   - All 4 resources accept multi-adProduct filter [SP, SB, SD]
 *   - Response format is GZIP_JSON (magic bytes 1f 8b)
 *   - Signed URL TTL is 1 hour from generation
 *   - GET /exports/{id} needs the SAME per-resource MIME as the create
 *
 * v1 record schemas captured in H.1 — see field-level mapping below.
 * Idempotent: re-running an export for the same (profileId, resource)
 * returns a new exportId; we keep all job rows for forensics.
 */

import { gunzipSync } from 'zlib'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { liveCall, type AdsRegion } from './ads-api-client.js'

// ── Resource configuration ────────────────────────────────────────────

export type V1Resource = 'campaigns' | 'adGroups' | 'targets' | 'ads'

export type V1AdProduct = 'SPONSORED_PRODUCTS' | 'SPONSORED_BRANDS' | 'SPONSORED_DISPLAY'

const ALL_RESOURCES: V1Resource[] = ['campaigns', 'adGroups', 'targets', 'ads']
const ALL_AD_PRODUCTS: V1AdProduct[] = ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY']

const RESOURCE_PATH: Record<V1Resource, string> = {
  campaigns: '/campaigns/export',
  adGroups:  '/adGroups/export',
  targets:   '/targets/export',
  ads:       '/ads/export',
}

const RESOURCE_MIME: Record<V1Resource, string> = {
  campaigns: 'application/vnd.campaignsexport.v1+json',
  adGroups:  'application/vnd.adgroupsexport.v1+json',
  targets:   'application/vnd.targetsexport.v1+json',
  ads:       'application/vnd.adsexport.v1+json',
}

// ── Type assertions for the v1 records (from H.1 captures) ────────────

interface V1Campaign {
  campaignId: string
  adProduct: V1AdProduct
  name: string
  state: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
  startDate: string // YYYY-MM-DD
  endDate?: string
  brandEntityId?: string
  optimization?: { bidStrategy?: string }
  budgetCaps?: { budgetValue?: { monetaryBudget?: { amount?: number; currencyCode?: string } } }
  costType?: string
  deliveryStatus?: string
  deliveryReasons?: string[]
}

interface V1AdGroup {
  adGroupId: string
  campaignId: string
  adProduct: V1AdProduct
  name: string
  state: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
  deliveryStatus?: string
  deliveryReasons?: string[]
}

interface V1Target {
  targetId: string
  campaignId: string
  adGroupId?: string
  adProduct: V1AdProduct
  state: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
  negative: boolean
  targetType: 'KEYWORD' | 'PRODUCT' | 'CATEGORY' | 'AUDIENCE'
  targetLevel: 'CAMPAIGN' | 'AD_GROUP'
  targetDetails?: { matchType?: string; keyword?: string; asin?: string; categoryId?: string }
  bid?: number
  deliveryStatus?: string
  deliveryReasons?: string[]
}

interface V1Ad {
  adId: string
  adGroupId: string
  campaignId: string
  adProduct: V1AdProduct
  state: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
  adType: string
  creative?: { products?: Array<{ productIdType: 'ASIN' | 'SKU'; productId: string }> }
  deliveryStatus?: string
  deliveryReasons?: string[]
}

// ── Normalization helpers (v1 → DTO conventions) ──────────────────────

function normalizeStateV1(s: string | undefined): string {
  return (s ?? 'ENABLED').toLowerCase()
}

function stripDateDashes(iso: string | undefined): string {
  return (iso ?? '').replace(/-/g, '')
}

// v1 returns SALES, ACOS_LIFT, etc. Map to our existing DTO enum where
// possible; otherwise leave for storage in bidStrategyJson.
const V1_BID_STRATEGY_MAP: Record<string, 'legacyForSales' | 'autoForSales' | 'manual'> = {
  SALES: 'autoForSales',
  ACOS_LIFT: 'autoForSales',
  LEGACY_FOR_SALES: 'legacyForSales',
  MANUAL: 'manual',
}

function mapBiddingStrategy(v1: string | undefined): 'legacyForSales' | 'autoForSales' | 'manual' {
  if (!v1) return 'legacyForSales'
  return V1_BID_STRATEGY_MAP[v1] ?? 'manual'
}

// Convert v1 adProduct discriminator → legacy two-letter type enum
const ADPRODUCT_TO_TYPE: Record<V1AdProduct, 'SP' | 'SB' | 'SD'> = {
  SPONSORED_PRODUCTS: 'SP',
  SPONSORED_BRANDS:   'SB',
  SPONSORED_DISPLAY:  'SD',
}

// Legacy STATE_TO_PRISMA mapping (shared with ads-sync.service.ts).
const STATE_TO_PRISMA: Record<string, 'ENABLED' | 'PAUSED' | 'ARCHIVED' | 'DRAFT'> = {
  enabled: 'ENABLED', paused: 'PAUSED', archived: 'ARCHIVED', draft: 'DRAFT',
}

// ── 1. Create export job ──────────────────────────────────────────────

export interface CreateExportArgs {
  profileId: string
  resource: V1Resource
  adProducts?: V1AdProduct[]
}

export interface CreateExportResult {
  jobId: string
  externalExportId: string
}

export async function createExportJob(args: CreateExportArgs): Promise<CreateExportResult> {
  const adProducts = args.adProducts ?? ALL_AD_PRODUCTS
  const conn = await prisma.amazonAdsConnection.findUnique({
    where: { profileId: args.profileId },
    select: { region: true },
  })
  const region: AdsRegion = (conn?.region === 'NA' || conn?.region === 'FE')
    ? (conn.region as AdsRegion) : 'EU'

  const mime = RESOURCE_MIME[args.resource]
  const path = RESOURCE_PATH[args.resource]
  const body = { adProductFilter: adProducts }

  const response = await liveCall<{ exportId: string }>({
    profileId: args.profileId,
    region,
    method: 'POST',
    path,
    body,
    contentType: mime,
    acceptHeader: mime,
  })

  const job = await prisma.amazonAdsExportJob.create({
    data: {
      profileId: args.profileId,
      resource: args.resource,
      adProducts,
      externalExportId: response.exportId,
      configuration: body as object,
      status: 'PENDING',
    },
  })
  return { jobId: job.id, externalExportId: response.exportId }
}

// ── 2. Poll pending exports ───────────────────────────────────────────

export interface PollSummary {
  polled: number
  completed: number
  failed: number
  stillPending: number
  errors: string[]
}

export async function pollPendingExports(limit = 20): Promise<PollSummary> {
  const summary: PollSummary = {
    polled: 0, completed: 0, failed: 0, stillPending: 0, errors: [],
  }
  const jobs = await prisma.amazonAdsExportJob.findMany({
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
        ? (conn.region as AdsRegion) : 'EU'

      const mime = RESOURCE_MIME[job.resource as V1Resource]
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
        path: `/exports/${job.externalExportId}`,
        acceptHeader: mime,
      })

      const upper = (status.status ?? 'PENDING').toUpperCase()
      if (upper === 'COMPLETED' && status.url) {
        await prisma.amazonAdsExportJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            url: status.url,
            urlExpiresAt: status.urlExpiresAt ? new Date(status.urlExpiresAt) : null,
            fileSize: status.fileSize ?? null,
            lastPolledAt: new Date(),
            completedAt: new Date(),
            attempts: job.attempts + 1,
          },
        })
        summary.completed += 1
      } else if (upper === 'FAILED' || upper === 'FAILURE') {
        await prisma.amazonAdsExportJob.update({
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
        // COMPLETED-without-url race → keep in IN_PROGRESS for re-poll
        const writeStatus = upper === 'COMPLETED' ? 'IN_PROGRESS' : upper
        await prisma.amazonAdsExportJob.update({
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
      logger.warn('[ads-v1-sync] poll failed', { jobId: job.id, error: msg })
      await prisma.amazonAdsExportJob.update({
        where: { id: job.id },
        data: { lastPolledAt: new Date(), attempts: job.attempts + 1 },
      }).catch(() => undefined)
    }
  }
  return summary
}

// ── 3. Ingest completed export ────────────────────────────────────────

export interface IngestResult {
  jobId: string
  resource: V1Resource
  rowsIngested: number
  error?: string
  breakdown?: Record<string, number> // AF.1 — targets ingest diagnostics
}

export async function ingestCompletedExport(jobId: string): Promise<IngestResult> {
  const job = await prisma.amazonAdsExportJob.findUnique({ where: { id: jobId } })
  if (!job) return { jobId, resource: 'campaigns', rowsIngested: 0, error: 'job_not_found' }
  if (job.status !== 'COMPLETED' || !job.url) {
    return { jobId, resource: job.resource as V1Resource, rowsIngested: 0, error: `not_ingestable: status=${job.status}` }
  }

  // Download + decompress + parse
  let records: unknown[]
  try {
    const res = await fetch(job.url)
    if (!res.ok) throw new Error(`s3_download_${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
    const decoded = isGzip ? gunzipSync(buf) : buf
    const text = decoded.toString('utf-8')
    const parsed = JSON.parse(text)
    records = Array.isArray(parsed) ? parsed : []
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.amazonAdsExportJob.update({
      where: { id: jobId },
      data: { errorMessage: `download/parse: ${msg.slice(0, 500)}` },
    }).catch(() => undefined)
    return { jobId, resource: job.resource as V1Resource, rowsIngested: 0, error: msg.slice(0, 200) }
  }

  // Dispatch per resource
  let rowsIngested = 0
  let breakdown: Record<string, number> | undefined
  const resource = job.resource as V1Resource
  try {
    if (resource === 'campaigns') {
      rowsIngested = await ingestCampaigns(job.profileId, records as V1Campaign[])
    } else if (resource === 'adGroups') {
      rowsIngested = await ingestAdGroups(job.profileId, records as V1AdGroup[])
    } else if (resource === 'targets') {
      const tr = await ingestTargets(records as V1Target[])
      rowsIngested = tr.upserted
      breakdown = tr.breakdown
    } else if (resource === 'ads') {
      rowsIngested = await ingestAds(records as V1Ad[])
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.amazonAdsExportJob.update({
      where: { id: jobId },
      data: { errorMessage: `ingest: ${msg.slice(0, 500)}` },
    }).catch(() => undefined)
    return { jobId, resource, rowsIngested, error: msg.slice(0, 200) }
  }

  await prisma.amazonAdsExportJob.update({
    where: { id: jobId },
    // Clear any stale errorMessage left by a prior failed retry — this
    // run succeeded, so the record is now clean.
    data: { rowsIngested, errorMessage: null },
  })
  return { jobId, resource, rowsIngested, breakdown }
}

// ── Resource-level ingest functions ───────────────────────────────────

async function ingestCampaigns(profileId: string, records: V1Campaign[]): Promise<number> {
  const conn = await prisma.amazonAdsConnection.findUnique({
    where: { profileId },
    select: { marketplace: true },
  })
  const marketplace = conn?.marketplace ?? ''
  let upserted = 0
  for (const r of records) {
    if (!r.campaignId) continue
    const dailyBudget = r.budgetCaps?.budgetValue?.monetaryBudget?.amount ?? 0
    const stateLower = normalizeStateV1(r.state)
    const data = {
      name: r.name,
      type: ADPRODUCT_TO_TYPE[r.adProduct] ?? 'SP' as const,
      adProduct: r.adProduct,
      status: STATE_TO_PRISMA[stateLower] ?? 'ENABLED',
      dailyBudget,
      startDate: r.startDate ? new Date(r.startDate) : new Date(),
      endDate: r.endDate ? new Date(r.endDate) : null,
      marketplace,
      externalCampaignId: r.campaignId,
      biddingStrategy: r.optimization?.bidStrategy
        ? (V1_BID_STRATEGY_MAP[r.optimization.bidStrategy] === 'autoForSales' ? 'AUTO_FOR_SALES'
           : V1_BID_STRATEGY_MAP[r.optimization.bidStrategy] === 'legacyForSales' ? 'LEGACY_FOR_SALES'
           : 'MANUAL') as 'AUTO_FOR_SALES' | 'LEGACY_FOR_SALES' | 'MANUAL'
        : 'LEGACY_FOR_SALES' as const,
      brandEntityId: r.brandEntityId ?? null,
      budgetJson: r.budgetCaps ? (r.budgetCaps as object) : undefined,
      bidStrategyJson: r.optimization ? (r.optimization as object) : undefined,
      costType: r.costType ?? null,
      deliveryStatus: r.deliveryStatus ?? null,
      deliveryReasons: r.deliveryReasons ?? [],
      lastSyncedAt: new Date(),
      lastSyncStatus: 'SUCCESS' as const,
      lastSyncError: null,
    }
    try {
      const existing = await prisma.campaign.findFirst({
        where: { externalCampaignId: r.campaignId, marketplace },
        select: { id: true },
      })
      if (existing) {
        await prisma.campaign.update({ where: { id: existing.id }, data })
      } else {
        await prisma.campaign.create({ data })
      }
      upserted += 1
    } catch (err) {
      logger.warn('[ads-v1-sync] campaign upsert failed', {
        campaignId: r.campaignId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return upserted
}

async function ingestAdGroups(profileId: string, records: V1AdGroup[]): Promise<number> {
  void profileId
  // Build externalCampaignId → local Campaign.id map for FK resolution
  const extIds = [...new Set(records.map((r) => r.campaignId))]
  const campaigns = await prisma.campaign.findMany({
    where: { externalCampaignId: { in: extIds } },
    select: { id: true, externalCampaignId: true },
  })
  const campMap = new Map(campaigns.map((c) => [c.externalCampaignId ?? '', c.id]))

  let upserted = 0
  for (const r of records) {
    if (!r.adGroupId) continue
    const localCampaignId = campMap.get(r.campaignId)
    if (!localCampaignId) continue
    const stateLower = normalizeStateV1(r.state)
    const data = {
      campaignId: localCampaignId,
      externalAdGroupId: r.adGroupId,
      name: r.name,
      status: STATE_TO_PRISMA[stateLower] ?? 'ENABLED',
      // v1 doesn't expose defaultBid on ad groups (bids are per-target);
      // preserve existing value if present, default to 50¢ for new rows.
      defaultBidCents: 50,
      deliveryStatus: r.deliveryStatus ?? null,
      deliveryReasons: r.deliveryReasons ?? [],
      lastSyncedAt: new Date(),
      lastSyncStatus: 'SUCCESS' as const,
      lastSyncError: null,
    }
    try {
      const existing = await prisma.adGroup.findFirst({
        where: { externalAdGroupId: r.adGroupId, campaignId: localCampaignId },
        select: { id: true, defaultBidCents: true },
      })
      if (existing) {
        // Keep the existing defaultBidCents — v1 doesn't carry it
        await prisma.adGroup.update({
          where: { id: existing.id },
          data: { ...data, defaultBidCents: existing.defaultBidCents },
        })
      } else {
        await prisma.adGroup.create({ data })
      }
      upserted += 1
    } catch (err) {
      logger.warn('[ads-v1-sync] adGroup upsert failed', {
        adGroupId: r.adGroupId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return upserted
}

async function ingestTargets(records: V1Target[]): Promise<{ upserted: number; breakdown: Record<string, number> }> {
  // Build adGroupId → local AdGroup.id map. Some targets are CAMPAIGN-level
  // negatives (no adGroupId); we skip those for the AdTarget table since
  // it requires an adGroupId FK. Campaign-level negatives could go in a
  // separate column on Campaign in a follow-up — out of H.2 scope.
  const extAdGroupIds = [...new Set(records.map((r) => r.adGroupId).filter((x): x is string => !!x))]
  const adGroups = await prisma.adGroup.findMany({
    where: { externalAdGroupId: { in: extAdGroupIds } },
    select: { id: true, externalAdGroupId: true },
  })
  const agMap = new Map(adGroups.map((g) => [g.externalAdGroupId ?? '', g.id]))

  let upserted = 0
  // AF.1 — instrument where rows go (positives were missing fleet-wide).
  const bd = { seen: records.length, noTargetId: 0, noAdGroupId: 0, noLocalAdGroup: 0, positives: 0, negatives: 0, kwPositives: 0 }
  for (const r of records) {
    if (!r.targetId) { bd.noTargetId++; continue }
    if (!r.adGroupId) { bd.noAdGroupId++; continue } // campaign-level negatives
    const localAdGroupId = agMap.get(r.adGroupId)
    if (!localAdGroupId) { bd.noLocalAdGroup++; continue }
    if (r.negative === true) bd.negatives++; else { bd.positives++; if ((r.targetType ?? 'KEYWORD') === 'KEYWORD') bd.kwPositives++ }
    const stateLower = normalizeStateV1(r.state)
    const kind = (r.targetType ?? 'KEYWORD') as 'KEYWORD' | 'PRODUCT' | 'CATEGORY' | 'AUDIENCE'
    const expressionType = r.targetDetails?.matchType?.toUpperCase()
      ?? (kind === 'KEYWORD' ? 'BROAD' : kind === 'PRODUCT' ? 'ASIN' : 'UNKNOWN')
    const expressionValue = r.targetDetails?.keyword
      ?? r.targetDetails?.asin
      ?? r.targetDetails?.categoryId
      ?? ''
    const data = {
      adGroupId: localAdGroupId,
      externalTargetId: r.targetId,
      kind,
      expressionType,
      expressionValue,
      bidCents: r.bid != null ? Math.round(r.bid * 100) : 0,
      status: STATE_TO_PRISMA[stateLower] ?? 'ENABLED',
      isNegative: r.negative === true,
      negativeLevel: r.negative === true ? (r.targetLevel ?? null) : null,
      deliveryStatus: r.deliveryStatus ?? null,
      deliveryReasons: r.deliveryReasons ?? [],
      lastSyncedAt: new Date(),
      lastSyncStatus: 'SUCCESS' as const,
      lastSyncError: null,
    }
    try {
      const existing = await prisma.adTarget.findFirst({
        where: { externalTargetId: r.targetId, adGroupId: localAdGroupId },
        select: { id: true },
      })
      if (existing) {
        await prisma.adTarget.update({ where: { id: existing.id }, data })
      } else {
        await prisma.adTarget.create({ data })
      }
      upserted += 1
    } catch (err) {
      logger.warn('[ads-v1-sync] target upsert failed', {
        targetId: r.targetId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  logger.info('[ads-v1-sync] targets ingest breakdown', { ...bd, upserted })
  return { upserted, breakdown: { ...bd, upserted } }
}

async function ingestAds(records: V1Ad[]): Promise<number> {
  // adGroupId → local AdGroup.id
  const extAdGroupIds = [...new Set(records.map((r) => r.adGroupId))]
  const adGroups = await prisma.adGroup.findMany({
    where: { externalAdGroupId: { in: extAdGroupIds } },
    select: { id: true, externalAdGroupId: true },
  })
  const agMap = new Map(adGroups.map((g) => [g.externalAdGroupId ?? '', g.id]))

  // Pre-resolve ASIN + SKU → Product.id in batch (single query)
  const asins = new Set<string>()
  const skus = new Set<string>()
  for (const r of records) {
    for (const p of r.creative?.products ?? []) {
      if (p.productIdType === 'ASIN' && p.productId) asins.add(p.productId)
      if (p.productIdType === 'SKU' && p.productId) skus.add(p.productId)
    }
  }
  const products = (asins.size > 0 || skus.size > 0)
    ? await prisma.product.findMany({
        where: {
          OR: [
            ...(asins.size > 0 ? [{ amazonAsin: { in: [...asins] } }] : []),
            ...(skus.size > 0  ? [{ sku:        { in: [...skus]  } }] : []),
          ],
        },
        select: { id: true, amazonAsin: true, sku: true },
      })
    : []
  const asinToId = new Map(products.filter((p) => p.amazonAsin).map((p) => [p.amazonAsin!, p.id]))
  const skuToId  = new Map(products.map((p) => [p.sku, p.id]))

  let upserted = 0
  for (const r of records) {
    if (!r.adId) continue
    const localAdGroupId = agMap.get(r.adGroupId)
    if (!localAdGroupId) continue
    const stateLower = normalizeStateV1(r.state)
    // Pick the first product as the "primary" for the flat asin/sku columns
    const firstProduct = r.creative?.products?.[0]
    const primaryAsin = firstProduct?.productIdType === 'ASIN' ? firstProduct.productId : undefined
    const primarySku  = firstProduct?.productIdType === 'SKU'  ? firstProduct.productId : undefined
    const productId = (primaryAsin && asinToId.get(primaryAsin))
      ?? (primarySku && skuToId.get(primarySku))
      ?? null
    const data = {
      adGroupId: localAdGroupId,
      externalAdId: r.adId,
      asin: primaryAsin ?? null,
      sku: primarySku ?? null,
      productId,
      status: STATE_TO_PRISMA[stateLower] ?? 'ENABLED',
      adType: r.adType ?? null,
      creativeJson: r.creative ? (r.creative as object) : undefined,
      deliveryStatus: r.deliveryStatus ?? null,
      deliveryReasons: r.deliveryReasons ?? [],
      lastSyncedAt: new Date(),
    }
    try {
      // The natural unique key in our schema is (adGroupId, asin); use findFirst by externalAdId for stability
      const existing = await prisma.adProductAd.findFirst({
        where: { externalAdId: r.adId, adGroupId: localAdGroupId },
        select: { id: true },
      })
      if (existing) {
        await prisma.adProductAd.update({ where: { id: existing.id }, data })
      } else {
        await prisma.adProductAd.create({ data })
      }
      upserted += 1
    } catch (err) {
      logger.warn('[ads-v1-sync] ad upsert failed', {
        adId: r.adId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return upserted
}

// ── 4. Orchestrate the full cycle ─────────────────────────────────────

export interface CycleResult {
  jobsCreated: number
  jobsSkipped: number
  errors: string[]
}

export async function runV1ExportCycle(args: {
  profileIds?: string[]
  resources?: V1Resource[]
  adProducts?: V1AdProduct[]
} = {}): Promise<CycleResult> {
  const result: CycleResult = { jobsCreated: 0, jobsSkipped: 0, errors: [] }
  const resources = args.resources ?? ALL_RESOURCES
  const adProducts = args.adProducts ?? ALL_AD_PRODUCTS

  // Default: every active connection with credentials
  const profiles = args.profileIds
    ? await prisma.amazonAdsConnection.findMany({
        where: { profileId: { in: args.profileIds }, isActive: true },
        select: { profileId: true },
      })
    : await prisma.amazonAdsConnection.findMany({
        where: { isActive: true, credentialsEncrypted: { not: null } },
        select: { profileId: true },
      })

  for (const profile of profiles) {
    for (const resource of resources) {
      try {
        await createExportJob({ profileId: profile.profileId, resource, adProducts })
        result.jobsCreated += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`${profile.profileId} ${resource}: ${msg.slice(0, 800)}`)
      }
    }
  }
  return result
}

export function summarizeCycle(r: CycleResult): string {
  return [
    `created=${r.jobsCreated}`,
    `skipped=${r.jobsSkipped}`,
    r.errors.length > 0 ? `errors=${r.errors.length}` : null,
  ].filter(Boolean).join(' · ')
}
