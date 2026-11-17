import { NotFoundError } from '@nexus/factory-domain/core/errors'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { processFiles } from '../../../platform/files/service'
import { hasSmallPreview, smallPreviewAddress } from '../../../platform/files/thumbs/small'
import { mainPictureThumbnails } from '../../product/images/main-picture'
import { officeContextOf, officeQuote, readCurrentVersion, type Reader } from './store'

/**
 * TH-6 part B (the quote list's Picture, a follow-up of B-TH-257; feature O-SAL-QUO-LIST.grid-F01, as the Orders sheet's B-TH-017 /
 * B-TH-063 and Incoming's B-TH-216): what a Sales › Quotes row carries beside the quote, read for one page of rows, one query per kind.
 *
 *   picture     the current version's first line's style: that style's main picture (modules/product/images/main-picture.ts), its
 *               file only with files.read over the file's company (no right: the style's code and name, no file — the cell shows its
 *               placeholder); `small` says its ~320 px preview exists, which GET /sales/quotes/:quoteId/picture serves: the list
 *               never loads the original. No line yet: null.
 *   styleCount  the distinct styles of the current version ("+2" beside the picture).
 */

export interface QuoteRowPicture {
  readonly styleId: string
  readonly styleCode: string
  readonly styleName: string
  readonly fileId: string | null
  readonly contentType: string | null
  readonly small: boolean
}

export interface QuoteRowExtras {
  readonly picture: QuoteRowPicture | null
  readonly styleCount: number
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

/** The extras of each quote of the page, by quote id, from its current version's id. */
export async function quoteRowExtras(db: Reader, actor: Actor, versions: ReadonlyMap<string, string>): Promise<Map<string, QuoteRowExtras>> {
  const out = new Map<string, QuoteRowExtras>()
  if (versions.size === 0) return out
  const lines = await db.quoteLine.findMany({ where: { versionId: { in: [...versions.values()] } }, select: { versionId: true, seq: true, styleId: true }, orderBy: [{ versionId: 'asc' }, { seq: 'asc' }] })
  const linesOf = new Map<string, { seq: number; styleId: string }[]>()
  for (const line of lines) {
    const list = linesOf.get(line.versionId)
    if (list) list.push(line)
    else linesOf.set(line.versionId, [line])
  }
  const firstStyle = new Map<string, string>()
  for (const [quoteId, versionId] of versions) {
    const first = linesOf.get(versionId)?.[0]?.styleId
    if (first) firstStyle.set(quoteId, first)
  }
  const styleIds = unique([...firstStyle.values()])
  const styles = styleIds.length > 0 ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } }) : []
  const styleOf = new Map(styles.map((style) => [style.id, style]))
  const thumbnails = await mainPictureThumbnails(db, actor, styleIds)
  const fileIds = unique([...thumbnails.values()].map((thumbnail) => thumbnail.fileId))
  const prepared = new Map(fileIds.length > 0 ? (await db.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, contentType: true, thumbnailKey: true } })).map((file) => [file.id, hasSmallPreview(file)]) : [])
  for (const [quoteId, versionId] of versions) {
    const styleId = firstStyle.get(quoteId)
    const style = styleId ? styleOf.get(styleId) : undefined
    const thumbnail = styleId ? thumbnails.get(styleId) : undefined
    out.set(quoteId, {
      picture: style ? { styleId: style.id, styleCode: style.code, styleName: style.name, fileId: thumbnail?.fileId ?? null, contentType: thumbnail?.contentType ?? null, small: thumbnail ? prepared.get(thumbnail.fileId) === true : false } : null,
      styleCount: unique((linesOf.get(versionId) ?? []).map((line) => line.styleId)).length,
    })
  }
  return out
}

/**
 * GET /sales/quotes/:quoteId/picture: a presigned GET (60 seconds) of the SMALL preview (~320 px) of the main picture of the style
 * the current version's first line names — the picture its row names — never the original. The quote as the list shows it
 * (quotes.view over its company and customer, else 404), the file with files.read over its company (else 404: the row names no file
 * then). `small` is null while the preview does not exist yet (the cell shows its placeholder).
 */
export async function quotePicture(caller: CommandCaller, quoteId: string) {
  const quote = await officeQuote(caller, quoteId)
  const actor = actorOf(officeContextOf(caller))
  const found = await caller.withClient(async (db) => {
    const version = await readCurrentVersion(db, quote)
    const first = await db.quoteLine.findFirst({ where: { versionId: version.id }, orderBy: { seq: 'asc' }, select: { styleId: true } })
    const thumbnail = first ? (await mainPictureThumbnails(db, actor, [first.styleId])).get(first.styleId) : undefined
    const file = thumbnail ? await db.storedFile.findUnique({ where: { id: thumbnail.fileId }, select: { id: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true } }) : null
    return first && file ? { styleId: first.styleId, file } : null
  })
  if (!found) throw new NotFoundError('This quote has no picture to show.')
  const { styleId, file } = found
  // The store is called outside the read (the gateway writes its own ledger row).
  const small = hasSmallPreview(file) ? await smallPreviewAddress(processFiles(), caller, { storeAccountId: file.storeAccountId, thumbnailKey: file.thumbnailKey!, contentType: file.contentType, originalName: file.originalName }) : null
  return { picture: { fileId: file.id, styleId, contentType: file.contentType, small } }
}
