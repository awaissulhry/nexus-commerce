/**
 * AE.3c — a shared product's images arrive in the follower business (R-AE-14).
 *
 * Plan: docs/2026-09-16-assortment-engine-plan.md §16.1 and §12.2. Runs in the FOLLOWER's context,
 * from the copy run's finish step, one product at a time.
 *
 *   A stored file (the owner's Cloudinary or Shopify storage) is COPIED: downloaded, then uploaded
 *   through the follower's own image storage — its Shopify store when one is connected, otherwise
 *   Cloudinary — exactly as an image uploaded by hand in that business. Sharing the owner's file by
 *   reference is unsafe: the owner's delete counts references under its own row security and cannot
 *   see the follower's rows, so it would delete bytes the follower still shows.
 *
 *   An outside address (for example an Amazon image URL) is not in either business's storage, so no
 *   delete here can remove it. It is carried as the same address, and never downloaded: this process
 *   downloads only from the two storage hosts, so a crafted image address cannot make the server
 *   fetch an internal URL.
 *
 * Safe to run again. A file whose bytes the product already holds (same content hash) is reused, and
 * an address the product already shows is not added twice, so a retried finish copies only what is
 * missing. Placement never takes over what the follower already has: a copied MAIN becomes ALT when
 * the product already has a MAIN, and the hero flag is copied only when the product has none.
 * Videos, 3D models and documents are not copied in this phase; the review says so.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { isCloudinaryConfigured, uploadBufferToCloudinary } from '../cloudinary.service.js'
import { aHashBuffer, dHash256Buffer, sha256Buffer } from '../images/image-hash.service.js'
import { saveMediaFingerprint } from '../images/media-fingerprint.service.js'
import { productEventService } from '../product-event.service.js'
import { attachShopifyImage, defaultShopifyMediaAccount, uploadReadyShopifyAsset } from '../shopify/media-library.service.js'
import type { SourceImage } from './copy-source.service.js'

/** What the owner confirmed in Review 1, per image. Stored on the copy run's plan. */
export type PlannedImage = Pick<SourceImage, 'id' | 'url' | 'alt' | 'type' | 'isPrimary' | 'sortOrder' | 'width' | 'height' | 'mimeType' | 'fileSize'>

export interface MediaCopyResult { copied: number; reused: number; addressed: number; failed: string[] }

/** The storage hosts a stored file can come from. Nothing else is ever downloaded. */
const STORAGE_HOSTS = new Set(['res.cloudinary.com', 'cdn.shopify.com'])
/** The follower's Shopify storage refuses a larger image, so Cloudinary gets the same ceiling. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000
const EXTENSION_BY_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic' }

/** "file": copied into the follower's storage. "address": the same outside address. */
export function imageOrigin(url: string): 'file' | 'address' {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && STORAGE_HOSTS.has(parsed.hostname) ? 'file' : 'address'
  } catch {
    return 'address'
  }
}

