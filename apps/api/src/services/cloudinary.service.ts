/**
 * Constraint #4 — Minimal Cloudinary upload helper.
 *
 * Used today for BrandSettings.logoUrl; reusable for any future image
 * upload path. Configured via three env vars (CLOUDINARY_CLOUD_NAME,
 * CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET — already present in .env).
 *
 * Constraints:
 *   - Buffers only (caller decodes multipart upload before calling).
 *   - One folder per resource type (e.g. 'brand-logos') for tidy
 *     dashboard organization.
 *   - Failure throws; caller wraps in try/catch and surfaces user-
 *     friendly errors.
 *
 * isConfigured() lets callers (e.g. settings page) detect missing env
 * vars and offer a manual-URL fallback rather than failing opaquely.
 */

import { v2 as cloudinary } from 'cloudinary'

let configured = false
function ensureConfigured(): void {
  if (configured) return
  const name = process.env.CLOUDINARY_CLOUD_NAME
  const key = process.env.CLOUDINARY_API_KEY
  const secret = process.env.CLOUDINARY_API_SECRET
  if (!name || !key || !secret) {
    throw new Error(
      'Cloudinary not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.',
    )
  }
  cloudinary.config({
    cloud_name: name,
    api_key: key,
    api_secret: secret,
    secure: true,
  })
  configured = true
}

export function isCloudinaryConfigured(): boolean {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  )
}

export interface CloudinaryUploadResult {
  url: string
  publicId: string
  width: number
  height: number
  format: string
  bytes: number
  /// MC.7 — set on video uploads (resource_type=video). Seconds.
  durationSeconds?: number
  /// MC.7 — Cloudinary's resource_type ('image' | 'video' | 'raw').
  resourceType?: string
  /// IE.1 — 16-char hex perceptual hash (64-bit). Returned only when
  /// the caller sets `phash: true` and the asset is an image. Used by
  /// the upload-dedup gate to detect near-duplicates (Hamming ≤ 6).
  perceptualHash?: string
}

/**
 * Upload a Buffer to Cloudinary and return the secure URL + metadata.
 * `folder` keeps assets tidy — e.g. 'brand-logos' for letterhead.
 *
 * Cloudinary's SDK exposes upload_stream for buffer uploads; wrap it
 * in a Promise so callers stay async/await-friendly.
 */
export function uploadBufferToCloudinary(
  buffer: Buffer,
  options: {
    folder: string
    /** Optional public ID; otherwise Cloudinary generates one. Useful
     *  for "stable URL" cases like a brand logo where you want re-uploads
     *  to overwrite the same asset. */
    publicId?: string
    /** MC.7 — when 'video', Cloudinary handles MP4/MOV/WebM uploads
     *  and exposes duration. Defaults to 'image' so existing callers
     *  are unaffected. */
    resourceType?: 'image' | 'video' | 'raw'
    /** IE.1 — ask Cloudinary to compute a perceptual hash for the
     *  uploaded image and return it as `phash` on the result. Adds
     *  a small server-side compute step on Cloudinary's side; only
     *  set this on paths that consume the hash (currently product
     *  image upload for the dedup gate). */
    phash?: boolean
  },
): Promise<CloudinaryUploadResult> {
  ensureConfigured()
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder,
        public_id: options.publicId,
        overwrite: true,
        resource_type: options.resourceType ?? 'image',
        phash: options.phash === true ? true : undefined,
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error('Cloudinary upload returned no result'))
          return
        }
        const phash = (result as unknown as { phash?: string }).phash
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: result.bytes,
          durationSeconds:
            typeof (result as unknown as { duration?: number }).duration ===
            'number'
              ? (result as unknown as { duration: number }).duration
              : undefined,
          resourceType: result.resource_type,
          perceptualHash: typeof phash === 'string' && phash.length > 0 ? phash : undefined,
        })
      },
    )
    stream.end(buffer)
  })
}

/**
 * Delete an asset from Cloudinary by its public_id.
 * Returns true when the asset was found and deleted; false when it
 * was already gone (result.result === 'not found'). Throws on network
 * or auth errors so callers can decide whether to surface them.
 */
