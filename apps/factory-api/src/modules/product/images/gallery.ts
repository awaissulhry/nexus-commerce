import type { FastifyRequest } from 'fastify'
import { can } from '@nexus/factory-domain/core/permissions'
import type { GalleryLooksView } from '@nexus/factory-domain/product/images/contracts'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { actorOf } from '../../../core/context'
import { mainPictures } from './main-picture'
import { contextOf, lookOf } from './store'

/**
 * The styles list's Gallery view (B-W2b-236; design products.styles sec:styles.gallery "Card: main picture, code, name,
 * colourway swatches, status, revision"): for the styles on screen (the list's own rows: the same filters), each one's main
 * picture with its address (bytes.ts), how many pictures it has, and its active colourways with their library colour. A style
 * the caller may not see is left out (as an unknown id). Reads only.
 *
 *   POST /product/pictures/looks { styleIds ≤ 60 }   (product.styles.view over each style's company)
 */
export async function galleryLooks(request: FastifyRequest, styleIds: readonly string[]): Promise<GalleryLooksView> {
  const actor = actorOf(contextOf(request))
  const asked = [...new Set(styleIds)]
  const read = await request.withClient(async (client) => {
    const styles = (await client.style.findMany({ where: { id: { in: asked } }, select: { id: true, companyId: true } })).filter((style) => can(actor, PRODUCT_STYLES_VIEW, { companyId: style.companyId }))
    const ids = styles.map((style) => style.id)
    const mains = await mainPictures(client, ids)
    const counts = ids.length === 0 ? [] : await client.styleImage.groupBy({ by: ['styleId'], where: { styleId: { in: ids } }, _count: { _all: true } })
    const colourways = ids.length === 0 ? [] : await client.colourway.findMany({ where: { styleId: { in: ids }, status: 'ACTIVE' }, select: { styleId: true, code: true, name: true, colourId: true }, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] })
    const colourIds = [...new Set(colourways.flatMap((row) => (row.colourId ? [row.colourId] : [])))]
    const colours = colourIds.length === 0 ? [] : await client.colour.findMany({ where: { id: { in: colourIds } }, select: { id: true, hex: true } })
    return { styles, mains, counts: new Map(counts.map((row) => [row.styleId, row._count._all])), colourways, hex: new Map(colours.map((row) => [row.id, row.hex])) }
  })
  const companyOf = new Map(read.styles.map((style) => [style.id, style.companyId]))
  const looks: GalleryLooksView['looks'] = []
  for (const styleId of asked) {
    if (!companyOf.has(styleId)) continue
    const main = read.mains.get(styleId)
    looks.push({
      styleId,
      picture: main ? { id: main.pictureId, kind: main.kind, caption: main.caption, look: lookOf({ id: main.fileId, status: 'AVAILABLE', contentType: main.contentType }) } : null,
      pictures: read.counts.get(styleId) ?? 0,
      colourways: read.colourways.filter((row) => row.styleId === styleId).map((row) => ({ code: row.code, name: row.name, hex: row.colourId ? (read.hex.get(row.colourId) ?? null) : null })),
    })
  }
  return { looks, at: new Date().toISOString() }
}
