import { canonicalVariantAxis } from './variant-attribute-keys.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Scalar edits and channel pushes address the same declared variation values. */
export function variationAttributePatch(
  product: { categoryAttributes: unknown; variantAttributes: unknown },
  axes: readonly string[],
  patch: Record<string, unknown>,
  remove: readonly string[],
) {
  const attributes = object(product.categoryAttributes)
  const variations = object(attributes.variations)
  const legacy = object(product.variantAttributes)
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  for (const field of new Set([...Object.keys(patch), ...remove])) {
    const canonical = canonicalVariantAxis(field)
    const axis = axes.find(key => canonicalVariantAxis(key) === canonical)
    if (!axis) continue
    const keys = new Set([axis, ...Object.keys(variations), ...Object.keys(legacy)]
      .filter(key => canonicalVariantAxis(key) === canonical))
    for (const key of keys) {
      if (remove.includes(field)) unset.push(key)
      else set[key] = patch[field]
    }
  }
  return { set, unset, changed: Object.keys(set).length > 0 || unset.length > 0 }
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
