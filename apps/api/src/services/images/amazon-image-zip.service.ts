/**
 * IM.2 + IA.1 — Amazon image ZIP generator (fallback export).
 *
 * Produces a flat ZIP archive named per Amazon's bulk-upload
 * convention (https://sellercentral.amazon.it/help/hub/reference/G1881):
 *   {ASIN}.{SLOT}.{ext}   e.g.  B0AAXXXX.MAIN.jpg
 *
 * Uses the same 9-level cascade as amazon-image-feed.service.ts so
 * the downloaded ZIP is consistent with what JSON_LISTINGS_FEED
 * would publish. IA.1 fixed the bug where the FE never passed
 * activeAxis — group-based overrides (Color=Black, Size=M…) were
 * silently dropped because the resolver only ran the product-level
 * cascade layer.
 *
 * IA.1 also added:
 *   • marketplace='ALL' → per-market folders (IT/, DE/, …) in one ZIP.
 *   • Per-image fetch timeout (15s) via AbortController so a slow
 *     Cloudinary can't stall the export.
 *   • Per-image error reporting so the FE can surface "ASIN X slot Y
 *     skipped: 404" rather than silently shrinking the archive.
 */

import JSZip from 'jszip'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { resolveAmazonImages } from './amazon-image-feed.service.js'
import { validateAmazonPublish } from './amazon-publish-validator.service.js'
import { resolveSlotTaxonomy } from './amazon-slot-taxonomy.service.js'

export const ALL_AMAZON_MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK'] as const
type Marketplace = typeof ALL_AMAZON_MARKETPLACES[number]
const IMAGE_FETCH_TIMEOUT_MS = 15_000

/**
 * IA.7 — Filename templates for Amazon's bulk-upload page.
 *
 * Default `asin` matches Amazon's documented expectation
 * (https://sellercentral.amazon.it/help/hub/reference/G1881) —
 * the bulk-upload page resolves files by ASIN. `sku` is offered
 * for the operator-facing variant where seller SKUs are stable
 * but ASINs aren't always known (e.g. pre-publish photoshoot
 * archive). The slot + extension never change shape.
 */
export type FilenameTemplate = 'asin' | 'sku'

export interface AmazonZipInput {
  productId: string
  /** 'IT' | 'DE' | 'FR' | 'ES' | 'UK' | 'ALL' (all-markets mode) */
  marketplace: string
  /** IA.1 — operator's chosen grouping axis (e.g. 'Color'). Required
   *  for the resolver to honour per-group overrides. Defaults to
   *  Product.imageAxisPreference when not passed, falling back to
   *  null which scopes resolution to product-level rows only. */
  activeAxis?: string | null
  /** Optional explicit variant subset. Undefined = all child variants. */
  variantIds?: string[]
  /** IA.7 — filename template (default 'asin'). */
  filenameTemplate?: FilenameTemplate
}

export interface AmazonZipError {
  asin: string
  slot: string
  marketplace: string
  reason: string
}

export interface AmazonZipOutput {
  buffer: Buffer
  filename: string         // suggested Content-Disposition filename
  fileCount: number
  skippedNoAsin: string[]  // variant SKUs that had no ASIN on the requested marketplace
  errors: AmazonZipError[] // per-image failures (timeout, 4xx, decode)
}

/** Fetch with a hard timeout — Cloudinary occasionally hangs and we
 *  don't want one slow image to stall the whole export. AbortController
 *  is the standard mechanism for time-bounded fetches in Node 18+. */
async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

interface MarketplaceRunResult {
  fileCount: number
  skippedNoAsin: string[]
  errors: AmazonZipError[]
}

/** Run one marketplace's worth of resolution + fetches, adding files
 *  to the shared zip under an optional folder prefix. IA.4 added the
 *  validation gate — blocked ASINs (missing MAIN, sub-1000px, broken
 *  URL) get skipped with a clear reason in errors[] so the ZIP
 *  matches what Amazon would actually accept. */
