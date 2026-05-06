/**
 * Phase 10a — canonical filter contract shared by every page that
 * filters tabular data (/products, /listings, /catalog/organize,
 * /bulk-operations, /products/drafts).
 *
 * Why this exists
 * ───────────────
 * Phase 1 audit found that each page invented its own URL vocabulary
 * (`channels=A,B` vs `channel=A` vs `listingStatus=…`) so filters could
 * not be bookmarked across pages and the same UI was reimplemented per
 * page. Centralising the contract lets the universal filter bar (10c)
 * speak one language while individual pages still extend it with their
 * own page-specific filters.
 *
 * The contract
 * ────────────
 * URL params are encoded as REPEATED keys, not CSVs:
 *
 *   ?channel=AMAZON&channel=EBAY&marketplace=IT&status=ACTIVE&search=jacket
 *
 * Repeated keys are the standard URL convention for arrays
 * (`URLSearchParams.getAll(key)` parses them natively) and let users
 * add/remove individual values without re-encoding the whole list.
 *
 * Backwards compatibility
 * ───────────────────────
 * The legacy CSV form (e.g. `?channels=AMAZON,EBAY` from /products) is
 * accepted by the parser as a deprecated alias and silently rewritten
 * to the canonical form. See parseFilters() in url.ts. Existing
 * bookmarks keep working; new code should always emit the canonical
 * form via serializeFilters().
 *
 * Extending per page
 * ──────────────────
 * Pages with extra filters intersect CommonFilters:
 *
 *   type ProductsFilters = CommonFilters & {
 *     productType: string[]
 *     brand: string[]
 *   }
 *
 * The url.ts helpers operate on CommonFilters; page-specific extensions
 * carry their own parse/serialize for the extras. This keeps the shared
 * contract small and lets pages evolve independently.
 */

export interface CommonFilters {
  /** Free-text search across page-defined fields. */
  search?: string

  /**
   * Channel codes in upper-case (AMAZON, EBAY, SHOPIFY, WOOCOMMERCE,
   * ETSY). Empty array = no channel filter.
   */
  channel: string[]

  /**
   * Marketplace codes in upper-case (IT, DE, FR, ES, UK, GLOBAL, …).
   * Empty array = no marketplace filter.
   */
  marketplace: string[]

  /**
   * Status filter values, page-specific (Product.status uses
   * ACTIVE/DRAFT/INACTIVE; ChannelListing.listingStatus uses
   * DRAFT/ACTIVE/PENDING/SUPPRESSED/ENDED/ERROR; etc.). Pages document
   * the values they accept. Empty array = no status filter.
   */
  status: string[]
}

/** Partial update — used by mergeFilters and on-change callbacks. */
export type FilterDelta = Partial<CommonFilters>

/**
 * Empty / default value. Helpful for resetting a filter bar or
 * initialising state when the URL has nothing.
 */
export const EMPTY_FILTERS: CommonFilters = {
  search: undefined,
  channel: [],
  marketplace: [],
  status: [],
}

/**
 * True when the filters carry no constraints — useful for "no active
 * filters" empty states and the "Clear all" CTA visibility.
 */
export function isEmpty(filters: CommonFilters): boolean {
  return (
    !filters.search &&
    filters.channel.length === 0 &&
    filters.marketplace.length === 0 &&
    filters.status.length === 0
  )
}

/**
 * Count of active filter constraints — drives the "5 filters active"
 * badge in the universal filter bar.
 */
export function activeCount(filters: CommonFilters): number {
  let n = 0
  if (filters.search) n++
  n += filters.channel.length
  n += filters.marketplace.length
  n += filters.status.length
  return n
}
