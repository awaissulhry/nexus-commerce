/**
 * The cross-site finder by name: given an eBay category's localised name from one site, eBay's category suggestions
 * on ANOTHER site's tree, best match only. eBay's EU trees are roughly parallel, but their leaf ids are not safe to
 * copy between sites (177104 is motorcycle jackets in IT, FR and ES; FR 177117 is motocross), so the result is a
 * suggestion for a person to confirm, never an assignment.
 *
 * Moved out of the legacy `GET /api/ebay/cockpit/category-map` so the Categories workspace's "Fill other eBay sites"
 * reuses the same lookup. It calls eBay only through `EbayCategoryService.searchCategories`, which goes through the
 * channel gateway.
 */
import type { EbayCategoryService } from './ebay-category.service.js'

export interface CrossSiteMatch { id: string; name: string; path: string; matchScore: number }

export async function findCategoryByNameOnSite(
  ebay: Pick<EbayCategoryService, 'searchCategories'>,
  market: string,
  categoryName: string,
  options: { throwOnError?: boolean } = {},
): Promise<CrossSiteMatch | null> {
  const items = await ebay.searchCategories(market, categoryName, { throwOnError: options.throwOnError ?? false, limit: 1 })
  const first = items[0]
  return first
    ? { id: first.productType, name: first.displayName.split(' › ').pop() ?? first.displayName, path: first.displayName, matchScore: first.matchPercentage ?? 0 }
    : null
}
