'use client'

/**
 * MX.P — the Matrix grid's column model (design §3.3, Revision): PRODUCT · SHARED · one GROUP per
 * coordinate in the read's order · `Not listed` singles.
 *
 * ## What this file does NOT build
 *
 * The cells. Every Matrix cell kind is ONE engine definition (`matrixColumnDef`, MX.G), consumed
 * here by `colId`, coordinate and a `cells` reader — the reader hands back the row's CLONE, which the
 * engine's setter mutates (see `useMatrix.commitRead`).
 * The SHARED group's `Base price` is the Information sheet's OWN column def, taken from
 * `buildMasterColumns` and re-grouped (`feedback_shared_components_no_copy_props`). The identity band
 * is the Variants page's shared `VariantIdentity`. The Nexus product status (`ACTIVE` …) is NOT shown:
 * since 2026-10-04 (Owner) it is the Products list's catalog status, not a selling state, and the
 * Information page's Shared scope dropped it — each market's own Status column says whether it sells.
 *
 * What is genuinely this page's: the group shape, the strip tag, the `Not listed` column, the
 * `Stock` column (a read of `MatrixRowRead.stock`, never a number derived here), the locked `FBA qty`
 * column (a read of `MatrixRowRead.fba`) and the preview-mode hold on the master column.
 */
import type { MutableRefObject } from 'react'

import { CellAction, type MenuItemDef } from '@/design-system/components'
import { Pill, Tag } from '@/design-system/primitives'
import { poolSourceSentence } from '@/app/_shared/stock-pool/PoolSourceTag'
import { lockedColumn, matrixColumnDef, numericColumn, type CellSaveTracker, type ColDef, type ColGroupDef, type ICellRendererParams, type MatrixColumnOptions } from '@/design-system/grid'

import { when } from '../drawer/format'
import { buildMasterColumns } from '../sheet/master/columns'
import type { SheetColumn, StudioRow } from '../sheet/master/types'
import { VariantIdentity as SharedVariantIdentity } from '../variants/VariantIdentity'
import { sharedProgressColumn } from '../sheet/progressColumns'
import type { AxisSummary } from '../variants/family/coverage'

import { MATRIX_COPY, type CoordinateKey, type FulfilmentMethod, type MatrixCellKind, type MatrixCells, type MatrixCoordinate, type MatrixRowRead } from './contract'
import { refusedTooltip } from './refusals'
import { FROM_COL_W, FROM_LABEL, fromBefore, fromCellText, fromCellView, isMatrixFromColId, matrixFromColId } from './sellsFrom'
import styles from './matrix.module.css'

/**
 * The identity column's id — `identity`, the same id the Variants page uses and the one
 * `scripts/check-layout-v2.mjs` measures. AG holds column ids and group ids in ONE namespace, so
 * every group id below is `grp-` prefixed (a `product` column inside a `product` group is renamed
 * `product_1` with warning #273).
 */
export const IDENTITY_COL = 'identity'
/** §3.3: the identity column FIXED at 380 (the same reasoning as the Variants page: a fixed slot set). */
export const IDENTITY_COL_W = 380
/**
 * 2026-09-30 — a phone. At 390px the grid is ~322px wide, and a 380px PINNED column covered all of it: no coordinate
 * column was ever on screen, and scrolling the grid moved nothing you could see. So the pinned band gives way on a
 * narrow grid, leaving at least `IDENTITY_MIN_SCROLL_W` for the coordinate columns to scroll in, and never goes below
 * `IDENTITY_MIN_W`: the DS identity band keeps its role chip, picture and `⋯` whole and truncates the SKU (the full
 * key stays on hover — `IdentityBand`, `.nds-identity-band-sku`). A wide grid keeps exactly 380.
 */
export const IDENTITY_MIN_W = 160
export const IDENTITY_MIN_SCROLL_W = 160

