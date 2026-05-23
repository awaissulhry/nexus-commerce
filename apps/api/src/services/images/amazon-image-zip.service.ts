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

export const ALL_AMAZON_MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK'] as const
type Marketplace = typeof ALL_AMAZON_MARKETPLACES[number]
const IMAGE_FETCH_TIMEOUT_MS = 15_000

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
 *  to the shared zip under an optional folder prefix. */
async function runMarketplace(
  zip: JSZip,
  productId: string,
  marketplace: Marketplace,
  activeAxis: string | null,
  variantIds: string[] | undefined,
  folderPrefix: string,
): Promise<MarketplaceRunResult> {
  const resolved = await resolveAmazonImages(
    productId,
    marketplace,
    variantIds,
    activeAxis ?? undefined,
  )
  const skippedNoAsin: string[] = []
  const errors: AmazonZipError[] = []
  let fileCount = 0

  for (const variant of resolved) {
    if (!variant.amazonAsin) {
      skippedNoAsin.push(variant.sku)
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
        const filename = `${folderPrefix}${variant.amazonAsin}.${slot}.${ext}`
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
    select: { sku: true, imageAxisPreference: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)

  // IA.1 — Honor the operator's chosen axis. Falls back to the
  // product's stored preference so a script-driven export still
  // resolves group overrides.
  const activeAxis = input.activeAxis ?? product.imageAxisPreference ?? null

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
      const r = await runMarketplace(zip, productId, m, activeAxis, variantIds, `${m}/`)
      totalFileCount += r.fileCount
      allSkipped.push(...r.skippedNoAsin.map((sku) => `${m}/${sku}`))
      allErrors.push(...r.errors)
    }
  } else {
    if (!ALL_AMAZON_MARKETPLACES.includes(mkt as Marketplace)) {
      throw new Error(`Invalid marketplace: ${marketplace}`)
    }
    const r = await runMarketplace(zip, productId, mkt as Marketplace, activeAxis, variantIds, '')
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

function mimeToExt(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('tiff')) return 'tif'
  return 'jpg'
}
