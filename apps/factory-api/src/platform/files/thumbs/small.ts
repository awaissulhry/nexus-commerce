import { createHash } from 'node:crypto'
import { dispositionOf, PREVIEW_URL_SECONDS } from '@nexus/factory-domain/files/preview/rules'
import { isStrippable } from '@nexus/factory-domain/files/thumbs/strip'
import type { CommandCaller } from '../../../core/command'
import { presignedView, storeCall } from '../files'
import type { FilesRuntime } from '../service'
import { decodeJpeg } from './codec/jpeg-decode'
import { encodeJpeg } from './codec/jpeg-encode'
import { CodecError, orient, shrink } from './codec/picture'
import { decodePng, encodePng } from './codec/png'

/**
 * The small preview of a picture (B-TH-063; threads plan TH-1a, gap G8): about 320 pixels on its longer side, made by
 * the job that makes the stripped copy (strip-copy.ts) from the stripped copy's pixels, so it holds no EXIF and no
 * position either, turned the right way up (the EXIF orientation applied to the pixels). The Picture column of Sales ›
 * Orders reads it, never the original (GET /sales/orders/:orderId/picture); lists and portal cards can read it the same
 * way. A placeholder shows until it exists.
 *
 *   key       derived from the stripped copy's key (one small preview per file, made once with it): the same prefix and a
 *             UUID from a hash of the copy's random part, so it is a key the store accepts (files/keys isStorageKey) and,
 *             like every key, nothing a caller knows (a file id) leads to it. No column records it: the stripped copy's
 *             key is written only after both objects are in the store, so a file with `thumbnailKey` has its preview.
 *   pixels    JPEG and PNG are decoded here (codec/: no image library in the factory API), reduced and written in their
 *             own format (a PNG keeps its transparency). A picture the codec does not read (a WebP, an unusual JPEG, a
 *             damaged one) is kept as its stripped copy under the same key: the cell still shows the right picture, only
 *             heavier. Pictures already this small are copied too.
 */

/** The small preview's longer side, in pixels. */
export const SMALL_EDGE = 320
/** The JPEG quality of a small preview. */
const SMALL_QUALITY = 82

/** The small preview's key: the stripped copy's prefix and a UUID derived from the copy's random part. */
export function smallKeyOf(thumbnailKey: string): string {
  const slash = thumbnailKey.lastIndexOf('/')
  const hex = createHash('sha256').update(`small-preview:${SMALL_EDGE}:${thumbnailKey.slice(slash + 1)}`).digest('hex')
  // A version-4 shaped UUID (the variant and version nibbles set), so it reads like every other key's random part.
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  return `${thumbnailKey.slice(0, slash + 1)}${uuid}`
}

/** The file has its small preview: a picture whose stripped copy was made (the preview is made with it). */
export const hasSmallPreview = (file: { readonly thumbnailKey: string | null; readonly contentType: string }): boolean => file.thumbnailKey !== null && isStrippable(file.contentType)

export interface SmallPreview {
  readonly bytes: Uint8Array
  /** RESIZED: decoded and reduced; COPIED: the stripped copy as it is (already small, or a picture the codec does not read). */
  readonly made: 'RESIZED' | 'COPIED'
  readonly width: number | null
  readonly height: number | null
  /** Why it was copied, when the codec could not read it. */
  readonly reason: string | null
}

const normalised = (contentType: string): string => contentType.split(';')[0]!.trim().toLowerCase()

/** The small preview of a stripped picture (pure; never throws: what it cannot read, it copies). */
export function makeSmallPreview(stripped: Uint8Array, contentType: string): SmallPreview {
  const copied = (reason: string | null, width: number | null = null, height: number | null = null): SmallPreview => ({ bytes: stripped, made: 'COPIED', width, height, reason })
  try {
    const type = normalised(contentType)
    if (type === 'image/jpeg') {
      const decoded = decodeJpeg(stripped, { minEdge: SMALL_EDGE })
      const upright = orient(decoded, decoded.orientation)
      // A picture already this small, the right way up: kept as it is (re-encoding would only lose quality).
      if (Math.max(upright.width, upright.height) <= SMALL_EDGE && decoded.orientation === 1) return copied(null, upright.width, upright.height)
      const small = shrink(upright, SMALL_EDGE)
      return { bytes: encodeJpeg(small, SMALL_QUALITY), made: 'RESIZED', width: small.width, height: small.height, reason: null }
    }
    if (type === 'image/png') {
      const decoded = decodePng(stripped)
      if (Math.max(decoded.width, decoded.height) <= SMALL_EDGE) return copied(null, decoded.width, decoded.height)
      const small = shrink(decoded, SMALL_EDGE)
      return { bytes: encodePng(small), made: 'RESIZED', width: small.width, height: small.height, reason: null }
    }
    return copied('This kind of picture is kept as its stripped copy.')
  } catch (error) {
    // A picture the codec cannot read never stops the copy job: it is kept as its stripped copy, with the reason.
    if (error instanceof CodecError) return copied(error.message)
    if (error instanceof RangeError) return copied('The picture is too large to reduce here.')
    return copied('The picture could not be read to make it smaller.')
  }
}

/**
 * A presigned GET of the file's small preview (60 seconds, inline), for a caller the route has already checked. The store
 * not answering is 503 in words (files.ts storeCall).
 */
export async function smallPreviewAddress(
  runtime: FilesRuntime,
  caller: CommandCaller,
  file: { readonly storeAccountId: string; readonly thumbnailKey: string; readonly contentType: string; readonly originalName: string },
) {
  const request = await storeCall(() =>
    runtime.storage.presignDownload(caller, file.storeAccountId, {
      key: smallKeyOf(file.thumbnailKey),
      contentType: file.contentType,
      disposition: dispositionOf('inline', file.originalName),
      expiresInSeconds: PREVIEW_URL_SECONDS,
      now: runtime.clock.now(),
    }),
  )
  return { ...presignedView(request), method: 'GET' as const }
}