/** The identity column's width, given the grid width it shares (the grid's client width less any other pinned column, px). Unknown → the desktop 380. */
export function identityWidthFor(gridWidth: number): number {
  if (!Number.isFinite(gridWidth) || gridWidth <= 0) return IDENTITY_COL_W
  return Math.max(IDENTITY_MIN_W, Math.min(IDENTITY_COL_W, Math.floor(gridWidth - IDENTITY_MIN_SCROLL_W)))
}
export const BASE_PRICE_COL = 'basePrice'
/**
 * MX.F item 2, measured on the live page at 1440/1728: at 100px the header's 10/10 padding and the 16px menu button left a
 * 56px label box for a 59.02px `Base price` (11.5px/700 Inter) → `Base pr…`. 120 fits the text, the menu button AND the sort
 * indicator AG adds once the column is sorted (59 + 16 + 16 + gaps inside 100). `Stock` 96 (32.1px) and `Status` 104 (36.3px) fit.
 */
export const BASE_PRICE_COL_W = 120
export const STOCK_COL = 'shared.stock'
/** The FBA qty column (Owner 2026-10-06): Amazon's FBA units, shown and LOCKED — nothing on this page can write it. */
export const FBA_COL = 'shared.fba'
export const FBA_COL_W = 96
export const NOT_LISTED_W = 120

export const matrixColId = (key: CoordinateKey, kind: MatrixCellKind | 'notListed'): string => `${key}.${kind}`

/**
 * The Status column of one market (Owner 2026-10-07): the Information page's own Status column (`statusColumn`), once
 * per market, right after Listing. Its id is not a Matrix cell id (`parseMatrixColId` → null), so no Matrix write path
 * can take it: its values are the publish actions' (`usePublishActions`), written by `usePublishCellEditing`.
 */
export const matrixStatusColId = (key: CoordinateKey): string => `${key}.status`
export const isMatrixStatusColId = (colId: string | null | undefined): boolean => !!colId && colId.lastIndexOf('.') > 0 && colId.endsWith('.status')
/** The market group a column belongs to (its coordinate key): a Matrix cell's, a market's Status or From; null for the rest. */
export function matrixGroupKeyOf(colId: string | null | undefined): CoordinateKey | null {
  const parsed = parseMatrixColId(colId)
  if (parsed) return parsed.key
  // A market's Status and From columns belong to its group too.
  return isMatrixStatusColId(colId) || isMatrixFromColId(colId) ? colId!.slice(0, colId!.lastIndexOf('.')) : null
}
/** A market that draws a Status column: one with a Listing cell (a listed market, or an alias), never a region's inventory. */
export const hasMatrixStatus = (coord: Pick<MatrixCoordinate, 'connected' | 'cells'>): boolean => coord.connected && coord.cells.includes('listing')

/** `AMAZON:IT.price` → `{ key: 'AMAZON:IT', kind: 'price' }`; a non-Matrix id → null. Keys carry no `.`. */
export function parseMatrixColId(colId: string | undefined | null): { key: CoordinateKey; kind: MatrixCellKind } | null {
  if (!colId) return null
  const i = colId.lastIndexOf('.')
  if (i <= 0) return null
  const key = colId.slice(0, i)
  const kind = colId.slice(i + 1)
  if (key === 'shared') return null
  const kinds: readonly string[] = ['listing', 'fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price', 'salePrice']
  return kinds.includes(kind) ? { key, kind: kind as MatrixCellKind } : null
}

/* ── the identity cell ────────────────────────────────────────────────────────────────────── */

interface IdentityParams {
  axesRef: MutableRefObject<AxisSummary[]>
  rowMenuRef: MutableRefObject<(row: StudioRow) => MenuItemDef[]>
}

