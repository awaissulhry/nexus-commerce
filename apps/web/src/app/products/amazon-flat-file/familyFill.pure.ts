/**
 * FFT-I3 — family-uniform gap fill for the Amazon import wizard.
 *
 * Root cause of "the import is missing fields on some rows": Amazon's own
 * template downloads carry values only where AMAZON has them — never-listed
 * sizes arrive blank for columns like product_tax_code, and no import can
 * fill what neither the file nor the grid has. The family, however, usually
 * KNOWS the value: it is uniform across the listed siblings.
 *
 * This module finds columns where a family's children agree on exactly ONE
 * non-empty value while other children are blank (in the post-plan state),
 * and proposes fill cells for the blanks. The wizard shows the proposal as a
 * visible, toggleable line (default ON) and merges the cells into the apply —
 * operator-controlled, never silent.
 *
 * Never proposed: quantity (the pool governs), identity/system columns, and
 * per-row-by-nature columns (SKUs, ids, images, size/color axis values).
 */

export interface FamilyFillCell {
  /** Plan row key: 'upd:<rowId>' for existing rows, 'new:<sku>' for new rows. */
  rowKey: string
  sku: string
  columnId: string
  value: string
}

export interface FamilyFillSummary {
  cells: FamilyFillCell[]
  /** columnId → { value, count } for the strip breakdown. */
  byColumn: Record<string, { value: string; count: number }>
}

const NEVER_FILL = [
  /^item_sku$/, /^parent_sku$/, /^parentage_level$/, /^product_type$/,
  /^external_product_id/, /^update_delete$/, /^record_action$/,
  /^fulfillment_availability__quantity$/, /^quantity$/, /^follow$/, /^buffer$/,
  /^variation_theme$/,
  /size|color/i, // axis value columns are per-row by nature
  /^main_product_image_locator|^other_product_image_locator|image_locator/i,
  /_name$/i, // item_name / title-ish columns are per-row
]

const str = (v: unknown) => String(v ?? '').trim()

export function computeFamilyUniformFills(
  /** Effective post-plan rows: grid rows with plan cells already overlaid,
   *  plus plan new-rows. Each needs item_sku, parent_sku, parentage_level and
   *  the candidate columns; `rowKey` identifies the plan target. */
  rows: Array<{ rowKey: string; row: Record<string, unknown> }>,
  /** Candidate columns (typically the mapped/plan columns ∪ grid columns). */
  columnIds: string[],
  opts?: { minAgreeing?: number },
): FamilyFillSummary {
  const minAgreeing = opts?.minAgreeing ?? 2
  const candidates = columnIds.filter((id) => !NEVER_FILL.some((re) => re.test(id)))

  // Group CHILD rows by family (parent_sku).
  const families = new Map<string, Array<{ rowKey: string; row: Record<string, unknown> }>>()
  for (const entry of rows) {
    const parentage = str(entry.row.parentage_level).toLowerCase()
    const parentSku = str(entry.row.parent_sku)
    if (parentage === 'parent' || !parentSku) continue
    const arr = families.get(parentSku) ?? []
    arr.push(entry)
    families.set(parentSku, arr)
  }

  const cells: FamilyFillCell[] = []
  const byColumn: Record<string, { value: string; count: number }> = {}

  for (const [, children] of families) {
    if (children.length < minAgreeing + 1) continue
    for (const col of candidates) {
      const values = new Set<string>()
      let filled = 0
      const blanks: Array<{ rowKey: string; sku: string }> = []
      for (const { rowKey, row } of children) {
        const v = str(row[col])
        if (v) { values.add(v); filled++ }
        else blanks.push({ rowKey, sku: str(row.item_sku) })
      }
      if (values.size !== 1 || filled < minAgreeing || blanks.length === 0) continue
      const value = [...values][0]
      for (const b of blanks) cells.push({ rowKey: b.rowKey, sku: b.sku, columnId: col, value })
      const agg = byColumn[col] ?? { value, count: 0 }
      agg.count += blanks.length
      byColumn[col] = agg
    }
  }

  return { cells, byColumn }
}
