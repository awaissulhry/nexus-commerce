import type { InformationField, InformationRow } from './shopify-information.js'
import type { ShopifyLinkedDraft } from './shopify-linked-products.js'
import { normalizeShopifyWeight, shopifyWeightUnit } from './shopify-weight.js'

/** Channel-specific addresses ride the common sheet contract; they never identify a shared write. */
export interface ShopifySheetWrite {
  ownerId: string
  fieldId: string
  token: string
  baseline: string | null
  /**
   * The cell's sharing facts, as the server read them: the source product of a primary product metafield's sharing rule
   * and whether this owner follows it. `null`: no sharing rule applies. Absent: the facts were not reported — never proof
   * of an own or a following value. Display/ordering facts only; never write authority.
   */
  sharing?: ShopifySharingFacts | null
}
export interface ShopifySharingFacts {
  sourceOwnerId: string
  follows: boolean
}
export interface ShopifySheetRow {
  productId: string
  listingId: string
}

/**
 * A Shared value as the native Shopify cell holds it. A weight is Shopify's JSON text with Shopify's unit code (a Shared
 * `{ value: 1.2, unit: 'kg' }` is `{"value":1.2,"unit":"KILOGRAMS"}`); a weight whose unit is not a weight unit is left as
 * it is, for the validator to name. Every other value is unchanged.
 */
export function informationSheetValue(field: InformationField, value: unknown): unknown {
  if (field.definition || field.id !== 'weight' || value == null) return value
  if (typeof value === 'string') return normalizeShopifyWeight(value)
  const weight = normalizeShopifyWeight(value)
  return weight && typeof weight === 'object' && !Array.isArray(weight) && shopifyWeightUnit((weight as Record<string, unknown>).unit) ? JSON.stringify(weight) : value
}

export function informationPendingValue(row: InformationRow, field: InformationField, draft: ShopifyLinkedDraft): string | null | undefined {
  if (row.locale) return draft.nativeEdits?.find(e => e.ownerId === row.id && e.translation?.fieldId === field.id && e.translation.locale === row.locale)?.nextValue
  if (field.id === 'media') {
    const edit = draft.mediaEdits?.find(e => e.productId === row.id)
    return edit ? JSON.stringify(edit) : undefined
  }
  if (field.definition) return draft.edits.find(e => e.ownerId === row.id && e.namespace === field.definition!.namespace && e.key === field.definition!.key)?.nextValue
  return draft.nativeEdits?.find(e => e.ownerId === row.id && e.field === field.id)?.nextValue
}
export function informationStoredValue(row: InformationRow, field: InformationField): string | null {
  if (row.locale && row.translations?.[field.id]) return row.translations[field.id].value
  if (field.id === 'media') return JSON.stringify({ productId: row.id, ownerLabel: row.title, value: row.media.map(m => m.id), nextValue: row.media.map(m => m.id) })
  if (field.definition) return row.fields.find(f => f.namespace === field.definition!.namespace && f.key === field.definition!.key)?.value ?? null
  return row.values[field.id] ?? null
}
