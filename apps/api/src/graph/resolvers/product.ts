// PH.3 — catalog facet.
//
// Reads ProductReadCache: the denormalised projection that already exists, so
// the graph's hot path costs one indexed read rather than a join across the
// catalog tables. Soft-deleted rows are excluded — the cache keeps them, and a
// graph that served them would resurrect deleted products in every consumer at
// once.

import prisma from '../../db.js'
import { MAX_PRODUCTS, type GraphContext, type ProductSource } from '../types.js'

const SELECT = {
  id: true, sku: true, name: true, brand: true, status: true, productType: true,
  fulfillmentMethod: true, asin: true, imageUrl: true, basePrice: true,
  isParent: true, parentId: true, familyJson: true, workflowStageJson: true,
  cacheRefreshedAt: true,
} as const

/** familyJson / workflowStageJson are stored as { id, code, label }. */
function jsonNode(value: unknown): { id: string; code: string | null; label: string | null } | null {
  if (!value || typeof value !== 'object') return null
  const node = value as Record<string, unknown>
  if (typeof node.id !== 'string') return null
  return {
    id: node.id,
    code: typeof node.code === 'string' ? node.code : null,
    label: typeof node.label === 'string' ? node.label : null,
  }
}

export const productResolvers = {
  Query: {
    async product(
      _root: unknown,
      args: { id?: string | null; sku?: string | null },
    ): Promise<ProductSource | null> {
      const hasId = Boolean(args.id)
      const hasSku = Boolean(args.sku)
      // Both or neither is a caller error, and answering it anyway would mean
      // silently picking one — the caller would never learn its query was wrong.
      if (hasId === hasSku) {
        throw new Error('product(): supply exactly one of `id` or `sku`')
      }
      return prisma.productReadCache.findFirst({
        where: { ...(hasId ? { id: args.id! } : { sku: args.sku! }), deletedAt: null },
        select: SELECT,
      }) as Promise<ProductSource | null>
    },

    async products(_root: unknown, args: { skus: string[] }): Promise<ProductSource[]> {
      if (args.skus.length === 0) return []
      if (args.skus.length > MAX_PRODUCTS) {
        // Refuse rather than truncate. A silently shortened list is a wrong
        // answer that looks like a right one.
        throw new Error(`products(): at most ${MAX_PRODUCTS} skus per query (received ${args.skus.length})`)
      }
      return prisma.productReadCache.findMany({
        where: { sku: { in: args.skus }, deletedAt: null },
        select: SELECT,
      }) as Promise<ProductSource[]>
    },
  },

  Product: {
    basePrice: (p: ProductSource) => (p.basePrice == null ? null : Number(p.basePrice)),
    family: (p: ProductSource) => jsonNode(p.familyJson),
    workflowStage: (p: ProductSource) => jsonNode(p.workflowStageJson),
    cacheRefreshedAt: (p: ProductSource) => p.cacheRefreshedAt.toISOString(),

    // Not in the projection — a query that does not select it pays nothing.
    // The value is then stripped for unauthorised callers by the same
    // preSerialization filter that guards every REST response.
    costPrice: (p: ProductSource, _args: unknown, ctx: GraphContext) =>
      ctx.loaders.costPriceByProduct.load(p.id),
  },
}
