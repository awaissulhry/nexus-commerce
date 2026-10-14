/**
 * Amazon Business step 5 (Part 4) — the Amazon product sheet's B2B price and Quantity discounts columns ARE the Matrix's
 * cells, READ ONLY. The engine's `matrixColumnDef` (renderer, text, classes, tooltip, comparator, the copy table
 * `MATRIX_COPY`) over this row's MARKET cells (`row.business.cells`, API `studio-stock.ts`), so the rule, the price it
 * gives now, the quantity discounts with their unit prices, the send, the warnings and a held reason read exactly as on
 * the Matrix.
 *
 * What the sheet changes is only what makes them read only, in the DEFINITION (GRID.md rule 10, as the FBA qty column):
 * not editable, no editor, no setter, no fill handle, no paste, and no pencil (no `onOpenBusiness`). They are set on the
 * Matrix:
 *   - Enter, F2 or a double-click on a cell the Matrix would let this person set opens the Matrix tab (`businessGesture`);
 *   - any other open gesture says the cell's sentence (the sheet's refusal: the server's `writeBlockedReason`, "Set on the
 *     Matrix…" or why the Matrix holds it: the parent, a market without B2B, no listing there);
 *   - a paste, a fill or Delete that reaches them changes nothing there and says `BUSINESS_SHEET_COPY.readOnly`.
 * Amazon scopes only: the column keys are not namespaced, so another channel's field of the same name stays its own.
 */
import { matrixCellOpens, matrixColumnDef, type CellClassParams, type ColDef, type MatrixCoordinate } from '@/design-system/grid'

import { MATRIX_COPY } from '../../matrix/contract'
import type { ChannelScope, ChannelSheetRow, SheetColumn } from './types'

/** The two columns (API `STUDIO_BUSINESS_KEYS`) and the Matrix cell each one shows. */
export const BUSINESS_COLUMN_KEYS = ['business_price', 'business_tiers'] as const
export type BusinessColumnKey = (typeof BUSINESS_COLUMN_KEYS)[number]
export const BUSINESS_CELL_OF: Readonly<Record<BusinessColumnKey, 'businessPrice' | 'businessTiers'>> = { business_price: 'businessPrice', business_tiers: 'businessTiers' }
export const isBusinessColumnKey = (key: string | null | undefined): key is BusinessColumnKey => (BUSINESS_COLUMN_KEYS as readonly string[]).includes(key ?? '')

/** The sheet the pair is drawn on: Amazon only. */
export const isBusinessScope = (scope: Pick<ChannelScope, 'channel'> | null | undefined): boolean => String(scope?.channel ?? '').toUpperCase() === 'AMAZON'

export const BUSINESS_SHEET_COPY = {
  /** A paste, a fill or Delete that reached the pair. */
  readOnly: 'Not changed: B2B price and Quantity discounts are set on the Matrix. Enter or a double-click on one of their cells opens the Matrix.',
} as const

type BusinessScope = Pick<ChannelScope, 'channel' | 'marketplace' | 'label'> & { connectionId?: string | null }

/** The column-level coordinate `matrixColumnDef` needs (header, renderer frame); each row reads its own (`row.business.coordinate`). */
export function sheetBusinessCoordinate(scope: BusinessScope): MatrixCoordinate {
  const channel = String(scope.channel).toUpperCase(), market = String(scope.marketplace).toUpperCase()
  return {
    key: `${channel}:${market}`, kind: 'market', channel, market, label: scope.label, region: null, alias: null,
    accountId: scope.connectionId ?? null, currency: '', connected: true, listed: null, draft: null,
    cells: ['businessPrice', 'businessTiers'], absent: [], sharedInventoryWith: null, inventoryOn: null, vocabulary: { fulfilment: null },
  }
}

/** The cell's hover: the Matrix's own lines, then where it is set or why it is held (once, when the Matrix did not say it). */
export function businessTooltip(matrix: string | null | undefined, reason: string | null | undefined): string | undefined {
  const lines = [matrix || null, reason && !(matrix ?? '').includes(reason) ? reason : null].filter(Boolean)
  return lines.length ? lines.join(' · ') : undefined
}

/** Classes the Matrix gives a cell a person may set THERE: here the cell is read only, and has no pencil to reveal. */
const NOT_HERE = new Set(['nds-cell-is-editable', 'nds-reveal-row'])

/**
 * ONE ColDef for a B2B column — spread LAST over the sheet's own column (like the stock columns): it owns every cell
 * piece and clears what the sheet's builder put there for ordinary cells (the formula editor selector, the scalar
 * parser, the formula keys, the setter).
 */
