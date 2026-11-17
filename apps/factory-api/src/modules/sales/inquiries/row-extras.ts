import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { processFiles } from '../../../platform/files/service'
import { hasSmallPreview, smallPreviewAddress } from '../../../platform/files/thumbs/small'
import { mainPictureThumbnails } from '../../product/images/main-picture'
import { officeInquiry, type InquiryData, type LineData, type Reader } from './store'

/**
 * B-TH-216 (threads plan TH-1b, Sales › Incoming; features O-SAL-INQ-LIST.list-F01, -F02): what an Incoming row carries beside
 * the request, read for one page of rows, one query per kind, each part only for a reader who may see it.
 *
 *   picture     the first line that names a style: that style's main picture (modules/product/images/main-picture.ts), its
 *               file only with files.read over the file's company (as the Orders sheet's, B-TH-017); `small` says its ~320 px
 *               preview exists, which GET /sales/inquiries/:inquiryId/picture serves: the list never loads the original. No
 *               style named: null (the cell shows the kind of files with their count). `styleCount`: the distinct styles.
 *   files       the request's own files and its mail's kept attachments (not deleted), as photos and documents — counts only,
 *               no names — for a reader with files.read over the request's company; null without it ("—").
 */

export interface RowPicture {
  readonly styleId: string
  readonly styleCode: string
  readonly styleName: string
  readonly fileId: string | null
  readonly contentType: string | null
  readonly small: boolean
}

export interface InquiryRowExtras {
  readonly picture: RowPicture | null
  readonly styleCount: number
  readonly files: { readonly photos: number; readonly documents: number } | null
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]
const isPhoto = (contentType: string): boolean => contentType.toLowerCase().startsWith('image/')

/** The extras of a page of rows (their lines already read by the list). */
export async function inquiryRowExtras(db: Reader, context: OfficeContext, rows: readonly Pick<InquiryData, 'id' | 'companyId' | 'sourceEmailId'>[], linesOf: ReadonlyMap<string, readonly Pick<LineData, 'styleId'>[]>): Promise<Map<string, InquiryRowExtras>> {
  const out = new Map<string, InquiryRowExtras>()
  if (rows.length === 0) return out
  const actor = actorOf(context)

  // ---- the picture: the first line that names a style ----------------------------------------------------------------------
  const firstStyle = new Map<string, string>()
  for (const row of rows) {
    const first = (linesOf.get(row.id) ?? []).find((line) => line.styleId !== null)?.styleId
    if (first) firstStyle.set(row.id, first)
  }
  const styleIds = unique([...firstStyle.values()])
  const styles = styleIds.length > 0 ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } }) : []
  const styleOf = new Map(styles.map((style) => [style.id, style]))
  const thumbnails = await mainPictureThumbnails(db, actor, styleIds)
  const fileIds = unique([...thumbnails.values()].map((thumbnail) => thumbnail.fileId))
  const prepared = new Map(fileIds.length > 0 ? (await db.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, contentType: true, thumbnailKey: true } })).map((file) => [file.id, hasSmallPreview(file)]) : [])

  // ---- the files: the request's and its mail's, counted by kind ------------------------------------------------------------
  const readable = rows.filter((row) => can(actor, FILES_READ, { companyId: row.companyId }))
  const mailOf = new Map(readable.flatMap((row) => (row.sourceEmailId ? [[row.sourceEmailId, row.id] as const] : [])))
  const stored =
    readable.length > 0
      ? await db.storedFile.findMany({
          where: {
            status: { not: 'DELETED' },
            OR: [{ recordType: 'Inquiry', recordId: { in: readable.map((row) => row.id) } }, ...(mailOf.size > 0 ? [{ recordType: 'InboundEmail', recordId: { in: [...mailOf.keys()] } }] : [])],
          },
          select: { recordType: true, recordId: true, contentType: true },
        })
      : []
  const counts = new Map(readable.map((row) => [row.id, { photos: 0, documents: 0 }]))
  for (const file of stored) {
    const inquiryId = file.recordType === 'Inquiry' ? file.recordId : mailOf.get(file.recordId)
    const count = inquiryId ? counts.get(inquiryId) : undefined
    if (!count) continue
    if (isPhoto(file.contentType)) count.photos += 1
    else count.documents += 1
  }

  for (const row of rows) {
    const styleId = firstStyle.get(row.id)
    const style = styleId ? styleOf.get(styleId) : undefined
    const thumbnail = styleId ? thumbnails.get(styleId) : undefined
    out.set(row.id, {
      picture: style ? { styleId: style.id, styleCode: style.code, styleName: style.name, fileId: thumbnail?.fileId ?? null, contentType: thumbnail?.contentType ?? null, small: thumbnail ? prepared.get(thumbnail.fileId) === true : false } : null,
      styleCount: unique((linesOf.get(row.id) ?? []).flatMap((line) => (line.styleId ? [line.styleId] : []))).length,
      files: counts.get(row.id) ?? null,
    })
  }
  return out
}

/**
 * GET /sales/inquiries/:inquiryId/picture (B-TH-216 with B-TH-063; O-SAL-INQ-LIST.list-F02): a presigned GET (60 seconds) of the
 * SMALL preview (~320 px) of the main picture of the style the request's first style line names — the picture its row names —
 * never the original. The request as the list shows it (sales.inquiries.view over its company and customer, else 404), the file
 * with files.read over its company (else 404: the row names no file then). `small` is null while the preview does not exist yet.
 */
export async function inquiryPicture(caller: CommandCaller, inquiryId: string) {
  const { context } = await officeInquiry(caller, inquiryId)
  const found = await caller.withClient(async (db) => {
    const first = await db.inquiryLine.findFirst({ where: { inquiryId, styleId: { not: null } }, orderBy: { seq: 'asc' }, select: { styleId: true } })
    const styleId = first?.styleId ?? null
    const thumbnail = styleId ? (await mainPictureThumbnails(db, actorOf(context), [styleId])).get(styleId) : undefined
    const file = thumbnail ? await db.storedFile.findUnique({ where: { id: thumbnail.fileId }, select: { id: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true } }) : null
    return styleId && file ? { styleId, file } : null
  })
  if (!found) throw new NotFoundError('This request has no picture to show.')
  const { styleId, file } = found
  // The store is called outside the read (the gateway writes its own ledger row).
  const small = hasSmallPreview(file) ? await smallPreviewAddress(processFiles(), caller, { storeAccountId: file.storeAccountId, thumbnailKey: file.thumbnailKey!, contentType: file.contentType, originalName: file.originalName }) : null
  return { picture: { fileId: file.id, styleId, contentType: file.contentType, small } }
}
