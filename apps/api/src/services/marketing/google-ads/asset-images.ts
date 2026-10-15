/**
 * Google Ads changes (2026-10-15, programme 2 group G6) — an image for a Google Ads image asset: from an https link, or
 * from this business's Nexus image library (`da_…` a library file, `pi_…` a product photo, as image-library names them).
 * The bytes go to Google inside the change (ImageAsset.data, "the raw bytes data of an image … mutate only": base64 in
 * Google's JSON), so the change is built on the image as it is now; the run fetches it again and sends it only when its
 * bytes are exactly what was approved (the change's plan holds them).
 *
 * Fetched only through the one public-address fetch (images/photo-from-url.service.ts fetchPhoto → net/safe-fetch.ts):
 * https only (every redirect too), public internet addresses only, bounded time and bytes, the declared type AND the
 * file's own first bytes must be a picture. Then Google's own rules (checked 2026-10-15): JPEG, PNG or GIF ("The supported
 * file types for images are GIF, JPG, and PNG", developers.google.com/google-ads/api/performance-max/asset-requirements;
 * WebP is refused), at most 5120 KB. Width and height are read from the file (sharp); the ratio and size rules of the
 * place it goes (field type) are change-assets-all.ts's.
 *
 * Reads the web and this business's library rows; writes nothing.
 */
import sharp from 'sharp'
import prisma from '../../../db.js'
import { fetchPhoto, PhotoUrlError } from '../../images/photo-from-url.service.js'

/** "Max file size 5120 KB" (Google's asset requirements). */
export const GOOGLE_IMAGE_MAX_BYTES = 5120 * 1024
export const GOOGLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif'] as const
export type GoogleImageType = typeof GOOGLE_IMAGE_TYPES[number]

/** An image ready to send: its bytes (base64), what it is, and where it came from (never the bytes in a record). */
export interface PreparedImage {
  /** The https link it was read from, or the library id. */
  source: string
  /** A name for the asset when none is given: the library label, or the file name of the link. */
  label: string | null
  mimeType: GoogleImageType
  bytes: number
  width: number
  height: number
  sha256: string
  /** The bytes, base64 (Google's JSON for a bytes field). */
  data: string
}

export interface ImageSource { imageUrl?: string | null; libraryImageId?: string | null }

/** The link of a library image of THIS business (row-level security keeps other businesses' rows out), or why not. */
export async function libraryImageLink(id: string): Promise<{ url: string; label: string | null } | { problem: string }> {
  const ref = id.trim()
  if (ref.startsWith('da_')) {
    const row = await prisma.digitalAsset.findFirst({ where: { id: ref.slice(3), type: 'image' }, select: { url: true, label: true } })
    return row ? { url: row.url, label: row.label || null } : { problem: `library image ${ref} is not an image of this business's image library (image-library lists them)` }
  }
  if (ref.startsWith('pi_')) {
    const row = await prisma.productImage.findFirst({ where: { id: ref.slice(3), product: { deletedAt: null } }, select: { url: true, alt: true } })
    return row ? { url: row.url, label: row.alt || null } : { problem: `library image ${ref} is not a photo of a product of this business (image-library lists them)` }
  }
  return { problem: `library image "${ref}" is not an image-library id (da_… or pi_…)` }
}

const fileNameOf = (link: string): string | null => {
  try {
    const last = new URL(link).pathname.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(last).replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 80) || null
  } catch { return null }
}

/** Fetch and inspect one image, or say why it cannot be a Google Ads image (nothing was sent to Google). */
export async function prepareImage(source: ImageSource): Promise<PreparedImage | { problem: string }> {
  const url = source.imageUrl?.trim() || null
  const libraryId = source.libraryImageId?.trim() || null
  if (!!url === !!libraryId) return { problem: 'give imageUrl or libraryImageId (one of them)' }
  let link = url!
  let label: string | null = null
  if (libraryId) {
    const found = await libraryImageLink(libraryId)
    if ('problem' in found) return found
    link = found.url
    label = found.label
  }
  let fetched: Awaited<ReturnType<typeof fetchPhoto>>
  try {
    // Google's cap is the fetch's own: a file over 5120 KB stops at 5120 KB, nothing more is read.
    fetched = await fetchPhoto(link, GOOGLE_IMAGE_MAX_BYTES)
  } catch (err) {
    if (err instanceof PhotoUrlError) return { problem: `${libraryId ?? 'the link'}: ${err.message.replace(/\.$/, '')}` }
    throw err
  }
  const where = libraryId ?? fetched.url
  if (!(GOOGLE_IMAGE_TYPES as readonly string[]).includes(fetched.mimeType)) {
    return { problem: `${where} is ${fetched.mimeType}: Google takes JPG, PNG or GIF images` }
  }
  if (fetched.bytes > GOOGLE_IMAGE_MAX_BYTES) {
    return { problem: `${where} is ${Math.ceil(fetched.bytes / 1024)} KB: Google takes at most 5120 KB` }
  }
  let width = 0
  let height = 0
  try {
    const meta = await sharp(fetched.buffer).metadata()
    width = meta.width ?? 0
    height = meta.pageHeight ?? meta.height ?? 0
  } catch { /* not readable: said below */ }
  if (!width || !height) return { problem: `${where}: Nexus could not read the image's width and height` }
  return {
    source: libraryId ?? fetched.url,
    label: label ?? fileNameOf(fetched.url),
    mimeType: fetched.mimeType as GoogleImageType,
    bytes: fetched.bytes,
    width,
    height,
    sha256: fetched.contentHash,
    data: fetched.buffer.toString('base64'),
  }
}
