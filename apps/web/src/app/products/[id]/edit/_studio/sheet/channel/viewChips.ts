/**
 * PES.3 — the channel scope's View-bar chips.
 *
 * Hub ruling #34: the frame ships the registry (`useRegisterViewChip` / `useViewChips`); the
 * PRODUCER owns the count and the cells, and the frame computes nothing. This is that producer for
 * a channel scope, and it is pure so the honesty rules below are testable.
 *
 * ── The honest-count rule, which is the whole point ─────────────────────────────────────────────
 * `count: null` means NOBODY HAS COUNTED — the chip renders with no number and stays visible.
 * `count: 0` means counted, and there are none — hidden by `hideWhenZero`. Printing "(0)" for an
 * uncounted chip states "we checked, there are none" on the strength of not having checked, and
 * hiding an uncounted chip answers "none" just as silently.
 *
 * So: if the server sent no readiness for a row, this does not treat that row as clean. It counts
 * nothing and says why in `note`.
 *
 * ── Cells are CELL-level ────────────────────────────────────────────────────────────────────────
 * `{byRow: {rowId: [colId]}}`, per #34 — from `{rows, cols}` you cannot recover WHICH cell in the
 * rectangle was the reason, and the filter needs exactly that.
 *
 * ── A cell you cannot reach is not a cell you can count ─────────────────────────────────────────
 * A readiness issue names a field key. If that key is not one of the scope's columns, the operator
 * cannot be taken to it, so counting it would promise a destination that does not exist. Those are
 * excluded from the count and reported in `note` instead of being silently dropped.
 */

import type { ChannelSheetRow, SheetColumn, StudioCellValue } from './types'

/** Mirrors the frame's `ViewChipCells` without importing across the lane boundary for a type. */
export interface ChipCells {
  byRow: Record<string, string[]>
}

export interface ChipDraft {
  id: string
  label: string
  tone?: 'warning' | 'danger' | 'info' | 'neutral'
  count: number | null
  hideWhenZero?: boolean
  note?: string
  cells: ChipCells
}

interface Accum {
  byRow: Record<string, string[]>
  cells: number
  /** Issue keys that are not columns on this scope — real, but not reachable from this sheet. */
  unreachable: Set<string>
}

const empty = (): Accum => ({ byRow: {}, cells: 0, unreachable: new Set() })

function add(acc: Accum, rowId: string, colId: string): void {
  const list = acc.byRow[rowId] ?? (acc.byRow[rowId] = [])
  if (!list.includes(colId)) {
    list.push(colId)
    acc.cells++
  }
}

/**
 * True when every row carried a readiness object. When one did not, the scope is NOT counted —
 * a partial count reported as a total is the dishonest half of this contract.
 */
function fullyCounted(rows: ChannelSheetRow[]): boolean {
  return rows.every((r) => !!r.readiness && Array.isArray(r.readiness.issues))
}

function noteFor(counted: boolean, acc: Accum, why: string): string | undefined {
  if (!counted) return why
  if (acc.unreachable.size > 0) {
    const keys = [...acc.unreachable].sort().join(', ')
    return `${acc.unreachable.size} more on fields this view does not show (${keys}) — switch view to reach them`
  }
  return undefined
}

/**
 * Build the channel scope's chips from the rows it already holds.
 *
 * No fetch, no second source of truth: readiness comes from the same payload the grid renders, so
 * the chip and the cells it filters to cannot disagree.
 */
