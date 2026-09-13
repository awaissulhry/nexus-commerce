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

import type { ChannelSheetRow, SheetColumn } from './types'

export { type ChipCells, type ChipDraft } from '../sheetChips'
import { buildSheetChips, type ChipCells } from '../sheetChips'

export function buildChannelChips(rows: ChannelSheetRow[], columns: SheetColumn[], mappingRun?: { skippedReason?: string | null; missingProductIds?: string[] } | null) {
  return buildSheetChips(rows, columns, mappingRun, { mapping: true, warningsId: 'channel-warnings' })
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