export function businessColumnDef(col: SheetColumn, deps: { scope: BusinessScope }): ColDef<ChannelSheetRow> {
  const kind = BUSINESS_CELL_OF[col.key as BusinessColumnKey] ?? 'businessPrice'
  const def = matrixColumnDef<ChannelSheetRow>(kind, {
    colId: col.key,
    coordinate: sheetBusinessCoordinate(deps.scope),
    coordinateOf: (row) => row?.business?.coordinate,
    cells: (row) => row?.business?.cells ?? null,
    copy: MATRIX_COPY,
  })
  const matrixClass = def.cellClass as (p: CellClassParams<ChannelSheetRow>) => string
  const matrixTooltip = def.tooltipValueGetter as (p: { data?: ChannelSheetRow }) => string | undefined
  return {
    ...def,
    colId: col.key,
    headerName: col.label || def.headerName,
    headerTooltip: col.helpText ?? def.headerTooltip,
    width: col.width ?? def.width,
    editable: false,
    suppressFillHandle: true,
    suppressPaste: true,
    cellClass: (p) => matrixClass(p).split(' ').filter((c) => !NOT_HERE.has(c)).join(' '),
    cellEditor: undefined,
    cellEditorSelector: undefined,
    cellEditorParams: undefined,
    cellEditorPopup: undefined,
    valueParser: undefined,
    valueSetter: () => false,
    suppressKeyboardEvent: undefined,
    tooltipValueGetter: (p) => businessTooltip(matrixTooltip(p), p.data?.values?.[col.key]?.writeBlockedReason),
  }
}

/** Does an open gesture (Enter, F2, a double-click) on this cell open the Matrix? Where the Matrix would let this person set it. */
export function businessOpensMatrix(colId: string | null | undefined, row: ChannelSheetRow | null | undefined): boolean {
  return isBusinessColumnKey(colId) && !!row && matrixCellOpens(BUSINESS_CELL_OF[colId], row.business?.cells ?? null)
}

type GestureKey = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

/**
 * What a gesture on the sheet does to the pair. `open`: Enter, F2 or a double-click on a cell the Matrix would let this
 * person set — the Matrix tab opens. `readOnly`: Delete or Backspace on the pair, or on a selection that reaches it — the
 * sentence (the rest of the selection is cleared as usual). null: the sheet's own handling (a held cell's open gesture
 * says its reason). `selected`: the column ids of the selected ranges.
 */
export function businessGesture(input: { colId: string | null | undefined; row: ChannelSheetRow | null | undefined; key?: GestureKey | null; doubleClick?: boolean; selected?: readonly string[] }): 'open' | 'readOnly' | null {
  const { colId, row, key } = input
  if (input.doubleClick) return businessOpensMatrix(colId, row) ? 'open' : null
  if (!key || key.altKey || key.ctrlKey || key.metaKey) return null
  if ((key.key === 'Enter' && !key.shiftKey) || key.key === 'F2') return businessOpensMatrix(colId, row) ? 'open' : null
  if ((key.key === 'Delete' || key.key === 'Backspace') && !key.shiftKey) return isBusinessColumnKey(colId) || (input.selected ?? []).some(isBusinessColumnKey) ? 'readOnly' : null
  return null
}

/**
 * The columns a paste lands on, by AG's rule: every selected range's columns, and from the focused cell rightwards as many
 * displayed columns as the clipboard is wide. (A header paste names its columns; it can only land on fewer.)
 */
export function pasteTargetColumns(input: { ranges: ReadonlyArray<readonly string[]>; focused: string | null | undefined; displayed: readonly string[]; width: number }): string[] {
  const out = new Set(input.ranges.flat())
  const at = input.focused ? input.displayed.indexOf(input.focused) : -1
  if (at >= 0) for (const id of input.displayed.slice(at, at + Math.max(1, input.width))) out.add(id)
  return [...out]
}

/** The part of the grid a paste reads (AG's `ProcessDataFromClipboardParams.api`). */
interface PasteApiLike {
  getCellRanges(): ReadonlyArray<{ columns: ReadonlyArray<{ getColId(): string }> }> | null
  getFocusedCell(): { column: { getColId(): string } } | null
  getAllDisplayedColumns(): ReadonlyArray<{ getColId(): string }>
}

/**
 * The sheet's paste (`processDataFromClipboard`) with the pair's sentence in front: the columns this paste lands on are
 * told to `say` (which speaks only when they reach the pair); the paste itself is `next`'s, unchanged.
 */
export function withBusinessPaste<P extends { data: string[][]; api: PasteApiLike }>(next: (params: P) => string[][] | null, say: (columns: string[]) => void): (params: P) => string[][] | null {
  return (params) => {
    say(pasteTargetColumns({
      ranges: (params.api.getCellRanges() ?? []).map((range) => range.columns.map((column) => column.getColId())),
      focused: params.api.getFocusedCell()?.column.getColId(),
      displayed: params.api.getAllDisplayedColumns().map((column) => column.getColId()),
      width: Math.max(1, ...params.data.map((line) => line.length)),
    }))
    return next(params)
  }
}

interface RangeLike { columns: readonly string[]; startRow: number | null; endRow: number | null }

/** The columns a fill writes: a fill down or up writes every column of its range; a fill across only the new ones. */
export function fillTargetColumns(initial: RangeLike, final: RangeLike): string[] {
  const sameRows = initial.startRow === final.startRow && initial.endRow === final.endRow
  return sameRows ? final.columns.filter((id) => !initial.columns.includes(id)) : [...final.columns]
}

/** Did the operation reach the pair? Then it says `BUSINESS_SHEET_COPY.readOnly`. */
export const reachesBusiness = (columns: readonly string[]): boolean => columns.some(isBusinessColumnKey)