function MatrixIdentity(p: ICellRendererParams<StudioRow> & Partial<IdentityParams>) {
  const d = p.data
  if (!d) return null
  return (
    <SharedVariantIdentity
      sku={d.sku} isParent={d.isParent} parentId={d.parentId} childCount={d.childCount}
      image={d.imageUrl} inherited={d.imageInherited}
      axes={(p.axesRef?.current ?? []).map((axis) => d.axisValues?.[axis.key] ?? '—')}
      suspect={(d as StudioRow & { axisValuesSuspect?: Array<{ reason: string }> }).axisValuesSuspect}
      menuItems={p.rowMenuRef?.current(d)}
    />
  )
}

/* ── the strip tag ────────────────────────────────────────────────────────────────────────── */

/**
 * The coordinate's strip label + roll-up tag (`19 listed · 1 not listed`). `listed: null` = not counted
 * → NO tag, never `0 listed` (rule 7). A counted zero is shown: it is a fact.
 */
/**
 * The strip's title. A LISTED coordinate: its cell count (+ the EU note). Item 8(b): a coordinate that is CONNECTED but has
 * no listing (`connected: true, cells: []` — Amazon NL, eBay FR…) says so; ONLY an unconnected one (WooCommerce) says no
 * account is connected. The same two sentences head the `Not listed` column.
 */
export function notListedTitle(c: MatrixCoordinate): string {
  if (!c.connected) return `${c.label} — ${MATRIX_COPY.noAccountConnected}`
  if (c.cells.length === 0) return `${c.label} — ${MATRIX_COPY.noListingYet}`
  return `${c.label} — ${c.cells.length} ${c.cells.length === 1 ? 'cell' : 'cells'}${c.sharedInventoryWith ? ` · ${MATRIX_COPY.sharedEu(c.sharedInventoryWith)}` : ''}`
}

/**
 * The group's roll-up tag: `20 listed`, `0 listed · 1 not listed` (a draft is Not listed — one set of selling words,
 * Owner 2026-10-04); null for a group that serves no `Listing` cell.
 */
export function stripTag(c: MatrixCoordinate | undefined): string | null {
  /* A group that serves no `Listing` cell (the EU inventory group) has nothing to count: no tag,
     rather than a `0 listed` that reads as "nothing is listed here". */
  return c && c.listed !== null && c.cells.includes('listing')
    ? `${c.listed} listed${c.draft !== null && c.draft > 0 ? ` · ${c.draft} not listed` : ''}`
    : null
}

/** The strip's tooltip: the whole name, and the counts — which a narrow group moves off its line (matrix.module.css). */
export function stripTitle(c: MatrixCoordinate | undefined, displayName: string): string {
  if (!c) return displayName
  const tag = stripTag(c)
  return tag ? `${notListedTitle(c)} · ${tag}` : notListedTitle(c)
}

export function MatrixGroupHeader(p: { displayName: string; coordinate?: MatrixCoordinate }) {
  const c = p.coordinate
  const tag = stripTag(c)
  return (
    <span className="nds-matrix-strip" title={stripTitle(c, p.displayName)}>
      <span className="nds-matrix-strip-label">{p.displayName}</span>
      {tag && <Tag tone={c && c.listed! > 0 ? 'success' : 'neutral'} className="nds-matrix-strip-tag">{tag}</Tag>}
    </span>
  )
}

/* ── the stock cell ───────────────────────────────────────────────────────────────────────── */

function stockOf(row: MatrixRowRead | null): MatrixRowRead['stock'] | null { return row?.stock ?? null }

/** The Stock cell's door: the Products page's inventory editor (stock per location), for this row. */
export const STOCK_EDIT_COPY = { label: 'Stock by location', detail: 'Enter or F2 opens the stock per location.' } as const

