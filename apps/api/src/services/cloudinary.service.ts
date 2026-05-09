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
  },
): Promise<CloudinaryUploadResult> {
  ensureConfigured()
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder,
        public_id: options.publicId,
        overwrite: true,
        resource_type: 'image',
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error('Cloudinary upload returned no result'))
          return
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: result.bytes,
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
export async function deleteFromCloudinary(publicId: string): Promise<boolean> {
  ensureConfigured()
  const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' })
  return result.result === 'ok'
}
