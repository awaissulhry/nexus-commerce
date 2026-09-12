import type { Prisma } from '@prisma/client'
import { productRoleOf } from '@nexus/shared/master-sheet'
import prisma from '../../db.js'
import { relationshipAliasConflicts } from './relationship-alias-guard.js'
import { productReadCacheService } from '../product-read-cache.service.js'

export class ProductRelationshipError extends Error {
  readonly code = 'PRODUCT_RELATIONSHIP_CONFLICT'
  constructor(message: string, readonly statusCode = 409) { super(message) }
}

/** All membership reads and writes share one serializable snapshot, including alias creation. */
export async function relationshipTransaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(run, { isolationLevel: 'Serializable', timeout: 30_000 })
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2034') {
      throw new ProductRelationshipError('This family changed during the operation. Reload it and review the action again.')
    }
    throw error
  }
}

export async function relationshipProduct(tx: Prisma.TransactionClient, id: string) {
  const product = await tx.product.findUnique({ where: { id }, select: { id: true, sku: true, parentId: true, isParent: true, deletedAt: true, variantAttributes: true, categoryAttributes: true, _count: { select: { children: true } } } })
  if (!product || product.deletedAt) throw new ProductRelationshipError('Product is no longer available. Reload the family.', 404)
  return product
}

export async function relationshipParent(tx: Prisma.TransactionClient, id: string) {
  const parent = await relationshipProduct(tx, id)
  if (productRoleOf({ ...parent, childCount: parent._count.children }) !== 'parent') {
    throw new ProductRelationshipError(`${parent.sku} is not a top-level parent. Promote a standalone product before attaching children.`)
  }
  return parent
}

export async function assertNoRelationshipAliases(tx: Prisma.TransactionClient, ids: string[]) {
  if ((await relationshipAliasConflicts(tx, ids)).size) {
    throw new ProductRelationshipError('This action affects products with listing aliases. Resolve their listing relationships before changing the family. Archived aliases are protected too.')
  }
}

function assertCanBecomeChild(product: Awaited<ReturnType<typeof relationshipProduct>>) {
  if (product.isParent || product._count.children) {
    throw new ProductRelationshipError(`${product.sku} is a parent. Detach its children and demote it before moving it.`)
  }
}

export async function attachProduct(tx: Prisma.TransactionClient, parentId: string, productId: string, axes: Record<string, string>) {
  if (productId === parentId) throw new ProductRelationshipError('A product cannot be its own parent')
  await relationshipParent(tx, parentId)
  const product = await relationshipProduct(tx, productId)
  assertCanBecomeChild(product)
  if (product.parentId && product.parentId !== parentId) throw new ProductRelationshipError(`${product.sku} already has a parent. Use Move to another parent.`)
  const changed = product.parentId !== parentId
  if (changed) await assertNoRelationshipAliases(tx, [productId])
  if (!changed && !Object.keys(axes).length) return false
  const attributes = (product.categoryAttributes ?? {}) as Record<string, any>
  await tx.product.update({ where: { id: productId }, data: {
    parentId, isParent: false, version: { increment: 1 },
    ...(Object.keys(axes).length ? { variantAttributes: { ...(product.variantAttributes as object ?? {}), ...axes },
      categoryAttributes: { ...attributes, variations: { ...(attributes.variations ?? {}), ...axes } } } : {}),
  } })
  await productReadCacheService.refreshInTransaction(tx, [productId, parentId])
  return true
}

export async function reparentProduct(tx: Prisma.TransactionClient, productId: string, newParentId: string, expectedParentId?: string) {
  if (productId === newParentId) throw new ProductRelationshipError('A product cannot be its own parent')
  const product = await relationshipProduct(tx, productId)
  if (expectedParentId !== undefined && product.parentId !== expectedParentId) throw new ProductRelationshipError('This child moved after you reviewed it. Reload the family and confirm again.')
  await relationshipParent(tx, newParentId)
  assertCanBecomeChild(product)
  if (!product.parentId) throw new ProductRelationshipError(`${product.sku} is standalone. Use Attach existing products.`)
  if (product.parentId !== newParentId) {
    await assertNoRelationshipAliases(tx, [productId])
    await tx.product.update({ where: { id: productId }, data: { parentId: newParentId, version: { increment: 1 } } })
    await productReadCacheService.refreshInTransaction(tx, [productId, product.parentId, newParentId])
  }
  // An empty parent stays a Parent, just as it does after unlink and Parent SKU import.
  return { success: true, productId, newParentId, oldParentId: product.parentId }
}

