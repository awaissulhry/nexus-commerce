import type { ProductRow } from '../../_types'
import type { MarketplaceCoverageCell, MarketplaceKey } from './types'

/**
 * Extracts the marketplaceCoverage map for a single product row.
 * Returns an empty object when the field is missing (e.g. when the
 * API was called without includeMarketplaceCoverage=true, or the
 * product has no channel listings).
 */
export function getProductCoverage(
  product: ProductRow,
): Record<MarketplaceKey, MarketplaceCoverageCell> {
  return (product.marketplaceCoverage ?? {}) as Record<MarketplaceKey, MarketplaceCoverageCell>
}

/**
 * Returns the coverage cell for a specific (channel, marketplace) pair.
 * Falls back to a 'none' cell so callers can always render something.
 */
export function getCoverageCell(
  product: ProductRow,
  channel: string,
  marketplace: string,
): MarketplaceCoverageCell {
  const key = `${channel}:${marketplace}` as MarketplaceKey
  return (
    (product.marketplaceCoverage?.[key] as MarketplaceCoverageCell | undefined) ?? {
      status: 'none',
      errorChildCount: 0,
      overrideChildCount: 0,
      totalChildren: 0,
    }
  )
}
