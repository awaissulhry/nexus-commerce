import type { StudioPublishSelection } from '@nexus/shared/studio-publication'
import { selectPublicationChanges } from './studio-publication-changes.js'
import { compileAmazonChanges, type AmazonChangePlan } from './studio-publication-amazon-changes.js'
import { compileEbayChanges, type EbayChangePlan } from './studio-publication-ebay-changes.js'
import { ebayPublicationRequest } from './studio-publication-ebay.js'

export type PublicationChangePlan = AmazonChangePlan | EbayChangePlan

/** Pure compilation from the durable plan; choosing fields never performs another provider read. */
export function compileSelection(plan: PublicationChangePlan, selectedIds: string[], reviewId: string) {
  const changes = selectPublicationChanges(plan.changes, selectedIds)
  const selection: Omit<StudioPublishSelection, 'token'> = { reviewId, selectedIds: changes.map(c => c.id),
    products: [], fieldCount: changes.length, payload: { format: plan.kind === 'amazon-changes' ? 'json' : 'xml', content: '' } }
  if (!changes.length) return { prepared: null, selection }
  const prepared = plan.kind === 'amazon-changes' ? compileAmazonChanges(plan, selection.selectedIds) : compileEbayChanges(plan, selection.selectedIds)
  selection.products = prepared.products
  selection.payload = prepared.kind === 'amazon'
    ? { format: 'json', content: JSON.stringify({ feedType: 'JSON_LISTINGS_FEED', marketplaceIds: [prepared.marketplaceId], feed: prepared.feed }, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value, 2) }
    : { format: 'xml', content: ebayPublicationRequest(prepared, reviewId).xml }
  return { prepared, selection }
}
