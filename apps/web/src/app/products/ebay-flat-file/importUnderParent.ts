/**
 * stampUnderParent — pure helper used in handleImport's new-row branch.
 * When the operator chooses "Import under parent" the new row is stamped
 * with the chosen parent's product id and _isParent=false so the grid
 * treats it as a variant of that family rather than a standalone listing.
 *
 * Caller is responsible for the guard (only call when targetParentId is
 * a non-empty string). The function is extracted so it can be unit-tested
 * independently of the EbayFlatFileClient closure.
 *
 * @param parentSku - the parent row's SKU; written to `parent_sku` so the
 *   explicit column is populated immediately (falls back to '' if unknown).
 */
export function stampUnderParent(
  row: Record<string, unknown>,
  targetParentId: string,
  parentSku = '',
): Record<string, unknown> {
  return {
    ...row,
    platformProductId: targetParentId,
    _isParent: false,
    parentage: 'child',
    parent_sku: parentSku,
  }
}
