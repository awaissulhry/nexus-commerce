import type { PrismaClient } from '@prisma/client'
import type { ResolvedCategory } from './category-mapping.service.js'
import type { PresentationContext } from './presentation-rules.js'

export async function presentationContexts(db: PrismaClient, products: Array<{ id: string; parentId: string | null; familyId: string | null }>, parents: Array<{ id: string; familyId: string | null }>, categories: Record<string, ResolvedCategory>, accountId: string | null): Promise<Map<string, PresentationContext>> {
  const ids = [...new Set(products.flatMap(p => [p.id, ...(p.parentId ? [p.parentId] : [])]))]
  const memberships = await db.productCategory.findMany({ where: { productId: { in: ids } }, select: { productId: true, categoryId: true } })
  const byProduct = new Map<string, string[]>()
  for (const row of memberships) byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), row.categoryId])
  const byParent = new Map(parents.map(p => [p.id, p]))
  return new Map(products.map(p => [p.id, { accountId,
    familyId: p.familyId ?? byParent.get(p.parentId ?? '')?.familyId ?? '',
    sharedCategoryIds: byProduct.get(p.id) ?? byProduct.get(p.parentId ?? '') ?? [],
    marketplaceCategoryId: categories[p.id]?.channelCategoryId ?? null,
  }]))
}
