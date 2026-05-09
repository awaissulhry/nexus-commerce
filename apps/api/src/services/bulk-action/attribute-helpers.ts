/**
 * W1.8 — ATTRIBUTE_UPDATE helpers extracted from
 * bulk-action.service.ts. These are pure functions: no `this.`, no
 * Prisma. Used by the ATTRIBUTE_UPDATE handler + its preview path.
 */

/**
 * C.9 — strict allowlist for ATTRIBUTE_UPDATE scalar Product columns.
 * Anything else in the attributeName payload is interpreted as a
 * one-level dot-path inside categoryAttributes (e.g.
 * `categoryAttributes.material`). FK columns / IDs / version /
 * status / pricing fields are intentionally excluded — those have
 * dedicated action types (STATUS_UPDATE, PRICING_UPDATE, …) or are
 * not safe for bulk write.
 */
export const ATTRIBUTE_SCALAR_ALLOWLIST: ReadonlySet<string> = new Set([
  'name',
  'brand',
  'manufacturer',
  'productType',
  'hsCode',
  'countryOfOrigin',
  'fulfillmentMethod',
  'weightValue',
  'weightUnit',
  'dimLength',
  'dimWidth',
  'dimHeight',
  'dimUnit',
])

export const CATEGORY_ATTRIBUTES_PREFIX = 'categoryAttributes.'
// P1 #52 — variantAttributes path lets bulk ATTRIBUTE_UPDATE write
// per-child-row variant values (e.g., Color, Size) on Product child
// rows. Same shape as categoryAttributes but on a different JSON
// column. Use `variantAttributes.Color` etc. as the attributeName.
export const VARIANT_ATTRIBUTES_PREFIX = 'variantAttributes.'

export type ProductLike = {
  categoryAttributes?: unknown
  variantAttributes?: unknown
  [key: string]: unknown
}

/**
 * Read the current value of the attribute referenced by attributeName.
 * Returns kind='unsupported' for keys outside the allowlist + the
 * categoryAttributes / variantAttributes prefixes so callers can
 * surface a clear preview skip without writing.
 */
export function readProductAttribute(
  product: ProductLike,
  attributeName: string,
): {
  currentValue: unknown
  kind: 'scalar' | 'categoryAttribute' | 'variantAttribute' | 'unsupported'
  /** When kind is a JSON-path variant, the inner key (after the prefix). */
  jsonKey?: string
} {
  if (ATTRIBUTE_SCALAR_ALLOWLIST.has(attributeName)) {
    return {
      currentValue: product[attributeName] ?? null,
      kind: 'scalar',
    }
  }
  if (attributeName.startsWith(CATEGORY_ATTRIBUTES_PREFIX)) {
    const jsonKey = attributeName.slice(CATEGORY_ATTRIBUTES_PREFIX.length)
    if (jsonKey.length === 0) {
      return { currentValue: null, kind: 'unsupported' }
    }
    const raw = product.categoryAttributes
    const obj =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    return {
      currentValue: obj[jsonKey] ?? null,
      kind: 'categoryAttribute',
      jsonKey,
    }
  }
  if (attributeName.startsWith(VARIANT_ATTRIBUTES_PREFIX)) {
    const jsonKey = attributeName.slice(VARIANT_ATTRIBUTES_PREFIX.length)
    if (jsonKey.length === 0) {
      return { currentValue: null, kind: 'unsupported' }
    }
    const raw = product.variantAttributes
    const obj =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    return {
      currentValue: obj[jsonKey] ?? null,
      kind: 'variantAttribute',
      jsonKey,
    }
  }
  return { currentValue: null, kind: 'unsupported' }
}
