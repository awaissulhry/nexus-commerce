/**
 * Which Nexus row holds a Shopify product's product-level fields (title, description, vendor, product type, tags, SEO,
 * product metafields) when several Nexus rows are tied to one Shopify product — the sizes of an adopted colour product,
 * or a family whose rows all name its product. ONE rule for the Shopify product sheet (`channel-sheet-projection.ts`,
 * where those cells are shown and edited) and the Shopify product CSV import (`pim/catalog-shopify-csv.ts`, where they
 * are recorded): rows without a parent first, then the rows in the sheet's order (the family read: by SKU); the first
 * row tied to a product owns it. Pure: no database, no Shopify.
 */

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const productGid = (value: unknown) => typeof value === 'string' && /^(gid:\/\/shopify\/Product\/)?\d+$/.test(value) ? value.startsWith('gid:') ? value : `gid://shopify/Product/${value}` : null

/** The Shopify product a Nexus listing is tied to, as a GID: its external listing id, else its `shopifyProductId`. */
export function listingShopifyProductId(listing: { externalListingId?: string | null; platformAttributes?: unknown } | null | undefined): string | null {
  return productGid(listing?.externalListingId) ?? productGid(record(listing?.platformAttributes).shopifyProductId)
}

/** Each product's owning row. `rows` come in the sheet's order; `productOf` names the product a row is tied to, if any. */
export function shopifyProductOwners<R>(rows: readonly R[], productOf: (row: R) => string | null | undefined, hasParent: (row: R) => boolean): Map<string, R> {
  const owners = new Map<string, R>()
  // A stable sort: rows without a parent first, every other row keeps its place.
  for (const row of [...rows].sort((a, b) => Number(hasParent(a)) - Number(hasParent(b)))) {
    const product = productOf(row)
    if (product && !owners.has(product)) owners.set(product, row)
  }
  return owners
}
