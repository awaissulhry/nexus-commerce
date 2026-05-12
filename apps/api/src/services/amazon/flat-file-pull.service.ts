/**
 * Flat-File Pull Service
 *
 * Background job that reconciles the platform's ChannelListing records
 * against Amazon's live listing data by calling getListingsItem per SKU.
 *
 * What it writes per SKU (for the requested marketplace):
 *   ChannelListing.platformAttributes.attributes  ← raw SP-API attributes
 *   ChannelListing.title / description / bulletPointsOverride / price / qty
 *   ChannelListing.externalListingId              ← ASIN
 *   ChannelListing.listingStatus / isPublished
 *   Product.isParent / parentId                  ← from SP-API relationships
 *   ProductVariation.amazonAsin
 *
 * After all SKUs are processed, getExistingRows() is called so the client
 * receives fully-expanded flat-file rows it can write to localStorage and
 * open directly in the flat file editor.
 *
 * Job lifecycle:
 *   startPullJob()  → returns jobId immediately, work starts async
 *   getJobStatus()  → poll every 3 s; status: 'running' | 'done' | 'failed'
 *   Jobs are kept in memory for 2 hours, then pruned.
 */

import prisma from '../../db.js'
import { AmazonService, AMAZON_MARKETPLACE_CODE_TO_ID } from '../marketplaces/amazon.service.js'
import { AmazonFlatFileService } from './flat-file.service.js'
import { CategorySchemaService } from '../categories/schema-sync.service.js'
import { MARKETPLACE_ID_MAP, LANGUAGE_TAG_MAP, CURRENCY_MAP } from './flat-file.service.js'

// ── Job types ──────────────────────────────────────────────────────────────

export interface PullJob {
  jobId: string
  marketplace: string
  productType: string
  status: 'running' | 'done' | 'failed'
  progress: number
  total: number
  pulled: number
  skipped: number
  failed: number
  errors: Array<{ sku: string; error: string }>
  rows: any[]
  startedAt: string
  doneAt?: string
  fatalError?: string
}

// ── In-memory store ────────────────────────────────────────────────────────

const JOB_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours
const jobs = new Map<string, PullJob>()

function pruneOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS
  for (const [id, job] of jobs) {
    if (new Date(job.startedAt).getTime() < cutoff) jobs.delete(id)
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function startPullJob(marketplace: string, productType: string): string {
  pruneOldJobs()
  const jobId = `ffpull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const job: PullJob = {
    jobId,
    marketplace: marketplace.toUpperCase(),
    productType: productType.toUpperCase(),
    status: 'running',
    progress: 0,
    total: 0,
    pulled: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    rows: [],
    startedAt: new Date().toISOString(),
  }
  jobs.set(jobId, job)
  void runJob(job).catch((err) => {
    job.status = 'failed'
    job.fatalError = err instanceof Error ? err.message : String(err)
    job.doneAt = new Date().toISOString()
  })
  return jobId
}

export function getJobStatus(jobId: string): PullJob | null {
  return jobs.get(jobId) ?? null
}

// ── All-markets pull ───────────────────────────────────────────────────────

export interface AllMarketsPullJob {
  jobId: string
  productType: string
  markets: string[]
  currentMarket: string | null
  status: 'running' | 'done' | 'failed'
  perMarket: Record<string, PullJob | null>
  startedAt: string
  doneAt?: string
  fatalError?: string
}

const allMarketJobs = new Map<string, AllMarketsPullJob>()

export function startAllMarketsPullJob(productType: string, markets: string[]): string {
  pruneOldJobs()
  const jobId = `ffpull-all-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const perMarket: Record<string, PullJob | null> = {}
  for (const mp of markets) perMarket[mp.toUpperCase()] = null

  const parentJob: AllMarketsPullJob = {
    jobId,
    productType: productType.toUpperCase(),
    markets: markets.map((m) => m.toUpperCase()),
    currentMarket: null,
    status: 'running',
    perMarket,
    startedAt: new Date().toISOString(),
  }
  allMarketJobs.set(jobId, parentJob)

  void runAllMarketsJob(parentJob).catch((err) => {
    parentJob.status = 'failed'
    parentJob.fatalError = err instanceof Error ? err.message : String(err)
    parentJob.doneAt = new Date().toISOString()
  })
  return jobId
}

export function getAllMarketsPullJobStatus(jobId: string): AllMarketsPullJob | null {
  return allMarketJobs.get(jobId) ?? null
}

async function runAllMarketsJob(parentJob: AllMarketsPullJob): Promise<void> {
  for (const mp of parentJob.markets) {
    parentJob.currentMarket = mp
    const childJob: PullJob = {
      jobId: `ffpull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      marketplace: mp,
      productType: parentJob.productType,
      status: 'running',
      progress: 0, total: 0, pulled: 0, skipped: 0, failed: 0,
      errors: [], rows: [],
      startedAt: new Date().toISOString(),
    }
    jobs.set(childJob.jobId, childJob)
    parentJob.perMarket[mp] = childJob
    await runJob(childJob) // sequential — rate-limit friendly
  }
  parentJob.currentMarket = null
  parentJob.status = 'done'
  parentJob.doneAt = new Date().toISOString()
}

// ── Core job logic ─────────────────────────────────────────────────────────

async function runJob(job: PullJob): Promise<void> {
  const { marketplace: mp, productType: pt } = job
  const marketplaceId = MARKETPLACE_ID_MAP[mp] ?? MARKETPLACE_ID_MAP.IT
  const channelMarket = `AMAZON_${mp}`

  // All products for this productType, parents first
  const products = await prisma.product.findMany({
    where: { deletedAt: null, productType: pt },
    select: { id: true, sku: true, isParent: true, parentId: true },
    orderBy: [{ isParent: 'desc' }, { sku: 'asc' }],
    take: 2000,
  })

  job.total = products.length

  if (!products.length) {
    job.status = 'done'
    job.doneAt = new Date().toISOString()
    return
  }

  const amazonService = new AmazonService()

  // Pre-build ASIN → SKU from existing ChannelListings for this marketplace
  // so child rows can resolve their parent SKU even before the parent is pulled.
  const existingListings = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', marketplace: mp, externalListingId: { not: null } },
    select: { externalListingId: true, product: { select: { sku: true } } },
  })
  const asinToSku = new Map<string, string>(
    existingListings
      .filter((r) => r.externalListingId)
      .map((r) => [r.externalListingId!, r.product.sku]),
  )

  // Process SKUs sequentially so we build up asinToSku as parents are pulled.
  // The SP client handles rate-limit back-off automatically.
  for (const product of products) {
    try {
      const listing = await amazonService.fetchListingForFlatFile(product.sku, marketplaceId)

      if (!listing) {
        job.skipped++
        job.progress++
        continue
      }

      const { asin, attributes: attrs, title, listingStatus, productType: amazonPt, relationships } = listing

      // Track ASIN → SKU so subsequent child lookups can resolve
      if (asin) asinToSku.set(asin, product.sku)

      // ── Price + qty from attributes ──────────────────────────────
      let price: number | null = null
      const offerAttr = attrs.purchasable_offer
      if (Array.isArray(offerAttr) && offerAttr[0]) {
        const schedule = offerAttr[0]?.our_price?.[0]?.schedule?.[0]
        if (schedule?.value_with_tax != null) price = parseFloat(String(schedule.value_with_tax))
      }

      let qty: number | null = null
      const qtyAttr = attrs.fulfillment_availability
      if (Array.isArray(qtyAttr) && qtyAttr[0]?.quantity != null) {
        qty = parseInt(String(qtyAttr[0].quantity), 10)
      }

      // ── Parentage from relationships ─────────────────────────────
      let isParentListing = false
      let parentAsin: string | null = null

      for (const rel of relationships) {
        if (rel.type === 'VARIATION') {
          if (Array.isArray(rel.childAsins) && rel.childAsins.length > 0) {
            isParentListing = true
          }
          if (typeof rel.parentAsin === 'string') {
            parentAsin = rel.parentAsin
          }
        }
      }

      const parentSku = parentAsin ? (asinToSku.get(parentAsin) ?? null) : null

      // ── Bullet points ────────────────────────────────────────────
      const bulletsRaw = attrs.bullet_point
      const bullets: string[] = Array.isArray(bulletsRaw)
        ? bulletsRaw.map((b: any) => b?.value ?? String(b)).filter(Boolean)
        : []

      // ── Upsert ChannelListing ────────────────────────────────────
      const existingCl = await prisma.channelListing.findFirst({
        where: { productId: product.id, channel: 'AMAZON', marketplace: mp },
        select: { id: true, version: true },
      })

      const listingPayload: Record<string, any> = {
        channel: 'AMAZON',
        marketplace: mp,
        region: mp,
        channelMarket,
        title: title ?? attrs.item_name?.[0]?.value ?? undefined,
        description: attrs.product_description?.[0]?.value ?? undefined,
        platformAttributes: { attributes: attrs },
        externalListingId: asin,
        syncStatus: 'SYNCED',
        lastSyncedAt: new Date(),
        lastSyncStatus: 'SUCCESS',
        isPublished: listingStatus === 'BUYABLE' || listingStatus === 'ACTIVE',
        listingStatus: listingStatus ?? 'ACTIVE',
        followMasterTitle: false,
        followMasterDescription: false,
        ...(bullets.length > 0 ? { bulletPointsOverride: bullets, followMasterBulletPoints: false } : {}),
        ...(price !== null && !isNaN(price) ? { price, followMasterPrice: false } : {}),
        ...(qty !== null && !isNaN(qty) ? { quantity: qty, followMasterQuantity: false } : {}),
      }

      if (existingCl) {
        await prisma.channelListing.update({
          where: { id: existingCl.id },
          data: { ...listingPayload, version: { increment: 1 } },
        })
      } else {
        await prisma.channelListing.create({
          data: { productId: product.id, ...listingPayload } as any,
        })
      }

      // ── Product hierarchy ────────────────────────────────────────
      const productUpdates: Record<string, any> = {}
      if (isParentListing && !product.isParent) productUpdates.isParent = true
      if (amazonPt && amazonPt.toUpperCase() !== pt) {
        // Don't overwrite productType if Amazon returns something different
        // (can happen on shared-ASIN pan-EU accounts) — only set if blank
      }
      if (parentSku) {
        const parentProduct = products.find((p) => p.sku === parentSku)
        if (parentProduct && product.parentId !== parentProduct.id) {
          productUpdates.parentId = parentProduct.id
        }
      }
      if (Object.keys(productUpdates).length) {
        await prisma.product.update({ where: { id: product.id }, data: productUpdates })
      }

      // ── ASIN on ProductVariation ─────────────────────────────────
      if (asin) {
        await prisma.productVariation.updateMany({
          where: { productId: product.id },
          data: { amazonAsin: asin },
        })
      }

      job.pulled++
    } catch (err: any) {
      job.failed++
      job.errors.push({ sku: product.sku, error: err?.message ?? 'Pull failed' })
    }

    job.progress++
  }

  // Generate flat-file rows from DB — reuses all expansion logic in getExistingRows
  try {
    const amazon = new AmazonService()
    const schemaService = new CategorySchemaService(prisma, amazon)
    const flatFileService = new AmazonFlatFileService(prisma, schemaService)
    job.rows = await flatFileService.getExistingRows(mp, pt)
  } catch {
    job.rows = []
  }

  job.status = 'done'
  job.doneAt = new Date().toISOString()
}
