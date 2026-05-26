// FL.1.3 — Manifest parentage reader (pure).
//
// Routes a field to PARENT (one value, variants inherit) or CHILD (lives
// in the variant grid, one value per variant) by reading the Amazon
// flat-file manifest's `applicableParentage` tag
// ('VARIATION_PARENT' | 'VARIATION_CHILD' | 'STANDALONE'). eBay aspects
// pass their variant-defining flag through the same helper.
//
// Rule:
//   - CHILD  when the field applies to children but NOT the parent
//            (e.g. price, quantity, the variant's own image) — these
//            genuinely differ per variant.
//   - PARENT otherwise (the ~90% case): parent-applicable fields,
//            standalone-only fields, and anything untagged. Variants
//            inherit, so the field is one row in the field matrix.

export type FieldParentage = 'PARENT' | 'CHILD'

export type AmazonParentageTag = 'VARIATION_PARENT' | 'VARIATION_CHILD' | 'STANDALONE'

export function parentageFromTags(
  tags: readonly string[] | null | undefined,
): FieldParentage {
  if (!tags || tags.length === 0) return 'PARENT'
  const hasChild = tags.includes('VARIATION_CHILD')
  const hasParent = tags.includes('VARIATION_PARENT')
  // Child-applicable but not parent-applicable → genuinely per-variant.
  if (hasChild && !hasParent) return 'CHILD'
  return 'PARENT'
}

/** eBay: a variant-defining aspect (the axes, e.g. Size/Colour) is CHILD;
 *  every other aspect is PARENT. */
export function parentageFromEbayAspect(isVariantDefining: boolean): FieldParentage {
  return isVariantDefining ? 'CHILD' : 'PARENT'
}
