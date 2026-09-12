import type { ShopifyLinkedDraft, ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { channelValuePatch } from '../pim/channel-value-mutation.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}
const gid = (kind: string, value: unknown) => typeof value === 'string' && new RegExp(`^(gid://shopify/${kind}/)?\\d+$`).test(value) ? value.startsWith('gid:') ? value : `gid://shopify/${kind}/${value}` : undefined
/** Project durable sheet pins into the existing publication adapter, without database writes. */
export function listingSheetValues<T extends { productId: string; platformAttributes: unknown; externalListingId?: string | null }>(listings: T[], familyId: string, accountId: string, schema: ShopifyStoreSchema): T[] {
  const result = listings.map(l => ({ ...l })), root = listings.find(l => l.productId === familyId), pa = object(root?.platformAttributes)
  const draft = object(pa._nexusLinkedProducts) as Partial<ShopifyLinkedDraft>, publish = object(pa._nexusContentPublish)
  for (const pin of draft.sheetValues ?? []) {
    if (pin.inherited || pin.fieldId === 'inventory') continue
    const fields = shopifyProductSpec(schema, accountId, pin.locale || undefined).fields
    const spec = fields.find(s => s.shopifyField?.id === pin.fieldId)
    if (!spec || spec.shopifyField?.type !== pin.type) throw new WorkspaceScopeError('A saved sheet override changed definition. Review its preserved value before publication.', 422)
    const index = result.findIndex(l => pin.ownerId.includes('/ProductVariant/')
      ? pin.ownerId === (gid('ProductVariant', object(l.platformAttributes).variantId) ?? gid('ProductVariant', object(publish.variantIds)[l.productId]))
      : l.productId === familyId && pin.ownerId === (gid('Product', l.externalListingId) ?? gid('Product', object(l.platformAttributes).shopifyProductId) ?? gid('Product', publish.productId)))
    if (index < 0) throw new WorkspaceScopeError('A saved sheet override targets another Shopify owner. Resolve the listing identities before full publication.', 422)
    let value: unknown = pin.value
    if (!spec.shopifyField.definition && pin.value !== null) {
      // Native lists, booleans and measurements use the existing typed listing storage.
      if (spec.shopifyField.type === 'boolean' || spec.shopifyField.type.startsWith('list.') || spec.channelStore?.kind === 'platformAttributes' && spec.channelStore.unitPath) value = JSON.parse(pin.value)
    }
    result[index] = { ...result[index], ...channelValuePatch(result[index] as any, spec.channelStore, [spec.masterKey ?? spec.key, spec.key], 'SET', value) }
  }
  return result
}