export async function copyImages(productId: string, images: PlannedImage[]): Promise<MediaCopyResult> {
  const result: MediaCopyResult = { copied: 0, reused: 0, addressed: 0, failed: [] }
  if (images.length === 0) return result
  const present = await prisma.productImage.findMany({ where: { productId }, select: { type: true, isPrimary: true } })
  let hasMain = present.some((image) => image.type === 'MAIN')
  let hasPrimary = present.some((image) => image.isPrimary)

  for (const image of [...images].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const type = image.type === 'MAIN' && hasMain ? 'ALT' : image.type
    const primary = image.isPrimary && !hasPrimary
    try {
      const outcome = imageOrigin(image.url) === 'file'
        ? await copyFile(productId, image, type, primary)
        : await carryAddress(productId, image, type, primary)
      result[outcome]++
      if (outcome !== 'reused') {
        if (type === 'MAIN') hasMain = true
        if (primary) hasPrimary = true
      }
    } catch (error) {
      result.failed.push(`image ${image.sortOrder + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (result.copied + result.addressed > 0) {
    await productEventService.emit({ aggregateId: productId, aggregateType: 'Product', eventType: 'IMAGES_UPDATED', data: { source: 'assortment-copy' } })
  }
  return result
}

async function copyFile(productId: string, image: PlannedImage, type: string, primary: boolean): Promise<'copied' | 'reused'> {
  const { buffer, mimeType } = await download(image.url)
  const contentHash = sha256Buffer(buffer)
  if (await prisma.productImage.findFirst({ where: { productId, contentHash }, select: { id: true } })) return 'reused'
  const perceptualHash = await aHashBuffer(buffer).catch(() => null)
  const dhash256 = await dHash256Buffer(buffer).catch(() => null)

  // The follower's storage, chosen the way a hand upload chooses it. An unclear Shopify choice is a
  // refusal with its reason, never a silent switch to another provider.
  const shopifyAccount = await defaultShopifyMediaAccount()
  if (shopifyAccount) {
    const { asset } = await uploadReadyShopifyAsset(shopifyAccount, buffer, fileName(image.url, mimeType))
    const attached = await attachShopifyImage(productId, asset, type, image.alt)
    await saveMediaFingerprint(attached.image.id, { contentHash, perceptualHash, dhash256 })
    if (primary) await prisma.productImage.update({ where: { id: attached.image.id }, data: { isPrimary: true } })
    return attached.reused ? 'reused' : 'copied'
  }
  if (!isCloudinaryConfigured()) throw new Error('This business has no image storage. Connect a Shopify store or configure Cloudinary.')
  const uploaded = await uploadBufferToCloudinary(buffer, { folder: `product-images/${productId}` })
  try {
    await prisma.productImage.create({
      data: {
        productId, url: uploaded.url, publicId: uploaded.publicId, type, alt: image.alt, sortOrder: await nextSortOrder(productId),
        isPrimary: primary, width: uploaded.width, height: uploaded.height, fileSize: uploaded.bytes, mimeType,
        contentHash, perceptualHash, dhash256,
      },
    })
  } catch (error) {
    // Another finish saved the same bytes first. The uploaded file stays unreferenced, as for a hand upload.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'reused'
    throw error
  }
  return 'copied'
}

async function carryAddress(productId: string, image: PlannedImage, type: string, primary: boolean): Promise<'addressed' | 'reused'> {
  if (await prisma.productImage.findFirst({ where: { productId, url: image.url }, select: { id: true } })) return 'reused'
  await prisma.productImage.create({
    data: {
      productId, url: image.url, publicId: null, type, alt: image.alt, sortOrder: await nextSortOrder(productId), isPrimary: primary,
      width: image.width, height: image.height, mimeType: image.mimeType, fileSize: image.fileSize,
    },
  })
  return 'addressed'
}

async function nextSortOrder(productId: string) {
  const max = await prisma.productImage.aggregate({ where: { productId }, _max: { sortOrder: true } })
  return (max._max.sortOrder ?? -1) + 1
}

/** Only called for a storage host. No redirect is followed, and the body is read up to the ceiling. */
async function download(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (response.status === 404 || response.status === 410) throw new Error('the image no longer exists at its address')
  if (!response.ok || !response.body) throw new Error('the image could not be downloaded; try again later')
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!mimeType.startsWith('image/')) {
    await response.body.cancel()
    throw new Error('the address does not hold an image')
  }
  if (Number(response.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) {
    await response.body.cancel()
    throw new Error('the image is larger than 20 MB')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength
    if (size > MAX_IMAGE_BYTES) throw new Error('the image is larger than 20 MB')
    chunks.push(Buffer.from(chunk))
  }
  if (size === 0) throw new Error('the image file is empty')
  return { buffer: Buffer.concat(chunks), mimeType }
}

/** Shopify names a file by its extension; a storage URL may carry a transformation instead of one. */
function fileName(url: string, mimeType: string) {
  const last = new URL(url).pathname.split('/').pop() ?? ''
  let base = last
  try { base = decodeURIComponent(last) } catch { /* a malformed escape keeps the raw segment */ }
  base ||= 'image'
  const extension = EXTENSION_BY_MIME[mimeType] ?? 'jpg'
  return /\.[a-z0-9]+$/i.test(base) && base.toLowerCase().endsWith(`.${extension}`) ? base : `${base.replace(/\.[^.]+$/, '')}.${extension}`
}