export async function unlinkProducts(tx: Prisma.TransactionClient, ids: string[], expectedParentId?: string) {
  const uniqueIds = [...new Set(ids)]
  const products = await tx.product.findMany({ where: { id: { in: uniqueIds }, deletedAt: null }, include: { _count: { select: { children: true } } } })
  if (products.length !== uniqueIds.length) throw new ProductRelationshipError('A selected product is no longer available. Reload the family.')
  if (expectedParentId !== undefined && products.some(product => product.parentId !== expectedParentId)) throw new ProductRelationshipError('A selected child moved after you reviewed it. Reload the family and confirm again.')
  for (const product of products) assertCanBecomeChild(product)
  const changedIds = products.filter(product => product.parentId).map(product => product.id)
  await assertNoRelationshipAliases(tx, changedIds)
  if (changedIds.length) await tx.product.updateMany({ where: { id: { in: changedIds } }, data: { parentId: null, version: { increment: 1 } } })
  if (changedIds.length) await productReadCacheService.refreshInTransaction(tx, [...changedIds, ...products.flatMap(product => product.parentId ? [product.parentId] : [])])
  // Retain the legacy response count, including already-unlinked children on a retry.
  return { success: true, detached: uniqueIds.length }
}

export async function promoteProduct(tx: Prisma.TransactionClient, productId: string, variationTheme?: string, variationAxes?: string[]) {
  const product = await relationshipProduct(tx, productId)
  if (product.parentId) throw new ProductRelationshipError(`${product.sku} is a child. Unlink it before promoting it.`)
  await tx.product.update({ where: { id: productId }, data: { isParent: true, version: { increment: 1 },
    ...(variationTheme ? { variationTheme } : {}), ...(variationAxes ? { variationAxes } : {}),
  } })
  await productReadCacheService.refreshInTransaction(tx, [productId])
  return { success: true, productId }
}

export async function demoteProduct(tx: Prisma.TransactionClient, productId: string, force: boolean, expectedChildIds?: string[]) {
  await relationshipParent(tx, productId)
  const children = await tx.product.findMany({ where: { parentId: productId }, select: { id: true } })
  if (children.length && !force) throw new ProductRelationshipError(`This parent has ${children.length} children. Review and confirm detaching them first.`)
  if (force && (!Array.isArray(expectedChildIds) || JSON.stringify([...new Set(expectedChildIds)].sort()) !== JSON.stringify(children.map(child => child.id).sort()))) {
    throw new ProductRelationshipError('The children differ from the reviewed selection. Reload the family and confirm again.')
  }
  await assertNoRelationshipAliases(tx, [productId, ...children.map(child => child.id)])
  if (children.length) await tx.product.updateMany({ where: { parentId: productId }, data: { parentId: null, version: { increment: 1 } } })
  await tx.product.update({ where: { id: productId }, data: { isParent: false, variationTheme: null, version: { increment: 1 } } })
  await productReadCacheService.refreshInTransaction(tx, [productId, ...children.map(child => child.id)])
  return { success: true, productId }
}

export async function assertCanDeleteRelationshipProduct(tx: Prisma.TransactionClient, ids: string[]) {
  await assertNoRelationshipAliases(tx, ids)
  const remote = await tx.channelListing.findFirst({ where: { productId: { in: ids }, OR: [
    { externalListingId: { not: null, notIn: [''] } }, { isPublished: true },
  ] }, select: { id: true } })
  if (remote) throw new ProductRelationshipError('This product still has a marketplace listing. Resolve that listing before deleting its local record.')
}