function StockCell(p: ICellRendererParams<StudioRow> & { rowOf?: (id: string) => MatrixRowRead | null; onOpenStock?: (rowId: string) => void }) {
  const d = p.data
  const s = d ? stockOf(p.rowOf?.(d.id) ?? null) : null
  if (!d || !s) return null
  const open = p.onOpenStock
    ? <CellAction label={STOCK_EDIT_COPY.label} description={STOCK_EDIT_COPY.detail} onActivate={() => p.onOpenStock?.(d.id)}
        onFocusCell={() => { const col = p.column?.getColId(); if (p.node.rowIndex != null && col) p.api.setFocusedCell(p.node.rowIndex, col) }} />
    : null
  if (s.uncounted) return <span className={styles.stockShared}>{open}<span className="nds-cell-value nds-cell-stock-out"><span className="nds-cell-value-text">⚠ {MATRIX_COPY.uncounted}</span></span></span>
  const number = <span className="nds-cell-value nds-cell-num"><span className="nds-cell-value-text">{s.available ?? '—'}</span></span>
  // Shared stock by SKU: a SKU that sells from another business's stock says so; the tooltip names the business.
  if (s.source) return <span className={styles.stockShared}>{open}{number}<Pill tone="info">Shared</Pill></span>
  return open ? <span className={styles.stockShared}>{open}{number}</span> : number
}

/**
 * Shared stock by SKU (Owner 2026-10-01): a Qty or Mode cell whose number follows ANOTHER business's stock right now —
 * the row sells from a lent stock and the listing follows it (a fixed, paused or Amazon-managed listing does not). Such a
 * cell carries the DS state `nds-cell-is-shared-stock` (violet) and says the lender in its tooltip: never colour alone.
 */
export const SHARED_STOCK_CELL = 'nds-cell-is-shared-stock'
export function sharedStockOf(sync: MatrixCells['sync'] | null | undefined, source: MatrixRowRead['stock']['source']): NonNullable<MatrixRowRead['stock']['source']> | null {
  return source && sync?.kind === 'FOLLOW' ? source : null
}

/** The Stock cell's tooltip: where the number comes from, and which warehouses hold it. */
export function stockTooltip(s: MatrixRowRead['stock']): string {
  if (s.uncounted) return MATRIX_COPY.uncountedHint
  const where = s.locations.length ? s.locations.map((l) => `${l.code} ${l.available}`).join(' · ') : 'No routed location'
  if (!s.source) return where
  return `${poolSourceSentence({ lenderName: s.source.lenderName, available: s.available ?? 0 })} ${where}. This business's own stock is not used.`
}

/* ── the FBA qty cell ─────────────────────────────────────────────────────────────────────── */

/** The FBA number a row shows: units, or null for "no FBA row" AND for "not read" (the tooltip tells them apart). */
export function fbaUnitsOf(row: MatrixRowRead | null | undefined): number | null {
  return row?.fba?.units ?? null
}

/**
 * The FBA qty cell's tooltip: how many units and where, when Nexus last updated them, and — on every row, whatever the
 * number — why the cell is locked. `null` (no FBA row) and `undefined` (not read) say different things: neither is `0`.
 * The product sheet's Amazon FBA qty column reads it too (`sheet/channel/stockColumns.tsx`).
 */
export function fbaTooltip(row: Pick<MatrixRowRead, 'role' | 'fba'> | null | undefined): string {
  const f = row?.fba
  const lines: string[] = []
  if (f === undefined) lines.push(MATRIX_COPY.fbaNotRead)
  else if (f === null) lines.push(MATRIX_COPY.fbaNone)
  else {
    lines.push(`${row?.role === 'parent' ? 'Family total: ' : ''}${MATRIX_COPY.fbaUnits(f.units, f.locations.map((l) => `${l.code} ${l.units}`))}`)
    if (f.updatedAt && Number.isFinite(Date.parse(f.updatedAt))) lines.push(`Last updated in Nexus ${when(f.updatedAt)}`)
  }
  lines.push(MATRIX_COPY.fbaLocked)
  return lines.join(' · ')
}

/* ── the From cell ("Sells from", Step 2) ─────────────────────────────────────────────────────── */

