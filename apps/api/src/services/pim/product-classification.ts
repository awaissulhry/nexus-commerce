import prisma from '../../db.js'
import { lockCategoryTree } from '../category-lock.js'
import { categoryName } from './mapping/category-mapping.service.js'

export async function getProductClassification(productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null }, select: { id: true, parentId: true },
  })
  if (!product) return null
  const [root, families, categories] = await Promise.all([
    prisma.product.findUnique({ where: { id: product.parentId ?? product.id }, select: {
      id: true, sku: true, version: true, familyId: true,
      categories: { select: { categoryId: true, isPrimary: true } },
    } }),
    prisma.productFamily.findMany({ orderBy: { label: 'asc' }, select: { id: true, label: true } }),
    prisma.category.findMany({ where: { isActive: true }, orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { slug: 'asc' }], select: {
      id: true, parentId: true, name: true, slug: true, attributes: true,
      channelMappings: { select: { channel: true, marketplace: true, channelCategoryId: true, reviewedAt: true } },
    } }),
  ])
  const paths = new Map<string, string>()
  return { product: root, families, categories: categories.map(c => {
    const label = [paths.get(c.parentId ?? ''), categoryName(c.name) ?? c.slug].filter(Boolean).join(' › ')
    paths.set(c.id, label)
    return { id: c.id, label, suggestedFamilyId: (c.attributes as Record<string, unknown> | null)?.suggestedFamilyId ?? null, mappings: c.channelMappings }
  }) }
}

export interface ClassificationChange { version: number; familyId: string | null; categoryIds: string[]; primaryId: string | null }
export function validClassificationChange(body: unknown): body is ClassificationChange {
  if (!body || typeof body !== 'object') return false
  const b = body as ClassificationChange
  return Number.isSafeInteger(b.version) && b.version >= 0
    && (b.familyId === null || typeof b.familyId === 'string' && b.familyId.length > 0)
    && Array.isArray(b.categoryIds) && b.categoryIds.length <= 100 && b.categoryIds.every(v => typeof v === 'string' && v.length > 0)
    && new Set(b.categoryIds).size === b.categoryIds.length
    && (b.primaryId === null ? b.categoryIds.length === 0 : b.categoryIds.includes(b.primaryId))
}

/** One version-checked transaction changes classification; attribute values are untouched. */
export async function updateProductClassification(productId: string, change: ClassificationChange) {
  const { productEventService } = await import('../product-event.service.js')
  return prisma.$transaction(async tx => {
    await lockCategoryTree(tx)
    const product = await tx.product.findFirst({ where: { id: productId, deletedAt: null }, select: { parentId: true, familyId: true } })
    if (!product) return { status: 404, error: 'Product not found' }
    if (product.parentId) return { status: 400, error: 'Set classification on the parent product' }
    if (change.familyId && !await tx.productFamily.findUnique({ where: { id: change.familyId }, select: { id: true } })) return { status: 400, error: 'Product family does not exist' }
    const categories = await tx.category.count({ where: { id: { in: change.categoryIds }, isActive: true } })
    if (categories !== change.categoryIds.length) return { status: 400, error: 'A selected category is unavailable' }
    const updated = await tx.product.updateMany({ where: { id: productId, version: change.version, deletedAt: null }, data: { familyId: change.familyId, version: { increment: 1 } } })
    if (!updated.count) return { status: 409, error: 'This product changed. Reload classification and try again.' }
    await tx.productCategory.deleteMany({ where: { productId } })
    await tx.productCategory.createMany({ data: change.categoryIds.map(categoryId => ({ productId, categoryId, isPrimary: categoryId === change.primaryId })) })
    await productEventService.emitTx(tx, { aggregateId: productId, aggregateType: 'Product', eventType: 'PRODUCT_UPDATED', data: { familyId: change.familyId, categoryIds: change.categoryIds, primaryCategoryId: change.primaryId }, metadata: { source: 'OPERATOR' } })
    return { status: 200, version: change.version + 1 }
  })
}
