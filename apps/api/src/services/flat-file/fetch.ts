/**
 * FF1.6 — Catalog fetch layer for the flat-file export engine.
 *
 * Reads live Product (parent + child rows) and ChannelListing rows from the
 * database and shapes them into WorkbookData that the workbook generator
 * (Task 7) fills into an XLSX/CSV workbook.
 *
 * Prisma is injected as the first argument (typed `any`) so this module is
 * usable from both route handlers and background jobs without importing a
 * global singleton.
 *
 * Relation names verified against packages/database/prisma/schema.prisma:
 *   - Product.parent     — @relation("ProductHierarchy") self-join (line 250)
 *   - Product.deletedAt  — soft-delete DateTime? field (line 416)
 *   - ChannelListing.product   — @relation to Product (line 1417)
 *   - ChannelListing.channel   — String column (line 1436)
 *   - ChannelListing.marketplace — String column (line 1441)
 */

export type Channel = 'AMAZON' | 'EBAY' | 'SHOPIFY'

export interface CatalogFilters {
  /** Restrict to a specific set of SKUs (subset export / Task 8). */
  skuIn?: string[]
  /** Filter by product status string (e.g. "ACTIVE"). */
  status?: string
  /** Filter by brand string. */
  brand?: string
  /** Filter by productType string. */
  productType?: string
  /** Which channel buckets to include in the listings query. */
  channels: Channel[]
}

export interface WorkbookData {
  /** Product rows (parent + child), each augmented with a resolved `parent_sku` field. */
  products: Array<Record<string, unknown>>
  /** ChannelListing rows bucketed by channel, each augmented with a `sku` field from the joined product. */
  listings: Record<'AMAZON' | 'EBAY' | 'SHOPIFY', Array<Record<string, unknown>>>
}

// ---------------------------------------------------------------------------
// fetchCatalog
// ---------------------------------------------------------------------------

/**
 * Fetch the catalog from the database and shape it into WorkbookData.
 *
 * @param prisma  — Injected Prisma client (typed `any`; avoids singleton import).
 * @param filters — Query constraints (channels is required; rest are optional).
 */
export async function fetchCatalog(
  prisma: any,
  filters: CatalogFilters,
): Promise<WorkbookData> {
  // Build the shared product WHERE clause. Applied to both the product query
  // and (as a nested filter) to the channelListing→product relation.
  const productWhere = {
    deletedAt: null,
    ...(filters.skuIn ? { sku: { in: filters.skuIn } } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.brand ? { brand: filters.brand } : {}),
    ...(filters.productType ? { productType: filters.productType } : {}),
  }

  // ── 1. Fetch products ────────────────────────────────────────────────────
  // Include the parent self-join so we can resolve parent_sku.
  // Ordered by sku asc for deterministic workbook row ordering.
  const rawProducts: Array<any> = await prisma.product.findMany({
    where: productWhere,
    include: { parent: { select: { sku: true } } },
    orderBy: { sku: 'asc' },
  })

  // Map parentId → parent.sku into a flat parent_sku field.
  const products: Array<Record<string, unknown>> = rawProducts.map((p) => ({
    ...p,
    parent_sku: p.parent?.sku ?? '',
  }))

  // ── 2. Fetch channel listings ────────────────────────────────────────────
  // Filter by channel (from filters.channels) and restrict to the same
  // product population via the nested product relation filter.
  // Ordered deterministically: product.sku asc, then marketplace asc.
  const rows: Array<any> = await prisma.channelListing.findMany({
    where: {
      channel: { in: filters.channels },
      product: productWhere,
    },
    include: { product: { select: { sku: true } } },
    orderBy: [{ product: { sku: 'asc' } }, { marketplace: 'asc' }],
  })

  // ── 3. Bucket listings by channel ───────────────────────────────────────
  const listings: Record<'AMAZON' | 'EBAY' | 'SHOPIFY', Array<Record<string, unknown>>> = {
    AMAZON: [],
    EBAY: [],
    SHOPIFY: [],
  }

  for (const r of rows) {
    const bucket = r.channel as 'AMAZON' | 'EBAY' | 'SHOPIFY'
    // Augment with sku from the joined product relation.
    ;(listings[bucket] ??= []).push({ ...r, sku: r.product.sku })
  }

  return { products, listings }
}
