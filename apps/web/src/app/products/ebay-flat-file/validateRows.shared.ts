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
  /** Membership-synthesized read-back rows (extra shared listings). */
  _shared?: boolean
  parentage?: string
  parent_sku?: unknown
  shared_sku_listing?: unknown
}

/**
 * Import files carry booleans as text ('TRUE', 'VERO', '1', 'Sì'…) — the grid
 * checkbox and every strict `=== true` check need real booleans. Empty/null is
 * NOT truthy (and callers must leave it untouched so fill-missing still sees
 * the cell as empty).
 */
export function truthyFlag(v: unknown): boolean {
  if (v === true) return true
  if (typeof v === 'number') return v === 1
  if (typeof v === 'string') return /^(true|vero|wahr|vrai|verdadero|yes|y|x|si|sì|1)$/i.test(v.trim())
  return false
}

/**
 * Returns true iff the duplicate SKU is ALLOWED — i.e. the occurrences span at
 * least two DISTINCT families and EVERY occurrence belongs to a shared-SKU
 * family (parent flagged `shared_sku_listing`, in any spelling an import file
 * uses) or is a membership-synthesized `_shared` row. Two occurrences in the
 * same family, or any occurrence in a non-shared family, still count as a real
 * duplicate error.
 *
 * Family resolution handles all three row shapes:
 *  • saved families — children carry `platformProductId` → parent by id
 *  • file-linked families (imported, not yet saved) — children carry
 *    `parent_sku` only → parent by SKU
 *  • membership-synthesized rows — `_shared: true`, `parent_sku` set, no
 *    parent row in the grid → the parent_sku itself is the family identity
 */
export function isSharedDuplicateAllowed(sku: string, allRows: EbayRowMin[]): boolean {
  const occ = allRows.filter(r => String(r.sku ?? '').trim() === sku)
  if (occ.length < 2) return false

  const parentByKey = new Map<string, EbayRowMin>()
  const parentBySku = new Map<string, EbayRowMin>()
  for (const r of allRows) {
    if (r._isParent !== true && r.parentage !== 'parent') continue
    for (const k of [r._productId, r._rowId, r.platformProductId]) {
      if (k) parentByKey.set(String(k), r)
    }
    const ps = String(r.sku ?? '').trim()
    if (ps && !parentBySku.has(ps)) parentBySku.set(ps, r)
  }

  const familyKeys = new Set<string>()
  for (const o of occ) {
    const viaId = o.platformProductId ? parentByKey.get(String(o.platformProductId)) : undefined
    const linkSku = String(o.parent_sku ?? '').trim()
    const parent = viaId ?? (linkSku ? parentBySku.get(linkSku) : undefined)
    const famKey = parent
      ? String(parent._rowId ?? parent._productId ?? parent.platformProductId ?? parent.sku ?? '')
      : String(o.platformProductId ?? (linkSku || o._rowId || ''))
    familyKeys.add(famKey)
    const shared = o._shared === true || truthyFlag((parent ?? o).shared_sku_listing)
    if (!shared) return false
  }
  return familyKeys.size >= 2 // same family twice = real error
}
