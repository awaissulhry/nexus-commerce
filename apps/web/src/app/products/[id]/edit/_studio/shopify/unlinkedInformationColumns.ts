import { informationRegistry, informationSheetValue, shopifyMappingFieldKey } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { ChannelScopePage } from '../sheet/channel/types'

/** Show the same store attributes before linking, preserving the existing Nexus draft writers.
 * Unmapped fields have no remote owner or value; their presence must not invent either.
 */
export function withShopifyColumns(page: ChannelScopePage | null, schema: ShopifyStoreSchema | null | undefined): ChannelScopePage | null {
  if (!page || page.scope.channel !== 'SHOPIFY' || !schema) return page
  const fields = informationRegistry(schema)
  const liveKeys = new Set(fields.map(f => shopifyMappingFieldKey(f, page.scope.connectionId ?? '')))
  const columns = page.columns.filter(c => !c.key.startsWith('shopify_metafield:') || liveKeys.has(c.key)).map(column => {
    const definition = fields.find(f => f.definition && shopifyMappingFieldKey(f, page.scope.connectionId ?? '') === column.key)
    if (definition) return { ...column, label: definition.label }
    const source = Object.values(column.channels ?? {}).find(c => c.store?.kind === 'platformAttributes')?.store
    const address = source?.kind === 'platformAttributes' ? source.path.join('.') : null
    const field = fields.find(f => !f.definition && (f.id === address || f.id === column.key || (f.id === 'title' && column.key === 'name') ||
      Object.values(column.channels ?? {}).some(c => c.attribute === f.id)))
    const originalName = field?.channelLabel && field.channelLabel !== field.label ? `Shopify: ${field.channelLabel}.` : ''
    return field ? { ...column, label: field.id === 'inventory' ? column.label : field.label,
      helpText: [originalName && !column.helpText?.includes(originalName) ? originalName : '', column.helpText].filter(Boolean).join(' ') || undefined } : column
  })
  const weight = columns.find(column => column.shopifyField?.id === 'weight')
  const rows = weight?.shopifyField ? page.rows.map(row => {
    const cell = row.values[weight.key]
    if (!cell) return row
    const value = informationSheetValue(weight.shopifyField!, cell.value)
    return value === cell.value ? row : { ...row, values: { ...row.values, [weight.key]: { ...cell, value } } }
  }) : page.rows
  return { ...page, rows, columns }
}

export const withUnlinkedShopifyColumns = withShopifyColumns
