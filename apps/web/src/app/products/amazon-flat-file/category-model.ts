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
