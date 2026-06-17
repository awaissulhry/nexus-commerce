/**
 * FX.5 — import merge planner.
 *
 * Given the current grid rows (existing) and the mapped+coerced import rows
 * (incoming), compute a PLAN describing exactly what an apply would do — matched
 * by item_sku — so the wizard can show a per-row / per-cell diff and the
 * operator can choose what lands. The plan is mode-aware:
 *   • fill-missing — write only where the existing cell is BLANK (never
 *     overwrites existing data) — the default
 *   • overwrite    — write every mapped value, replacing what's there
 * A column allowlist (the operator's column selection) and addNewRows (whether
 * an unknown SKU becomes a new row) further scope it. Each shown cell carries a
 * willApply flag + reason so the UI can render + the apply step can act on it.
 *
 * Pure: no DB, no AI. The client sends its in-memory rows in and renders the
 * plan; per-cell toggles flip willApply locally, a mode/column change re-plans.
 */

export type ImportApplyMode = 'fill-missing' | 'overwrite'

export type PlanCellReason = 'fill' | 'overwrite' | 'skip-existing' | 'skip-column'

export interface PlanCell {
  columnId: string
  from: string
  to: string
  willApply: boolean
  reason: PlanCellReason
}

export interface PlanNewRow {
  sku: string
  cells: PlanCell[]
}

export interface PlanUpdate {
  sku: string
  /** The existing row's _rowId, echoed so the client can apply in place. */
  rowId: string
  cells: PlanCell[]
}

export interface ImportMergePlan {
  newRows: PlanNewRow[]
  updates: PlanUpdate[]
  /** Incoming rows with a blank match key — can't match or create. */
  skippedNoSku: number
  /** When addNewRows=false: incoming SKUs absent from the grid (ignored). */
  unmatchedSkipped: string[]
  stats: { newRows: number; updatedRows: number; cellsToApply: number; cellsToSkip: number }
}

export interface PlanOptions {
  mode: ImportApplyMode
  /** Allowlist of column ids the operator chose; null/empty = all incoming columns. */
  columns?: string[] | null
  /** Match key for row identity. Default 'item_sku'. */
  matchKey?: string
  /** Whether an incoming SKU absent from the grid becomes a new row. Default true. */
  addNewRows?: boolean
}

const META_KEYS = new Set(['_rowId', '_isNew', '_dirty', '_status', '_feedMessage', '_productId'])

const str = (v: unknown): string => (v == null ? '' : String(v))
const isBlank = (v: unknown): boolean => str(v).trim() === ''

export function planImportMerge(
  existing: Record<string, unknown>[],
  incoming: Record<string, unknown>[],
  options: PlanOptions,
): ImportMergePlan {
  const matchKey = options.matchKey ?? 'item_sku'
  const addNew = options.addNewRows !== false
  const allow = options.columns && options.columns.length ? new Set(options.columns) : null

  const bySku = new Map<string, Record<string, unknown>>()
  for (const r of existing) {
    const sku = str(r[matchKey]).trim()
    if (sku && !bySku.has(sku)) bySku.set(sku, r)
  }

  const newRows: PlanNewRow[] = []
  const updates: PlanUpdate[] = []
  const unmatchedSkipped: string[] = []
  let skippedNoSku = 0
  let cellsToApply = 0
  let cellsToSkip = 0
  const bump = (apply: boolean) => { if (apply) cellsToApply++; else cellsToSkip++ }

  for (const inc of incoming) {
    const sku = str(inc[matchKey]).trim()
    if (!sku) { skippedNoSku++; continue }
    const cols = Object.keys(inc).filter((k) => !META_KEYS.has(k))
    const match = bySku.get(sku)

    if (match) {
      const cells: PlanCell[] = []
      for (const columnId of cols) {
        const to = str(inc[columnId])
        const from = str(match[columnId])
        if (to === from || isBlank(to)) continue // unchanged or nothing to write
        let willApply: boolean
        let reason: PlanCellReason
        if (allow && !allow.has(columnId)) { willApply = false; reason = 'skip-column' }
        else if (options.mode === 'fill-missing' && !isBlank(from)) { willApply = false; reason = 'skip-existing' }
        else { willApply = true; reason = isBlank(from) ? 'fill' : 'overwrite' }
        cells.push({ columnId, from, to, willApply, reason })
        bump(willApply)
      }
      if (cells.length) updates.push({ sku, rowId: str(match['_rowId']), cells })
    } else if (addNew) {
      const cells: PlanCell[] = []
      for (const columnId of cols) {
        const to = str(inc[columnId])
        if (isBlank(to)) continue
        const willApply = !allow || allow.has(columnId)
        cells.push({ columnId, from: '', to, willApply, reason: willApply ? 'fill' : 'skip-column' })
        bump(willApply)
      }
      newRows.push({ sku, cells })
    } else {
      unmatchedSkipped.push(sku)
    }
  }

  return {
    newRows,
    updates,
    skippedNoSku,
    unmatchedSkipped,
    stats: { newRows: newRows.length, updatedRows: updates.length, cellsToApply, cellsToSkip },
  }
}
