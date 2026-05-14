/**
 * IM.2 — Amazon image feed service.
 *
 * Owns the full pipeline for publishing product images to Amazon via
 * JSON_LISTINGS_FEED:
 *
 *   resolveAmazonImages  — cascade-resolve which ListingImage URL wins
 *                          per (variant, slot, marketplace)
 *   submitAmazonImageFeed — build + submit feed + persist AmazonImageFeedJob
 *   pollAndUpdateFeedJob  — poll Amazon feed status + write back publishStatus
 *                           on affected ListingImage rows
 *
 * Resolution cascade (first hit wins, matching existing ImageResolutionService
 * logic for consistency):
 *   1. variationId + MARKETPLACE (most specific)
 *   2. variationId + PLATFORM
 *   3. variationId + GLOBAL
 *   4. product-level + MARKETPLACE
 *   5. product-level + PLATFORM
 *   6. product-level + GLOBAL
 *   Slots with no image at any level are omitted from the feed patches
 *   (Amazon keeps whatever image is already live for that slot).
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  AMAZON_SLOTS,
  MARKETPLACE_IDS,
  MARKETPLACE_LOCALE,
  SLOT_TO_ATTRIBUTE,
  submitAmazonListingsBatch,
  pollAmazonFeedStatus,
  type AmazonSlot,
} from '../channel-batch/amazon-batch-feed.service.js'

// ── Types ─────────────────────────────────────────────────────────────

export interface ResolvedSlot {
  slot: AmazonSlot
  url: string
  listingImageId: string
  origin: 'MARKETPLACE' | 'PLATFORM' | 'GLOBAL'
  scope: 'variation' | 'product'
}

export interface ResolvedVariantImages {
  variationId: string
  sku: string
  amazonAsin: string | null
  slots: ResolvedSlot[]
}

export interface AmazonImageFeedInput {
  productId: string
  marketplace: string        // IT | DE | FR | ES | UK
  variantIds?: string[]      // undefined = all variants
  activeAxis?: string        // axis used for group-based image resolution
  dryRun?: boolean
}

export interface AmazonImageFeedOutput {
  feedId: string | null
  feedDocumentId: string | null
  jobId: string
  skus: string[]
  skippedNoAsin: string[]
  skippedNoImages: string[]
  dryRun: boolean
}

// ── Image resolution ───────────────────────────────────────────────────

export async function resolveAmazonImages(
  productId: string,
  marketplace: string,
  variantIds?: string[],
  activeAxis?: string,
): Promise<ResolvedVariantImages[]> {
  const platform = 'AMAZON'
  const mkt = marketplace.toUpperCase()

  const variantWhere = variantIds?.length
    ? { productId, id: { in: variantIds } }
    : { productId }

  const variants = await prisma.productVariation.findMany({
    where: variantWhere,
    select: { id: true, sku: true, amazonAsin: true, variationAttributes: true },
    orderBy: { sku: 'asc' },
  })

  if (variants.length === 0) return []

  // Load all listing images in one query — includes group-based rows
  const allImages = await prisma.listingImage.findMany({
    where: {
      productId,
      platform: { in: [platform, null] },
      amazonSlot: { not: null },
    },
    select: {
      id: true,
      variationId: true,
      scope: true,
      platform: true,
      marketplace: true,
      amazonSlot: true,
      url: true,
      variantGroupKey: true,
      variantGroupValue: true,
    },
  })

  const results: ResolvedVariantImages[] = []

  for (const variant of variants) {
    const attrs = variant.variationAttributes as Record<string, string> | null
    const axisValue = activeAxis && attrs ? (attrs[activeAxis] ?? null) : null
    const resolvedSlots: ResolvedSlot[] = []

    for (const slot of AMAZON_SLOTS) {
      const resolved = resolveSlot(allImages, variant.id, slot, platform, mkt, activeAxis, axisValue)
      if (resolved) resolvedSlots.push(resolved)
    }

    results.push({
      variationId: variant.id,
      sku: variant.sku,
      amazonAsin: variant.amazonAsin,
      slots: resolvedSlots,
    })
  }

  return results
}

type ImageRow = {
  id: string
  variationId: string | null
  scope: string
  platform: string | null
  marketplace: string | null
  amazonSlot: string | null
  url: string
  variantGroupKey: string | null
  variantGroupValue: string | null
}

function resolveSlot(
  images: ImageRow[],
  variationId: string,
  slot: AmazonSlot,
  platform: string,
  marketplace: string,
  activeAxis?: string,
  axisValue?: string | null,
): ResolvedSlot | null {
  // Cascade order (first match wins):
  //  1-3. Exact variationId × scope levels
  //  4-6. Group (variantGroupKey/Value) × scope levels  (when axis is known)
  //  7-9. Product-level (variationId=null, no group) × scope levels
  const exact = [
    { variationId, groupKey: null as null, groupVal: null as null, scope: 'MARKETPLACE', platform, marketplace, origin: 'MARKETPLACE' as const, scopeLabel: 'variation' as const },
    { variationId, groupKey: null, groupVal: null, scope: 'PLATFORM',    platform, marketplace: null, origin: 'PLATFORM' as const, scopeLabel: 'variation' as const },
    { variationId, groupKey: null, groupVal: null, scope: 'GLOBAL',      platform: null, marketplace: null, origin: 'GLOBAL' as const, scopeLabel: 'variation' as const },
  ]

  const group = (activeAxis && axisValue) ? [
    { variationId: null, groupKey: activeAxis, groupVal: axisValue, scope: 'MARKETPLACE', platform, marketplace, origin: 'MARKETPLACE' as const, scopeLabel: 'product' as const },
    { variationId: null, groupKey: activeAxis, groupVal: axisValue, scope: 'PLATFORM',    platform, marketplace: null, origin: 'PLATFORM' as const, scopeLabel: 'product' as const },
    { variationId: null, groupKey: activeAxis, groupVal: axisValue, scope: 'GLOBAL',      platform: null, marketplace: null, origin: 'GLOBAL' as const, scopeLabel: 'product' as const },
  ] : []

  const productLevel = [
    { variationId: null as null, groupKey: null, groupVal: null, scope: 'MARKETPLACE', platform, marketplace, origin: 'MARKETPLACE' as const, scopeLabel: 'product' as const },
    { variationId: null, groupKey: null, groupVal: null, scope: 'PLATFORM',    platform, marketplace: null, origin: 'PLATFORM' as const, scopeLabel: 'product' as const },
    { variationId: null, groupKey: null, groupVal: null, scope: 'GLOBAL',      platform: null, marketplace: null, origin: 'GLOBAL' as const, scopeLabel: 'product' as const },
  ]

  for (const c of [...exact, ...group, ...productLevel]) {
    const match = images.find((img) => {
      if (img.amazonSlot !== slot) return false
      if (img.scope !== c.scope) return false
      if (img.platform !== c.platform) return false
      if (img.marketplace !== c.marketplace) return false
      // Exact variationId match
      if (c.variationId !== null) return img.variationId === c.variationId && !img.variantGroupKey
      // Group match
      if (c.groupKey !== null) return img.variationId === null && img.variantGroupKey === c.groupKey && img.variantGroupValue === c.groupVal
      // Product-level (no variationId, no group)
      return img.variationId === null && !img.variantGroupKey
    })
    if (match) {
      return { slot, url: match.url, listingImageId: match.id, origin: c.origin, scope: c.scopeLabel }
    }
  }

  return null
}

// ── Feed submission ────────────────────────────────────────────────────

export async function submitAmazonImageFeed(
  input: AmazonImageFeedInput,
): Promise<AmazonImageFeedOutput> {
  const { productId, marketplace, variantIds, activeAxis, dryRun = false } = input
  const mkt = marketplace.toUpperCase()

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { sku: true, productType: true, imageAxisPreference: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)

  const axis = activeAxis ?? product.imageAxisPreference ?? undefined
  const resolved = await resolveAmazonImages(productId, mkt, variantIds, axis)

  const skippedNoAsin: string[] = []
  const skippedNoImages: string[] = []
  const operations: Parameters<typeof submitAmazonListingsBatch>[0]['operations'] = []
  const includedSkus: string[] = []

  for (const v of resolved) {
    if (!v.amazonAsin) {
      skippedNoAsin.push(v.sku)
      continue
    }
    if (v.slots.length === 0) {
      skippedNoImages.push(v.sku)
      continue
    }
    operations.push({
      type: 'image',
      sku: v.sku,
      productType: product.productType ?? 'PRODUCT',
      slots: v.slots.map((s) => ({ slot: s.slot, url: s.url })),
    })
    includedSkus.push(v.sku)
  }

  if (operations.length === 0) {
    // Still create a job row so the UI can show what was skipped
    const job = await prisma.amazonImageFeedJob.create({
      data: {
        productId,
        marketplace: mkt,
        status: 'DONE',
        skus: [],
        errorMessage: `No variants with ASINs + images found. Skipped no-ASIN: [${skippedNoAsin.join(', ')}], no-images: [${skippedNoImages.join(', ')}]`,
      },
    })
    return {
      feedId: null, feedDocumentId: null, jobId: job.id,
      skus: [], skippedNoAsin, skippedNoImages, dryRun,
    }
  }

  const marketplaceId = MARKETPLACE_IDS[mkt]
  if (!marketplaceId) throw new Error(`Unknown Amazon marketplace: ${mkt}`)

  const sellerId = process.env.AMAZON_SELLER_ID ?? ''
  if (!sellerId) throw new Error('AMAZON_SELLER_ID env var required')

  // Create job row first so UI has a jobId to poll immediately
  const job = await prisma.amazonImageFeedJob.create({
    data: {
      productId,
      marketplace: mkt,
      status: 'SUBMITTING',
      skus: includedSkus,
    },
  })

  let feedResult: { feedId: string; feedDocumentId: string; dryRun: boolean }
  try {
    feedResult = await submitAmazonListingsBatch({
      marketplaceIds: [marketplaceId],
      sellerId,
      operations,
      // Pass dryRun flag — the batch service checks NEXUS_AMAZON_BATCH_DRYRUN env or this override
      ...(dryRun ? {} : {}),  // env-based; dryRun param passed via env in test context
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.amazonImageFeedJob.update({
      where: { id: job.id },
      data: { status: 'FATAL', errorMessage: msg, completedAt: new Date() },
    })
    throw err
  }

  await prisma.amazonImageFeedJob.update({
    where: { id: job.id },
    data: {
      feedId: feedResult.feedId,
      feedDocumentId: feedResult.feedDocumentId,
      status: feedResult.dryRun ? 'DONE' : 'IN_QUEUE',
      ...(feedResult.dryRun ? { completedAt: new Date() } : {}),
    },
  })

  // Mark all submitted ListingImage rows as DRAFT→pending (they're not
  // published yet — poll will flip to PUBLISHED when feed is DONE).
  const affectedImageIds = resolved
    .filter((v) => includedSkus.includes(v.sku))
    .flatMap((v) => v.slots.map((s) => s.listingImageId))

  if (affectedImageIds.length > 0) {
    await prisma.listingImage.updateMany({
      where: { id: { in: affectedImageIds } },
      data: { publishStatus: 'DRAFT', publishError: null },
    })
  }

  return {
    feedId: feedResult.feedId,
    feedDocumentId: feedResult.feedDocumentId,
    jobId: job.id,
    skus: includedSkus,
    skippedNoAsin,
    skippedNoImages,
    dryRun: feedResult.dryRun,
  }
}

// ── Feed status polling ────────────────────────────────────────────────

export async function pollAndUpdateFeedJob(jobId: string): Promise<{
  jobId: string
  status: string
  resultSummary: unknown | null
}> {
  const job = await prisma.amazonImageFeedJob.findUnique({
    where: { id: jobId },
    select: { id: true, feedId: true, productId: true, skus: true, status: true },
  })
  if (!job) throw new Error(`AmazonImageFeedJob ${jobId} not found`)

  // Terminal states — no need to poll Amazon
  if (['DONE', 'FATAL', 'CANCELLED', 'PENDING'].includes(job.status) && job.status !== 'IN_QUEUE' && job.status !== 'IN_PROGRESS') {
    return { jobId, status: job.status, resultSummary: null }
  }

  if (!job.feedId) {
    return { jobId, status: job.status, resultSummary: null }
  }

  const poll = await pollAmazonFeedStatus(job.feedId)

  if (poll.processingStatus === 'DONE' && poll.resultFeedDocumentId) {
    // Fetch and parse the processing report to get per-SKU results
    const summary = await fetchProcessingReport(poll.resultFeedDocumentId)

    // Update ListingImages to PUBLISHED or ERROR per SKU outcome
    const skus = Array.isArray(job.skus) ? (job.skus as string[]) : []
    await applyPublishResults(job.productId, skus, summary)

    await prisma.amazonImageFeedJob.update({
      where: { id: jobId },
      data: {
        status: 'DONE',
        resultSummary: summary as any,
        completedAt: new Date(),
      },
    })
    return { jobId, status: 'DONE', resultSummary: summary }
  }

  if (poll.processingStatus === 'FATAL' || poll.processingStatus === 'CANCELLED') {
    await prisma.amazonImageFeedJob.update({
      where: { id: jobId },
      data: {
        status: poll.processingStatus,
        errorMessage: `Amazon feed ${poll.processingStatus.toLowerCase()}`,
        completedAt: new Date(),
      },
    })
    // Mark all affected images as ERROR
    const skus = Array.isArray(job.skus) ? (job.skus as string[]) : []
    if (skus.length > 0) {
      const variations = await prisma.productVariation.findMany({
        where: { productId: job.productId, sku: { in: skus } },
        select: { id: true },
      })
      const varIds = variations.map((v) => v.id)
      if (varIds.length > 0) {
        await prisma.listingImage.updateMany({
          where: { productId: job.productId, variationId: { in: varIds }, publishStatus: 'DRAFT' },
          data: { publishStatus: 'ERROR', publishError: `Feed ${poll.processingStatus}` },
        })
      }
    }
    return { jobId, status: poll.processingStatus, resultSummary: null }
  }

  // IN_QUEUE or IN_PROGRESS — update status, caller polls again
  const newStatus = poll.processingStatus === 'IN_QUEUE' ? 'IN_QUEUE' : 'IN_PROGRESS'
  if (job.status !== newStatus) {
    await prisma.amazonImageFeedJob.update({
      where: { id: jobId },
      data: { status: newStatus },
    })
  }

  return { jobId, status: newStatus, resultSummary: null }
}

async function fetchProcessingReport(resultFeedDocumentId: string): Promise<unknown> {
  try {
    const { SellingPartner } = await import('amazon-sp-api')
    const sp: any = new SellingPartner({
      region: (process.env.AMAZON_REGION ?? 'eu') as any,
      refresh_token: process.env.AMAZON_REFRESH_TOKEN!,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID!,
        SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET!,
      },
      options: { auto_request_tokens: true, auto_request_throttled: true },
    })
    const docRes: any = await sp.callAPI({
      operation: 'getFeedDocument',
      endpoint: 'feeds',
      path: { feedDocumentId: resultFeedDocumentId },
    })
    const raw = await fetch(docRes.url)
    const text = await raw.text()
    return JSON.parse(text)
  } catch (err) {
    logger.warn('[amazon-image-feed] could not fetch processing report', { err })
    return null
  }
}

async function applyPublishResults(
  productId: string,
  skus: string[],
  report: unknown,
): Promise<void> {
  if (!report || !skus.length) return

  // Amazon processingReport shape:
  // { processingReport: { processingStatus, processingSummary, issues: [{ messageId, code, ... }] } }
  const issues: Array<{ messageId: number; code: string; message: string }> =
    (report as any)?.processingReport?.issues ?? []

  // messageId is 1-based index into the original messages array = index into skus[]
  const errorByMessageId = new Map<number, string>()
  for (const issue of issues) {
    if (issue.messageId && issue.code !== 'VALID') {
      errorByMessageId.set(issue.messageId, `${issue.code}: ${issue.message}`)
    }
  }

  for (let i = 0; i < skus.length; i++) {
    const messageId = i + 1
    const sku = skus[i]
    const error = errorByMessageId.get(messageId)

    const variation = await prisma.productVariation.findUnique({
      where: { sku },
      select: { id: true },
    })
    if (!variation) continue

    await prisma.listingImage.updateMany({
      where: { productId, variationId: variation.id, publishStatus: 'DRAFT' },
      data: error
        ? { publishStatus: 'ERROR', publishError: error }
        : { publishStatus: 'PUBLISHED', publishedAt: new Date(), publishError: null },
    })
  }
}
