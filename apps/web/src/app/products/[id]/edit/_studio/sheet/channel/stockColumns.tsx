'use client'

/**
 * Amazon sheet gaps (gaps 4–5) — the product sheet's Mode / Qty / Buffer columns ARE the Matrix's columns: the engine's
 * `matrixColumnDef` (renderer, editor, fill rule, text, classes, tooltip, copy table — `MATRIX_COPY`), reading this row's
 * own Matrix cells (`row.stock.cells`) and this row's coordinate (an Amazon EU row is shared by every EU market).
 *
 * What the sheet adds is only what the Matrix page adds too: a refused cell's hover leads with the reason
 * (`refusedTooltip`). Editable = the server's cell (`values[key]`) AND the Matrix rule (`matrixCellEditable`); a held row
 * (no listing there, another account's) says the server's sentence. No formula editor: a stock cell is not a formula
 * target. The write leaves through the Matrix door (`stockCells.ts`).
 */
import {
  lockedColumn,
  matrixColumnDef,
  SELECT_CELL_CLASS,
  type CellClassParams,
  type CellSaveTracker,
  type ColDef,
  type MatrixCoordinate,
} from '@/design-system/grid'

import { fbaTooltip, FBA_COL_W } from '../../matrix/columns'
import { MATRIX_COPY } from '../../matrix/contract'
import { refusedTooltip } from '../../matrix/refusals'
import { isCellEditable } from './rows'
import { applyStockValue, stockCellOf } from './stockCells'
import type { ChannelScope, ChannelSheetRow, SheetColumn } from './types'

export interface StockColumnDeps {
  tracker: CellSaveTracker
  /** The sheet's coordinate: the column's own (header) coordinate; each row reads its own (`row.stock.coordinate`). */
  scope: Pick<ChannelScope, 'channel' | 'marketplace' | 'label'> & { connectionId?: string | null }
}

/**
 * The column-level coordinate `matrixColumnDef` needs (header, renderer frame). Every per-row fact — the EU sharing
 * sentence, the classes, the text — reads the row's own coordinate through `coordinateOf`; the stock kinds read no
 * currency or vocabulary from it.
 */
export function sheetStockCoordinate(scope: StockColumnDeps['scope']): MatrixCoordinate {
  const channel = String(scope.channel).toUpperCase(), market = String(scope.marketplace).toUpperCase()
  return {
    key: `${channel}:${market}`, kind: 'market', channel, market, label: scope.label, region: null, alias: null,
    accountId: scope.connectionId ?? null, currency: '', connected: true, listed: null, draft: null,
    cells: ['syncMode', 'syncQty', 'syncBuffer'], absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: null },
  }
}

const rowIdOf = (row: ChannelSheetRow) => row.rowId

/**
 * ONE ColDef for a `stockControl` column — spread LAST over the sheet's own column (like the variation theme): it owns
 * every cell piece, and clears what the sheet's builder put there for ordinary cells (the formula editor selector, the
 * scalar parser, the formula keys).
 */
