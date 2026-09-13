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
 * The SHARED group's `Base price` and `Status` are the Information sheet's OWN column defs, taken
 * from `buildMasterColumns` and re-grouped — the editor a `Status` cell opens here is the one it
 * opens on Information (`feedback_shared_components_no_copy_props`). The identity band is the
 * Variants page's shared `VariantIdentity`.
 *
 * What is genuinely this page's: the group shape, the strip tag, the `Not listed` column, the
 * `Stock` column (a read of `MatrixRowRead.stock`, never a number derived here) and the preview-mode
 * hold on the two master columns.
 */
import type { MutableRefObject } from 'react'

import type { MenuItemDef } from '@/design-system/components'
import { Tag } from '@/design-system/primitives'
import { matrixColumnDef, type CellSaveTracker, type ColDef, type ColGroupDef, type ICellRendererParams, type MatrixColumnOptions } from '@/design-system/grid'

import { buildMasterColumns } from '../sheet/master/columns'
import type { SheetColumn, StudioRow } from '../sheet/master/types'
import { VariantIdentity as SharedVariantIdentity } from '../variants/VariantIdentity'
import type { AxisSummary } from '../variants/family/coverage'

import { MATRIX_COPY, type CoordinateKey, type FulfilmentMethod, type MatrixCellKind, type MatrixCells, type MatrixCoordinate, type MatrixRowRead } from './contract'

/**
 * The identity column's id — `identity`, the same id the Variants page uses and the one
 * `scripts/check-layout-v2.mjs` measures. AG holds column ids and group ids in ONE namespace, so
 * every group id below is `grp-` prefixed (a `product` column inside a `product` group is renamed
 * `product_1` with warning #273).
 */
export const IDENTITY_COL = 'identity'
/** §3.3: the identity column FIXED at 380 (the same reasoning as the Variants page: a fixed slot set). */
export const IDENTITY_COL_W = 380
export const BASE_PRICE_COL = 'basePrice'
/**
 * MX.F item 2, measured on the live page at 1440/1728: at 100px the header's 10/10 padding and the 16px menu button left a
 * 56px label box for a 59.02px `Base price` (11.5px/700 Inter) → `Base pr…`. 120 fits the text, the menu button AND the sort
 * indicator AG adds once the column is sorted (59 + 16 + 16 + gaps inside 100). `Stock` 96 (32.1px) and `Status` 104 (36.3px) fit.
 */
export const BASE_PRICE_COL_W = 120
export const STOCK_COL = 'shared.stock'
export const STATUS_COL = 'status'
export const NOT_LISTED_W = 120

export const matrixColId = (key: CoordinateKey, kind: MatrixCellKind | 'notListed'): string => `${key}.${kind}`

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
      pct={d.completeness.overall.pct} menuItems={p.rowMenuRef?.current(d)}
    />
  )
}

/* ── the strip tag ────────────────────────────────────────────────────────────────────────── */

/**
 * The coordinate's strip label + roll-up tag (`19 listed · 1 draft`). `listed: null` = not counted
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

export function MatrixGroupHeader(p: { displayName: string; coordinate?: MatrixCoordinate }) {
  const c = p.coordinate
  /* A group that serves no `Listing` cell (the EU inventory group) has nothing to count: no tag,
     rather than a `0 listed` that reads as "nothing is listed here". */
  const tag = c && c.listed !== null && c.cells.includes('listing')
    ? `${c.listed} listed${c.draft !== null && c.draft > 0 ? ` · ${c.draft} draft` : ''}`
    : null
  return (
    <span className="nds-matrix-strip" title={c ? notListedTitle(c) : p.displayName}>
      <span className="nds-matrix-strip-label">{p.displayName}</span>
      {tag && <Tag tone={c && c.listed! > 0 ? 'success' : 'neutral'} className="nds-matrix-strip-tag">{tag}</Tag>}
    </span>
  )
}

