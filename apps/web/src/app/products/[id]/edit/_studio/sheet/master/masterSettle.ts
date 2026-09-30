/**
 * Audit B27 (2026-09-30) — the Master sheet's half of P2's "patch the edited rows from the save answer".
 *
 * Every confirmed Master save used to read the whole sheet again (`GET /studio/sheet`, every row replaced, every column
 * rebuilt). The channel sheet settles a save in place when its answer describes the result (`channel/savedCellPatch.ts`);
 * this is the same rule for the Master scope, where the value setter already painted the cell exactly as the server
 * folds it (`master/columns.tsx`: this row's own value — layer `variant` and pinned on a variation, `master` on the
 * family row; `studio-sheet.service.ts` `layerFor` and its `pinned` rule). What the answer cannot describe still reads
 * the sheet once:
 *
 *  - anything but an explicit value (`set`): a reset or a clear shows what the row inherits, which only a read knows;
 *  - a family row with variations: the variations that inherit the value change with it;
 *  - a translated or language cell (other languages fall back to it), a formula, the variation theme, a slot list, the
 *    product's category or type (they decide the columns);
 *  - a required field filled, or a row whose count disagrees with the cell (its progress moves as only the server counts);
 *  - an answer that refused, warned, cascaded, normalised or stored nothing new.
 *
 * Pure: no React, no grid at runtime.
 */
import { presentValue } from '../channel/savedCellPatch'
import { saveWarningFor } from '../saveWarnings'
import { priorCellOf } from '../sheetUndo'
import type { SheetColumn, StudioRow } from './types'

export interface MasterSavedChange { colId: string; field: string; value: unknown; intent?: string }

export type MasterSettle = { kind: 'patch'; apply: () => void } | { kind: 'read'; reason: string }

/** Columns whose value decides which columns the sheet has, or who inherits what: their save always reads. */
const STRUCTURE_KEYS = new Set(['productType', 'categoryId', 'categories', 'family', 'familyId', 'variationAxes', 'variation_theme'])

const read = (reason: string): MasterSettle => ({ kind: 'read', reason })

export function planMasterSettle({ row, changes, column, body }: {
  row: StudioRow
  changes: readonly MasterSavedChange[]
  column: (colId: string) => SheetColumn | undefined
  /** The save's answer (a 200). */
  body: unknown
}): MasterSettle {
  const answer = (body ?? {}) as Record<string, unknown>
  if (Array.isArray(answer.errors) && answer.errors.length) return read('the answer refused a cell')
  if (Number(answer.unchanged ?? 0) > 0 || !(Number(answer.updated ?? 0) >= 1)) return read('the answer stored nothing new')
  if (Number(answer.cascadeCount ?? 0) > 0 || (Array.isArray(answer.affectedChildren) ? answer.affectedChildren.length : Number(answer.affectedChildren ?? 0)) > 0) return read('the save cascaded')
  if (Array.isArray(answer.normalizedChanges) && answer.normalizedChanges.length) return read('the server normalised a value')
  if (answer.versionOf !== undefined && answer.versionOf !== 'product') return read('the answer is about another record')
  if (!changes.length) return read('nothing stored')
  if (row.isParent && row.childCount > 0) return read('a family row: its variations inherit the value')
  const steps: Array<() => void> = []
  for (const change of changes) {
    const col = column(change.colId)
    const cell = row.values[change.colId]
    if (!col || !cell) return read(`${change.colId}: no column or cell`)
    if (change.intent !== undefined && change.intent !== 'set') return read(`${change.colId}: a ${change.intent}`)
    if (!presentValue(change.value)) return read(`${change.colId}: a clear`)
    if (saveWarningFor(body, row.id, [change.field, change.colId])) return read(`${change.colId}: stored with a warning`)
    if (col.kind === 'variationTheme' || (col as { axis?: boolean }).axis || col.slot || STRUCTURE_KEYS.has(col.key) || STRUCTURE_KEYS.has(change.field))
      return read(`${change.colId}: theme, axis, slot or structure column`)
    if (col.locale || cell.tier || cell.translation || cell.contentVersion !== undefined || cell.linkGroupId != null ||
        (cell as { formula?: unknown }).formula || (cell as { formulaError?: unknown }).formulaError) return read(`${change.colId}: not a plain value cell`)
    if (row.readiness?.issues?.some((issue) => issue.key === col.key)) return read(`${change.colId}: the row names an issue on it`)
    const missing = row.completeness?.optional?.missing?.some((entry) => entry.key === col.key)
    if (row.completeness?.required?.missing?.some((entry) => entry.key === col.key)) return read(`${change.colId}: fills a required field`)
    // The value setter already replaced the cell; the row counted the one it replaced.
    const before = priorCellOf(cell) as { value?: unknown } | undefined
    if (before && presentValue(before.value) === !!missing) return read(`${change.colId}: the row's count disagrees with the cell`)
    if (missing) steps.push(() => fillOptional(row, col))
  }
  return { kind: 'patch', apply: () => { for (const step of steps) step() } }
}

/** A first value in an optional field the row counted as missing: the server's `completenessFor`, by one. */
function fillOptional(row: StudioRow, col: SheetColumn): void {
  const c = row.completeness as (StudioRow['completeness'] & { byGroup?: Array<{ group: string; filled: number; total: number }> }) | undefined
  if (!c?.optional || !c.overall) return
  const filled = c.overall.filled + 1
  row.completeness = {
    ...c,
    overall: { ...c.overall, filled, pct: c.overall.total > 0 ? Math.round((filled / c.overall.total) * 100) : 100 },
    optional: { ...c.optional, filled: c.optional.filled + 1, missing: c.optional.missing.filter((entry) => entry.key !== col.key) },
    ...(c.byGroup ? { byGroup: c.byGroup.map((g) => (g.group === (col as { group?: string }).group ? { ...g, filled: g.filled + 1 } : g)) } : {}),
  }
}

/**
 * One row's save, which can leave in several parts (one per language, the variation theme by its own route). Settled in
 * place only when EVERY cell it sent was reported patched; a part that reports nothing or asks for a read makes the
 * sheet read — the channel sheet's `rowSettle`, for Master rows.
 */
export function masterRowSettle(cells: ReadonlyArray<{ colId: string }>) {
  const covered = new Set<string>()
  const steps: Array<() => void> = []
  let readReason: string | null = null
  return {
    onStored(colIds: readonly string[], plan: MasterSettle): void {
      if (plan.kind === 'read') { readReason ??= plan.reason; return }
      steps.push(plan.apply)
      for (const colId of colIds) covered.add(colId)
    },
    /** The columns to repaint when the whole save settled in place (its patches applied); `null`: the sheet reads. */
    inPlace(ok: boolean): string[] | null {
      if (!ok || readReason !== null || !cells.every((cell) => covered.has(cell.colId))) return null
      for (const step of steps) step()
      return [...covered]
    },
    get readReason() { return readReason },
  }
}
