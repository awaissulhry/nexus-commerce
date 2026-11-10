import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { isPictureType } from '@nexus/factory-domain/product/images/rules'
import type { StyleRow as ListRow } from '@nexus/factory-domain/product/styles/contracts'
import type { Client } from './store'

/**
 * A style's main picture (B-W2b-236; SY3:02, SY3:03): the StyleImage marked main (one per style, B-W2b-206's partial unique
 * index), when its file is AVAILABLE and a picture a browser shows (JPEG, PNG, WebP). The styles list's thumbnail
 * (modules/product/styles/row-extras.ts), the gallery's card and the public DoC page's picture all read it; a style without
 * a main picture shows none (no longer its oldest image file, B-W2b-25's stand-in).
 */

export interface MainPicture {
  readonly styleId: string
  readonly pictureId: string
  readonly kind: 'SKETCH' | 'PHOTO' | 'PAGE'
  readonly caption: string | null
  readonly fileId: string
  readonly name: string
  readonly contentType: string
  readonly companyId: string | null
}

/** The main picture of each style that has one that can be shown. */
export async function mainPictures(client: Client, styleIds: readonly string[]): Promise<Map<string, MainPicture>> {
  const out = new Map<string, MainPicture>()
  if (styleIds.length === 0) return out
  const marked = await client.styleImage.findMany({ where: { styleId: { in: [...new Set(styleIds)] }, isMain: true }, select: { id: true, styleId: true, kind: true, caption: true, fileId: true } })
  if (marked.length === 0) return out
  const files = await client.storedFile.findMany({ where: { id: { in: marked.map((row) => row.fileId) }, status: 'AVAILABLE' }, select: { id: true, originalName: true, contentType: true, companyId: true } })
  const byId = new Map(files.map((file) => [file.id, file]))
  for (const row of marked) {
    const file = byId.get(row.fileId)
    if (!file || !isPictureType(file.contentType)) continue
    out.set(row.styleId, { styleId: row.styleId, pictureId: row.id, kind: row.kind, caption: row.caption, fileId: file.id, name: file.originalName, contentType: file.contentType, companyId: file.companyId })
  }
  return out
}

/**
 * The styles list's thumbnail (SY3:02): the main picture's file, for a caller holding files.read over the file's company
 * (B-W2b-25's rule for the row's `thumbnail`: the row names a file the caller may open with GET /files/:fileId/download).
 */
export async function mainPictureThumbnails(client: Client, actor: Actor, styleIds: readonly string[]): Promise<Map<string, NonNullable<ListRow['thumbnail']>>> {
  const out = new Map<string, NonNullable<ListRow['thumbnail']>>()
  if (styleIds.length === 0 || !holds(actor, FILES_READ)) return out
  const mains = await mainPictures(client, styleIds)
  if (mains.size === 0) return out
  const visible = await client.storedFile.findMany({
    where: { AND: [scopeWhere(actor, FILES_READ, { company: { field: 'companyId', nullable: true } }) as object, { id: { in: [...mains.values()].map((main) => main.fileId) } }] },
    select: { id: true },
  })
  const seen = new Set(visible.map((row) => row.id))
  for (const main of mains.values()) if (seen.has(main.fileId)) out.set(main.styleId, { fileId: main.fileId, name: main.name, contentType: main.contentType })
  return out
}
