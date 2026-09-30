/**
 * MCP.12 — the one rule every tool that names a product by id follows: a deleted product (soft delete, `deletedAt`)
 * is not found, as everywhere else in the app. Before this, product-search listed deleted products and the tools that
 * take a productId read them, previewed changes to them, and would have run those changes.
 */
import prisma from '../../../db.js'

export const PRODUCT_NOT_FOUND = 'Product not found'

/** The `where` of a lookup by id that only finds a product that is not deleted. */
export const liveProduct = (id: string) => ({ id, deletedAt: null })

/** For a tool that reads other rows by productId (listings, recommendations): does the product exist here? */
export async function isLiveProduct(id: string): Promise<boolean> {
  return (await prisma.product.count({ where: liveProduct(id) })) > 0
}
