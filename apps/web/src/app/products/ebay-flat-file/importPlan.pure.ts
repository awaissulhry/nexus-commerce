/**
 * EI.3 — import policies + destructive-action gating + cell-level merge plan
 * (pure, fully testable).
 *
 * Policies are column allowlists applied to the final import rows — the
 * operator decides per import whether prices / quantities / content / images /
 * policies come along. Identity + structure (sku, parentage, parent_sku,
 * theme, Shared-SKU flag, Item IDs, category) ALWAYS import — they define what
 * a row IS, not what it says.
 *
 * Destructive actions: rows whose `row_action` is `end` or `deactivate` would
 * take live listings down on the next push. They are EXCLUDED by default and
 * only enter the grid behind an explicit typed-END confirmation (mirrors the
 * Amazon wizard's typed-DELETE override; `skip` rows are harmless and import
 * normally).
 *
 * The cell plan computes exactly what an import will do to EXISTING grid rows
 * before it happens: per cell from → to under the chosen merge mode, with
 * per-cell exclusion (the operator's final word). New rows are listed whole.
 */

export interface ImportPolicy {
  id: 'prices' | 'quantities' | 'content' | 'images' | 'policies'
  label: string
  matches: (columnId: string) => boolean
}

export const IMPORT_POLICIES: ImportPolicy[] = [
  { id: 'prices', label: 'Prices', matches: (c) => /(^|_)price$/.test(c) || c === 'start_price' || c === 'best_offer_floor' },
  { id: 'quantities', label: 'Quantities', matches: (c) => /(^|_)qty$/.test(c) || c === 'quantity' || /_buffer$/.test(c) },
  { id: 'content', label: 'Content (title/subtitle/description)', matches: (c) => ['title', 'subtitle', 'description', 'description_theme'].includes(c) },
  { id: 'images', label: 'Images', matches: (c) => /^(image|picture)_/.test(c) || /_image(_\d+)?$/.test(c) },
  { id: 'policies', label: 'Business policies', matches: (c) => /_policy_id$/.test(c) || c === 'vat_percent' },
]

/** Columns that always import regardless of policies — row identity/structure. */
export const STRUCTURAL_COLUMNS = new Set([
  'sku', 'parentage', 'parent_sku', 'variation_theme', 'shared_sku_listing',
  'category_id', 'row_action', 'condition',
])

const isItemIdCol = (c: string) => /^(it|de|fr|es|uk)_(item_id|status|listing_id)$/.test(c) || c === 'ebay_item_id'

/** Strip cells whose policy toggle is OFF. Structural + identity always kept. */
export function filterRowsByPolicies(
  rows: Record<string, unknown>[],
  disabled: Set<ImportPolicy['id']>,
): Record<string, unknown>[] {
  if (disabled.size === 0) return rows
  const off = IMPORT_POLICIES.filter((p) => disabled.has(p.id))
  return rows.map((r) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      if (STRUCTURAL_COLUMNS.has(k) || isItemIdCol(k) || k.startsWith('_') || k.startsWith('aspect_')) {
        out[k] = v
        continue
      }
      if (off.some((p) => p.matches(k))) continue
      out[k] = v
    }
    return out
  })
}

export interface ActionRowsSummary {
  /** Row indexes carrying a destructive action (end / deactivate). */
  destructiveIndexes: number[]
  byAction: Record<string, number>
}

export function findDestructiveActionRows(rows: Record<string, unknown>[]): ActionRowsSummary {
  const destructiveIndexes: number[] = []
  const byAction: Record<string, number> = {}
  rows.forEach((r, i) => {
    const action = String(r.row_action ?? '').trim().toLowerCase()
    if (action === 'end' || action === 'deactivate') {
      destructiveIndexes.push(i)
      byAction[action] = (byAction[action] ?? 0) + 1
    }
  })
  return { destructiveIndexes, byAction }
}

/** Drop destructive rows unless the operator armed the typed override. */
export function applyDestructiveGate(
  rows: Record<string, unknown>[],
  summary: ActionRowsSummary,
  armed: boolean,
): Record<string, unknown>[] {
  if (armed || summary.destructiveIndexes.length === 0) return rows
  const drop = new Set(summary.destructiveIndexes)
  return rows.filter((_, i) => !drop.has(i))
}

export interface CellChange {
  sku: string
  columnId: string
  from: string
  to: string
  /** false when fill-missing keeps the existing non-empty value. */
  willApply: boolean
}

export interface ImportCellPlan {
  changes: CellChange[]
  newRowSkus: string[]
  /** cells that WILL apply (excluding fill-missing-kept ones). */
  applyCount: number
}

const cellStr = (v: unknown): string => (v == null ? '' : String(v))

/**
 * Per-cell diff of the import against existing grid rows (matched by SKU —
 * first occurrence wins, mirroring the merge). `mode` mirrors handleImport:
 * fill-missing only fills empty cells; overwrite replaces on difference. The
 * structural Shared-SKU flag applies in BOTH modes (applyStructural parity).
 */
export function planImportCells(
  importRows: Record<string, unknown>[],
  existingRows: Record<string, unknown>[],
  mode: 'fill-missing' | 'overwrite',
): ImportCellPlan {
  const bySku = new Map<string, Record<string, unknown>>()
  for (const r of existingRows) {
    const sku = cellStr(r.sku).trim()
    if (sku && !bySku.has(sku)) bySku.set(sku, r)
  }
  const changes: CellChange[] = []
  const newRowSkus: string[] = []
  for (const imp of importRows) {
    const sku = cellStr(imp.sku).trim()
    const existing = sku ? bySku.get(sku) : undefined
    if (!existing) {
      if (sku) newRowSkus.push(sku)
      continue
    }
    for (const [k, v] of Object.entries(imp)) {
      if (k.startsWith('_') || k === 'sku') continue
      const from = cellStr(existing[k])
      const to = cellStr(v)
      if (to === '' || from === to) continue
      const structuralShared = k === 'shared_sku_listing'
      const willApply = mode === 'overwrite' || from === '' || structuralShared
      changes.push({ sku, columnId: k, from, to, willApply })
    }
  }
  return { changes, newRowSkus, applyCount: changes.filter((c) => c.willApply).length }
}

/** Remove operator-excluded cells ("sku|columnId") from the import rows. */
export function pruneExcludedCells(
  rows: Record<string, unknown>[],
  excluded: Set<string>,
): Record<string, unknown>[] {
  if (excluded.size === 0) return rows
  return rows.map((r) => {
    const sku = cellStr(r.sku).trim()
    if (!sku) return r
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      if (excluded.has(`${sku}|${k}`)) continue
      out[k] = v
    }
    return out
  })
}