/** The From cell's door: the "Sells from" pop-up for this row on this market group. */
export const FROM_EDIT_COPY = { label: 'Sells from', detail: 'Enter or F2 opens the warehouses it sells from.' } as const
export const FROM_HEADER_TIP = 'The warehouses this market sells from, in sale order. Listings show the sum.'

interface FromCellParams {
  coordinate: MatrixCoordinate
  rowOf: (id: string) => MatrixRowRead | null
  cellsOf: (rowId: string, key: CoordinateKey) => MatrixCells | null
  onOpenFrom?: (rowId: string, key: CoordinateKey, anchor: HTMLElement | null) => void
}

function FromCell(p: ICellRendererParams<StudioRow> & Partial<FromCellParams>) {
  const d = p.data
  if (!d || !p.coordinate || !p.rowOf || !p.cellsOf) return null
  const coord = p.coordinate
  const v = fromCellView(p.rowOf(d.id), p.cellsOf(d.id, coord.key), coord)
  if (v.look === 'none') return null
  if (v.look === 'shared') return <span className="nds-cell-value"><Pill tone="info">{v.text}</Pill></span>
  const open = v.door && p.onOpenFrom
    ? <CellAction label={FROM_EDIT_COPY.label} description={FROM_EDIT_COPY.detail} onActivate={(anchor) => p.onOpenFrom?.(d.id, coord.key, anchor)}
        onFocusCell={() => { const col = p.column?.getColId(); if (p.node.rowIndex != null && col) p.api.setFocusedCell(p.node.rowIndex, col) }} />
    : null
  // Muted while it follows the market default; normal weight once this product has its own choice.
  return <span className="nds-cell-value"><span className={`nds-cell-value-text${v.look === 'own' ? '' : ' nds-cell-muted'}`}>{v.text}</span>{open}</span>
}

function NotListedCell() {
  return <span className="nds-cell-value nds-cell-muted"><span className="nds-cell-value-text">{MATRIX_COPY.notListed}</span></span>
}

/* ── the whole model ──────────────────────────────────────────────────────────────────────── */

export interface BuildMatrixColumnsOptions {
  /** The coordinates ON SCREEN, in the read's (= the contract's) order — already scope-filtered. */
  coordinates: readonly MatrixCoordinate[]
  /** A row's cells on a coordinate, read at PAINT time — a new read repaints without a rebuild. */
  cellsOf: (rowId: string, key: CoordinateKey) => MatrixCells | null
  rowOf: (rowId: string) => MatrixRowRead | null
  tracker: CellSaveTracker
  /** The sheet's column set — `Base price` and `Status` are taken from it, never rebuilt. */
  sheetColumns: readonly SheetColumn[]
  locale: string
  market: string
  axesRef: MutableRefObject<AxisSummary[]>
  rowMenuRef: MutableRefObject<(row: StudioRow) => MenuItemDef[]>
  /** Preview mode: the master column (Base price) is read-only, and this is the sentence it carries. */
  masterHeldReason: string | null
  onJump: (params: ICellRendererParams) => void
  /** The fulfilment select's CHOICE — the engine's setter routes it here and writes nothing (§3.4). */
  onPickFulfilment: (method: FulfilmentMethod, params: ICellRendererParams) => void
  rowsRef: MutableRefObject<StudioRow[]>
  /** The identity column's width (`identityWidthFor`); the desktop 380 when not given. */
  identityWidth?: number
  /** A market's Status column (the page builds it with `statusColumn`), placed right after its Listing; null = none. */
  statusColumnOf?: (coord: MatrixCoordinate) => ColDef<StudioRow> | null
  /** The Stock cell opens the stock per location for a row (absent = no door: preview, or no right to adjust stock). */
  onOpenStock?: (rowId: string) => void
  /** A market's From cell opens "Sells from" (absent = no door: preview, or no right to adjust stock). */
  onOpenFrom?: (rowId: string, key: CoordinateKey, anchor: HTMLElement | null) => void
}