async function runMarketplace(
  zip: JSZip,
  productId: string,
  marketplace: Marketplace,
  activeAxis: string | null,
  variantIds: string[] | undefined,
  folderPrefix: string,
  filenameTemplate: FilenameTemplate,
  productType: string,
): Promise<MarketplaceRunResult> {
  // Resolve the FULL writable slot taxonomy (incl. PS / safety-data-sheet
  // locators) so the export covers every slot the publish would. Without the
  // explicit slot list, resolveAmazonImages defaults to MAIN/PT/SWCH only and
  // silently drops PS images — the export then looks complete but isn't.
  const taxonomy = await resolveSlotTaxonomy(marketplace, productType)
  const [resolved, validation] = await Promise.all([
    resolveAmazonImages(
      productId,
      marketplace,
      variantIds,
      activeAxis ?? undefined,
      taxonomy.slots.map((s) => s.slot),
    ),
    validateAmazonPublish({
      productId,
      marketplace,
      activeAxis,
      variantIds,
    }),
  ])
  const skippedNoAsin: string[] = []
  const errors: AmazonZipError[] = []
  let fileCount = 0

  for (const variant of resolved) {
    if (!variant.amazonAsin) {
      skippedNoAsin.push(variant.sku)
      continue
    }
    // IA.4 — Skip ASINs the validator blocked. Their hard fails
    // surface as ZIP errors so the operator sees "B0XXX skipped:
    // MAIN_MISSING" in the response, not just a missing file.
    if (validation.blockedAsins.has(variant.amazonAsin)) {
      for (const issue of validation.hardFails.filter((i) => i.asin === variant.amazonAsin)) {
        errors.push({
          asin: variant.amazonAsin,
          slot: issue.slot ?? '*',
          marketplace,
          reason: `${issue.code}: ${issue.message}`,
        })
      }
      continue
    }
    for (const { slot, url } of variant.slots) {
      try {
        const imgRes = await fetchWithTimeout(url)
        if (!imgRes.ok) {
          errors.push({ asin: variant.amazonAsin, slot, marketplace, reason: `HTTP ${imgRes.status}` })
          continue
        }
        const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg'
        const ext = mimeToExt(contentType)
        // IA.7 — Filename token from template. ASIN is Amazon's
        // documented expectation; SKU is the operator-facing fallback.
        const token = filenameTemplate === 'sku' ? variant.sku : variant.amazonAsin
        const filename = `${folderPrefix}${token}.${slot}.${ext}`
        const buffer = Buffer.from(await imgRes.arrayBuffer())
        zip.file(filename, buffer)
        fileCount++
      } catch (err) {
        const reason = err instanceof Error
          ? err.name === 'AbortError'
            ? `timeout after ${IMAGE_FETCH_TIMEOUT_MS}ms`
            : err.message
          : String(err)
        errors.push({ asin: variant.amazonAsin, slot, marketplace, reason })
        logger.warn('[amazon-zip] failed to add image', { url, slot, asin: variant.amazonAsin, marketplace, reason })
      }
    }
  }

  return { fileCount, skippedNoAsin, errors }
}

