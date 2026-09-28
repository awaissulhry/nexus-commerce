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

/**
 * The taxonomy categories through which a taxonomy-value field's attribute can be read (Lane B slice B2, gap G12): Shopify
 * lists an attribute's values only through a category. A product field uses its own category constraint; an entry field
 * (in a kind such as the category `shopify--color-pattern`) uses the constraints of the product fields that point to that
 * kind. Empty when none is known — the caller then says so, it never guesses. At most five, in schema order.
 */
export function shopifyTaxonomyCategories(def: Pick<ShopifyFieldDefinition, 'ownerType' | 'namespace' | 'constraints'>, schema: Pick<ShopifyStoreSchema, 'definitions' | 'metaobjectDefinitions'>): string[] {
  const own = def.constraints?.key === 'category' ? def.constraints.values : []
  if (own.length || def.ownerType !== 'METAOBJECT') return [...new Set(own)].slice(0, 5)
  const kind = schema.metaobjectDefinitions.find(d => d.type === def.namespace)
  if (!kind) return []
  const pointsHere = (d: ShopifyFieldDefinition) => d.validations.some(v => (v.name === 'metaobject_definition_id' && v.value === kind.id) || (v.name === 'metaobject_definition_type' && v.value === kind.type))
  return [...new Set(schema.definitions.filter(pointsHere).flatMap(d => d.constraints?.key === 'category' ? d.constraints.values : []))].slice(0, 5)
}
