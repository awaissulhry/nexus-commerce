import prisma from '../../db.js'
import { getSheetColumns } from './sheet-columns.service.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { ProductRelationshipError, relationshipTransaction } from './product-relationship.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'

export interface AxisChange { version: number; axes: string[]; childIds: string[]; market: string }
export function validAxisChange(value: unknown): value is AxisChange {
  if (!value || typeof value !== 'object') return false
  const body = value as AxisChange
  return Number.isSafeInteger(body.version) && body.version >= 0
    && typeof body.market === 'string' && /^[A-Z0-9_-]{2,20}$/i.test(body.market)
    && Array.isArray(body.axes) && body.axes.length <= 50
    && body.axes.every(axis => typeof axis === 'string' && !!axis.trim() && axis.length <= 150)
    && new Set(body.axes.map(canonicalVariantAxis)).size === body.axes.length
    && Array.isArray(body.childIds) && body.childIds.every(id => typeof id === 'string' && !!id)
    && new Set(body.childIds).size === body.childIds.length
}

/** The dictionary supplies stable attribute keys; legacy names remain visible and preservable. */
export async function getFamilyVariationAxes(productId: string, market: string) {
  const self = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!self) throw new ProductRelationshipError('Product not found', 404)
  const product = await prisma.product.findFirst({ where: { id: self.parentId ?? self.id, deletedAt: null }, select: {
    id: true, sku: true, version: true, isParent: true, parentId: true, variationAxes: true, productType: true, familyId: true,
    children: { where: { deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' } },
  } })
  if (!product || product.parentId) throw new ProductRelationshipError('The family changed. Reload the product.')
  const schema = await getSheetColumns({ market, productTypes: product.productType ? [product.productType] : [],
    familyIds: product.familyId ? [product.familyId] : [], variationAxes: product.variationAxes, scopeKind: 'master' })
  const candidates = schema.columns.filter(column => column.editable && column.scope === 'per_variant'
    && (column.storage === 'categoryAttributes' || column.storage === 'localizedContent' && column.writeField.startsWith('attr_'))
    && (!column.shape || column.shape === 'scalar'))
  const options = candidates.map(column => ({ key: column.key, label: column.label, identity: canonicalVariantAxis(column.key) }))
  for (const axis of product.variationAxes) {
    if (!options.some(option => option.key === axis)) {
      const known = options.find(option => canonicalVariantAxis(option.key) === canonicalVariantAxis(axis))
      options.push({ key: axis, label: known ? `${known.label} (${axis})` : `${axis} · saved axis`, identity: canonicalVariantAxis(axis) })
    }
  }
  return { product: { id: product.id, sku: product.sku, version: product.version, isParent: product.isParent || product.children.length > 0 },
    axes: product.variationAxes, childIds: product.children.map(child => child.id), options }
}

export async function updateFamilyVariationAxes(productId: string, change: AxisChange) {
  const reviewed = await getFamilyVariationAxes(productId, change.market)
  if (reviewed.product.id !== productId || !reviewed.product.isParent) {
    throw new ProductRelationshipError('Set axes on the shared parent. Promote a standalone product before adding axes.', 400)
  }
  if (change.axes.some(axis => !reviewed.options.some(option => option.key === axis))) {
    throw new ProductRelationshipError('An axis is no longer available in the attribute dictionary. Reload axes and review the selection.', 400)
  }
  return relationshipTransaction(async tx => {
    const parent = await tx.product.findFirst({ where: { id: productId, deletedAt: null, parentId: null }, select: {
      version: true, variationAxes: true, children: { where: { deletedAt: null }, select: { id: true } },
    } })
    if (!parent || parent.version !== change.version || parent.children.length !== change.childIds.length
      || parent.children.some(child => !change.childIds.includes(child.id))) {
      throw new ProductRelationshipError('This family changed after you reviewed it. Reload axes and review the affected products again.')
    }
    if (JSON.stringify(parent.variationAxes) === JSON.stringify(change.axes)) return { version: parent.version }
    const result = await tx.product.updateMany({ where: { id: productId, version: change.version }, data: {
      variationAxes: change.axes, version: { increment: 1 },
    } })
    if (result.count !== 1) throw new ProductRelationshipError('This family changed. Reload axes and try again.')
    // An open coordinate editor was based on the previous shared axis set. Invalidate its CAS token too.
    await tx.channelListing.updateMany({ where: { productId }, data: { version: { increment: 1 } } })
    const { productEventService } = await import('../product-event.service.js')
    await productEventService.emitTx(tx, { aggregateId: productId, aggregateType: 'Product', eventType: 'PRODUCT_UPDATED',
      data: { variationAxes: change.axes, previousVariationAxes: parent.variationAxes }, metadata: { source: 'OPERATOR' } })
    await productReadCacheService.refreshInTransaction(tx, [productId, ...change.childIds])
    return { version: change.version + 1 }
  })
}
