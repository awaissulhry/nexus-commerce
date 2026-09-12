import type { ChannelFieldSpec } from '../channel-specs/types.js'
import type { FieldMappingRule } from '../schema-mapping.service.js'

/** Only declared semantic matches inherit automatically; labels and package/item measures are not interchangeable. */
export function masterDefaultRule(field: Pick<ChannelFieldSpec, 'key' | 'masterKey' | 'channelStore' | 'defaultRule' | 'shopifyField' | 'readOnlyReason'> | undefined, masterKeys: ReadonlySet<string>): FieldMappingRule | null {
  if (!field || (!field.masterKey && ['productType', 'categoryId', 'taxonomy_id', 'type'].includes(field.key))) return null
  if (field.defaultRule) return field.defaultRule
  if (field.readOnlyReason) return null
  if (field.shopifyField && !field.masterKey) return null
  const followSource = field.channelStore?.kind === 'listingColumn'
    ? ({ followMasterPrice: 'basePrice', followMasterQuantity: 'totalStock' } as Record<string, string>)[field.channelStore.followFlag ?? ''] : undefined
  const key = field.masterKey ?? followSource ?? (field.key === 'country_of_origin' ? 'countryOfOrigin' : field.key)
  if (!masterKeys.has(key)) return null
  return {
    source: key === 'name' ? 'title' : key,
    ...(key === 'name' ? { fallback: 'name' } : {}),
    ...(field.key === 'generic_keyword' ? { transforms: [{ type: 'expr' as const, expr: 'replace(text($keywords), ", ", " ")' }] } : {}),
    notes: 'Inherits the corresponding Master attribute. A channel mapping or listing override can replace it.',
  }
}
