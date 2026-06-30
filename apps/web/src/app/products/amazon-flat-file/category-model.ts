// category-model.ts
export const BROWSE_NODE_KEY = 'recommended_browse_nodes'
export const PRODUCT_TYPE_KEY = 'product_type'

export interface RowCategory { productType: string; nodeId: string | null; nodePath: string | null }

export function categoryOf(row: Record<string, unknown>, labels: Record<string, string>): RowCategory {
  const productType = String(row[PRODUCT_TYPE_KEY] ?? '')
  const raw = row[BROWSE_NODE_KEY]
  const nodeId = raw == null || raw === '' ? null : String(raw)
  return { productType, nodeId, nodePath: nodeId ? labels[nodeId] ?? null : null }
}

export function productTypesInUse(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    const t = String(r[PRODUCT_TYPE_KEY] ?? '').toUpperCase()
    if (t && !seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out
}

export function assignCategory(
  row: Record<string, unknown>,
  c: { productType: string; nodeId: string | null },
): Record<string, unknown> {
  return { ...row, [PRODUCT_TYPE_KEY]: c.productType.toUpperCase(), [BROWSE_NODE_KEY]: c.nodeId ?? '' }
}

/** Parent item_skus whose children span >1 distinct product type. */
export function mixedTypeFamilies(rows: Array<Record<string, unknown>>): string[] {
  const out: string[] = []
  for (const p of rows) {
    if (String(p.parentage_level ?? '') !== 'parent') continue
    const pSku = String(p.item_sku ?? '')
    if (!pSku) continue
    const types = new Set(
      rows
        .filter((r) => String(r.parentage_level ?? '') === 'child' && String(r.parent_sku ?? '') === pSku)
        .map((r) => String(r.product_type ?? '').toUpperCase())
        .filter(Boolean),
    )
    if (types.size > 1) out.push(pSku)
  }
  return out
}

/** Format a browse-node path for the Category chip: ' › ' separators, and when
 *  there are >3 levels, collapse the middle so the leaf is never lost:
 *  'A › B › C › D' -> 'A › … › C › D'. Returns '' for empty. */
export function formatNodeBreadcrumb(path: string | null | undefined): string {
  if (!path) return ''
  const segs = path.split('>').map((s) => s.trim()).filter(Boolean)
  if (segs.length === 0) return ''
  if (segs.length <= 3) return segs.join(' › ')
  return `${segs[0]} › … › ${segs[segs.length - 2]} › ${segs[segs.length - 1]}`
}

/** _rowIds of real (non-ghost, non-parent) rows that HAVE a product type but NO browse node. */
export function rowsMissingNode(rows: Array<Record<string, unknown>>): string[] {
  return rows
    .filter((r) =>
      !r._ghost &&
      String(r.parentage_level ?? '') !== 'parent' &&
      String(r.product_type ?? '') !== '' &&
      (r[BROWSE_NODE_KEY] == null || r[BROWSE_NODE_KEY] === ''),
    )
    .map((r) => String(r._rowId ?? ''))
    .filter(Boolean)
}