const rowId = (r: StudioRow) => r.id

export function buildMatrixColumns(opts: BuildMatrixColumnsOptions): (ColDef<StudioRow> | ColGroupDef<StudioRow>)[] {
  const { coordinates, cellsOf, rowOf, tracker, sheetColumns, locale, market, axesRef, rowMenuRef, masterHeldReason, onJump, onPickFulfilment, rowsRef } = opts
  const identityWidth = opts.identityWidth ?? IDENTITY_COL_W

  const identity: ColDef<StudioRow> = {
    colId: IDENTITY_COL,
    headerName: 'Product',
    /* Still a FIXED slot at any one grid width (min = max = width): only the grid's own width changes it. */
    width: identityWidth, minWidth: identityWidth, maxWidth: identityWidth, resizable: false,
    pinned: 'left', lockPinned: true, lockPosition: 'left',
    suppressMovable: true, suppressHeaderMenuButton: true, sortable: false,
    cellClass: 'nds-ag-cell',
    cellRenderer: MatrixIdentity,
    cellRendererParams: { axesRef, rowMenuRef },
    headerTooltip: 'The parent and its variants',
    getQuickFilterText: (p) => `${p.data?.sku ?? ''} ${p.data?.name ?? ''}`,
  }

  /* The SHARED group: the sheet's own `basePrice` and `status` defs, re-grouped. `grouped: false`
     hands back flat ColDefs; `reservedColumnIds` keeps the identity band's `sku` out. */
  const sheetDefs = buildMasterColumns(
    { columns: [...sheetColumns], tracker, locale, market, reservedColumnIds: [IDENTITY_COL, 'sku'], grouped: false },
    rowsRef,
  ) as ColDef<StudioRow>[]
  const byId = new Map(sheetDefs.map((c) => [(c.colId ?? '').toLowerCase(), c]))
  const held = (def: ColDef<StudioRow> | undefined, fallback: ColDef<StudioRow>): ColDef<StudioRow> => {
    const base = def ?? fallback
    if (!masterHeldReason) return { ...base, suppressMovable: true }
    /* Preview mode: read-only with the reason on the cell — the lock class the sheet uses, and the
       sentence where the tooltip already lives. An `editable:false` with no reason is a silent hold. */
    return {
      ...base,
      suppressMovable: true,
      editable: false,
      suppressFillHandle: true,
      cellClassRules: { ...(base.cellClassRules ?? {}), 'nds-cell-is-locked': () => true },
      tooltipValueGetter: () => masterHeldReason,
    }
  }
  const basePrice = held(byId.get(BASE_PRICE_COL.toLowerCase()), {
    colId: BASE_PRICE_COL, headerName: 'Base price', width: BASE_PRICE_COL_W, minWidth: BASE_PRICE_COL_W, editable: false,
    valueGetter: (p) => p.data?.basePrice ?? null, cellClass: 'nds-ag-cell nds-cell-num',
  })
  const stock: ColDef<StudioRow> = {
    colId: STOCK_COL,
    headerName: 'Stock',
    headerTooltip: 'The routed WAREHOUSE pool this SKU follows — the number Follow rows derive from. "Shared": the stock another business lends. Parent = the family total. Enter or the pencil opens the stock per location.',
    width: 112, minWidth: 96,
    editable: false, suppressMovable: true, suppressHeaderMenuButton: true, sortable: true, resizable: true,
    /* A number column: right-aligned with tabular figures, as FBA qty and every market's Qty and Price beside it. */
    type: numericColumn.type, cellClass: [...numericColumn.cellClass, 'nds-reveal-row'], headerClass: numericColumn.headerClass,
    valueGetter: (p) => (p.data ? stockOf(rowOf(p.data.id))?.available ?? null : null),
    cellRenderer: StockCell,
    cellRendererParams: { rowOf, onOpenStock: opts.onOpenStock,
      suppressMouseEventHandling: (p: { event: MouseEvent }) => p.event.target instanceof Element && !!p.event.target.closest('[data-nds-cell-action]') },
    tooltipValueGetter: (p) => {
      const s = p.data ? stockOf(rowOf(p.data.id)) : null
      if (!s) return undefined
      return stockTooltip(s)
    },
    getQuickFilterText: (p) => { const s = p.data ? stockOf(rowOf(p.data.id)) : null; return s?.uncounted ? MATRIX_COPY.uncounted : `${s?.available ?? ''}${s?.source ? ` shared ${s.source.lenderName}` : ''}` },
  }

  /* The DS locked column (`lockedColumn`, GRID.md rule 10: the lock is in the DEFINITION) — not editable, not movable, no
     fill handle, the lock glyph in the cell and the locked tint on it. Its value is a READ of `MatrixRowRead.fba`, the
     same way Stock reads `stock`: a copy, an export and a sort read the number; nothing can paste one back. */
  const fba: ColDef<StudioRow> = {
    ...lockedColumn<StudioRow>(FBA_COL, { kind: 'integer', reason: MATRIX_COPY.fbaLocked }),
    field: undefined,
    colId: FBA_COL,
    headerName: 'FBA qty',
    headerTooltip: `Units Amazon holds at its FBA warehouses for this SKU. ${MATRIX_COPY.fbaLocked}. Parent = the family total.`,
    width: FBA_COL_W, minWidth: FBA_COL_W,
    suppressHeaderMenuButton: true, suppressFillHandle: true, suppressPaste: true, sortable: true, resizable: true,
    cellClassRules: { 'nds-cell-is-locked': () => true },
    valueGetter: (p) => (p.data ? fbaUnitsOf(rowOf(p.data.id)) : null),
    valueFormatter: (p) => (p.value == null ? '' : String(p.value)),
    tooltipValueGetter: (p) => (p.data ? fbaTooltip(rowOf(p.data.id)) : undefined),
    getQuickFilterText: (p) => { const n = p.data ? fbaUnitsOf(rowOf(p.data.id)) : null; return n == null ? '' : `${n} fba` },
  }

  const groups: (ColDef<StudioRow> | ColGroupDef<StudioRow>)[] = [
    { groupId: 'grp-product', headerName: 'Product', children: [identity] },
    /* The progress column has its OWN header group. Inside the Product group it split that group across the pinned
       boundary (Product is pinned, progress is not) and AG drew "PRODUCT" twice — measured on production 2026-09-27. */
    { groupId: 'grp-progress', headerName: 'Progress', children: [sharedProgressColumn<StudioRow>({ market: opts.market, locale: opts.locale })] },
    { groupId: 'grp-shared', headerName: 'Shared', children: [{ ...basePrice, headerName: 'Base price', width: BASE_PRICE_COL_W, minWidth: BASE_PRICE_COL_W }, stock, fba] },
  ]

  /* A market group's From column ("Sells from", Step 2): read-only here — the pop-up is its only writer. */
  const fromColumn = (coord: MatrixCoordinate): ColDef<StudioRow> => {
    const colId = matrixFromColId(coord.key)
    const view = (data: StudioRow | undefined) => (data ? fromCellView(rowOf(data.id), cellsOf(data.id, coord.key), coord) : null)
    return {
      colId,
      headerName: FROM_LABEL,
      headerTooltip: FROM_HEADER_TIP,
      width: FROM_COL_W, minWidth: 96,
      editable: false, suppressMovable: true, suppressHeaderMenuButton: true, suppressFillHandle: true, suppressPaste: true, sortable: false, resizable: true,
      cellClass: ['nds-ag-cell', 'nds-reveal-row'],
      valueGetter: (p) => (p.data ? fromCellText(rowOf(p.data.id), cellsOf(p.data.id, coord.key), coord) : null),
      cellRenderer: FromCell,
      cellRendererParams: { coordinate: coord, rowOf, cellsOf, onOpenFrom: opts.onOpenFrom,
        suppressMouseEventHandling: (p: { event: MouseEvent }) => p.event.target instanceof Element && !!p.event.target.closest('[data-nds-cell-action]') },
      tooltipValueGetter: (p) => {
        const mark = p.data ? tracker?.get(rowId(p.data), colId) : undefined
        return refusedTooltip(mark?.state === 'refused' ? mark.reason : undefined, view(p.data)?.tooltip)
      },
      getQuickFilterText: (p) => view(p.data)?.text ?? '',
    }
  }

  for (const coord of coordinates) {
    const children: ColDef<StudioRow>[] = []
    const fromAt = fromBefore(coord)
    if (!coord.connected || coord.cells.length === 0) {
      /* ONE `Not listed` column — never eight empty cells (§3.1 rule 6). */
      children.push({
        colId: matrixColId(coord.key, 'notListed'),
        headerName: MATRIX_COPY.notListed,
        headerTooltip: notListedTitle(coord),
        width: NOT_LISTED_W, minWidth: NOT_LISTED_W,
        editable: false, sortable: false, suppressMovable: true, suppressHeaderMenuButton: true, suppressFillHandle: true,
        cellClass: 'nds-ag-cell nds-cell-muted',
        valueGetter: () => null,
        cellRenderer: NotListedCell,
      })
    } else {
      for (const kind of coord.cells) {
        // Fulfilment · From · Mode · Qty · Buffer · Sync
        if (kind === fromAt) children.push(fromColumn(coord))
        const o: MatrixColumnOptions<StudioRow> = {
          colId: matrixColId(coord.key, kind),
          coordinate: coord,
          cells: (data) => (data ? cellsOf(data.id, coord.key) : null),
          tracker,
          rowIdOf: rowId,
          onJump,
          onPickFulfilment,
          /* The app's copy table, verbatim (Appendix A) — the engine asks, the page supplies. */
          copy: MATRIX_COPY,
        }
        const def = matrixColumnDef<StudioRow>(kind, o)
        const cellTooltip = def.tooltipValueGetter
        const colId = matrixColId(coord.key, kind)
        // Shared stock by SKU: the Qty and Mode cells of a row that follows another business's stock.
        const marksShared = kind === 'syncQty' || kind === 'syncMode'
        const sharedFrom = (data: StudioRow | undefined) => (marksShared && data ? sharedStockOf(cellsOf(data.id, coord.key)?.sync, rowOf(data.id)?.stock.source ?? null) : null)
        /* A refused cell's hover leads with WHY (`refusals.ts`); the footer note is the view, this elaborates. */
        children.push({
          ...def,
          ...(marksShared ? { cellClassRules: { ...(def.cellClassRules as Record<string, unknown>), [SHARED_STOCK_CELL]: (p: { data?: StudioRow }) => !!sharedFrom(p.data) } as ColDef<StudioRow>['cellClassRules'] } : {}),
          tooltipValueGetter: (p) => {
            const mark = p.data ? tracker.get(rowId(p.data), colId) : undefined
            const base = cellTooltip?.(p) as string | undefined
            const shared = sharedFrom(p.data)
            const withSource = shared ? [base, `Follows ${shared.lenderName}'s stock (shared stock).`].filter(Boolean).join('\n') : base
            return refusedTooltip(mark?.state === 'refused' ? mark.reason : undefined, withSource)
          },
        })
        if (kind === 'listing' && hasMatrixStatus(coord)) {
          const status = opts.statusColumnOf?.(coord)
          if (status) children.push(status)
        }
      }
    }
    groups.push({
      groupId: `grp-${coord.key}`,
      headerName: coord.label,
      headerGroupComponent: MatrixGroupHeader,
      headerGroupComponentParams: { coordinate: coord },
      children,
    })
  }
  return groups
}