export async function generateAmazonZip(
  input: AmazonZipInput,
): Promise<AmazonZipOutput> {
  const { productId, marketplace, variantIds } = input
  const mkt = marketplace.toUpperCase()
  const isAll = mkt === 'ALL'

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { sku: true, imageAxisPreference: true, productType: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)
  const productType = product.productType ?? 'PRODUCT'

  // IA.1 — Honor the operator's chosen axis. Falls back to the
  // product's stored preference so a script-driven export still
  // resolves group overrides.
  const activeAxis = input.activeAxis ?? product.imageAxisPreference ?? null
  const filenameTemplate: FilenameTemplate = input.filenameTemplate ?? 'asin'

  const zip = new JSZip()
  let totalFileCount = 0
  const allSkipped: string[] = []
  const allErrors: AmazonZipError[] = []

  if (isAll) {
    // IA.1 — Multi-marketplace export. Each marketplace gets its own
    // folder so the operator can drag the per-market subdirectory
    // onto Seller Central's bulk-upload page without colliding ASINs
    // that sell on multiple markets.
    for (const m of ALL_AMAZON_MARKETPLACES) {
      const r = await runMarketplace(zip, productId, m, activeAxis, variantIds, `${m}/`, filenameTemplate, productType)
      totalFileCount += r.fileCount
      allSkipped.push(...r.skippedNoAsin.map((sku) => `${m}/${sku}`))
      allErrors.push(...r.errors)
    }
  } else {
    if (!ALL_AMAZON_MARKETPLACES.includes(mkt as Marketplace)) {
      throw new Error(`Invalid marketplace: ${marketplace}`)
    }
    const r = await runMarketplace(zip, productId, mkt as Marketplace, activeAxis, variantIds, '', filenameTemplate, productType)
    totalFileCount = r.fileCount
    allSkipped.push(...r.skippedNoAsin)
    allErrors.push(...r.errors)
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const date = new Date().toISOString().slice(0, 10)
  const tag = isAll ? 'all' : mkt.toLowerCase()
  const filename = `amazon-${tag}-${product.sku}-${date}.zip`

  return {
    buffer,
    filename,
    fileCount: totalFileCount,
    skippedNoAsin: allSkipped,
    errors: allErrors,
  }
}

// ── Manifest (preview + completeness report) ────────────────────────────
// Per-market coverage WITHOUT downloading images: what would be exported,
// what's skipped (no ASIN), what's blocked (validation) + why. Powers the
// pre-export preview and the post-export report so nothing is silently missing.
export interface ZipManifestMarket {
  market: string
  asinCount: number          // variants that have an ASIN on this market
  estimatedFiles: number     // images that would be exported (non-blocked)
  skippedNoAsin: string[]    // SKUs with no ASIN on this market
  blocked: Array<{ asin: string; sku: string; reasons: string[] }>
}
export interface ZipManifest {
  perMarket: ZipManifestMarket[]
  totalEstimatedFiles: number
  totalBlocked: number
  totalSkippedNoAsin: number
}

export async function buildAmazonZipManifest(input: {
  productId: string
  marketplace: string
  activeAxis?: string | null
  variantIds?: string[]
}): Promise<ZipManifest> {
  const mkt = input.marketplace.toUpperCase()
  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { imageAxisPreference: true, productType: true },
  })
  if (!product) throw new Error(`Product ${input.productId} not found`)
  const activeAxis = input.activeAxis ?? product.imageAxisPreference ?? null
  const productType = product.productType ?? 'PRODUCT'
  const markets: Marketplace[] = mkt === 'ALL'
    ? [...ALL_AMAZON_MARKETPLACES]
    : [mkt as Marketplace]

  const perMarket: ZipManifestMarket[] = []
  for (const m of markets) {
    const taxonomy = await resolveSlotTaxonomy(m, productType)
    const [resolved, validation] = await Promise.all([
      resolveAmazonImages(input.productId, m, input.variantIds, activeAxis ?? undefined, taxonomy.slots.map((s) => s.slot)),
      validateAmazonPublish({ productId: input.productId, marketplace: m, activeAxis, variantIds: input.variantIds }),
    ])
    const withAsin = resolved.filter((v) => v.amazonAsin)
    const skippedNoAsin = resolved.filter((v) => !v.amazonAsin).map((v) => v.sku)
    const blocked: ZipManifestMarket['blocked'] = []
    let estimatedFiles = 0
    for (const v of withAsin) {
      if (validation.blockedAsins.has(v.amazonAsin!)) {
        const reasons = [...new Set(validation.hardFails.filter((i) => i.asin === v.amazonAsin).map((i) => i.code))]
        blocked.push({ asin: v.amazonAsin!, sku: v.sku, reasons })
      } else {
        estimatedFiles += v.slots.length
      }
    }
    perMarket.push({ market: m, asinCount: withAsin.length, estimatedFiles, skippedNoAsin, blocked })
  }

  return {
    perMarket,
    totalEstimatedFiles: perMarket.reduce((s, p) => s + p.estimatedFiles, 0),
    totalBlocked: perMarket.reduce((s, p) => s + p.blocked.length, 0),
    totalSkippedNoAsin: perMarket.reduce((s, p) => s + p.skippedNoAsin.length, 0),
  }
}

function mimeToExt(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('tiff')) return 'tif'
  return 'jpg'
}
