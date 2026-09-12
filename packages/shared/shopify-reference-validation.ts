import type { ShopifyFieldDefinition, ShopifyStoreSchema } from './shopify-linked-products.js'
/** Definition IDs and allowed types come from the selected store, never field labels. */
export function shopifyReferenceTypes(def: Pick<ShopifyFieldDefinition, 'validations' | 'type'>, schema: ShopifyStoreSchema): string[] | null {
  const permitted: string[] = []
  let constrained = false
  for (const rule of def.validations) {
    if (!['metaobject_definition_id', 'metaobject_definition_ids', 'metaobject_definition_type', 'metaobject_definition_types'].includes(rule.name)) continue
    constrained = true
    const values: string[] = rule.name.endsWith('s') ? JSON.parse(rule.value) : [rule.value]
    for (const value of values) {
      const type = rule.name.includes('_id') ? schema.metaobjectDefinitions.find(d => d.id === value)?.type : value
      if (type) permitted.push(type)
    }
  }
  if (def.type.includes('disclosure_reference') && !def.type.includes('taxonomy')) return schema.metaobjectDefinitions.filter(d => d.type.startsWith('shopify--disclosure-')).map(d => d.type)
  return constrained ? [...new Set(permitted)] : null
}
export function shopifyReferenceError(def: Pick<ShopifyFieldDefinition, 'type' | 'validations'>, refs: { available?: boolean; type?: string }[], schema: ShopifyStoreSchema): string | null {
  if (refs.some(r => r.available === false)) return 'A selected reference is unavailable in this Shopify store.'
  try {
    const types = shopifyReferenceTypes(def, schema)
    if (types && refs.some(r => !r.type || !types.includes(r.type))) return 'Choose a reusable entry type allowed by this field’s definition.'
    const files = def.validations.find(v => v.name === 'file_type_options')
    if (files) { const allowed: string[] = JSON.parse(files.value); if (allowed.length && refs.some(r => !allowed.includes(r.type === 'MediaImage' ? 'Image' : r.type ?? ''))) return 'Choose a file type allowed by this field’s definition.' }
  } catch { return 'This field’s reference constraints cannot be read. Refresh the store schema.' }
  return null
}
