import type { Prisma } from '@prisma/client'

/** Moving a product must not strand alias records that belong to its former root. */
export async function relationshipAliasConflicts(db: Pick<Prisma.TransactionClient, 'productListingAlias' | 'channelListing'>, productIds: string[]): Promise<Set<string>> {
  if (!productIds.length) return new Set()
  const [ownedAliases, aliasListings] = await Promise.all([
    db.productListingAlias.findMany({ where: { productId: { in: productIds } }, select: { productId: true } }),
    db.channelListing.findMany({ where: { productId: { in: productIds }, OR: [{ aliasKey: { not: '' } }, { aliasId: { not: null } }] }, select: { productId: true } }),
  ])
  // Archived aliases may still represent live remote listings; they are protected too.
  return new Set([...ownedAliases, ...aliasListings].map(row => row.productId))
}
