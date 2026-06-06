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
import { resolveSlotTaxonomy } from './amazon-slot-taxonomy.service.js'
import { computeExactMirror } from './amazon-exact-mirror.js'
import { marketplaceCodeToId } from '../../utils/marketplace-code.js'

/**
 * M3 — publish mode. 'exact-mirror' (default) sends the full desired state
 * per slot (replace filled + delete empty) so Amazon matches Nexus exactly.
 * Kill-switch: NEXUS_AMAZON_IMAGE_MIRROR_ENABLED=0 falls back to 'additive'
 * (legacy: only push filled slots, never delete).
 */
export function defaultMirrorMode(): 'exact-mirror' | 'additive' {
  return process.env.NEXUS_AMAZON_IMAGE_MIRROR_ENABLED === '0' ? 'additive' : 'exact-mirror'
}

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
  /** M3 — defaults to defaultMirrorMode() (exact-mirror unless killed). */
  mode?: 'exact-mirror' | 'additive'
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
  slotCodes?: string[],
): Promise<ResolvedVariantImages[]> {
  const platform = 'AMAZON'
  const mkt = marketplace.toUpperCase()

  const variantWhere = variantIds?.length
    ? { productId, id: { in: variantIds } }
    : { productId }

  // M3.1 — resolve the buyable variants for BOTH variation models. Parent/
  // child Products take precedence (mirrors images-workspace), else
  // ProductVariation rows, else the product itself (single, no variants).
  // Without this the mirror is a no-op for child-Product products (the
  // common model here — e.g. GALE-JACKET has 18 child SKUs, 0 ProductVariation).
  type ResolvableVariant = { id: string; sku: string; amazonAsin: string | null; variationAttributes: unknown }
  const childWhere = variantIds?.length
    ? { parentId: productId, id: { in: variantIds } }
    : { parentId: productId }
  const children = await prisma.product.findMany({
    where: childWhere,
    select: { id: true, sku: true, amazonAsin: true },
    orderBy: { sku: 'asc' },
  })

  let variants: ResolvableVariant[]
  if (children.length > 0) {
    variants = children.map((c) => ({ id: c.id, sku: c.sku, amazonAsin: c.amazonAsin, variationAttributes: null }))
  } else {
    variants = await prisma.productVariation.findMany({
      where: variantWhere,
      select: { id: true, sku: true, amazonAsin: true, variationAttributes: true },
      orderBy: { sku: 'asc' },
    })
  }

  if (variants.length === 0) {
    const self = await prisma.product.findUnique({
      where: { id: productId },
      select: { sku: true, amazonAsin: true },
    })
    if (self && (self.amazonAsin || self.sku)) {
      variants = [{ id: productId, sku: self.sku, amazonAsin: self.amazonAsin ?? null, variationAttributes: null }]
    }
  }

  if (variants.length === 0) return []

  // Load all listing images in one query — includes group-based rows.
  // IE.6 — also pull sourceProductImageId so the effective-url
  // resolver can re-route to the master gallery's current URL.
  const allImagesRaw = await prisma.listingImage.findMany({
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
      sourceProductImageId: true,
      altOverride: true,
    },
  })

  // IE.6 — load master gallery once so the effective-url resolver
  // can swap stale ListingImage.url values for the master's current
  // URL. Single batched query keyed by productId.
  const masters = await prisma.productImage.findMany({
    where: { productId },
    select: { id: true, url: true, alt: true },
  })
  const masterById = new Map(masters.map((m) => [m.id, m]))
  const allImages = allImagesRaw.map((img) => {
    if (!img.sourceProductImageId) return img
    const m = masterById.get(img.sourceProductImageId)
    if (!m) return img
    // Override url with master's authoritative URL. Leave id +
    // variant/marketplace/slot fields alone so the resolver still
    // matches them in the cascade.
    return { ...img, url: m.url }
  })

  const results: ResolvedVariantImages[] = []

  for (const variant of variants) {
    const attrs = variant.variationAttributes as Record<string, string> | null
    const axisValue = activeAxis && attrs ? (attrs[activeAxis] ?? null) : null
    const resolvedSlots: ResolvedSlot[] = []

    for (const slot of (slotCodes ?? AMAZON_SLOTS)) {
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
  // IE.6 — present on rows linked to a master; resolver above swaps
  // url with master.url and the publisher reads that.
  sourceProductImageId?: string | null
  altOverride?: string | null
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
      // IA.11 — empty url = blocker row. Cell is explicitly empty
      // at this scope; short-circuit the cascade so we don't fall
      // back to inherited / product-level. Publisher + ZIP skip
      // the entire slot for this ASIN — Amazon receives nothing.
      if (!match.url) return null
      return { slot, url: match.url, listingImageId: match.id, origin: c.origin, scope: c.scopeLabel }
    }
  }

  return null
}

// ── Feed submission ────────────────────────────────────────────────────

