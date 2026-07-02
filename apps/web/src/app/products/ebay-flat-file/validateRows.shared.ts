/**
 * Pure validation helpers for the eBay flat-file editor.
 * Kept in a separate module so vitest can import them without loading
 * the full React component (EbayFlatFileClient.tsx) and its heavy deps.
 * Shared-SKU task 6 (Phase 3 unblock-persist plan).
 */

/** Minimal subset of EbayRow fields needed by the pure helpers. */
export interface EbayRowMin {
  sku?: unknown
  platformProductId?: string
  _productId?: string
  _rowId?: string
  _isParent?: boolean
  shared_sku_listing?: boolean
}

/**
 * Returns true iff the duplicate SKU is ALLOWED — i.e. every occurrence belongs
 * to a DISTINCT family whose parent row has `shared_sku_listing === true`.
 * Two occurrences in the same family, or any family without shared_sku_listing,
 * still count as a real duplicate error.
 */
export function isSharedDuplicateAllowed(sku: string, allRows: EbayRowMin[]): boolean {
  const occ = allRows.filter(r => String(r.sku ?? '').trim() === sku)
  if (occ.length < 2) return false
  const familyKeyOf = (r: EbayRowMin) => String(r.platformProductId ?? r._productId ?? r._rowId ?? '')
  const keys = new Set(occ.map(familyKeyOf))
  if (keys.size < 2) return false // same family twice = real error
  const parentSharedByKey = (key: string) => {
    const parent = allRows.find(
      r => r._isParent === true && String(r._productId ?? r._rowId ?? r.platformProductId ?? '') === key
    )
    return (parent ?? occ.find(o => familyKeyOf(o) === key))?.shared_sku_listing === true
  }
  return [...keys].every(parentSharedByKey)
}