/* ── the stock cell ───────────────────────────────────────────────────────────────────────── */

function stockOf(row: MatrixRowRead | null): MatrixRowRead['stock'] | null { return row?.stock ?? null }

function StockCell(p: ICellRendererParams<StudioRow> & { rowOf?: (id: string) => MatrixRowRead | null }) {
  const d = p.data
  const s = d ? stockOf(p.rowOf?.(d.id) ?? null) : null
  if (!s) return null
  if (s.uncounted) return <span className="nds-cell-value nds-cell-stock-out"><span className="nds-cell-value-text">⚠ {MATRIX_COPY.uncounted}</span></span>
  return <span className="nds-cell-value nds-cell-num"><span className="nds-cell-value-text">{s.available ?? '—'}</span></span>
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
  /** Preview mode: the two master columns are read-only, and this is the sentence they carry. */
  masterHeldReason: string | null
  onJump: (params: ICellRendererParams) => void
  /** The fulfilment select's CHOICE — the engine's setter routes it here and writes nothing (§3.4). */
  onPickFulfilment: (method: FulfilmentMethod, params: ICellRendererParams) => void
  rowsRef: MutableRefObject<StudioRow[]>
}

const rowId = (r: StudioRow) => r.id

export function buildMatrixColumns(opts: BuildMatrixColumnsOptions): (ColDef<StudioRow> | ColGroupDef<StudioRow>)[] {
  const { coordinates, cellsOf, rowOf, tracker, sheetColumns, locale, market, axesRef, rowMenuRef, masterHeldReason, onJump, onPickFulfilment, rowsRef } = opts

  const identity: ColDef<StudioRow> = {
    colId: IDENTITY_COL,
    headerName: 'Product',
    width: IDENTITY_COL_W, minWidth: IDENTITY_COL_W, maxWidth: IDENTITY_COL_W,
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
  const status = held(byId.get(STATUS_COL.toLowerCase()), {
    colId: STATUS_COL, headerName: 'Status', width: 104, minWidth: 104, editable: false,
    valueGetter: (p) => p.data?.status ?? null, cellClass: 'nds-ag-cell',
  })
  const stock: ColDef<StudioRow> = {
    colId: STOCK_COL,
    headerName: 'Stock',
    headerTooltip: 'The routed WAREHOUSE pool this SKU follows — the number Follow rows derive from. Parent = the family total.',
    width: 96, minWidth: 96,
    editable: false, suppressMovable: true, suppressHeaderMenuButton: true, sortable: true, resizable: true,
    cellClass: 'nds-ag-cell',
    valueGetter: (p) => (p.data ? stockOf(rowOf(p.data.id))?.available ?? null : null),
    cellRenderer: StockCell,
    cellRendererParams: { rowOf },
    tooltipValueGetter: (p) => {
      const s = p.data ? stockOf(rowOf(p.data.id)) : null
      if (!s) return undefined
      if (s.uncounted) return MATRIX_COPY.uncountedHint
      return s.locations.length ? s.locations.map((l) => `${l.code} ${l.available}`).join(' · ') : 'No routed location'
    },
    getQuickFilterText: (p) => { const s = p.data ? stockOf(rowOf(p.data.id)) : null; return s?.uncounted ? MATRIX_COPY.uncounted : String(s?.available ?? '') },
  }

  const groups: (ColDef<StudioRow> | ColGroupDef<StudioRow>)[] = [
    { groupId: 'grp-product', headerName: 'Product', children: [identity] },
    { groupId: 'grp-shared', headerName: 'Shared', children: [{ ...basePrice, headerName: 'Base price', width: BASE_PRICE_COL_W, minWidth: BASE_PRICE_COL_W }, stock, { ...status, headerName: 'Status', width: 104, minWidth: 104 }] },
  ]

  for (const coord of coordinates) {
    const children: ColDef<StudioRow>[] = []
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
        children.push(matrixColumnDef<StudioRow>(kind, o))
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
