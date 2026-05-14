/**
 * IM.2 — Amazon image ZIP generator (fallback export).
 *
 * Produces a flat ZIP archive named per Amazon's bulk-upload convention:
 *   {ASIN}.{SLOT}.{ext}   e.g.  B0AAXXXX.MAIN.jpg
 *
 * Uses the same 6-level cascade as amazon-image-feed.service.ts so the
 * downloaded ZIP is consistent with what the feed would publish.
 * Marketplace-specific images override platform-wide ones per slot.
 *
 * The ZIP is returned as a Buffer — the route handler streams it directly.
 */

import JSZip from 'jszip'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { resolveAmazonImages } from './amazon-image-feed.service.js'

export interface AmazonZipInput {
  productId: string
  marketplace: string   // IT | DE | FR | ES | UK
  variantIds?: string[] // undefined = all variants
}

export interface AmazonZipOutput {
  buffer: Buffer
  filename: string    // suggested Content-Disposition filename
  fileCount: number
  skippedNoAsin: string[]
}

export async function generateAmazonZip(
  input: AmazonZipInput,
): Promise<AmazonZipOutput> {
  const { productId, marketplace, variantIds } = input
  const mkt = marketplace.toUpperCase()

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { sku: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)

  const resolved = await resolveAmazonImages(productId, mkt, variantIds)

  const zip = new JSZip()
  const skippedNoAsin: string[] = []
  let fileCount = 0

  for (const variant of resolved) {
    if (!variant.amazonAsin) {
      skippedNoAsin.push(variant.sku)
      continue
    }
    for (const { slot, url } of variant.slots) {
      try {
        const imgRes = await fetch(url)
        if (!imgRes.ok) {
          logger.warn('[amazon-zip] could not fetch image', { url, status: imgRes.status })
          continue
        }
        const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg'
        const ext = mimeToExt(contentType)
        const filename = `${variant.amazonAsin}.${slot}.${ext}`
        const buffer = Buffer.from(await imgRes.arrayBuffer())
        zip.file(filename, buffer)
        fileCount++
      } catch (err) {
        logger.warn('[amazon-zip] failed to add image', { url, slot, err })
      }
    }
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const date = new Date().toISOString().slice(0, 10)
  const filename = `amazon-${mkt.toLowerCase()}-${product.sku}-${date}.zip`

  return { buffer, filename, fileCount, skippedNoAsin }
}

function mimeToExt(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('tiff')) return 'tif'
  return 'jpg'
}
