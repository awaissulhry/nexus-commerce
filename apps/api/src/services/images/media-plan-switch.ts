import prisma from '../../db.js'

/**
 * Images rebuild P2b — the ONE rule for "this family's photos live in the media plan": it has a Shared layer.
 * A leaf (prisma only), so every older photo path can ask without importing the plan service.
 */

/** What an older photo path says when it refuses such a family. */
export const MEDIA_PLAN_REFUSAL = 'This product\'s photos are managed on the Media page. Publish them from there — this older photo path would overwrite them.'

/** The ids among `productIds` whose family (the product or its parent) is on the media plan. */
export async function mediaPlanProducts(productIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(productIds.filter(Boolean))]
  if (!ids.length) return new Set()
  const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, parentId: true } })
  const roots = [...new Set(products.map(p => p.parentId ?? p.id))]
  const on = new Set((await prisma.productMediaPlan.findMany({ where: { productId: { in: roots }, layer: 'SHARED' }, select: { productId: true } })).map(r => r.productId))
  return new Set(products.filter(p => on.has(p.parentId ?? p.id)).map(p => p.id))
}

export async function isOnMediaPlan(productId: string): Promise<boolean> {
  return (await mediaPlanProducts([productId])).has(productId)
}
