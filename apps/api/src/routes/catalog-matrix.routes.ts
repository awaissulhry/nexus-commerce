/**
 * PIM C.1 — Catalog matrix backend endpoint.
 *
 * Powers the new /catalog/matrix grid (10k-row virtualized view).
 * Returns flat list of master/standalone products with their variant
 * children embedded — the client expands rows in place without a
 * second roundtrip.
 *
 * Read-only first cut; C.3 adds inline cell edit via existing
 * /products/:id PATCH endpoints. Xavia today is ~279 SKUs so we
 * load all in one shot; pagination/streaming lands in C.2 when we
 * need to scale past ~5k.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

interface ChannelCoverage {
  channel: string
  marketplace: string
  status: string
}

interface MatrixVariant {
  id: string
  sku: string
  name: string | null
  basePrice: number | null
  totalStock: number
  status: string
  channelCoverage: ChannelCoverage[]
  /** C.4 — categoryAttributes JSONB so the column picker can expose
   *  any attribute key as its own column. Null when the row has no
   *  technical attributes set. */
  categoryAttributes: Record<string, unknown> | null
}

interface MatrixRow {
  id: string
  sku: string
  name: string | null
  brand: string | null
  isParent: boolean
  status: string
  basePrice: number | null
  totalStock: number
  variantCount: number
  channelCoverage: ChannelCoverage[]
  variants: MatrixVariant[]
  /** C.4 — categoryAttributes JSONB (see MatrixVariant comment). */
  categoryAttributes: Record<string, unknown> | null
}

const catalogMatrixRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /catalog/matrix ─────────────────────────────────────────
  // Returns rows[] of master/standalone products with variant children
  // pre-joined. Soft-deleted rows excluded. Sorted alphabetically by SKU
  // (stable for the operator's mental model; client can re-sort).
  fastify.get('/catalog/matrix', async (_request, reply) => {
    // Load top-level products: anything that's a parent OR a standalone
    // (not the child of another product). Children are fetched in the
    // next query and folded in.
    const parents = await prisma.product.findMany({
      where: {
        deletedAt: null,
        parentId: null,
      },
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        status: true,
        basePrice: true,
        totalStock: true,
        isParent: true,
        categoryAttributes: true,
      },
      orderBy: { sku: 'asc' },
    })

    const parentIds = parents.map((p) => p.id)

    // Load all variant children of the parents in one query.
    const children = parentIds.length === 0
      ? []
      : await prisma.product.findMany({
          where: {
            deletedAt: null,
            parentId: { in: parentIds },
          },
          select: {
            id: true,
            sku: true,
            name: true,
            status: true,
            basePrice: true,
            totalStock: true,
            parentId: true,
            categoryAttributes: true,
          },
          orderBy: { sku: 'asc' },
        })

    // Channel coverage: one query for everything (rolled up by productId).
    const allProductIds = [...parentIds, ...children.map((c) => c.id)]
    const listings = allProductIds.length === 0
      ? []
      : await prisma.channelListing.findMany({
          where: { productId: { in: allProductIds } },
          select: {
            productId: true,
            channel: true,
            marketplace: true,
            listingStatus: true,
          },
        })

    const coverageByProduct = new Map<string, ChannelCoverage[]>()
    for (const l of listings) {
      const list = coverageByProduct.get(l.productId) ?? []
      list.push({
        channel: l.channel,
        marketplace: l.marketplace,
        status: l.listingStatus,
      })
      coverageByProduct.set(l.productId, list)
    }

    // Group children by parent for fold-in.
    const childrenByParent = new Map<string, typeof children>()
    for (const c of children) {
      if (!c.parentId) continue
      const list = childrenByParent.get(c.parentId) ?? []
      list.push(c)
      childrenByParent.set(c.parentId, list)
    }

    const toPlainAttrs = (v: unknown): Record<string, unknown> | null => {
      if (v === null || v === undefined) return null
      if (typeof v !== 'object' || Array.isArray(v)) return null
      return v as Record<string, unknown>
    }

    const rows: MatrixRow[] = parents.map((p) => {
      const variantList = childrenByParent.get(p.id) ?? []
      return {
        id: p.id,
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        isParent: p.isParent || variantList.length > 0,
        status: p.status,
        basePrice: p.basePrice == null ? null : Number(p.basePrice),
        totalStock: p.totalStock,
        variantCount: variantList.length,
        channelCoverage: coverageByProduct.get(p.id) ?? [],
        categoryAttributes: toPlainAttrs(p.categoryAttributes),
        variants: variantList.map((c) => ({
          id: c.id,
          sku: c.sku,
          name: c.name,
          basePrice: c.basePrice == null ? null : Number(c.basePrice),
          totalStock: c.totalStock,
          status: c.status,
          channelCoverage: coverageByProduct.get(c.id) ?? [],
          categoryAttributes: toPlainAttrs(c.categoryAttributes),
        })),
      }
    })

    return reply.send({
      rows,
      totalRows: rows.length,
      totalVariants: children.length,
    })
  })
}

export default catalogMatrixRoutes
