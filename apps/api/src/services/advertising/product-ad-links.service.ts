/**
 * MCP full control I11 — advertising's answer to "does an ad still name this product?", for the identity merge
 * (services/identity/identity-merge.service.ts), which may not read advertising's own tables (scripts/check-context-
 * boundary.mjs). A product ad that is not archived names the product by id or by its SKU.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'

type AdReader = { adProductAd: { count: (args: Prisma.AdProductAdCountArgs) => Promise<number> } }

export async function liveProductAdCount(product: { id: string; sku: string }, db: AdReader = prisma): Promise<number> {
  return db.adProductAd.count({
    where: { status: { not: 'ARCHIVED' }, OR: [{ productId: product.id }, { sku: product.sku }] },
  })
}
