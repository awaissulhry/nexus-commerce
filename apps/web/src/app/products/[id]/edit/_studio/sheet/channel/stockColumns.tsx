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
  matrixColumnDef,
  SELECT_CELL_CLASS,
  type CellClassParams,
  type CellSaveTracker,
  type ColDef,
  type MatrixCoordinate,
} from '@/design-system/grid'

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
    /* A refused cell's hover leads with WHY (the Matrix page's rule); a held row (no cells) carries the server's sentence. */
    tooltipValueGetter: (p) => {
      const row = p.data
      const mark = row ? deps.tracker.get(rowIdOf(row), col.key) : undefined
      const base = cellTooltip(p) ?? (row?.stock?.cells ? undefined : row?.values?.[col.key]?.writeBlockedReason ?? undefined)
      return refusedTooltip(mark?.state === 'refused' ? mark.reason : undefined, base)
    },
    cellEditorSelector: undefined,
    valueParser: undefined,
    suppressKeyboardEvent: undefined,
  }
}
