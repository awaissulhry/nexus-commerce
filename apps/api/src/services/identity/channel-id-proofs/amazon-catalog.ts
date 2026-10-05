/**
 * Item ID control, step I4 — Amazon's catalog, read for one typed ASIN in one marketplace, as the listing's own account:
 * Catalog Items (`getCatalogItemSummary`) through the SP-API client, which sends every call through the channel gateway.
 * Its own module so the product sheet's ASIN proof (`amazon.ts`) has one door to stand in.
 */
import { AmazonSpApiClient } from '../../../clients/amazon-sp-api.client.js'
import { getAmazonRegion } from '../../../lib/amazon-sp-client.js'
import { configuredAmazonMarketplaceId } from '../../categories/marketplace-ids.js'

export interface AmazonCatalogRead { found: boolean; title?: string | null; brand?: string | null; error?: string | null }

/** Whether Amazon has `asin` in the marketplace of `market` (a market code: IT, DE, …). 404 → not found; anything else → error. */
export async function readAmazonCatalog(accountId: string, asin: string, market: string): Promise<AmazonCatalogRead> {
  const marketplaceId = await configuredAmazonMarketplaceId(market)
  if (!marketplaceId) return { found: false, error: `Nexus has no Amazon marketplace id for ${market}.` }
  const client = new AmazonSpApiClient({ id: accountId, region: await getAmazonRegion(accountId) })
  const read = await client.getCatalogItemSummary(asin, marketplaceId)
  if (read.success) return { found: true, title: read.title ?? null, brand: read.brand ?? null }
  if (read.httpStatus === 404) return { found: false }
  return { found: false, error: read.error ?? `HTTP ${read.httpStatus}` }
}
