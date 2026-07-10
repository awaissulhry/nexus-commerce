/**
 * EFX P6 — pure derivation of the images-drawer family list from the grid's
 * CURRENT rows (latestRowsRef), replacing the old initialRows-only
 * derivedProductIds so families added/removed after page load (imports,
 * re-parenting, Add-listing) appear in the drawer.
 *
 * Kept in a separate module so vitest can import it without loading the full
 * React client (EbayFlatFileClient.tsx) and its JSX / path-alias deps.
 *
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/imageFamilies.vitest.test.ts
 */

export interface ImageFamilySummary {
  /** Family root productId — what the images workspace + publish key on. */
  productId: string
  /** Parent row's SKU ('' when the parent row isn't in the sheet). */
  parentSku: string
  /** Parent row's title ('' when absent). */
  title: string
  /** Number of variant child rows currently in the sheet for this family. */
  variantCount: number
  /**
   * Whether the family has an eBay ChannelListing. Only set on families added
   * via the drawer's "Add family" picker (the /products/lookup endpoint reports
   * it); left undefined for sheet-derived families (already in an eBay view).
   * `false` = DRAFT: images can be curated + saved but not published until the
   * listing is created via the flat-file push.
   */
  hasEbayListing?: boolean
}

/** Minimal row shape — mirrors the fields derivedProductIds/familyParentIds read. */
export interface FamilyDeriveRow {
  /** true on the family container (no parentId); false on variant children. */
  _isParent?: boolean
  /** P2.B2 — explicit parentage column: 'parent' | 'child' | '' | undefined */
  parentage?: '' | 'parent' | 'child'
  _productId?: unknown
  /** On child rows this is the PARENT's product id. */
  platformProductId?: unknown
  sku?: unknown
  title?: unknown
  /** P2.B2 — parent row's SKU on child rows (fallback grouping key). */
  parent_sku?: unknown
}

function asString(v: unknown): string {
  return v == null ? '' : String(v)
}

/**
 * One entry per unique family root in the sheet, in row order.
 *
 * Parent detection accepts BOTH the legacy `_isParent === true` flag and the
 * P2.B2 `parentage === 'parent'` convention (same robustness rule as
 * deriveAxes). `familyId` (single-family mode) is always included first even
 * when its parent row isn't rendered — matching the old derivedProductIds.
 */
export function deriveImageFamilies(
  rows: FamilyDeriveRow[],
  familyId?: string | null,
): ImageFamilySummary[] {
  const out = new Map<string, ImageFamilySummary>()
  if (familyId) out.set(familyId, { productId: familyId, parentSku: '', title: '', variantCount: 0 })

  // Pass 1 — parent rows establish the families (+ sku → id for the
  // parent_sku fallback below).
  const skuToId = new Map<string, string>()
  for (const r of rows) {
    const isParent = typeof r._isParent === 'boolean' ? r._isParent : r.parentage === 'parent'
    if (!isParent) continue
    const id = asString(r._productId ?? r.platformProductId)
    if (!id) continue
    const sku = asString(r.sku)
    const existing = out.get(id)
    if (existing) {
      // familyId placeholder (or a duplicate parent row) — fill in the blanks.
      if (!existing.parentSku) existing.parentSku = sku
      if (!existing.title) existing.title = asString(r.title)
    } else {
      out.set(id, { productId: id, parentSku: sku, title: asString(r.title), variantCount: 0 })
    }
    if (sku && !skuToId.has(sku)) skuToId.set(sku, id)
  }

  // Pass 2 — count variant children. Children carry the parent's id in
  // platformProductId; P2.B2 rows that haven't been back-filled fall back to
  // parent_sku.
  for (const r of rows) {
    const isChild = typeof r._isParent === 'boolean' ? !r._isParent : r.parentage === 'child'
    if (!isChild) continue
    const byId = asString(r.platformProductId)
    let target = byId && out.has(byId) ? byId : undefined
    if (!target) {
      const ps = asString(r.parent_sku)
      if (ps) target = skuToId.get(ps)
    }
    if (target) out.get(target)!.variantCount++
  }

  return [...out.values()]
}

/**
 * Merge the sheet-derived families with the ones the operator added via the
 * drawer's "Add family" picker, de-duped by productId. Derived families win on
 * collision (they carry the live sheet variantCount + parent SKU/title); a
 * picker-added family whose id already appears in the sheet is dropped, so the
 * same family never renders twice. Order: all derived first (sheet order),
 * then the added ones in add order.
 */
export function mergeImageFamilies(
  derived: ImageFamilySummary[],
  added: ImageFamilySummary[],
): ImageFamilySummary[] {
  const seen = new Set<string>()
  const out: ImageFamilySummary[] = []
  for (const f of derived) {
    if (!f.productId || seen.has(f.productId)) continue
    seen.add(f.productId)
    out.push(f)
  }
  for (const f of added) {
    if (!f.productId || seen.has(f.productId)) continue
    seen.add(f.productId)
    out.push(f)
  }
  return out
}
