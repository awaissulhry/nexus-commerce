import type { StudioPublishFieldWrite, StudioPublishSelection } from '@nexus/shared/studio-publication'
import { selectPublicationChanges } from './studio-publication-changes.js'
import { compileAmazonChanges, type AmazonChangePlan } from './studio-publication-amazon-changes.js'
import { compileEbayChanges, type EbayChangePlan } from './studio-publication-ebay-changes.js'
import { ebayPublicationRequest } from './studio-publication-ebay.js'
import { compileEbayInventoryChanges, type EbayInventoryChangePlan } from './studio-publication-ebay-inventory-changes.js'
import type { EbayInventoryDestination } from '../live-read/ebay-inventory.js'

export type PublicationChangePlan = AmazonChangePlan | EbayChangePlan | EbayInventoryChangePlan
/** The exact eBay Inventory send: one whole-group PUT built from the fresh live group (PE P3.4). */
export interface EbayInventorySend {
  kind: 'ebay-inventory-send'; destination: EbayInventoryDestination; groupKey: string; group: Record<string, unknown>
  /** Images rebuild P2d — whole inventory_item bodies to PUT before the group (availability is echoed fresh at send). */
  items?: Record<string, Record<string, unknown>>
  expectedRevision: string; fields: string[]; fieldWrites: Record<string, StudioPublishFieldWrite[]>; products: Array<{ productId: string; sku: string }>
}
const sortedJson = (value: unknown) => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry, 2)

/** Pure compilation from the durable plan; choosing fields never performs another provider read. */
export function compileSelection(plan: PublicationChangePlan, selectedIds: string[], reviewId: string) {
  const changes = selectPublicationChanges(plan.changes, selectedIds)
  const selection: Omit<StudioPublishSelection, 'token'> = { reviewId, selectedIds: changes.map(c => c.id),
    products: [], fieldCount: changes.length, payload: { format: plan.kind === 'ebay-changes' ? 'xml' : 'json', content: '' } }
  if (!changes.length) return { prepared: null, selection }
  if (plan.kind === 'ebay-inventory-changes') {
    const compiled = compileEbayInventoryChanges(plan, selection.selectedIds)
    if (!compiled.group || !compiled.groupKey) throw new Error('No eBay group change was compiled.')
    const prepared: EbayInventorySend = { kind: 'ebay-inventory-send', destination: plan.destination, groupKey: compiled.groupKey, group: compiled.group,
      ...(Object.keys(compiled.items).length ? { items: compiled.items } : {}),
      expectedRevision: plan.remoteRevision, fields: changes.map(c => c.field), fieldWrites: compiled.fieldWrites, products: [plan.owner] }
    selection.products = prepared.products
    selection.payload = { format: 'json', content: sortedJson({ operation: 'PUT inventory_item_group', groupKey: prepared.groupKey, body: prepared.group,
      ...(prepared.items ? { items: Object.fromEntries(Object.entries(prepared.items).map(([sku, body]) => [sku, { operation: 'PUT inventory_item (availability echoed fresh)', body }])) } : {}) }) }
    return { prepared, selection }
  }
  const prepared = plan.kind === 'amazon-changes' ? compileAmazonChanges(plan, selection.selectedIds) : compileEbayChanges(plan, selection.selectedIds)
  selection.products = prepared.products
  selection.payload = prepared.kind === 'amazon'
    ? { format: 'json', content: sortedJson({ feedType: 'JSON_LISTINGS_FEED', marketplaceIds: [prepared.marketplaceId], feed: prepared.feed }) }
    : { format: 'xml', content: ebayPublicationRequest(prepared, reviewId).xml }
  return { prepared, selection }
}
