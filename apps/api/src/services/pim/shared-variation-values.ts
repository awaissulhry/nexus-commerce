import { canonicalVariantAxis } from './variant-attribute-keys.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** R-23 (Step 2.6c) — a product's variation values as ONE bag, for readers that match raw axis keys. The
 * store (`categoryAttributes.variations`) wins; a legacy `variantAttributes` key fills in only for an axis
 * the store does not hold — compared by canonical axis, so a legacy `Taglia: 'XS'` never sits beside the
 * store's `Size: 'XXL'` (production, AIR-MESH-JACKET-MEN-XXL-BLACK). The raw-key twin of
 * `storedVariationValues`. */
export function variationBag(product: { categoryAttributes: unknown; variantAttributes: unknown }): Record<string, unknown> {
  const store = object(object(product.categoryAttributes).variations)
  const held = new Set(Object.keys(store).map(canonicalVariantAxis))
  const bag: Record<string, unknown> = { ...store }
  for (const [key, value] of Object.entries(object(product.variantAttributes))) {
    if (!held.has(canonicalVariantAxis(key))) bag[key] = value
  }
  return bag
}

/** A planned write of a product's variation values (R-23, Step 2.6c-2). `set` / `unset` address the ONE store,
 * `categoryAttributes.variations`. `legacyDrop` lists the legacy `variantAttributes` keys of every axis touched:
 * they are removed, never written, so a stale legacy value can never answer again for an axis that was edited
 * (`variationBag` lets the legacy bag fill in only for an axis the store lacks — a cleared store axis would
 * otherwise bring the old value back). Written by `writeVariationValues` (`category-attributes-write.ts`). */
export type VariationWritePlan = { set: Record<string, unknown>; unset: string[]; legacyDrop: string[]; changed: boolean }

function planVariationWrite(product: { categoryAttributes: unknown; variantAttributes: unknown },
  entries: ReadonlyArray<{ axis: string; value?: unknown; remove: boolean }>): VariationWritePlan {
  const variations = object(object(product.categoryAttributes).variations)
  const legacy = object(product.variantAttributes)
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  const legacyDrop: string[] = []
  for (const { axis, value, remove } of entries) {
    const canonical = canonicalVariantAxis(axis)
    // Every spelling the store already holds for this axis moves together, so the store never disagrees with itself.
    for (const key of new Set([axis, ...Object.keys(variations).filter(k => canonicalVariantAxis(k) === canonical)])) {
      if (remove) unset.push(key)
      else set[key] = value
    }
    for (const key of Object.keys(legacy)) if (canonicalVariantAxis(key) === canonical && !legacyDrop.includes(key)) legacyDrop.push(key)
  }
  return { set, unset, legacyDrop, changed: Object.keys(set).length > 0 || unset.length > 0 || legacyDrop.length > 0 }
}

/** Scalar edits and channel pushes address the same declared variation values. */
export function variationAttributePatch(
  product: { categoryAttributes: unknown; variantAttributes: unknown },
  axes: readonly string[],
  patch: Record<string, unknown>,
  remove: readonly string[],
): VariationWritePlan {
  const variations = object(object(product.categoryAttributes).variations)
  const legacy = object(product.variantAttributes)
  const entries: Array<{ axis: string; value?: unknown; remove: boolean }> = []
  for (const field of new Set([...Object.keys(patch), ...remove])) {
    const canonical = canonicalVariantAxis(field)
    // R-23 — an axis the product already holds is a variation value even when its family declares none
    // (`xracing`: `variationAxes = []`, every child stores `Size`). Declared-only, such an edit landed in
    // the flat key alone: shown on the sheet, never published.
    const axis = axes.find(key => canonicalVariantAxis(key) === canonical)
      ?? [...Object.keys(variations), ...Object.keys(legacy)].find(key => canonicalVariantAxis(key) === canonical)
    if (axis) entries.push({ axis, value: patch[field], remove: remove.includes(field) })
  }
  return planVariationWrite(product, entries)
}

/** A writer that names its axes directly (attach, organize, the variant-attributes route, auto-detect, bulk
 * "Set attribute"): these keys are set in the store, `deletes` are cleared, and each axis leaves the legacy bag. */
export function variationValuesPlan(
  product: { categoryAttributes: unknown; variantAttributes: unknown },
  writes: Record<string, unknown>,
  deletes: readonly string[] = [],
): VariationWritePlan {
  return planVariationWrite(product, [
    ...Object.entries(writes).map(([axis, value]) => ({ axis, value, remove: false })),
    ...deletes.map(axis => ({ axis, remove: true })),
  ])
}

/** Preserve stored order and append previously unseen values using the size/colour canon. */
export function completeAxisValueOrder(axis: string, stored: readonly string[], values: readonly string[]): string[] {
  const sizes = ['XXXS', '3XS', 'XXS', '2XS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL', '6XL']
  const compare = (a: string, b: string) => {
    if (canonicalVariantAxis(axis) === 'size') {
      const ai = sizes.indexOf(a.toUpperCase()), bi = sizes.indexOf(b.toUpperCase())
      if (ai >= 0 || bi >= 0) return (ai < 0 ? sizes.length : ai) - (bi < 0 ? sizes.length : bi)
    }
    return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })
  }
  const first = [...new Set(stored)]
  return [...first, ...[...new Set(values)].filter(value => !first.includes(value)).sort(compare)]
}