export function stockColumnDef(col: SheetColumn, deps: StockColumnDeps): ColDef<ChannelSheetRow> {
  const kind = stockCellOf(col, col.key) ?? 'syncQty'
  const def = matrixColumnDef<ChannelSheetRow>(kind, {
    colId: col.key,
    coordinate: sheetStockCoordinate(deps.scope),
    coordinateOf: (row) => row?.stock?.coordinate,
    cells: (row) => row?.stock?.cells ?? null,
    tracker: deps.tracker,
    rowIdOf,
    copy: MATRIX_COPY,
    applyValue: applyStockValue,
  })
  const serverWritable = (row: ChannelSheetRow | undefined) => isCellEditable(row?.values?.[col.key])
  const matrixEditable = def.editable as (p: { data?: ChannelSheetRow }) => boolean
  const editable = (p: { data?: ChannelSheetRow }) => serverWritable(p.data) && matrixEditable(p)
  const matrixClass = def.cellClass as (p: CellClassParams<ChannelSheetRow>) => string
  const cellTooltip = def.tooltipValueGetter as (p: { data?: ChannelSheetRow }) => string | undefined
  return {
    ...def,
    colId: col.key,
    headerName: col.label || def.headerName,
    headerTooltip: col.helpText ?? def.headerTooltip,
    width: col.width ?? def.width,
    editable,
    cellClass: (p) => {
      const classes = matrixClass(p)
      return serverWritable(p.data) ? classes : classes.split(' ').filter((c) => c !== 'nds-cell-is-editable').join(' ')
    },
    ...(kind === 'syncMode' ? { cellClassRules: { ...(def.cellClassRules as Record<string, unknown>), [SELECT_CELL_CLASS]: editable } as ColDef<ChannelSheetRow>['cellClassRules'] } : {}),
    /* A refused cell's hover leads with WHY (the Matrix page's rule); a held row (no cells) carries the server's sentence.
       The Amazon EU sharing sentence is this sheet's own line (2026-10-08): the Matrix says it once in its EU group's label,
       so the engine's cells no longer repeat it — and this sheet has no such label, so its stock cells still say it. */
    tooltipValueGetter: (p) => {
      const row = p.data
      const mark = row ? deps.tracker.get(rowIdOf(row), col.key) : undefined
      const matrix = cellTooltip(p)
      const shared = row?.stock?.cells ? row.stock.coordinate?.sharedInventoryWith : null
      const withEu = matrix && shared?.length ? `${matrix} · ${MATRIX_COPY.sharedEu(shared)}` : matrix
      const base = withEu ?? (row?.stock?.cells ? undefined : row?.values?.[col.key]?.writeBlockedReason ?? undefined)
      return refusedTooltip(mark?.state === 'refused' ? mark.reason : undefined, base)
    },
    cellEditorSelector: undefined,
    valueParser: undefined,
    suppressKeyboardEvent: undefined,
  }
}

/** The FBA number a sheet row shows: Amazon's units, or null (no FBA row, or not read — the tooltip tells them apart). */
export const sheetFbaUnits = (row: ChannelSheetRow | undefined): number | null => row?.stock?.fba?.units ?? null

/**
 * The FBA qty column (Owner 2026-10-07; the Amazon sheet only) — the Matrix page's locked column: the DS `lockedColumn`
 * (GRID.md rule 10, the lock is in the DEFINITION: not editable, not movable, no fill handle, no paste), the Matrix's
 * tooltip, and the row's `stock.fba` read. Spread LAST over the sheet's own column: it clears the editor selector, the
 * setter, the parser and the formula keys. Nothing writes it; an open gesture says the server's reason (Amazon-managed).
 */
export function fbaColumnDef(col: SheetColumn): ColDef<ChannelSheetRow> {
  return {
    ...lockedColumn<ChannelSheetRow>(col.key, { kind: 'integer', reason: MATRIX_COPY.fbaLocked }),
    field: undefined,
    colId: col.key,
    headerName: col.label || 'FBA qty',
    headerTooltip: `Units Amazon holds at its FBA warehouses for this SKU. ${MATRIX_COPY.fbaLocked}. Parent = the family total.`,
    width: FBA_COL_W, minWidth: FBA_COL_W,
    editable: false,
    suppressFillHandle: true, suppressPaste: true, sortable: true,
    cellClassRules: { 'nds-cell-is-locked': () => true },
    cellEditorSelector: undefined,
    valueParser: undefined,
    suppressKeyboardEvent: undefined,
    valueGetter: (p) => sheetFbaUnits(p.data),
    valueSetter: () => false,
    valueFormatter: (p) => (p.value == null ? '' : String(p.value)),
    tooltipValueGetter: (p) => (p.data ? fbaTooltip({ role: p.data.isParent ? 'parent' : 'variant', fba: p.data.stock?.fba }) : undefined),
    getQuickFilterText: (p) => { const n = sheetFbaUnits(p.data); return n == null ? '' : `${n} fba` },
  }
}
