/**
 * P4 (docs/attributes/PLAN.md §4.2) — which products a channel-rule change touches, and what happens to them.
 *
 * When a channel's rules for one (channel × market × category) change — a newly required field, a removed option —
 * every product in that category may now be more or less ready. Before this, `SchemaChange.affectedProducts` was always
 * empty and readiness caught up only at the nightly reconcile (20 h horizon) or when someone opened the product.
 *
 * `productsInChannelCategory` answers exactly: a product is in the category when the SAME resolution the sheet uses
 * says so — the listing's own pin first (`categoryForListing`), then the product's mapped category
 * (`resolveCategoriesForProducts`). A fixed number of queries per page of products, never one per product.
 * `markCategoryChangePending` then marks those families' readiness for that channel × market pending, so the P2 drain
 * rebuilds them (oldest first, bounded).
 */
import prisma from '../../db.js'
import { categoryForListing, resolveCategoriesForProducts } from './mapping/category-mapping.service.js'
import { markReadinessPending } from './readiness-index.service.js'

const PAGE = 2000

export interface CategoryImpact { productIds: string[]; rootIds: string[] }

const sameCategory = (channel: string, a: string | null | undefined, b: string) =>
  !!a && (channel === 'AMAZON' ? a.toUpperCase() === b.toUpperCase() : a === b)

/** Every live product whose effective category for (channel, marketplace) is `category`, and its family roots. */
export async function productsInChannelCategory(input: { channel: string; marketplace: string; category: string }): Promise<CategoryImpact> {
  const channel = input.channel.toUpperCase()
  const productIds: string[] = []
  const roots = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await prisma.product.findMany({
      where: { deletedAt: null }, select: { id: true, parentId: true }, orderBy: { id: 'asc' }, take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (!page.length) break
    cursor = page[page.length - 1].id
    const ids = page.map(p => p.id)
    const [resolved, listings] = await Promise.all([
      resolveCategoriesForProducts({ productIds: ids, channel, marketplace: input.marketplace }),
      prisma.channelListing.findMany({
        where: { productId: { in: ids }, channel, marketplace: input.marketplace },
        select: { productId: true, platformAttributes: true },
      }),
    ])
    // A product may have several listings on the coordinate (accounts, aliases); any of them pinned to the category counts.
    const pins = new Map<string, unknown[]>()
    for (const listing of listings) pins.set(listing.productId, [...(pins.get(listing.productId) ?? []), listing.platformAttributes])
    for (const product of page) {
      const candidates = pins.get(product.id)?.length ? pins.get(product.id)! : [null]
      const inCategory = candidates.some(attrs => sameCategory(channel, categoryForListing(resolved[product.id], channel, attrs).channelCategoryId, input.category))
      if (!inCategory) continue
      productIds.push(product.id)
      roots.add(product.parentId ?? product.id)
    }
    if (page.length < PAGE) break
  }
  return { productIds, rootIds: [...roots].sort() }
}

/**
 * A rule change landed for (channel, marketplace, category): mark the affected families' readiness for that channel ×
 * market pending (every account), so the drain rebuilds them. Returns what it found, for `SchemaChange.affectedProducts`.
 */
export async function markCategoryChangePending(input: { channel: string; marketplace: string; category: string }): Promise<CategoryImpact & { markedRows: number }> {
  const impact = await productsInChannelCategory(input)
  const markedRows = impact.rootIds.length
    ? await markReadinessPending(impact.rootIds, { channel: input.channel.toUpperCase(), market: input.marketplace })
    : 0
  return { ...impact, markedRows }
}
