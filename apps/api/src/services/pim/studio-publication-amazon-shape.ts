import type { ChannelSpec } from './channel-specs/types.js'
import { attributesFromCells } from './mapping/schema-requirements.js'

/** A family row of a studio Amazon publish: the variation parent, or a child naming its parent's seller SKU. */
export type AmazonFamilyRow = { role: 'parent'; theme: string } | { role: 'child'; theme: string; parentSku: string }

/** Roots whose items the legacy row builder stamps with a `marketplace_id` the category schema may not declare. */
const UNSCOPED_ITEM_ROOTS = ['fulfillment_availability', 'variation_theme'] as const

/** True only when the schema declares the root's item properties and `property` is not among them (unknown = keep). */
function itemOmits(spec: ChannelSpec, root: string, property: string): boolean {
  const schema = spec.validationSchema as Record<string, any> | undefined
  const deref = (node: any) => typeof node?.$ref === 'string' && node.$ref.startsWith('#/')
    ? node.$ref.slice(2).split('/').reduce((value: any, key: string) => value?.[key], schema) : node
  const items = deref(deref(schema?.properties?.[root])?.items)
  return !!items?.properties && typeof items.properties === 'object' && !Object.prototype.hasOwnProperty.call(items.properties, property)
}

/**
 * 2026-10-03 — the studio's Amazon message in the category schema's own shape. Every cached Amazon product type that
 * has variations (45 of 50: OUTERWEAR, COAT, HELMET, …) says:
 *  - with `parentage_level` set, `child_parent_sku_relationship` AND `variation_theme` are required on EVERY row: the
 *    parent carries `child_relationship_type` without `parent_sku`, a child names its parent's seller SKU;
 *  - `fulfillment_availability` and `variation_theme` items declare no `marketplace_id` and allow no other property.
 * The legacy row builder (the old flat-file route, unchanged) sends the theme on the parent only, and a `marketplace_id`
 * in both, so every studio family publish failed review. Pure; it never adds or changes a quantity.
 */
export function shapeAmazonStudioAttributes(spec: ChannelSpec, attributes: Record<string, unknown>, family: AmazonFamilyRow | null): Record<string, unknown> {
  const next = { ...attributes }
  for (const root of UNSCOPED_ITEM_ROOTS) {
    if (!Array.isArray(next[root]) || !itemOmits(spec, root, 'marketplace_id')) continue
    next[root] = (next[root] as unknown[]).map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item
      const { marketplace_id: _scoped, ...rest } = item as Record<string, unknown>
      return rest
    })
  }
  if (!family) return next
  const values: Record<string, unknown> = {}
  const put = (attribute: string, path: string[], value: unknown) => {
    const key = spec.fields.find(f => f.attribute === attribute && f.path.join('/') === path.join('/'))?.key
    if (key) values[key] = value
  }
  put('parentage_level', [], family.role)
  put('child_parent_sku_relationship', ['child_relationship_type'], 'variation')
  if (family.role === 'child') put('child_parent_sku_relationship', ['parent_sku'], family.parentSku)
  put('variation_theme', ['name'], family.theme)
  // The schema's own envelopes: a selector the item declares is filled, one it does not declare never appears.
  const shaped = attributesFromCells(spec, values)
  for (const root of ['parentage_level', 'child_parent_sku_relationship', 'variation_theme']) {
    if (shaped[root] !== undefined) next[root] = shaped[root]
  }
  return next
}
