/**
 * These authorable listing facts have a draft store independent of Amazon's update permission.
 * This is deliberately an allow-list of attribute drafts, not Product/Offer/listing identities
 * or the shared parent relationship. Observations and unknown fields keep their locks.
 * Column/row rules still apply, and publication uses the schema for the whole attribute root.
 * Item 12 (2026-10-05): the relationship type and parent SKU are no longer drafts — they are read-only system values
 * from the family (`sheet-columns.service.ts`), so a direct write is refused and nothing is stored.
 */
const DRAFT_FACTS = new Set(['brand', 'condition_type', 'externally_assigned_product_identifier',
  'externally_assigned_product_identifier__type'])

export function amazonImmutableDraftWarning(input: {
  channel?: string
  externalListingId?: string | null
  fieldKey?: string
  editableOnExisting?: boolean
  rootImmutable?: boolean
}): string | null {
  const key = input.fieldKey ?? ''
  if (input.channel !== 'AMAZON' || !input.externalListingId || (input.editableOnExisting !== false && !input.rootImmutable) || !DRAFT_FACTS.has(key)) return null
  return `${key.split('__')[0]} cannot be edited on an existing Amazon listing. You can save a draft here, but cannot publish this change.`
}
