/**
 * MCP full control P3 — the business's product tags, read in one place: GET /api/tags (products-catalog.routes.ts)
 * calls `listTags`, and so does Claude's `catalog-structure` read (kind: tags).
 *
 * Every tag, by name, with how many products carry it. Moved from the route without a change in behaviour
 * (tags.service.vitest.test.ts holds the route's answer byte for byte).
 *
 * MCP full control P7 — the writes Claude's `set-product-tags` shares with the page: create a tag (POST /api/tags),
 * add tags to a product (POST /api/products/:id/tags) and take one off (DELETE /api/products/:id/tags/:tagId).
 * Moved from the route without a change in behaviour (tags-writes.service.vitest.test.ts). Renaming, recolouring and
 * deleting a tag, and the bulk tag bar, stay in the route.
 */

import prisma from '../../db.js'

export interface TagListItem {
  id: string
  name: string
  color: string | null
  icon: string | null
  productCount: number
  updatedAt: Date
}

/** Every tag of the business, sorted by name, with its product count. */
export async function listTags(): Promise<{ items: TagListItem[] }> {
  const tags = await prisma.tag.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { products: true } } },
  })
  return {
    items: tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      icon: t.icon,
      productCount: t._count.products,
      updatedAt: t.updatedAt,
    })),
  }
}

/** A new tag: its name trimmed, colour and icon as given (null when absent). A duplicate name throws P2002. */
export async function createTag(input: { name: string; color?: string | null; icon?: string | null }) {
  return prisma.tag.create({
    data: { name: input.name.trim(), color: input.color ?? null, icon: input.icon ?? null },
  })
}

/** Add these tags to a product (one already on it stays as it is); returns every tag the product carries now. */
export async function addProductTags(productId: string, tagIds: readonly string[]) {
  for (const tagId of tagIds) {
    await prisma.productTag.upsert({
      where: { productId_tagId: { productId, tagId } },
      update: {},
      create: { productId, tagId },
    })
  }
  const current = await prisma.productTag.findMany({
    where: { productId },
    include: { tag: true },
  })
  return current.map((c) => c.tag)
}

/** Take one tag off a product. Throws (P2025) when the product does not carry it. */
export async function removeProductTag(productId: string, tagId: string): Promise<void> {
  await prisma.productTag.delete({
    where: { productId_tagId: { productId, tagId } },
  })
}
