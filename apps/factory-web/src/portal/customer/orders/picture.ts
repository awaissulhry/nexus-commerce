import type { OrderFilesRead } from '../../../lib/record-thread/files-view/model'
import type { DraftRecord } from '../../../lib/order-draft/schema'
import type { PictureChoice } from '../../../lib/record-picture/order-picture'

/**
 * owb-po5.1 / owb-po6.4 (design § 5zi E: "only a file the customer can open can be the picture: never an office-only file, never a priced
 * file, never a size sheet") — the files of an order or a request that may become its picture, for "The picture of the order" and
 * the Files tab's "Use as the picture". Pure. The portal's reads hold only files the customer may open (an office-only file never
 * reaches them); here: an image (PNG, JPEG, WebP) or a PDF, never a size sheet (MEASUREMENTS), never a fiscal paper.
 */

const PICTURE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
const NEVER_CATEGORIES: ReadonlySet<string> = new Set(['MEASUREMENTS', 'FISCAL_ARCHIVE'])

/** May this file be the order's picture? */
export function mayBePicture(file: { readonly contentType: string; readonly category?: string | null; readonly kind?: string | null }): boolean {
  if (!PICTURE_TYPES.has(file.contentType)) return false
  if (file.category && NEVER_CATEGORIES.has(file.category)) return false
  // A size file of a request (its kind SHEET), whatever its type.
  return file.kind !== 'SHEET' && file.kind !== 'MEASUREMENTS'
}

const choiceOf = (file: { readonly id: string; readonly name: string; readonly contentType: string }): PictureChoice => ({
  fileId: file.id,
  name: file.name,
  kind: file.contentType === 'application/pdf' ? 'pdf' : 'image',
  small: null,
})

/** An order's files that may be its picture (the portal's files read, every group), each once. */
export function pictureChoicesOf(read: Pick<OrderFilesRead, 'groups'> | null): PictureChoice[] {
  if (!read) return []
  const seen = new Set<string>()
  return read.groups.flatMap((group) => group.files).filter((file) => mayBePicture(file) && !seen.has(file.id) && Boolean(seen.add(file.id))).map(choiceOf)
}

/** A request's files that may be its picture: its mockups and its other files (never its size sheets), each with a name. */
export function pictureChoicesOfDraft(record: DraftRecord): PictureChoice[] {
  const files = record.request.files
  if (!files) return []
  return [...files.logos, ...files.references]
    .filter((file) => file.originalName !== null && mayBePicture({ contentType: file.contentType, kind: file.kind }))
    .map((file) => choiceOf({ id: file.id, name: file.originalName ?? '', contentType: file.contentType }))
}
