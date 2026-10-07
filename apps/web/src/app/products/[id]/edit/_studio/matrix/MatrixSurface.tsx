'use client'

/**
 * MX.P — the Matrix page (design `docs/2026-09-13-matrix-page-design.md`, Revision + §3): rows = the
 * family's variants, columns = every coordinate the family is listed on, cells = the offer and
 * inventory controls the operator turns.
 *
 *     [ 21 rows · 1 parent · 20 variants   Find…   chips   Views Customise Export ⋯ ]   40px
 *     [ Selected 12 rows   Edit…   Stock source…   Clear ]          (while rows are ticked)
 *     [ PRODUCT │ SHARED                 │ AMAZON EU · INVENTORY · IT DE │ AMAZON · IT │ … ]   30px
 *     [ Product │ Base price Stock FBA qty │ Fulfilment Mode Qty Buffer Sync │ Listing Status Price Sale ] 28px
 *     [ … 36px rows … ]
 *     [ 21 rows · 20 variants · Amazon EU: quantity is shared by 4 markets · 2 pinned this session · Undo ]
 *
 * ## What this file composes, and what it refuses to re-implement
 *
 * The ROWS are the master sheet's (`useMasterSheet` — identity, version, completeness, the writer
 * and the tracker), the axis values and face images the family read's (`useFamilyProjections`), the
 * CELLS the Matrix read's (`useMatrix`), the cell DEFINITIONS the engine's (`matrixColumnDef`, MX.G),
 * the toolbar `SheetToolbar`, the Customise dialog the ONE `PreferencesModal`, and every change to the
 * ticked rows ONE dialog (`bulk/`, Owner 2026-10-07: "Edit…" — any field, on the markets chosen, preview,
 * apply, Undo). ONE state: every coordinate at once; the scope bar FILTERS the groups
 * (`filters.ts`). Nothing here derives a number — quantities, prices and states arrive on the read.
 *
 * 🔴 PREVIEW MODE (`read.source === 'preview'`, while `GET …/studio/matrix` answers 404): the banner
 * is on screen, every write and verb goes to `store.ts` in memory, and NOTHING reaches a server —
 * the Network panel is the proof (0 PATCH/POST to `/studio/matrix`; the sheet's own GET is the
 * positive control). The master column (`Base price`) is held with the reason.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Banner, useToast, type MenuItemDef } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { PreferencesModal, type PreferencesColumnSpec, type PreferencesValue } from '@/design-system/patterns'
import {
  ALL_VIEW_ID,
  columnStateToPrefs,
  columnsViewPayload,
  exportGridCsv,
  GridExportRefused,
  GridSheet,
  GridSheetNote,
  GridSheetStatus,
  gridGeometry,
  gridSelection,
  isColumnsViewPayload,
  matrixCellEditable,
  matrixCellText,
  matrixWrite,
  MATRIX_UNCHANGED,
  NexusGrid,
  prefsToColumnState,
  SHEET_GRID_OPTIONS,
  useGridLifetime,
  useGridState,
  writeGate,
  type ColDef,
  type ColumnsViewPayload,
  type GridApi,
  type GridReadyEvent,
  type GridViewPreset,
  type ICellRendererParams,
  type SavedGridView,
} from '@/design-system/grid'
import { useAuth } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { InventoryEditorModal } from '@/app/products/next/InventoryEditorModal'
import type { InventoryEditorTarget } from '@/app/products/next/useInventoryEditor'
import { DEFAULT_DENSITY } from '@/app/products/next/density'

import { useRegisterViewChip, useSaveReporter, useStudioScope, useViewChips } from '../contracts'
import { SHEET_STATE_OVERLAYS, sheetEmptyState } from '../sheet/sheetGridStates'
import { SheetLoadError } from '../sheet/SheetLoadError'
import { useMasterSheet } from '../sheet/master/useMasterSheet'
import { useReferenceNames } from '../sheet/useReferenceNames'
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import { usePublishActions } from '../sheet/usePublishActions'
import type { PublishActionsDestination } from '../sheet/publishActionsApi'
import { usePublishCellEditing, type PublishCellPlace } from '../sheet/usePublishCellEditing'
import { STATUS_COLUMN_LABEL, STATUS_READ_FAILED, statusCellText, statusCellValue, statusColumn, type PublishCellReadState } from '../sheet/channel/statusColumn'
import { ACTION_ROLE_CANNOT_PUBLISH } from '../sheet/channel/channelActions'
import { listingLabel } from '../sheet/master/sharedActionColumn'
import type { StudioRow } from '../sheet/master/types'
import { orderByAxisValues, type AxisSummary } from '../variants/family/coverage'
import { familyAxes, familyAxisValues, familyReadScope } from '../sheet/familyOrder'
import { useFamilyProjections } from '../variants/family/useFamilyProjections'

import { matrixChip, matrixChips } from './chips'
import { BASE_PRICE_COL, buildMatrixColumns, FBA_COL, fbaUnitsOf, hasMatrixStatus, IDENTITY_COL, IDENTITY_COL_W, identityWidthFor, isMatrixStatusColId, matrixColId, matrixGroupKeyOf, matrixStatusColId, parseMatrixColId, STOCK_COL } from './columns'
import { SCOPE_PROGRESS_COLUMN } from '../sheet/progressColumns'
import { MATRIX_ABSENT_CELL_LABELS, MATRIX_CELL_LABELS, MATRIX_COPY, type CoordinateKey, type FulfilmentMethod, type MatrixCellKind, type MatrixCoordinate, type MatrixWriteOutcome } from './contract'
import { filterCoordinates, filterNote, visibleCoordinateKeys } from './filters'
import { MatrixBanner } from './MatrixBanner'
import { MatrixSelectionActions } from './MatrixSelectionActions'
import { StockSourceDialog, type StockSourceSwitched, type StockSourceTarget } from './StockSourceDialog'
import { sharingApi } from '@/app/settings/sharing/sharingApi'
import { MatrixToolbar, type MatrixPageState } from './MatrixToolbar'
import { useMatrix } from './useMatrix'
import { clearsNothing, matrixStatusCell, publishCellsByPlace, savedBeforeMatrixFrom, savedBeforeMatrixStatus } from './statusCells'
import { FROM_LABEL, fromBefore, fromCellText, fromCellView, fromGroupKey, isMatrixFromColId, matrixFromColId } from './sellsFrom'
import { SellsFromDialog, type SellsFromSaved, type SellsFromTarget } from './SellsFromDialog'
import { refusalLead, refusedRowIds, type RefusedMark } from './refusals'
import { BulkEditDialog } from './bulk/BulkEditDialog'
import { createBulkSource, type BulkDoors } from './bulk/bulkSource'
import type { BulkContext } from './bulk/fields'
import type { BulkEditSource, BulkInitial } from './bulk/types'
import styles from './matrix.module.css'

/** Saved views live here (design D-MX8); widths, pins and sort are remembered per surface. */
export const MATRIX_VIEWS_SURFACE = 'product-edit:views:matrix'
export const MATRIX_LAYOUT_SURFACE = 'product-edit:matrix'
const PERSIST_KEYS = ['columnSizing', 'columnPinning', 'sort'] as const

const INVENTORY_KINDS: readonly MatrixCellKind[] = ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState']
const PRICING_KINDS: readonly MatrixCellKind[] = ['price', 'salePrice']

/** The Status columns' read: every market, each as its own channel sheet reads it (new rows on each main listing). */
const MATRIX_PUBLISH_DESTINATION: PublishActionsDestination = { newRows: 'every' }

