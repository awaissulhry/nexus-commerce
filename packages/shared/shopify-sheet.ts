import type { InformationField, InformationRow } from './shopify-information.js'
import type { ShopifyLinkedDraft } from './shopify-linked-products.js'

/** Channel-specific addresses ride the common sheet contract; they never identify a shared write. */
export interface ShopifySheetWrite {
  ownerId: string
  fieldId: string
  token: string
  baseline: string | null
}
export interface ShopifySheetRow {
  productId: string
  listingId: string
}

/** Nexus measure units and Shopify's native weight enums describe the same magnitude. */
export function informationSheetValue(field: InformationField, value: unknown): unknown {
  if (field.definition || field.id !== 'weight' || value == null) return value
  let measure: unknown = value
  try { if (typeof measure === 'string') measure = JSON.parse(measure) } catch { return value }
  if (!measure || typeof measure !== 'object' || Array.isArray(measure)) return value
  const object = measure as Record<string, unknown>
  const units: Record<string, string> = { g: 'GRAMS', kg: 'KILOGRAMS', oz: 'OUNCES', lb: 'POUNDS' }
  const unit = typeof object.unit === 'string' ? units[object.unit] : undefined
  return unit ? JSON.stringify({ ...object, unit }) : value
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