export function buildChannelChips(
  rows: ChannelSheetRow[],
  columns: SheetColumn[],
  mappingRun?: { skippedReason?: string | null; missingProductIds?: string[] } | null,
): ChipDraft[] {
  const colIds = new Set(columns.map((c) => c.key))
  const counted = fullyCounted(rows)
  const requiredCounted = rows.every((r) => Array.isArray(r.completeness?.required?.missing))

  const required = empty()
  const invalid = empty()
  const warnings = empty()
  const mapping = empty()

  for (const row of rows) {
    const missing = new Set(row.completeness?.required?.missing?.map((m) => m.key) ?? [])
    for (const key of missing) {
      if (colIds.has(key)) add(required, row.rowId, key)
      else required.unreachable.add(key)
    }
    for (const issue of row.readiness?.issues ?? []) {
      if (missing.has(issue.key) && issue.severity === 'error') continue
      const target = issue.severity === 'error' ? invalid : warnings
      if (!colIds.has(issue.key)) {
        target.unreachable.add(issue.key)
        continue
      }
      add(target, row.rowId, issue.key)
    }
    // The mapping engine's own verdict, read never computed (layout §1).
    for (const [colId, cell] of Object.entries(row.values) as Array<[string, StudioCellValue]>) {
      if (!colIds.has(colId)) continue
      if ((cell.mapped?.mappingErrors ?? cell.mapped?.errors ?? []).length > 0) add(mapping, row.rowId, colId)
    }
  }

  return [
    {
      id: 'missing-required',
      label: 'Missing required',
      // §6.2 rule 1 (#362), the MASTER rule, applied here too (CH.1): a count of WORK is a view, not
      // an alarm. Master and channel now draw this chip identically; Warnings and Mapping errors
      // keep their glyphs because they ARE alarms.
      tone: 'neutral',
      count: requiredCounted ? required.cells : null,
      hideWhenZero: true,
      note: noteFor(
        requiredCounted,
        required,
        'Readiness has not been computed for every row yet — this is not a count of zero',
      ),
      cells: { byRow: required.byRow },
    },
    {
      id: 'validation-errors',
      label: 'Invalid values',
      tone: 'danger',
      count: counted ? invalid.cells : null,
      hideWhenZero: true,
      note: noteFor(counted, invalid, 'Validation has not been computed for every row yet'),
      cells: { byRow: invalid.byRow },
    },
    {
      id: 'channel-warnings',
      label: 'Warnings',
      // `neutral`, the same as master's Warnings chip (CH.1): a count of WORK, not an alarm (§6.2 rule 1).
      tone: 'neutral',
      count: counted ? warnings.cells : null,
      hideWhenZero: true,
      note: noteFor(
        counted,
        warnings,
        'Readiness has not been computed for every row yet — this is not a count of zero',
      ),
      cells: { byRow: warnings.byRow },
    },
    {
      id: 'mapping-errors',
      label: 'Mapping errors',
      tone: 'danger',
      // Null cells also occur when enrichment failed. Only a complete mapping run is counted.
      count: mappingRun === null || mappingRun?.skippedReason || mappingRun?.missingProductIds?.length ? null : mapping.cells,
      hideWhenZero: true,
      note: mappingRun === null ? 'Mapping has not been checked for this scope yet' : mappingRun?.skippedReason ?? (mappingRun?.missingProductIds?.length
        ? 'Mapping has not been checked for every product yet'
        : 'The mapping result has an error. Open Channel mapping to review the source rule and preview value.'),
      cells: { byRow: mapping.byRow },
    },
  ]
}

/**
 * The rows a chip's filter should leave on screen.
 *
 * ⚠ Tree-aware on purpose. The grid is `treeData` with the alias band as the group node, so a
 * matching variant whose band is filtered out becomes an orphan: AG has no parent to hang it under
 * and the row silently disappears — the filter would then show FEWER cells than the chip counted,
 * which is the chip lying by a different route. Bands of matching rows are always kept.
 */
export function rowsForChip(rows: ChannelSheetRow[], cells: ChipCells): ChannelSheetRow[] {
  const matched = new Set(Object.keys(cells.byRow).filter((k) => (cells.byRow[k] ?? []).length > 0))
  if (matched.size === 0) return []
  const keepAlias = new Set<string>()
  for (const r of rows) if (matched.has(r.rowId)) keepAlias.add(r.aliasId ?? 'primary')
  return rows.filter(
    (r) => matched.has(r.rowId) || (r.rowKind === 'parent' && keepAlias.has(r.aliasId ?? 'primary')),
  )
}

/** Does this cell belong to the active chip? Drives the cell tint while a chip is on. */
export function chipHasCell(cells: ChipCells, rowId: string, colId: string): boolean {
  return (cells.byRow[rowId] ?? []).includes(colId)
}
