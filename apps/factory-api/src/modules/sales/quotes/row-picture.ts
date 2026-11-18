import type { Actor } from '@nexus/factory-domain/core/permissions'
import { hasSmallPreview } from '../../../platform/files/thumbs/small'
import { mainPictureThumbnails } from '../../product/images/main-picture'
import type { Reader } from './store'

/**
 * TH-6 part B (the quote list's Picture, a follow-up of B-TH-257; feature O-SAL-QUO-LIST.grid-F01, as the Orders sheet's B-TH-017 /
 * B-TH-063 and Incoming's B-TH-216): what a Sales › Quotes row carries beside the quote, read for one page of rows, one query per kind.
 *
 *   picture     the current version's first line's style: that style's main picture (modules/product/images/main-picture.ts), its
 *               file only with files.read over the file's company (no right: the style's code and name, no file — the cell shows its
 *               placeholder); `small` says its ~320 px preview exists, which POST /sales/quotes/pictures serves (B-SA-011): the list
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