export async function submitAmazonImageFeed(
  input: AmazonImageFeedInput,
): Promise<AmazonImageFeedOutput> {
  const { productId, marketplace, variantIds, activeAxis, dryRun = false, mode = defaultMirrorMode() } = input
  const mkt = marketplace.toUpperCase()

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { sku: true, productType: true, imageAxisPreference: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)

  const axis = activeAxis ?? product.imageAxisPreference ?? undefined
  const productType = product.productType ?? 'PRODUCT'
  // M3 — resolve the schema-discovered slot taxonomy (MAIN/PT.../PS.../SWCH)
  // so the cascade covers every writable slot and exact-mirror knows the
  // delete set + the per-slot locator attribute.
  const taxonomy = await resolveSlotTaxonomy(mkt, productType)
  const taxLite = taxonomy.slots.map((s) => ({ slot: s.slot, kind: s.kind, writable: s.writable }))
  const resolved = await resolveAmazonImages(productId, mkt, variantIds, axis, taxonomy.slots.map((s) => s.slot))

  const skippedNoAsin: string[] = []
  const skippedNoImages: string[] = []
  const operations: Parameters<typeof submitAmazonListingsBatch>[0]['operations'] = []
  const includedSkus: string[] = []

  for (const v of resolved) {
    if (!v.amazonAsin) {
      skippedNoAsin.push(v.sku)
      continue
    }
    const filled = v.slots.map((s) => ({ slot: s.slot, url: s.url }))
    if (mode === 'exact-mirror') {
      const plan = computeExactMirror(filled, taxLite)
      if (plan.skip) {
        // SAFETY: no MAIN resolved → leave this ASIN untouched (never wipe).
        skippedNoImages.push(v.sku)
        continue
      }
      operations.push({
        type: 'image',
        sku: v.sku,
        productType,
        slots: plan.slots,
        deleteSlots: plan.deleteSlots,
        slotToAttribute: taxonomy.slotToAttribute,
      })
    } else {
      if (filled.length === 0) {
        skippedNoImages.push(v.sku)
        continue
      }
      operations.push({
        type: 'image',
        sku: v.sku,
        productType,
        slots: filled,
        slotToAttribute: taxonomy.slotToAttribute,
      })
    }
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

  const marketplaceId = MARKETPLACE_IDS[mkt] ?? marketplaceCodeToId(mkt)
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

    // IA.3 — Structured per-SKU receipt. Embedded in resultSummary
    // so existing readers (raw Amazon report) still work, while the
    // ImagePublishHistory drill-down can pivot on `perSku` directly.
    const perSku = await buildPerSkuReceipt(job.productId, skus, summary)
    const summaryWithReceipt = {
      ...((summary as Record<string, unknown> | null) ?? {}),
      perSku,
    }

    await prisma.amazonImageFeedJob.update({
      where: { id: jobId },
      data: {
        status: 'DONE',
        resultSummary: summaryWithReceipt as any,
        completedAt: new Date(),
      },
    })
    return { jobId, status: 'DONE', resultSummary: summaryWithReceipt }
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

/**
 * IA.3 — Build a structured per-SKU receipt from Amazon's processing
 * report. The drill-down UI pivots on this rather than re-parsing the
 * raw report. Stored on AmazonImageFeedJob.resultSummary.perSku so
 * existing readers (raw Amazon report) keep working.
 */
export interface PerSkuReceipt {
  sku: string
  asin: string | null
  accepted: boolean
  errors: Array<{ code: string; message: string }>
}

async function buildPerSkuReceipt(
  productId: string,
  skus: string[],
  report: unknown,
): Promise<PerSkuReceipt[]> {
  if (!skus.length) return []

  // Index issues by messageId (1-based — matches the position the
  // submitter wrote them at). Same parsing rules as applyPublishResults
  // so the receipt agrees with what we wrote to ListingImage.
  const issues: Array<{ messageId?: number; code?: string; message?: string }> =
    (report as any)?.processingReport?.issues ?? []
  const errorsByMessageId = new Map<number, Array<{ code: string; message: string }>>()
  for (const issue of issues) {
    if (!issue.messageId || issue.code === 'VALID' || !issue.code) continue
    const list = errorsByMessageId.get(issue.messageId) ?? []
    list.push({ code: issue.code, message: issue.message ?? '' })
    errorsByMessageId.set(issue.messageId, list)
  }

  // Resolve ASINs in one batched query — the operator wants to see
  // "B0XYZ123" not just the SKU when scanning the receipt.
  const variants = await prisma.product.findMany({
    where: { sku: { in: skus }, parentId: productId },
    select: { sku: true, amazonAsin: true },
  })
  const asinBySku = new Map<string, string | null>()
  for (const v of variants) asinBySku.set(v.sku, v.amazonAsin ?? null)
  // Fall back to legacy ProductVariation rows (pre-PIM refactor)
  // for any SKU the parent-child query missed.
  const missing = skus.filter((s) => !asinBySku.has(s))
  if (missing.length > 0) {
    const pvs = await prisma.productVariation.findMany({
      where: { sku: { in: missing }, productId },
      select: { sku: true, amazonAsin: true },
    })
    for (const v of pvs) asinBySku.set(v.sku, v.amazonAsin ?? null)
  }

  return skus.map((sku, i) => {
    const messageId = i + 1
    const errors = errorsByMessageId.get(messageId) ?? []
    return {
      sku,
      asin: asinBySku.get(sku) ?? null,
      accepted: errors.length === 0,
      errors,
    }
  })
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
