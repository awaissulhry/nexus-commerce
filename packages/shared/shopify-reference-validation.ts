import type { ShopifyFieldDefinition, ShopifyStoreSchema } from './shopify-linked-products.js'
import { shopifyFileKindsWords, shopifyNoun } from './shopify-field-rules.js'
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
/**
 * The references themselves (read from the store) against the field's rules: they still exist, entries are of an allowed
 * kind, files are of an allowed kind. The sentences are the plain words of docs/shopify-metafields/PLAN-2026-09-28.md §5.
 */
export function shopifyReferenceError(def: Pick<ShopifyFieldDefinition, 'type' | 'validations'>, refs: { available?: boolean; type?: string }[], schema: ShopifyStoreSchema): string | null {
  if (refs.some(r => r.available === false)) return `A chosen ${shopifyNoun(def.type).one} is no longer in the store. Remove it or choose another.`
  try {
    const types = shopifyReferenceTypes(def, schema)
    if (types && refs.some(r => !r.type || !types.includes(r.type))) {
      const names = types.map(type => schema.metaobjectDefinitions.find(d => d.type === type)?.name ?? type)
      return names.length
        ? `This field takes ${names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0]} entries only.`
        : 'This field’s entry kind is no longer in the store. Refresh the store schema.'
    }
    const files = def.validations.find(v => v.name === 'file_type_options')
    if (files) { const allowed: string[] = JSON.parse(files.value); if (allowed.length && refs.some(r => !allowed.includes(r.type === 'MediaImage' ? 'Image' : r.type ?? ''))) return `This field takes ${shopifyFileKindsWords(allowed)} only.` }
  } catch { return 'This field’s reference constraints cannot be read. Refresh the store schema.' }
  return null
}