const channelLabelOf = (channel: string): string =>
  ({ AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' } as Record<string, string>)[channel] ?? channel

export function MatrixSurface({ productId }: { productId: string }) {
  const { getApi: getGridApi, bind: bindGridApi, onGridPreDestroyed: releaseGrid } = useGridLifetime<GridApi<StudioRow>>()
  const reporter = useSaveReporter()
  const { has, status: authStatus } = useAuth()
  const toast = useToast()
  const studioScope = useStudioScope()
  const { scope, market, locale, accountId, options, marketplaces, setTab, setScope } = studioScope
  /* The family read's market and language — the Information page asks with the same rule (`familyReadScope`). */
  const { market: marketOrFirst, locale: localeOrFirst } = familyReadScope(studioScope)

  /* ── the rows: the sheet's, with the family read's axis values and images merged in ─────── */

  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const onWriteStart = useCallback((id: string, rowId: string) => reporter.pending(id, rowId), [reporter])
  const onWriteEnd = useCallback((id: string, ok: boolean, msg?: string, rowId?: string) => reporter.resolved(id, ok, msg, rowId), [reporter])
  const onSettled = useCallback(({ ok, savedAt }: { rowId?: string; ok: boolean; savedAt: string }) => { if (ok) setLastSavedAt(savedAt) }, [])
  const { sheet: loadedSheet, loading, error, contractProblems, reload, writer, tracker, conflicts, bindGrid } = useMasterSheet({
    productId, market: marketOrFirst, locale: localeOrFirst, onWriteStart, onWriteEnd, onSettled,
  })
  const sheet = useReferenceNames(loadedSheet, 'MASTER', marketOrFirst)
  const projectionsQuery = useFamilyProjections(productId, marketOrFirst, localeOrFirst)
  const projections = projectionsQuery.projections
  const axisKeys = useMemo(() => projections.axes.map((a) => a.key), [projections.axes])

  const rows = useMemo<StudioRow[]>(() => {
    const base = sheet?.rows ?? []
    if (axisKeys.length === 0 && Object.keys(projections.images).length === 0) return base
    return base.map((row) => {
      const axisValues = familyAxisValues(projections, row)
      const mine = projections.images[row.id]
      return { ...row, axisValues, imageUrl: row.imageUrl ?? mine?.url ?? null, imageInherited: row.imageUrl ? row.imageInherited : mine?.inherited, axisValuesSuspect: projections.suspect?.[row.id] ?? [] }
    })
  }, [sheet, axisKeys, projections.axisValues, projections.images, projections.suspect])
  const rowsRef = useRef<StudioRow[]>(rows)
  rowsRef.current = rows

  /* The family order the Information page shares — it builds the same axes with the same rule (`sheet/familyOrder.ts`). */
  const axes = useMemo<AxisSummary[]>(() => familyAxes(projections, sheet?.columns ?? [], rows), [projections.axes, sheet, rows])
  const axesRef = useRef<AxisSummary[]>(axes)
  axesRef.current = axes
  const ordered = useMemo(() => orderByAxisValues(rows, axes), [rows, axes])

  /* ── the Matrix read ─────────────────────────────────────────────────────────────────────── */

  const previewRows = useMemo(() => (sheet ? rows.map((r) => ({ id: r.id, sku: r.sku, isParent: r.isParent, basePrice: r.basePrice, status: r.status })) : null), [sheet, rows])
  const coordinateSource = useMemo(() => ({ channels: options.channels, marketplaces }), [options.channels, marketplaces])
  const getApiForMatrix = useCallback(() => getGridApi() as GridApi<{ id: string }> | null, [getGridApi])
  /* A server refusal is said the way the page says its own (`sayReason`, defined below with the verbs). */
  const sayRefusal = useRef<(reason: string) => void>(() => {})
  const onRefused = useCallback((reason: string) => sayRefusal.current(reason), [])
  /* A Matrix write (Fulfilment, Mode, Qty, a verb…) can move what a market's Status offers (an FBA warning, what may be
     paused): the Status read follows it, once per burst — as the Information page reads its own fresh. */
  const readStatusAgain = useRef<() => void>(() => {})
  const statusReread = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (statusReread.current) clearTimeout(statusReread.current) }, [])
  const onMatrixSettled = useCallback((info: { ok: boolean; savedAt: string }) => {
    onSettled(info)
    if (!info.ok) return
    if (statusReread.current) clearTimeout(statusReread.current)
    statusReread.current = setTimeout(() => { statusReread.current = null; readStatusAgain.current() }, 400)
  }, [onSettled])
  const matrix = useMatrix({ productId, accountId: accountId ?? null, locale, rows: previewRows, coordinates: coordinateSource, tracker, getApi: getApiForMatrix, can: has, onSettled: onMatrixSettled, onRefused })
  const read = matrix.read
  const previewMode = read?.source === 'preview'
  const masterHeldReason = previewMode ? 'Preview data — Base price is the Information sheet\'s; edit it there until the Matrix service lands.' : null

  /* ── the scope bar FILTERS the groups (filters.ts) ───────────────────────────────────────── */

  const filter = useMemo(() => ({ scope, market }), [scope, market])
  const visibleCoordinates = useMemo(() => (read ? filterCoordinates(read.coordinates, filter) : []), [read, filter])
  const visibleKeys = useMemo(() => (read ? visibleCoordinateKeys(read.coordinates, filter) : null), [read, filter])
  const scopeNote = useMemo(() => (read ? filterNote(read.coordinates, filter, channelLabelOf) : null), [read, filter])
  const euGroups = useMemo(() => visibleCoordinates.filter((c) => c.kind === 'region-inventory' && c.sharedInventoryWith), [visibleCoordinates])

  /* ── chips ───────────────────────────────────────────────────────────────────────────────── */

  const chipBar = useViewChips()
  const chips = useMemo(() => matrixChips(read, visibleKeys), [read, visibleKeys])
  /* By id, never by place (P12): a chip added to `matrixChips` cannot shift another chip's count onto the wrong id. */
  useRegisterViewChip('matrix-pinned', matrixChip(chips, 'matrix-pinned'))
  useRegisterViewChip('matrix-paused', matrixChip(chips, 'matrix-paused'))
  useRegisterViewChip('matrix-oversold', matrixChip(chips, 'matrix-oversold'))
  useRegisterViewChip('matrix-sync-issues', matrixChip(chips, 'matrix-sync-issues'))
  useRegisterViewChip('matrix-suppressed', matrixChip(chips, 'matrix-suppressed'))
  useRegisterViewChip('matrix-not-selling', matrixChip(chips, 'matrix-not-selling'))

  /* ── refusals: every refused cell, its reason, and a view of the rows they are on ────────── */

  const [refusedMarks, setRefusedMarks] = useState<RefusedMark[]>([])
  useEffect(() => {
    const collect = () => {
      const marks: RefusedMark[] = []
      for (const row of rowsRef.current) for (const c of visibleCoordinates) for (const k of c.cells) {
        const m = tracker.get(row.id, matrixColId(c.key, k))
        if (m?.state === 'refused') marks.push({ rowId: row.id, coordinate: c, kind: k, reason: m.reason })
      }
      setRefusedMarks(marks)
    }
    collect()
    return tracker.subscribe(collect)
  }, [tracker, visibleCoordinates])
  const [showRefusedOnly, setShowRefusedOnly] = useState(false)
  useEffect(() => { if (refusedMarks.length === 0) setShowRefusedOnly(false) }, [refusedMarks.length])
  const refusedIds = useMemo(() => refusedRowIds(refusedMarks), [refusedMarks])
  const refusalExample = useMemo(() => refusalLead(refusedMarks), [refusedMarks])
  const refusalReason = refusedMarks.find((mark) => mark.reason)?.reason ?? refusalExample

  const [search, setSearch] = useState('')
  const visibleRows = useMemo(() => {
    const chipRows = chipBar.active?.cells.byRow
    const needle = search.trim().toLowerCase()
    return ordered.filter((row) => {
      if (showRefusedOnly && refusedIds.size > 0 && !refusedIds.has(row.id)) return false
      if (chipRows && !(row.id in chipRows)) return false
      if (!needle) return true
      const line = axesRef.current.map((a) => String(row.axisValues?.[a.key] ?? '')).join(' ')
      return `${row.sku} ${row.name ?? ''} ${line}`.toLowerCase().includes(needle)
    })
  }, [ordered, chipBar.active, search, showRefusedOnly, refusedIds])

  /* ── the bulk Edit: one dialog for every change (Owner 2026-10-07) ─────────────────────────── */

  /* ONE way a refusal sentence reaches the operator, de-duplicated the way the sheet does it (a fill
     refused twenty times for one reason is one sentence). */
  const lastSaid = useRef({ text: '', at: 0 })
  const sayReason = useCallback((reason: string, tone: 'info' | 'danger') => {
    const now = Date.now()
    if (reason === lastSaid.current.text && now - lastSaid.current.at < 2500) return
    lastSaid.current = { text: reason, at: now }
    toast.toast(reason, tone)
  }, [toast])
  sayRefusal.current = (reason: string) => sayReason(reason, 'danger')
  const [selectedRows, setSelectedRows] = useState<StudioRow[]>([])
  // Shared stock by SKU (2026-10-01): "Stock source…" — the ticked SKUs, or the whole family when the parent is ticked.
  const [stockSourceTargets, setStockSourceTargets] = useState<StockSourceTarget[] | null>(null)
  const canSwitchStock = has('inventory.adjust')
  /* Stock per location (Owner 2026-10-07): the Stock cell opens the Products page's inventory editor — the SAME
     component — for its row: a parent opens the family, a variant its own SKU. */
  const [stockRow, setStockRow] = useState<InventoryEditorTarget | null>(null)
  const openStock = useCallback((rowId: string) => {
    const r = rowsRef.current.find((x) => x.id === rowId)
    const m = matrix.rowOf(rowId)
    if (!r || !m) return
    // A variant often has no name of its own: the editor's title is then the family's name.
    const parent = rowsRef.current.find((x) => matrix.rowOf(x.id)?.role === 'parent')
    const name = r.name?.trim() || parent?.name?.trim() || r.sku
    setStockRow({ id: r.id, sku: r.sku, name, isParent: m.role === 'parent', imageUrl: r.imageUrl ?? null })
  }, [matrix])
  const stockDoor = !previewMode && canSwitchStock ? openStock : undefined
  // The editor's Apply says `stock.adjusted` (this tab and the others): the Matrix re-reads its numbers quietly.
  useInvalidationChannel('stock.adjusted', () => { matrix.refresh() })
  /* "Sells from" (Step 2, Owner 2026-10-07): each market group's From cell opens one small pop-up — this product's
     warehouses, or the market default for every product. Read through refs so the door stays one function. */
  const readRef = useRef(read)
  readRef.current = read
  const [fromTarget, setFromTarget] = useState<SellsFromTarget | null>(null)
  const openFrom = useCallback((rowId: string, key: CoordinateKey, anchor: HTMLElement | null) => {
    const r = rowsRef.current.find((x) => x.id === rowId)
    const coord = readRef.current?.coordinates.find((c) => c.key === key)
    if (!r || !coord || !matrix.cellsOf(rowId, key)?.source?.writable) return
    setFromTarget({ rowId, sku: r.sku, coordinate: coord, anchor })
  }, [matrix.cellsOf])
  const fromDoor = !previewMode && canSwitchStock && (read?.locations?.length ?? 0) > 0 ? openFrom : undefined
  /** This product's choice, through the Matrix door at the cell's current version; quiet: the pop-up says a refusal. */
  const writeSource = useCallback(async (rowId: string, key: CoordinateKey, codes: string[]): Promise<MatrixWriteOutcome | null> => {
    const cells = matrix.cellsOf(rowId, key)
    if (!cells?.source || !cells.listingId) return null
    const [outcome] = await matrix.write([{ rowId, coordinateKey: key, cell: 'source', value: codes, expectedVersion: cells.version, expectedListingId: cells.listingId }], { quiet: true })
    return outcome ?? null
  }, [matrix])
  /** After a save: one toast with Undo (the bulk Edit's pattern). A market default re-pushes in the background: read again now and once more soon. */
  const onFromSaved = useCallback((saved: SellsFromSaved) => {
    const soon = () => { if (saved.scope === 'market') { matrix.refresh(); setTimeout(() => matrix.refresh(), 1500) } }
    let used = false
    const undo = async () => {
      if (used) return
      used = true
      try { toast.toast(await saved.undo(), 'info') } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'danger') } finally { soon() }
    }
    toast.toast(
      <span className="nds-matrix-toast">{saved.sentence} <Button size="sm" variant="link" onClick={() => { void undo() }}>Undo</Button></span>,
      'success',
      { duration: 12000 },
    )
    soon()
  }, [toast, matrix])
  const onReloadRef = useRef<() => void>(() => {})

  /**
   * The market group the operator is in — the Edit dialog ticks it first when the field lives there.
   *
   * 🔴 React state fed by AG's `cellFocused`, not a read of `api.getFocusedCell()` inside a memo — measured 17:1x: a
   * memo kept the old group after the focus had moved, because nothing re-ran it when only the focus moved.
   */
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const onCellFocused = useCallback((e: { column?: { getColId?: () => string } | string | null }) => {
    const col = e.column
    const colId = typeof col === 'string' ? col : col?.getColId?.()
    // A market's Status cell belongs to its group too.
    setFocusedKey(matrixGroupKeyOf(colId))
  }, [])
  /** Opens the Edit dialog on these rows (defined below, once the Status cells it reaches are). */
  const openBulkRef = useRef<(rows: readonly StudioRow[], initial?: BulkInitial) => void>(() => {})

  /* ── the grid ────────────────────────────────────────────────────────────────────────────── */

  const selfInflicted = useRef(false)

  /**
   * `syncState` click → Needs attention (Errors & Sync) on that listing's channel.
   *
   * 🔴 ONE merged URL patch, through the frame's own resolvers: `setScope(channel)` re-resolves the
   * market (kept when the channel serves it, else the channel's first) and CLEARS the locale so the
   * frame picks the scope's own; `setTab('errors')` adds the tab. Measured 17:2x: `setTab('errors',
   * channel)` alone carried the master locale (`it`) onto `Amazon · DE` and landed on the scope-error
   * state ("Choose a supported content language for this scope: de"). The frame merges same-tick
   * patches (later keys win), so the two calls are one navigation.
   */
  const onJump = useCallback((params: ICellRendererParams) => {
    const parsed = parseMatrixColId(params.colDef?.colId)
    const coord = parsed ? read?.coordinates.find((c) => c.key === parsed.key) : null
    if (!coord) return
    setScope(coord.channel)
    setTab('errors')
  }, [read, setScope, setTab])

  /* The Fulfilment cell's select: the choice opens the Edit dialog on that row and market, method chosen — the same
     preview, confirm word and Undo as a change made for many rows (§3.4: the cell itself writes nothing). */
  const onPickFulfilment = useCallback((method: FulfilmentMethod, params: ICellRendererParams) => {
    const parsed = parseMatrixColId(params.colDef?.colId)
    const row = params.data as StudioRow | undefined
    const coord = parsed ? read?.coordinates.find((c) => c.key === parsed.key) : null
    if (!coord || !row) return
    openBulkRef.current([row], { field: 'fulfilment', mode: 'method', input: { choice: method }, coordinateKeys: [coord.key] })
  }, [read])

  /* A phone: the pinned identity gives way so a coordinate column can be on screen (`identityWidthFor`). The room it
     shares is the grid's width less the OTHER pinned columns (the selection checkbox). Changes only when the grid
     crosses a width that changes the answer, so a desktop resize rebuilds nothing. */
  const [identityWidth, setIdentityWidth] = useState(IDENTITY_COL_W)
  const onGridSizeChanged = useCallback((e: { clientWidth: number; api: GridApi<StudioRow> }) => {
    const otherPinned = e.api.getDisplayedLeftColumns().filter((c) => c.getColId() !== IDENTITY_COL).reduce((n, c) => n + c.getActualWidth(), 0)
    const next = identityWidthFor(e.clientWidth - otherPinned)
    setIdentityWidth((prev) => (prev === next ? prev : next))
  }, [])
  /* ── Status per market (Owner 2026-10-07): the Information page's Status column itself, once per market ──────────────
     The values are the publish actions' — ONE read of every market, each exactly as that market's own sheet reads it
     (`newRows: 'every'`), kept live by the same store: a change on the Information page (any tab) reads again, and one
     made here reaches it the same way. Edits, fills, pastes and Delete go through the sheet's own editing
     (`usePublishCellEditing`): staged, written per value, one toast — and Publish sends them. Not in preview mode
     (fixture listings have no publish actions). */

  const publishActions = usePublishActions(productId, previewMode ? null : MATRIX_PUBLISH_DESTINATION, { familyId: sheet?.family.id ?? null })
  const publishActionsRef = useRef(publishActions)
  publishActionsRef.current = publishActions
  readStatusAgain.current = () => { void publishActionsRef.current.reload() }
  const cellsOfRef = useRef(matrix.cellsOf)
  cellsOfRef.current = matrix.cellsOf
  const publishByPlace = useMemo(() => publishCellsByPlace(publishActions.rows), [publishActions.rows])
  const publishByPlaceRef = useRef(publishByPlace)
  publishByPlaceRef.current = publishByPlace
  /** A row's Status cell on a market: its listing's (the Matrix's listing id), else the row that market's sheet shows for it. */
  const statusCellOf = useCallback((row: StudioRow, coord: MatrixCoordinate): PublishActionCell | null =>
    matrixStatusCell(row.id, coord, cellsOfRef.current(row.id, coord.key)?.listingId, publishActionsRef.current.byListingId, publishByPlaceRef.current), [])
  const publishRead = useMemo<PublishCellReadState>(() => ({
    loaded: publishActions.status === 'ready' || publishActions.status === 'error',
    failed: publishActions.status === 'error',
    lockedReason: authStatus !== 'loading' && !has('products.publish') ? ACTION_ROLE_CANNOT_PUBLISH : null,
  }), [publishActions.status, authStatus, has])
  const publishReadRef = useRef(publishRead)
  publishReadRef.current = publishRead
  const canDeleteRef = useRef(false)
  canDeleteRef.current = has('products.delete')
  const statusCoordinates = useMemo(() => (previewMode ? [] : visibleCoordinates.filter(hasMatrixStatus)), [previewMode, visibleCoordinates])
  const statusCoordinatesRef = useRef(statusCoordinates)
  statusCoordinatesRef.current = statusCoordinates
  const statusColIds = useMemo(() => statusCoordinates.map((c) => matrixStatusColId(c.key)), [statusCoordinates])
  const statusColIdsRef = useRef(statusColIds)
  statusColIdsRef.current = statusColIds
  const repaintStatusCells = useCallback((rowIds?: Iterable<string>) => {
    const api = getGridApi()
    if (!api || api.isDestroyed() || statusColIdsRef.current.length === 0) return
    const nodes = rowIds ? [...new Set(rowIds)].flatMap((id) => { const node = api.getRowNode(id); return node ? [node] : [] }) : undefined
    api.refreshCells({ ...(nodes ? { rowNodes: nodes } : {}), columns: [...statusColIdsRef.current], force: true })
  }, [getGridApi])
  /** A row's Status cell on a market, as the shared editing takes it: where it is, its value, and how the toast names it. */
  const statusPlaceOf = useCallback((row: StudioRow, coord: MatrixCoordinate): PublishCellPlace => {
    const cell = statusCellOf(row, coord)
    return { rowId: row.id, colId: matrixStatusColId(coord.key), column: 'status', cell, sku: cell ? listingLabel(row.sku, cell) : row.sku }
  }, [statusCellOf])
  const statusEditing = usePublishCellEditing({
    write: (change, listingIds) => publishActionsRef.current.write(change, listingIds),
    places: () => {
      const at = new Map<string, { rowId: string; colId: string; label: string }>()
      for (const coord of statusCoordinatesRef.current) for (const row of rowsRef.current) {
        const cell = statusCellOf(row, coord)
        if (cell) at.set(cell.listingId, { rowId: row.id, colId: matrixStatusColId(coord.key), label: listingLabel(row.sku, cell) })
      }
      return { place: (listingId, column) => (column === 'status' ? at.get(listingId) ?? null : null), label: (listingId) => at.get(listingId)?.label ?? null }
    },
    read: () => publishReadRef.current,
    repaint: repaintStatusCells,
    toast: (message, tone, options) => toast.toast(message, tone, options),
    // New listings: a choice started drafts — the Matrix reads again QUIETLY (its live re-read: the grid keeps its rows and
    // columns, and waits for an open editor) to hold their ids.
    onStarted: () => matrix.refresh(),
  })
  const { stage: stageStatus, tracker: statusTracker, onClearKey: clearStatusCells, begin: beginStatusOperation, end: endStatusOperation } = statusEditing
  const statusColumnOf = useCallback((coord: MatrixCoordinate): ColDef<StudioRow> | null => statusColumn<StudioRow>({
    colId: matrixStatusColId(coord.key),
    cell: (row) => statusCellOf(row, coord),
    read: () => publishReadRef.current,
    onInput: (row, input) => {
      const place = statusPlaceOf(row, coord)
      /* A range Delete begun on another Matrix cell (AG's own clear) reaches each Status cell as a clear: like the sheet's
         Delete rule (`onClearKey`), only a cell with a value waiting has one to clear — the rest are left as they are. */
      if (clearsNothing(input, place.cell)) return
      stageStatus(place, input)
    },
    canDelete: () => canDeleteRef.current,
    tracker: statusTracker,
    rowIdOf: (row) => row.id,
  }), [statusCellOf, statusPlaceOf, stageStatus, statusTracker])
  /* A new read (or a permission answer) repaints only the Status cells whose value changed (`equals`). */
  useEffect(() => { const api = getGridApi(); if (api && !api.isDestroyed() && statusColIds.length) api.refreshCells({ columns: statusColIds }) }, [publishActions.version, publishRead, statusColIds, getGridApi])
  /* A fill, a paste or a range Delete is one Status operation: one write per value, one toast. */
  const statusOperationProps = useMemo(() => ({
    onFillStart: beginStatusOperation, onFillEnd: endStatusOperation,
    onPasteStart: beginStatusOperation, onPasteEnd: endStatusOperation,
    onCellSelectionDeleteStart: beginStatusOperation, onCellSelectionDeleteEnd: endStatusOperation,
  }), [beginStatusOperation, endStatusOperation])

  /* ── the bulk Edit's doors ──────────────────────────────────────────────────────────────────
     Read at every preview and Apply through refs: a write moves cells and versions while the dialog is open. */

  const bulkLive = useRef({ visibleCoordinates, focusedKey, masterHeldReason, publishRead, previewMode, canPrice: false, canDelete: false, canStock: false })
  bulkLive.current = {
    visibleCoordinates, focusedKey, masterHeldReason, publishRead, previewMode,
    // "Sells from" needs `inventory.adjust` (the server's preview refuses it per row too).
    canStock: has('inventory.adjust'),
    // The server refuses every price write without both (`products.edit` on the route, `products.price.edit` in the service).
    canPrice: has('products.edit') && has('products.price.edit'),
    canDelete: has('products.delete'),
  }
  const statusEditingRef = useRef(statusEditing)
  statusEditingRef.current = statusEditing
  const statusPlaceOfRef = useRef(statusPlaceOf)
  statusPlaceOfRef.current = statusPlaceOf

  const bulkDoors = useCallback((rows: readonly StudioRow[]): BulkDoors => {
    const context = (): BulkContext => {
      const live = bulkLive.current
      const now = new Map(rowsRef.current.map((r) => [r.id, r]))
      return {
        rows: rows.map((r) => ({ id: r.id, sku: r.sku, isParent: r.isParent, basePrice: now.get(r.id)?.basePrice ?? r.basePrice ?? null })),
        coordinates: live.visibleCoordinates,
        cellsOf: (rowId, key) => cellsOfRef.current(rowId, key),
        statusCellOf: (rowId, coord) => { const row = now.get(rowId); return row ? statusCellOf(row, coord) : null },
        canPrice: live.canPrice,
        masterHeld: live.masterHeldReason,
        statusHeld: live.previewMode ? 'Preview data — the markets\' Status is set on each market\'s own sheet until the Matrix service lands.'
          : !live.publishRead.loaded ? 'The markets\' Status is still being read. Try again in a moment.'
            : live.publishRead.failed ? STATUS_READ_FAILED : live.publishRead.lockedReason,
        canDelete: live.canDelete,
        focusedKey: live.focusedKey,
        locations: readRef.current?.locations,
        canStock: live.canStock,
      }
    }
    return {
      context,
      previewVerb: (req) => matrix.previewVerbRun(req),
      applyVerb: (preview) => matrix.applyVerbRun(preview),
      revertVerb: (op) => matrix.revert(op),
      writeCells: (cells) => matrix.write(cells),
      /* Base price: the grid's own road (as the Information page's "Set every row…"): each value lands on its row and
         reaches `onCellValueChanged` → the master writer, fenced as ONE operation so it leaves as one save. */
      masterWrite: async (writes) => {
        const api = getGridApi()
        if (!api || api.isDestroyed()) throw new Error('The grid is not ready. Try again in a moment.')
        writer.beginOperation()
        try {
          for (const w of writes) api.getRowNode(w.rowId)?.setDataValue(BASE_PRICE_COL, w.value, 'bulk-edit')
        } finally {
          writer.endOperation()
        }
        await writer.flush()
        return writes.map((w) => {
          const mark = tracker.get(w.rowId, BASE_PRICE_COL)
          return mark?.state === 'refused' ? { rowId: w.rowId, ok: false, reason: mark.reason } : { rowId: w.rowId, ok: true }
        })
      },
      /* Each market's Status: the Status column's own editing (one write per value, the cells marked), answered, quiet —
         the dialog says the result. */
      statusWrite: async (target, places) => {
        const coords = bulkLive.current.visibleCoordinates
        const now = new Map(rowsRef.current.map((r) => [r.id, r]))
        const at = places.flatMap((p) => {
          const row = now.get(p.rowId)
          const coord = coords.find((c) => c.key === p.coordinateKey)
          return row && coord ? [{ ...p, place: statusPlaceOfRef.current(row, coord) }] : []
        })
        const answer = await statusEditingRef.current.fillNow({ column: 'status', target }, at.map((a) => a.place), { quiet: true })
        // Each cell's answer, by its listing: saved, or the server's reason (a whole write that failed refuses its cells).
        const saved = new Set(answer.outcomes.flatMap((o) => (o.ok ? o.applied : [])))
        const why = new Map<string, string>()
        for (const o of answer.outcomes) {
          if (!o.ok) for (const id of o.requested) why.set(id, o.error ?? 'The change could not be saved')
          for (const r of o.refused) why.set(r.listingId, r.reason)
          for (const c of o.conflicts) why.set(c.listingId, `${c.setByName ?? 'Someone else'} changed it first`)
        }
        const early = new Map(answer.refused.map((r) => [r.sku, r.reason]))
        const applied: Array<{ rowId: string; coordinateKey: string }> = []
        const refused: Array<{ rowId: string; coordinateKey: string; reason: string }> = []
        for (const a of at) {
          const id = a.place.cell?.listingId
          if (id && saved.has(id)) applied.push({ rowId: a.rowId, coordinateKey: a.coordinateKey })
          else refused.push({ rowId: a.rowId, coordinateKey: a.coordinateKey, reason: (id ? why.get(id) : undefined) ?? early.get(a.place.sku) ?? 'Not saved' })
        }
        return { applied, refused }
      },
    }
  }, [matrix, getGridApi, writer, tracker, statusCellOf])

  const [bulk, setBulk] = useState<{ source: BulkEditSource; initial?: BulkInitial } | null>(null)
  /** The last change the dialog applied that can still be put back — offered again as a toast when the dialog closes. */
  const bulkUndo = useRef<{ sentence: string; undo: () => Promise<string>; used: boolean } | null>(null)
  const openBulk = useCallback((rows: readonly StudioRow[], initial?: BulkInitial) => {
    if (!read || rows.length === 0) return
    const variantsTicked = rows.filter((r) => !r.isParent).length
    const family = sheet?.family.sku ?? ''
    const total = rowsRef.current.filter((r) => !r.isParent).length
    const base = createBulkSource(bulkDoors(rows), {
      title: rows.length === 1 ? `Edit ${rows[0]!.sku}` : `Edit ${rows.length} rows`,
      subtitle: [family, rows.length === 1 && rows[0]!.isParent ? 'the parent row' : `${variantsTicked} of ${total} ${total === 1 ? 'variant' : 'variants'}`].filter(Boolean).join(' · '),
    })
    bulkUndo.current = null
    setBulk({
      initial,
      source: {
        ...base,
        apply: async (preview) => {
          const result = await base.apply(preview)
          if (!result.undo) { bulkUndo.current = null; return result }
          const entry = { sentence: result.sentence, undo: result.undo, used: false }
          bulkUndo.current = entry
          return { ...result, undo: async () => { entry.used = true; return result.undo!() } }
        },
      },
    })
  }, [read, sheet, bulkDoors])
  openBulkRef.current = openBulk
  const closeBulk = useCallback(() => {
    setBulk(null)
    const last = bulkUndo.current
    bulkUndo.current = null
    if (!last || last.used) return
    const undo = async () => {
      if (last.used) return
      last.used = true
      try { toast.toast(await last.undo(), 'info') } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'danger') }
    }
    toast.toast(
      <span className="nds-matrix-toast">{last.sentence} <Button size="sm" variant="link" onClick={() => { void undo() }}>Undo</Button></span>,
      'success',
      { duration: 12000 },
    )
  }, [toast])

  /* The row ⋯: Edit that one row, and the two stock-sync actions on it — each opens the same dialog, preview first. */
  const rowMenuRef = useRef<(row: StudioRow) => MenuItemDef[]>(() => [])
  rowMenuRef.current = useMemo(() => (row: StudioRow): MenuItemDef[] => {
    if (!read) return []
    const edit: MenuItemDef = { id: 'matrix-row-edit', label: 'Edit…', description: `${row.sku} · price, status, fulfilment, quantity…`, onSelect: () => openBulk([row]) }
    if (row.isParent) return [edit]
    const coords = visibleCoordinates.filter((c) => c.connected)
    const cells = coords.map((c) => matrix.cellsOf(row.id, c.key)).filter((c): c is NonNullable<typeof c> => !!c)
    const noInventory = cells.some((c) => !!c.sync) ? null : 'Nothing on this row carries inventory'
    const noFailure = cells.some((c) => c.queue?.state === 'failed' || c.queue?.state === 'dead') ? null : 'Nothing on this row has failed'
    return [
      edit,
      { id: 'matrix-row-push-now', label: 'Push quantity now…', description: noInventory ?? 'Sends the quantity each market should show — preview first', disabled: !!noInventory, onSelect: () => openBulk([row], { field: 'stockSync', mode: 'push' }) },
      { id: 'matrix-row-retry-sync', label: 'Retry…', description: noFailure ?? 'Sends the failed push again — preview first', disabled: !!noFailure, onSelect: () => openBulk([row], { field: 'stockSync', mode: 'retry' }) },
    ]
  }, [read, visibleCoordinates, matrix, openBulk])

  const columnDefs = useMemo(
    () => buildMatrixColumns({
      coordinates: visibleCoordinates, cellsOf: matrix.cellsOf, rowOf: matrix.rowOf, tracker,
      sheetColumns: sheet?.columns ?? [], locale: localeOrFirst, market: marketOrFirst,
      axesRef, rowMenuRef, masterHeldReason, onJump, onPickFulfilment, rowsRef, identityWidth,
      statusColumnOf: previewMode ? undefined : statusColumnOf, onOpenStock: stockDoor, onOpenFrom: fromDoor,
    }),
    [visibleCoordinates, matrix.cellsOf, matrix.rowOf, tracker, sheet?.columns, localeOrFirst, marketOrFirst, masterHeldReason, onJump, onPickFulfilment, identityWidth, previewMode, statusColumnOf, stockDoor, fromDoor],
  )
  const defaultColDef = useMemo<ColDef<StudioRow>>(() => ({ sortable: true, resizable: true }), [])
  const rowSelection = useMemo(() => gridSelection<StudioRow>(), [])
  const getRowId = useCallback((p: { data: StudioRow }) => p.data.id, [])

  const onSelectionChanged = useCallback((e: { api: GridApi<StudioRow> }) => {
    setSelectedRows(e.api.getSelectedNodes().map((n) => n.data).filter((d): d is StudioRow => !!d))
  }, [])

  const onCellValueChanged = useCallback(
    (e: { data: StudioRow; colDef: { colId?: string }; oldValue?: unknown; newValue: unknown; source?: string }) => {
      const colId = e.colDef.colId
      /* A market's Status column never writes here: its setter stages the value (`usePublishCellEditing`) and returns
         false, so AG fires no change — and should one arrive anyway, it is not a Matrix or a master cell. */
      if (isMatrixStatusColId(colId) || isMatrixFromColId(colId)) return
      if (!writeGate({ colId, source: e.source, selfInflicted: selfInflicted.current, oldValue: e.oldValue, newValue: e.newValue }).write) return
      const parsed = parseMatrixColId(colId)
      if (!parsed) {
        /* A SHARED column (`Base price`, `Status`): the sheet's own write path, held in preview mode. */
        if (masterHeldReason || !colId) return
        writer.set(e.data.id, colId, e.newValue, { row: e.data })
        return
      }
      /* `fulfilment` never arrives here: the engine's setter hands the choice to `onPickFulfilment`
         and returns false, so AG fires no change (§3.4). Everything else goes through the engine's
         ONE routing branch, then the page's one door. */
      const cells = matrix.cellsOf(e.data.id, parsed.key)
      const decision = matrixWrite({ kind: parsed.kind, coordinateKey: parsed.key, rowId: e.data.id }, cells, e.oldValue, e.newValue)
      if (!decision.send) {
        if (decision.reason !== MATRIX_UNCHANGED) {
          tracker.set(e.data.id, colId!, 'refused', decision.reason)
          const api = getGridApi(); const node = api?.getRowNode(e.data.id)
          if (api && node) api.refreshCells({ rowNodes: [node], columns: [colId!], force: true })
          sayReason(decision.reason, 'danger')
        }
        return
      }
      void matrix.write([decision.cell])
    },
    [matrix, writer, tracker, masterHeldReason, getGridApi, sayReason],
  )

  /* ── a held cell EXPLAINS itself on an open gesture (the sheet's `explainRefusal` rule) ──── */

  const explainHeld = useCallback((e: { data?: StudioRow; colDef?: { colId?: string } }) => {
    const colId = e.colDef?.colId
    /* The FBA qty column is locked on every row: an open gesture says why, as any held Matrix cell does. */
    if (colId === FBA_COL && e.data) { sayReason(MATRIX_COPY.fbaLocked, 'info'); return true }
    /* A From cell that cannot open says why (the parent, FBA, shared stock, no right to adjust stock). */
    if (isMatrixFromColId(colId) && e.data) {
      const coord = read?.coordinates.find((c) => c.key === fromGroupKey(colId!))
      const held = coord ? fromCellView(matrix.rowOf(e.data.id), matrix.cellsOf(e.data.id, coord.key), coord).held : null
      if (held) { sayReason(held, 'info'); return true }
      return false
    }
    const parsed = parseMatrixColId(colId)
    if (!parsed || !e.data || !colId) return false
    const marked = tracker.get(e.data.id, colId)
    if (marked?.state === 'refused' && marked.reason) { sayReason(marked.reason, 'info'); return true }
    const held = matrixCellEditable(parsed.kind, matrix.cellsOf(e.data.id, parsed.key))
    if (held.editable || !held.reason) return false
    sayReason(held.reason, 'info')
    return true
  }, [tracker, matrix, sayReason, read])
  /** The From door on an open gesture (double-click, Enter, F2), when the cell has one; anchored on the cell. */
  const openFromCell = useCallback((e: { data?: StudioRow; colDef?: { colId?: string }; event?: Event | null }): boolean => {
    const colId = e.colDef?.colId
    if (!isMatrixFromColId(colId) || !e.data || !fromDoor) return false
    const key = fromGroupKey(colId!)
    if (!matrix.cellsOf(e.data.id, key)?.source?.writable || matrix.rowOf(e.data.id)?.stock.source) return false
    const target = e.event?.target
    fromDoor(e.data.id, key, target instanceof Element ? target.closest<HTMLElement>('[role="gridcell"]') : null)
    return true
  }, [fromDoor, matrix])
  const onCellDoubleClicked = useCallback((e: { data?: StudioRow; colDef?: { colId?: string }; event?: Event | null }) => {
    if (e.colDef?.colId === STOCK_COL && e.data && stockDoor) { stockDoor(e.data.id); return }
    if (openFromCell(e)) return
    explainHeld(e)
  }, [explainHeld, stockDoor, openFromCell])
  /* AG's union includes a full-width variant without `colDef`; both are typed loosely and guarded. */
  const onCellKeyDown = useCallback((e: { data?: StudioRow; colDef?: { colId?: string }; event?: Event | null; column?: { getColId(): string } | null }) => {
    /* Delete / Backspace on a market's Status: the selected Status cells go back to "no change" (the sheet's rule). */
    if (clearStatusCells<StudioRow>({ event: e.event, column: e.column ?? null }, getGridApi() ?? null, (row) => row.id, isMatrixStatusColId, (target) => {
      const coord = statusCoordinatesRef.current.find((c) => matrixStatusColId(c.key) === target.colId)
      return coord ? statusPlaceOf(target.row, coord) : null
    })) return
    const key = e.event as KeyboardEvent | undefined
    if (!key || key.altKey || key.ctrlKey || key.metaKey) return
    if ((key.key === 'Enter' || key.key === 'F2') && e.colDef?.colId === STOCK_COL && e.data && stockDoor) { stockDoor(e.data.id); return }
    if ((key.key === 'Enter' || key.key === 'F2') && openFromCell(e)) return
    const opens = key.key === 'Enter' || key.key === 'F2' || (key.key.length === 1 && key.key !== ' ')
    if (opens) explainHeld(e)
  }, [explainHeld, clearStatusCells, getGridApi, statusPlaceOf, stockDoor, openFromCell])

  /* ── views: presets + saved views on the Matrix surface ─────────────────────────────────── */

  const allColIds = useMemo(() => {
    const ids: string[] = [IDENTITY_COL, BASE_PRICE_COL, STOCK_COL, FBA_COL]
    for (const c of visibleCoordinates) {
      if (!c.connected || c.cells.length === 0) ids.push(matrixColId(c.key, 'notListed'))
      else for (const k of c.cells) {
        if (k === fromBefore(c)) ids.push(matrixFromColId(c.key))
        ids.push(matrixColId(c.key, k))
        if (k === 'listing' && statusColIds.includes(matrixStatusColId(c.key))) ids.push(matrixStatusColId(c.key))
      }
    }
    return ids
  }, [visibleCoordinates, statusColIds])
  const presets = useMemo<GridViewPreset[]>(() => {
    const byKind = (kinds: readonly MatrixCellKind[], shared: readonly string[]) => [IDENTITY_COL, ...shared, ...allColIds.filter((id) => { const p = parseMatrixColId(id); return !!p && kinds.includes(p.kind) })]
    return [
      { id: ALL_VIEW_ID, label: 'Everything', description: 'Every coordinate, every cell', columns: allColIds },
      { id: 'inventory', label: 'Inventory', description: 'Stock, FBA qty and the inventory lane: Fulfilment · From · Mode · Qty · Buffer · Sync', columns: [...byKind(INVENTORY_KINDS, [STOCK_COL, FBA_COL]), ...allColIds.filter(isMatrixFromColId)] },
      { id: 'pricing', label: 'Pricing', description: 'Base price and every coordinate\'s Price and Sale', columns: byKind(PRICING_KINDS, [BASE_PRICE_COL]) },
      { id: 'listings', label: 'Listings', description: 'Every market\'s Listing state and selling Status', columns: [...byKind(['listing'], []), ...allColIds.filter(isMatrixStatusColId)] },
    ]
  }, [allColIds])

  const visibleColIds = useCallback((): string[] => {
    const api = getGridApi()
    return api ? api.getAllDisplayedColumns().map((c) => c.getColId()).filter((id) => allColIds.includes(id)) : allColIds
  }, [getGridApi, allColIds])
  const [activePresetId, setActivePresetId] = useState<string | null>(ALL_VIEW_ID)
  const applyVisible = useCallback((keys: readonly string[], savedBefore: { status?: boolean; from?: boolean } = {}) => {
    const api = getGridApi()
    if (!api) return
    /* The progress column is kept like the Product cell: every saved view and preset predates it, and a view that
       could not have listed it must not hide it (the sheet's structural-column rule, views.ts). */
    const want = new Set([IDENTITY_COL, SCOPE_PROGRESS_COLUMN, ...keys])
    /* A view saved before the markets' Status columns existed (`MATRIX_STATUS_SINCE`) could not name them: it shows the
       Status of each Listing it shows, rather than hiding them all. A view saved since keeps exactly what it names. */
    if (savedBefore.status && !keys.some(isMatrixStatusColId))
      for (const colId of allColIds) if (isMatrixStatusColId(colId) && want.has(matrixColId(colId.slice(0, colId.lastIndexOf('.')), 'listing'))) want.add(colId)
    /* The same for the From columns (Step 2): a view saved before them shows From wherever it shows that group's Qty. */
    if (savedBefore.from && !keys.some(isMatrixFromColId))
      for (const colId of allColIds) if (isMatrixFromColId(colId) && want.has(matrixColId(fromGroupKey(colId), 'syncQty'))) want.add(colId)
    api.applyColumnState({ state: allColIds.map((colId) => ({ colId, hide: !want.has(colId) })) })
  }, [getGridApi, allColIds])
  const applyPreset = useCallback((preset: GridViewPreset) => { applyVisible(preset.columns); setActivePresetId(preset.id); views.markActive(null) }, [applyVisible]) // eslint-disable-line react-hooks/exhaustive-deps
  const applyColumnsView = useCallback((payload: ColumnsViewPayload, view?: { updatedAt?: string }) => {
    applyVisible(payload.columns, { status: savedBeforeMatrixStatus(view?.updatedAt), from: savedBeforeMatrixFrom(view?.updatedAt) })
    setActivePresetId(null)
  }, [applyVisible])
  const getPageState = useCallback((): MatrixPageState => ({ search }), [search])
  const applyPageState = useCallback((s: MatrixPageState) => { if (typeof s?.search === 'string') setSearch(s.search) }, [])
  const views = useGridState<MatrixPageState>({
    surface: MATRIX_LAYOUT_SURFACE, viewsSurface: MATRIX_VIEWS_SURFACE, baseUrl: getBackendUrl(),
    getPageState, applyPageState, applyColumnsView, persistKeys: PERSIST_KEYS, omitScroll: true,
  })
  const saveCurrentView = useCallback(async (name: string) => {
    const id = await views.save(name, { payload: columnsViewPayload(visibleColIds(), chipBar.activeId) })
    views.markActive(id); setActivePresetId(null)
    return id
  }, [views, visibleColIds, chipBar.activeId])
  const updateCurrentView = useCallback(async (view: SavedGridView<MatrixPageState>) => {
    const id = await views.save(view.name, { id: view.id, payload: columnsViewPayload(visibleColIds(), chipBar.activeId) })
    views.markActive(id)
    return id
  }, [views, visibleColIds, chipBar.activeId])
  /* A default saved COLUMNS view lands once the grid is up; the ground state stays Everything. */
  const landedDefault = useRef<string | null>(null)
  useEffect(() => {
    const v = views.defaultView
    if (!v || !getGridApi() || landedDefault.current === v.id) return
    if (v.payload && isColumnsViewPayload(v.payload)) { landedDefault.current = v.id; applyColumnsView(v.payload, v); views.markActive(v.id) }
  }, [views, applyColumnsView, getGridApi])

  /* ── Customise: the ONE PreferencesModal ────────────────────────────────────────────────── */

  const [prefs, setPrefs] = useState<PreferencesValue | null>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const preferenceColumns = useMemo<PreferencesColumnSpec[]>(() => {
    const out: PreferencesColumnSpec[] = [
      { key: IDENTITY_COL, label: 'Product', locked: true, group: 'Product' },
      { key: SCOPE_PROGRESS_COLUMN, label: 'Shared product (progress)', group: 'Product' },
      { key: BASE_PRICE_COL, label: 'Base price', group: 'Shared' },
      { key: STOCK_COL, label: 'Stock', group: 'Shared' },
      { key: FBA_COL, label: 'FBA qty', group: 'Shared' },
    ]
    for (const c of visibleCoordinates) {
      if (!c.connected || c.cells.length === 0) { out.push({ key: matrixColId(c.key, 'notListed'), label: MATRIX_COPY.notListed, group: c.label }); continue }
      for (const k of c.cells) {
        if (k === fromBefore(c)) out.push({ key: matrixFromColId(c.key), label: FROM_LABEL, group: c.label })
        out.push({ key: matrixColId(c.key, k), label: MATRIX_CELL_LABELS[k], group: c.label })
        if (k === 'listing' && statusColIds.includes(matrixStatusColId(c.key))) out.push({ key: matrixStatusColId(c.key), label: STATUS_COLUMN_LABEL, group: c.label })
      }
    }
    return out
  }, [visibleCoordinates, statusColIds])
  /* The kinds a coordinate has NO store for, with their sentences — greyed in the dialog's hint,
     since the DS list has no per-row "absent" slot (honest absence: §3.1 rule 6). */
  const absentHint = useMemo(() => {
    /* MX.F: the label table covers the reserved business cells too (`B2B price` · `Tiers`, design §3.11), so the server's
       derived B2B absence renders with its sentence rather than as `undefined`. */
    const lines = visibleCoordinates.flatMap((c) => c.absent.map((a) => `${c.label} · ${MATRIX_ABSENT_CELL_LABELS[a.cell]} — ${a.reason}`))
    return lines.length ? `Not offered here: ${lines.join(' · ')}` : null
  }, [visibleCoordinates])
  const defaultPrefs = useMemo<PreferencesValue>(() => ({ visibleColumns: preferenceColumns.map((c) => c.key), lockedColumns: [], stickyFirstColumn: true, stickyLastColumn: false, pageSize: 0, sortBy: '', sortDir: 'asc' }), [preferenceColumns])
  const bridge = useMemo(() => ({ columns: preferenceColumns.map((c) => ({ key: c.key, locked: c.locked })) }), [preferenceColumns])
  const openCustomise = useCallback(() => {
    const api = getGridApi()
    if (!api) return
    setPrefs((current) => columnStateToPrefs(api.getColumnState(), current ?? defaultPrefs, bridge))
    setPrefsOpen(true)
  }, [getGridApi, defaultPrefs, bridge])
  const applyPrefs = useCallback(async (next: PreferencesValue) => {
    const api = getGridApi()
    if (!api) return
    api.applyColumnState({ state: prefsToColumnState(next, bridge), applyOrder: true })
    setPrefs(next); setActivePresetId(null); views.markActive(null)
  }, [getGridApi, bridge, views])
  const columnDialog = useMemo(() => ({ customise: openCustomise, reset: () => { getGridApi()?.resetColumnState(); setPrefs(defaultPrefs); setActivePresetId(ALL_VIEW_ID) } }), [openCustomise, getGridApi, defaultPrefs])
  const activeViewName = views.views.find((v) => v.id === views.activeId)?.name ?? null
  const viewSave = useMemo(() => ({
    activeName: activeViewName,
    onSaveAs: async (name: string, value: PreferencesValue) => { await applyPrefs(value); await saveCurrentView(name) },
    onUpdate: activeViewName ? async (value: PreferencesValue) => { await applyPrefs(value); const v = views.views.find((x) => x.id === views.activeId); if (v) await updateCurrentView(v) } : undefined,
  }), [activeViewName, applyPrefs, saveCurrentView, updateCurrentView, views])

  /* ── export: what is on screen, D15.2 key row `sku` + `<key>.<kind>` ────────────────────── */

  const onExport = useCallback(() => {
    const api = getGridApi()
    if (!api || !read) return
    try {
      const r = exportGridCsv<StudioRow>(api, `${sheet?.family.sku ?? productId}-matrix`, {
        columns: 'displayed',
        keyOf: (colId) => (parseMatrixColId(colId) || isMatrixStatusColId(colId) || isMatrixFromColId(colId) ? colId : colId === BASE_PRICE_COL ? 'basePrice' : null),
        valueOf: (colId, row) => {
          if (isMatrixStatusColId(colId)) {
            /* The words the cell shows (the sheet's `statusCellText`): the waiting target, else the live state. */
            const coord = statusCoordinatesRef.current.find((c) => matrixStatusColId(c.key) === colId)
            return coord ? statusCellText(statusCellValue(statusCellOf(row, coord), publishReadRef.current)) || null : null
          }
          if (isMatrixFromColId(colId)) {
            const coord = read.coordinates.find((c) => c.key === fromGroupKey(colId))
            return coord ? fromCellText(matrix.rowOf(row.id), matrix.cellsOf(row.id, coord.key), coord) : null
          }
          const p = parseMatrixColId(colId)
          if (!p) return colId === STOCK_COL ? matrix.rowOf(row.id)?.stock.available ?? null : colId === FBA_COL ? fbaUnitsOf(matrix.rowOf(row.id)) : undefined
          const coord = read.coordinates.find((c) => c.key === p.key)
          return coord ? matrixCellText(p.kind, matrix.cellsOf(row.id, p.key), coord, MATRIX_COPY) : null
        },
        leading: [{ colId: '__export_sku', header: 'SKU', key: 'sku', value: (row) => row.sku }],
        narrowed: !!search.trim() || !!chipBar.activeId,
      })
      toast.toast(`Exported ${r.rows} ${r.rows === 1 ? 'row' : 'rows'} · ${r.columns} columns${previewMode ? ' · preview data' : ''}`, 'success')
    } catch (e) {
      toast.toast(e instanceof GridExportRefused ? e.message : e instanceof Error ? e.message : String(e), 'danger')
    }
  }, [getGridApi, read, sheet, productId, matrix, search, chipBar.activeId, toast, previewMode, statusCellOf])

  /* ── lifecycle ───────────────────────────────────────────────────────────────────────────── */

  const onGridReady = useCallback((e: GridReadyEvent<StudioRow>) => { bindGridApi(e.api); bindGrid(e.api); views.bind(e.api as unknown as GridApi) }, [bindGridApi, bindGrid, views])
  const onGridPreDestroyed = useCallback((e: { api: GridApi<StudioRow> }) => { releaseGrid(e); bindGrid(null) }, [releaseGrid, bindGrid])
  const onReload = useCallback(() => { matrix.reload(); reload(); projectionsQuery.reload() }, [matrix, reload, projectionsQuery])
  onReloadRef.current = onReload

  const [pending, setPending] = useState(0)
  useEffect(() => writer.subscribe(() => setPending(writer.pending)), [writer])
  const refused = refusedMarks.length

  const total = rows.length
  const variants = rows.filter((r) => !r.isParent).length
  const hasParent = rows.some((r) => r.isParent)
  const busy = loading || matrix.status === 'loading'
  const emptyState = useMemo(() => sheetEmptyState(total, () => { setSearch(''); chipBar.setActive(null) }, onReload), [total, chipBar, onReload])
  // The lent stock most of this family's SKUs sell from now (the dialog's default for SKUs that use their own).
  const familyGrantId = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) { const g = matrix.rowOf(r.id)?.stock.source?.grantId; if (g) counts.set(g, (counts.get(g) ?? 0) + 1) }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }, [rows, matrix])
  const stockSource = useMemo(() => {
    if (selectedRows.length === 0) return null
    const wholeFamily = selectedRows.some((r) => r.isParent)
    const family = wholeFamily ? rows : selectedRows
    return {
      description: wholeFamily ? `The whole family: ${family.length} SKUs — own stock, or the stock another business lends` : 'Own stock, or the stock another business lends',
      onSelect: () => setStockSourceTargets(family.map((r) => ({ id: r.id, sku: r.sku, source: matrix.rowOf(r.id)?.stock.source ?? null }))),
    }
  }, [selectedRows, rows, matrix])

  // After a switch: the Matrix re-reads now, and once more when the background has sent the new numbers.
  const reloadSoonAgain = useCallback(() => { onReloadRef.current(); setTimeout(() => onReloadRef.current(), 1500) }, [])
  const undoStockSource = useCallback(async (result: StockSourceSwitched) => {
    try {
      if (result.to === 'pool') {
        await sharingApi('stock-pool/products/switch', { productIds: result.switched.map((s) => s.id), to: 'own', withVariations: false })
      } else {
        const byGrant = new Map<string, string[]>()
        for (const s of result.switched) if (s.previous) byGrant.set(s.previous.grantId, [...(byGrant.get(s.previous.grantId) ?? []), s.id])
        for (const [grantId, productIds] of byGrant) await sharingApi('stock-pool/products/switch', { productIds, to: 'pool', grantId, withVariations: false })
      }
      toast.toast(`Undone: ${result.switched.length} ${result.switched.length === 1 ? 'SKU uses' : 'SKUs use'} the stock ${result.switched.length === 1 ? 'it' : 'they'} used before`, 'info')
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'danger')
    } finally {
      reloadSoonAgain()
    }
  }, [toast, reloadSoonAgain])
  const onStockSourceSwitched = useCallback(async (result: StockSourceSwitched) => {
    setStockSourceTargets(null)
    const n = result.switched.length
    const what = result.to === 'pool' ? `${n} ${n === 1 ? 'SKU uses' : 'SKUs use'} ${result.lenderName ?? 'the lent'}’s stock` : `${n} ${n === 1 ? 'SKU uses' : 'SKUs use'} this business’s own stock`
    toast.toast(
      <span className="nds-matrix-toast">{what} <Button size="sm" variant="link" onClick={() => { void undoStockSource(result) }}>Undo</Button></span>,
      'success',
      { duration: 12000 },
    )
    reloadSoonAgain()
  }, [toast, undoStockSource, reloadSoonAgain])

  const viewsEmptyLabel = `Custom (${visibleColIds().length})`

  return (
    <div className={styles.surface} data-matrix-surface data-matrix-source={read?.source ?? 'loading'}>
      <GridSheet
        toolbar={
          <MatrixToolbar
            visible={visibleRows.length} total={total} selected={selectedRows.length}
            hasParent={hasParent} variants={variants}
            loading={busy} unavailable={!!error || matrix.status === 'error'}
            search={search} onSearch={setSearch}
            chips={chipBar.chips} activeChipId={chipBar.activeId} onChipToggle={chipBar.setActive}
            views={views} presets={presets} activePresetId={activePresetId} onApplyPreset={applyPreset}
            onSaveCurrentView={saveCurrentView} onUpdateCurrentView={updateCurrentView} viewsEmptyLabel={viewsEmptyLabel}
            onCustomise={openCustomise} onExport={onExport} exportDisabled={!read || busy} onReload={onReload}
            /* Selection in the TOOLBAR, as on the sheet and the Variants tab (Owner, 2026-09-26). */
            selectionActions={<MatrixSelectionActions onEdit={() => openBulk(selectedRows)} editHeld={!read || busy ? 'The Matrix is still loading' : null} stockSource={stockSource} />}
            onClearSelection={() => getGridApi()?.deselectAll()}
          />
        }
        footer={
          !busy && !error && (
            <>
              {/* The selection is counted ONCE, on the toolbar ("Selected N rows"), not again here. */}
              <GridSheetStatus rows={visibleRows.length} pending={pending} saving={writer.busy} lastSavedAt={lastSavedAt}>
                {/* The sheet's refusal note (`SheetFooterNote`'s): the count is a VIEW — it narrows the grid to the affected
                    rows — and it carries ONE phrased example, so the reason is never only behind a hover. */}
                {refused > 0 && (
                  <span className="nds-grid-sheet-noteslot is-urgent">
                    <GridSheetNote
                      kind="refusal" count={refused} noun="cell" title={refusalExample}
                      lead={refusalReason}
                      onShow={() => setShowRefusedOnly((v) => !v)}
                    />
                  </span>
                )}
                <span className={styles.footerDetails}>
                  <span className="nds-cell-muted">{variants} {variants === 1 ? 'variant' : 'variants'}</span>
                  {euGroups.map((g) => (
                    <span key={g.key} className="nds-cell-muted" title={MATRIX_COPY.sharedEu(g.sharedInventoryWith!)}>Amazon EU: quantity is shared by {g.sharedInventoryWith!.length} markets</span>
                  ))}
                </span>
                {matrix.pinnedThisSession > 0 && matrix.undoLastPin && (
                  <span className="nds-cell-muted">
                    {MATRIX_COPY.pinnedThisSession(matrix.pinnedThisSession).replace(/ · Undo$/, '')}
                    {' · '}
                    <Button size="sm" variant="link" onClick={matrix.undoLastPin}>Undo</Button>
                  </span>
                )}
                {scopeNote && <span className="nds-cell-muted" title={scopeNote}>{scopeNote.split(' — ')[0]}</span>}
                {conflicts.length > 0 && (
                  <Button size="sm" variant="link" onClick={reload}>{conflicts.length} {conflicts.length === 1 ? 'row' : 'rows'} changed elsewhere — refresh</Button>
                )}
              </GridSheetStatus>
            </>
          )
        }
      >
        {error ? (
          <SheetLoadError label="this family" onRetry={onReload} />
        ) : matrix.status === 'error' ? (
          <SheetLoadError label="the Matrix" onRetry={onReload} />
        ) : (
          <>
            <MatrixBanner read={read} note={matrix.probeNote} />
            {contractProblems.length > 0 && <Banner tone="warning" title="The family read did not match its contract">{contractProblems.join(' · ')}</Banner>}
            {projectionsQuery.error && (
              <Banner tone="warning" title="The family's axis values could not be read" action={<Button size="sm" onClick={projectionsQuery.reload}>Try again</Button>}>
                {projectionsQuery.error} — the rows below are still live; the identity line falls back to the SKU.
              </Banner>
            )}
            {visibleCoordinates.length === 0 && read && (
              <Banner tone="info">{scopeNote ?? 'This family is listed on no coordinate the scope bar shows.'}</Banner>
            )}
            <NexusGrid<StudioRow>
              fill
              {...SHEET_GRID_OPTIONS}
              {...SHEET_STATE_OVERLAYS}
              noRowsOverlayComponentParams={emptyState}
              rows="media-line"
              groupHeaderHeight={gridGeometry.stripH}
              rowData={busy ? [] : visibleRows}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              getRowId={getRowId}
              rowSelection={rowSelection}
              onSelectionChanged={onSelectionChanged}
              onGridReady={onGridReady}
              onGridSizeChanged={onGridSizeChanged}
              onGridPreDestroyed={onGridPreDestroyed}
              onCellValueChanged={onCellValueChanged}
              {...statusOperationProps}
              onCellDoubleClicked={onCellDoubleClicked}
              onCellKeyDown={onCellKeyDown}
              onCellFocused={onCellFocused}
              loading={busy}
              columnDialog={columnDialog}
            />
          </>
        )}
      </GridSheet>

      <StockSourceDialog
        open={!!stockSourceTargets}
        targets={stockSourceTargets ?? []}
        suggestedGrantId={familyGrantId}
        canSwitch={canSwitchStock}
        onClose={() => setStockSourceTargets(null)}
        onSwitched={onStockSourceSwitched}
      />

      <InventoryEditorModal row={stockRow} density={DEFAULT_DENSITY} onClose={() => setStockRow(null)} />

      {fromTarget && (
        <SellsFromDialog
          target={fromTarget}
          cellsOf={matrix.cellsOf}
          rowOf={matrix.rowOf}
          locations={read?.locations ?? []}
          writeSource={writeSource}
          onClose={() => setFromTarget(null)}
          onSaved={onFromSaved}
        />
      )}

      <BulkEditDialog
        open={!!bulk}
        source={bulk?.source ?? null}
        initial={bulk?.initial}
        onClose={closeBulk}
      />

      <PreferencesModal
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        value={prefs ?? defaultPrefs}
        onConfirm={applyPrefs}
        allColumns={preferenceColumns}
        defaultVisible={preferenceColumns.map((c) => c.key)}
        pageSizeChoices={[]}
        sortFieldOptions={[]}
        showSticky={false}
        groupToggles
        inViewCount
        title="Customise columns"
        listHint={absentHint ?? 'Choose the coordinates and cells on screen. Save the arrangement as a view to keep it.'}
        viewSave={viewSave}
      />
    </div>
  )
}