/**
 * IR.4.2 — Build a Cloudinary transformation URL from an existing
 * publicId without re-uploading. Lets the editor commit crop / rotate /
 * flip operations as a new derived ProductImage whose `url` is just a
 * fresh signed URL pointing at the same source bytes with a transform
 * chain applied.
 *
 * Transformation order matters: crop → rotate → flips. Cloudinary
 * applies transformations left-to-right, so a crop after rotation
 * would crop in the rotated coordinate space — usually not what the
 * operator drew on screen.
 */
export interface DeriveTransforms {
  crop?: { x: number; y: number; width: number; height: number }
  rotate?: number   // degrees; multiples of 90 recommended
  flipH?: boolean
  flipV?: boolean
}

/**
 * IR.6.4 — Marketplace auto-enhance presets.
 *
 * Each preset is a Cloudinary transformation chain that takes a
 * source product photo and produces a derivative tuned for the
 * channel's requirements:
 *
 *   AMAZON_MAIN: background-removal + white pad + 1500×1500 square,
 *                quality auto:best. Result is Amazon-MAIN-ready when
 *                the source had a recognizable subject.
 *
 *   EBAY_MAIN: white pad + 1500×1500 square. No background removal —
 *              eBay accepts lifestyle/colored backgrounds.
 *
 *   SHOPIFY_PORTRAIT: 4:5 aspect at 1600×2000, fit + white pad.
 *                     Matches Dawn theme defaults.
 *
 * The background-removal step requires Cloudinary's "AI Background
 * Removal" add-on. Without it, e_background_removal still resolves
 * but returns the original image — call sites can detect by
 * comparing dimensions or by an explicit feature flag.
 */
export type AutoEnhancePreset = 'AMAZON_MAIN' | 'EBAY_MAIN' | 'SHOPIFY_PORTRAIT'

export function buildAutoEnhanceUrl(publicId: string, preset: AutoEnhancePreset): {
  url: string
  width: number
  height: number
} {
  ensureConfigured()
  let transformation: Array<Record<string, string | number>>
  let width: number
  let height: number

  switch (preset) {
    case 'AMAZON_MAIN':
      width = 1500
      height = 1500
      transformation = [
        { effect: 'background_removal' },
        { background: 'white', crop: 'pad', width, height, gravity: 'center' },
        { quality: 'auto:best', fetch_format: 'auto' },
      ]
      break
    case 'EBAY_MAIN':
      width = 1500
      height = 1500
      transformation = [
        { background: 'white', crop: 'pad', width, height, gravity: 'center' },
        { quality: 'auto:best', fetch_format: 'auto' },
      ]
      break
    case 'SHOPIFY_PORTRAIT':
      width = 1600
      height = 2000
      transformation = [
        { background: 'white', crop: 'pad', width, height, gravity: 'center' },
        { quality: 'auto:best', fetch_format: 'auto' },
      ]
      break
  }

  return {
    url: cloudinary.url(publicId, { secure: true, transformation }),
    width,
    height,
  }
}

export function buildDerivedUrl(publicId: string, transforms: DeriveTransforms): string {
  ensureConfigured()
  const chain: Array<Record<string, string | number>> = []
  if (transforms.crop) {
    const { x, y, width, height } = transforms.crop
    chain.push({
      crop: 'crop',
      width: Math.round(width),
      height: Math.round(height),
      x: Math.round(x),
      y: Math.round(y),
    })
  }
  if (transforms.rotate && transforms.rotate !== 0) {
    chain.push({ angle: Math.round(transforms.rotate) })
  }
  if (transforms.flipH) {
    chain.push({ angle: 'hflip' })
  }
  if (transforms.flipV) {
    chain.push({ angle: 'vflip' })
  }
  return cloudinary.url(publicId, {
    secure: true,
    transformation: chain,
  })
}

export async function deleteFromCloudinary(
  publicId: string,
  resourceType: 'image' | 'video' | 'raw' = 'image',
): Promise<boolean> {
  ensureConfigured()
  const result = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType })
  return result.result === 'ok'
}
