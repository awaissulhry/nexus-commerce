'use client'

/**
 * MX.P — the Matrix page (design `docs/2026-09-13-matrix-page-design.md`, Revision + §3): rows = the
 * family's variants, columns = every coordinate the family is listed on, cells = the offer and
 * inventory controls the operator turns.
 *
 *     [ 21 rows · 1 parent · 20 variants   Find…   chips   Views Customise Export ⋯ ]   40px
 *     [ PRODUCT │ SHARED             │ AMAZON EU · INVENTORY · IT DE │ AMAZON · IT │ … ]   30px
 *     [ Product │ Base price Stock Status │ Fulfilment Mode Qty Buffer Sync │ Listing Price Sale ] 28px
 *     [ … 36px rows … ]
 *     [ 21 rows · 20 variants · Amazon EU: quantity is shared by 4 markets · 2 pinned this session · Undo ]
 *
 * ## What this file composes, and what it refuses to re-implement
 *
 * The ROWS are the master sheet's (`useMasterSheet` — identity, version, completeness, the writer
 * and the tracker), the axis values and face images the family read's (`useFamilyProjections`), the
 * CELLS the Matrix read's (`useMatrix`), the cell DEFINITIONS the engine's (`matrixColumnDef`, MX.G),
 * the toolbar `SheetToolbar`, the Customise dialog the ONE
 * `PreferencesModal`, the selection bar the DS `BulkActionBar`, the verbs `matrixActions` from ONE
 * declaration. ONE state: every coordinate at once; the scope bar FILTERS the groups
 * (`filters.ts`). Nothing here derives a number — quantities, prices and states arrive on the read.
 *
 * 🔴 PREVIEW MODE (`read.source === 'preview'`, while `GET …/studio/matrix` answers 404): the banner
 * is on screen, every write and verb goes to `store.ts` in memory, and NOTHING reaches a server —
 * the Network panel is the proof (0 PATCH/POST to `/studio/matrix`; the sheet's own GET is the
 * positive control). The two master columns (`Base price`, `Status`) are held with the reason.
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
  GridSheetStatus,
  gridGeometry,
  gridSelection,
  isColumnsViewPayload,
  matrixActions,
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
  type MatrixVerbSpec,
  type ColumnsViewPayload,
  type GridApi,
  type GridReadyEvent,
  type GridViewPreset,
  type ICellRendererParams,
  type SavedGridView,
} from '@/design-system/grid'
import { useAuth } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'

import { useRegisterViewChip, useSaveReporter, useStudioScope, useViewChips } from '../contracts'
import { SHEET_STATE_OVERLAYS, sheetEmptyState } from '../sheet/sheetGridStates'
import { SheetLoadError } from '../sheet/SheetLoadError'
import { useMasterSheet } from '../sheet/master/useMasterSheet'
import { useReferenceNames } from '../sheet/useReferenceNames'
import type { StudioRow } from '../sheet/master/types'
import { axisSummary, orderByAxisValues, type AxisSummary } from '../variants/family/coverage'
import { mergeAxisValues } from '../variants/family/projections'
import { useFamilyProjections } from '../variants/family/useFamilyProjections'

import { matrixChips } from './chips'
import { BASE_PRICE_COL, buildMatrixColumns, IDENTITY_COL, matrixColId, parseMatrixColId, STATUS_COL, STOCK_COL } from './columns'
import { MATRIX_ABSENT_CELL_LABELS, MATRIX_CELL_LABELS, MATRIX_COPY, type FulfilmentMethod, type MatrixCellKind, type MatrixCoordinate, type MatrixVerbTarget } from './contract'
import { filterCoordinates, filterNote, visibleCoordinateKeys } from './filters'
import { MatrixBanner } from './MatrixBanner'
import { MatrixSelectionBar } from './MatrixSelectionBar'
import { MatrixToolbar, type MatrixPageState } from './MatrixToolbar'
import { useMatrix } from './useMatrix'
import { useVerbRun } from './verbs/useVerbRun'
import { VerbDialog, type VerbDialogInitial } from './verbs/VerbDialog'
import styles from './matrix.module.css'

/** Saved views live here (design D-MX8); widths, pins and sort are remembered per surface. */
export const MATRIX_VIEWS_SURFACE = 'product-edit:views:matrix'
export const MATRIX_LAYOUT_SURFACE = 'product-edit:matrix'
const PERSIST_KEYS = ['columnSizing', 'columnPinning', 'sort'] as const

const INVENTORY_KINDS: readonly MatrixCellKind[] = ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState']
const PRICING_KINDS: readonly MatrixCellKind[] = ['price', 'salePrice']

const channelLabelOf = (channel: string): string =>
  ({ AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' } as Record<string, string>)[channel] ?? channel

export function MatrixSurface({ productId }: { productId: string }) {
  const { getApi: getGridApi, bind: bindGridApi, onGridPreDestroyed: releaseGrid } = useGridLifetime<GridApi<StudioRow>>()
  const reporter = useSaveReporter()
  const { has } = useAuth()
  const toast = useToast()
  const { scope, market, locale, accountId, options, marketplaces, setTab, setScope } = useStudioScope()
  const marketOrFirst = market ?? options.markets[0]?.code ?? 'IT'
  const localeOrFirst = locale ?? options.locales[0]?.code ?? 'it'

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
      const axisValues = mergeAxisValues(axisKeys, projections.axisValues[row.id], row.axisValues)
      const mine = projections.images[row.id]
      return { ...row, axisValues, imageUrl: row.imageUrl ?? mine?.url ?? null, imageInherited: row.imageUrl ? row.imageInherited : mine?.inherited, axisValuesSuspect: projections.suspect?.[row.id] ?? [] }
    })
  }, [sheet, axisKeys, projections.axisValues, projections.images, projections.suspect])
  const rowsRef = useRef<StudioRow[]>(rows)
  rowsRef.current = rows

  const axes = useMemo<AxisSummary[]>(() => {
    const stated = new Map(projections.axes.map((a) => [a.key, a]))
    const columns = sheet?.columns ?? []
    return axisKeys.map((key) => {
      const server = stated.get(key)
      const want = [(server?.storedKey ?? key).toLowerCase(), key.toLowerCase()]
      const column = columns.find((c) => want.includes(c.key.toLowerCase()))
      /* `valueOrder` is the operator-arranged order stored on the parent listing — the Variants page's rule (VP.3). */
      return { valueOrder: server?.valueOrder, ...axisSummary({ key, label: server?.label ?? column?.label ?? key, storedKey: server?.storedKey, options: server?.values ?? column?.options, optionLabels: column?.optionLabels }, rows) }
    })
  }, [axisKeys, projections.axes, sheet, rows])
  const axesRef = useRef<AxisSummary[]>(axes)
  axesRef.current = axes
  const ordered = useMemo(() => orderByAxisValues(rows, axes), [rows, axes])

  /* ── the Matrix read ─────────────────────────────────────────────────────────────────────── */

  const previewRows = useMemo(() => (sheet ? rows.map((r) => ({ id: r.id, sku: r.sku, isParent: r.isParent, basePrice: r.basePrice, status: r.status })) : null), [sheet, rows])
  const coordinateSource = useMemo(() => ({ channels: options.channels, marketplaces }), [options.channels, marketplaces])
  const getApiForMatrix = useCallback(() => getGridApi() as GridApi<{ id: string }> | null, [getGridApi])
  const matrix = useMatrix({ productId, accountId: accountId ?? null, locale, rows: previewRows, coordinates: coordinateSource, tracker, getApi: getApiForMatrix, can: has, onSettled })
  const read = matrix.read
  const previewMode = read?.source === 'preview'
  const masterHeldReason = previewMode ? 'Preview data — Base price and Status are the Information sheet\'s; edit them there until the Matrix service lands.' : null

  /* ── the scope bar FILTERS the groups (filters.ts) ───────────────────────────────────────── */

  const filter = useMemo(() => ({ scope, market }), [scope, market])
  const visibleCoordinates = useMemo(() => (read ? filterCoordinates(read.coordinates, filter) : []), [read, filter])
  const visibleKeys = useMemo(() => (read ? visibleCoordinateKeys(read.coordinates, filter) : null), [read, filter])
  const scopeNote = useMemo(() => (read ? filterNote(read.coordinates, filter, channelLabelOf) : null), [read, filter])
  const euGroups = useMemo(() => visibleCoordinates.filter((c) => c.kind === 'region-inventory' && c.sharedInventoryWith), [visibleCoordinates])

  /* ── chips ───────────────────────────────────────────────────────────────────────────────── */

  const chipBar = useViewChips()
  const chips = useMemo(() => matrixChips(read, visibleKeys), [read, visibleKeys])
  useRegisterViewChip('matrix-pinned', chips[0] ?? null)
  useRegisterViewChip('matrix-paused', chips[1] ?? null)
  useRegisterViewChip('matrix-oversold', chips[2] ?? null)
  useRegisterViewChip('matrix-sync-issues', chips[3] ?? null)
  useRegisterViewChip('matrix-suppressed', chips[4] ?? null)

  const [search, setSearch] = useState('')
  const visibleRows = useMemo(() => {
    const chipRows = chipBar.active?.cells.byRow
    const needle = search.trim().toLowerCase()
    return ordered.filter((row) => {
      if (chipRows && !(row.id in chipRows)) return false
      if (!needle) return true
      const line = axesRef.current.map((a) => String(row.axisValues?.[a.key] ?? '')).join(' ')
      return `${row.sku} ${row.name ?? ''} ${line}`.toLowerCase().includes(needle)
    })
  }, [ordered, chipBar.active, search])

  /* ── verbs: preview → confirm → run → revert ────────────────────────────────────────────── */

  const run = useVerbRun(matrix)
  /* ONE way a refusal sentence reaches the operator, de-duplicated the way the sheet does it (a fill
     refused twenty times for one reason is one sentence). */
  const lastSaid = useRef({ text: '', at: 0 })
  const sayReason = useCallback((reason: string, tone: 'info' | 'danger') => {
    const now = Date.now()
    if (reason === lastSaid.current.text && now - lastSaid.current.at < 2500) return
    lastSaid.current = { text: reason, at: now }
    toast.toast(reason, tone)
  }, [toast])
  const [verb, setVerb] = useState<{ spec: MatrixVerbSpec; targets: MatrixVerbTarget[]; label: string; initial?: VerbDialogInitial } | null>(null)
  const [selectedRows, setSelectedRows] = useState<StudioRow[]>([])
  const canEdit = has('products.edit')

  /**
   * SELECTION = the ticked rows × the focused coordinate group, or every visible group.
   *
   * 🔴 The focused COORDINATE is React state fed by AG's `cellFocused`, not a read of
   * `api.getFocusedCell()` inside a memo — measured 17:1x: the bar kept saying `on Amazon EU · Inventory`
   * (and holding the price verbs) after the focus had moved to a Price cell, because nothing re-ran
   * the memo when only the focus moved.
   */
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const onCellFocused = useCallback((e: { column?: { getColId?: () => string } | string | null }) => {
    const col = e.column
    const colId = typeof col === 'string' ? col : col?.getColId?.()
    const parsed = parseMatrixColId(colId)
    setFocusedKey(parsed ? parsed.key : null)
  }, [])
  const focusedCoordinate = useCallback((): MatrixCoordinate | null => (focusedKey ? visibleCoordinates.find((c) => c.key === focusedKey) ?? null : null), [focusedKey, visibleCoordinates])

  const targetsFor = useCallback((rs: readonly StudioRow[], coords: readonly MatrixCoordinate[]): MatrixVerbTarget[] =>
    rs.flatMap((r) => coords.filter((c) => c.connected && matrix.cellsOf(r.id, c.key)).map((c) => ({ rowId: r.id, coordinateKey: c.key }))),
  [matrix])

  const selectionCoords = useMemo(() => {
    const f = focusedCoordinate()
    return f ? [f] : visibleCoordinates.filter((c) => c.connected)
  }, [focusedCoordinate, visibleCoordinates])
  const selectionLabel = selectionCoords.length === 1 ? `on ${selectionCoords[0]!.label}` : `on all ${selectionCoords.length} coordinates`

  const verbSpecs = useMemo<MatrixVerbSpec[]>(() => {
    if (!read) return []
    const targets = targetsFor(selectedRows, selectionCoords)
    const cells = targets.map((t) => matrix.cellsOf(t.rowId, t.coordinateKey)).filter((c): c is NonNullable<typeof c> => !!c)
    const parentOnly = selectedRows.length > 0 && selectedRows.every((r) => r.isParent)
    const currency = selectionCoords[0]?.currency ?? 'EUR'
    return matrixActions({
      hasInventory: cells.some((c) => !!c.sync),
      hasPrice: cells.some((c) => !!c.price),
      hasQueueFailure: cells.some((c) => c.queue?.state === 'failed' || c.queue?.state === 'dead'),
      parentOnly,
      canEditPrices: canEdit,
      currency,
      coordinateOptions: read.coordinates.filter((c) => c.connected && c.cells.includes('price') && !selectionCoords.some((s) => s.key === c.key)).map((c) => ({ value: c.key, label: c.label })),
    })
  }, [read, selectedRows, selectionCoords, targetsFor, matrix, canEdit])

  const openVerb = useCallback((spec: MatrixVerbSpec, targets: MatrixVerbTarget[], label: string, initial?: VerbDialogInitial) => {
    setVerb({ spec, targets, label, initial })
  }, [])
  const onSelectionVerb = useCallback((spec: MatrixVerbSpec) => {
    openVerb(spec, targetsFor(selectedRows, selectionCoords), `${selectedRows.length} ${selectedRows.length === 1 ? 'row' : 'rows'} ${selectionLabel}`)
  }, [openVerb, targetsFor, selectedRows, selectionCoords, selectionLabel])

  /* The row ⋯: the ROW verbs (`push-now`, `set-fulfilment`, `retry-sync`) across the row's coordinates. */
  const rowMenuRef = useRef<(row: StudioRow) => MenuItemDef[]>(() => [])
  rowMenuRef.current = useMemo(() => (row: StudioRow): MenuItemDef[] => {
    if (!read) return []
    const coords = visibleCoordinates.filter((c) => c.connected)
    const cells = coords.map((c) => matrix.cellsOf(row.id, c.key)).filter((c): c is NonNullable<typeof c> => !!c)
    const specs = matrixActions({
      hasInventory: cells.some((c) => !!c.sync), hasPrice: cells.some((c) => !!c.price),
      hasQueueFailure: cells.some((c) => c.queue?.state === 'failed' || c.queue?.state === 'dead'),
      parentOnly: row.isParent, canEditPrices: canEdit, currency: coords[0]?.currency ?? 'EUR', coordinateOptions: [],
    }).filter((s) => s.row && !s.hidden)
    return specs.map((s) => ({ id: `matrix-row-${s.id}`, label: s.label, description: s.unavailable ?? `${row.sku} · ${coords.length} ${coords.length === 1 ? 'coordinate' : 'coordinates'}`, disabled: !!s.unavailable, onSelect: () => openVerb(s, targetsFor([row], coords), `${row.sku} ${coords.length === 1 ? `on ${coords[0]!.label}` : `on all ${coords.length} coordinates`}`) }))
  }, [read, visibleCoordinates, matrix, canEdit, openVerb, targetsFor])

  const applyVerb = useCallback(async (preview: Parameters<typeof run.apply>[0]) => {
    const op = await run.apply(preview)
    if (op) setVerb(null)
  }, [run])

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

  const onPickFulfilment = useCallback((method: FulfilmentMethod, params: ICellRendererParams) => {
    const parsed = parseMatrixColId(params.colDef?.colId)
    const row = params.data as StudioRow | undefined
    const coord = parsed ? read?.coordinates.find((c) => c.key === parsed.key) : null
    if (!coord || !row) return
    const spec = verbSpecs.find((s) => s.id === 'set-fulfilment') ?? matrixActions({ hasInventory: true, hasPrice: false, hasQueueFailure: false, parentOnly: false, canEditPrices: canEdit, currency: coord.currency, coordinateOptions: [] }).find((s) => s.id === 'set-fulfilment')!
    openVerb({ ...spec, unavailable: null }, [{ rowId: row.id, coordinateKey: coord.key }], `${row.sku} on ${coord.label}`, { method })
  }, [read, verbSpecs, canEdit, openVerb])

  const columnDefs = useMemo(
    () => buildMatrixColumns({
      coordinates: visibleCoordinates, cellsOf: matrix.cellsOf, rowOf: matrix.rowOf, tracker,
      sheetColumns: sheet?.columns ?? [], locale: localeOrFirst, market: marketOrFirst,
      axesRef, rowMenuRef, masterHeldReason, onJump, onPickFulfilment, rowsRef,
    }),
    [visibleCoordinates, matrix.cellsOf, matrix.rowOf, tracker, sheet?.columns, localeOrFirst, marketOrFirst, masterHeldReason, onJump, onPickFulfilment],
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
    const parsed = parseMatrixColId(colId)
    if (!parsed || !e.data || !colId) return false
    const marked = tracker.get(e.data.id, colId)
    if (marked?.state === 'refused' && marked.reason) { sayReason(marked.reason, 'info'); return true }
    const held = matrixCellEditable(parsed.kind, matrix.cellsOf(e.data.id, parsed.key))
    if (held.editable || !held.reason) return false
    sayReason(held.reason, 'info')
    return true
  }, [tracker, matrix, sayReason])
  const onCellDoubleClicked = useCallback((e: { data?: StudioRow; colDef?: { colId?: string } }) => { explainHeld(e) }, [explainHeld])
  /* AG's union includes a full-width variant without `colDef`; both are typed loosely and guarded. */
  const onCellKeyDown = useCallback((e: { data?: StudioRow; colDef?: { colId?: string }; event?: Event | null }) => {
    const key = e.event as KeyboardEvent | undefined
    if (!key || key.altKey || key.ctrlKey || key.metaKey) return
    const opens = key.key === 'Enter' || key.key === 'F2' || (key.key.length === 1 && key.key !== ' ')
    if (opens) explainHeld(e)
  }, [explainHeld])

  /* ── views: presets + saved views on the Matrix surface ─────────────────────────────────── */

  const allColIds = useMemo(() => {
    const ids: string[] = [IDENTITY_COL, BASE_PRICE_COL, STOCK_COL, STATUS_COL]
    for (const c of visibleCoordinates) {
      if (!c.connected || c.cells.length === 0) ids.push(matrixColId(c.key, 'notListed'))
      else for (const k of c.cells) ids.push(matrixColId(c.key, k))
    }
    return ids
  }, [visibleCoordinates])
  const presets = useMemo<GridViewPreset[]>(() => {
    const byKind = (kinds: readonly MatrixCellKind[], shared: readonly string[]) => [IDENTITY_COL, ...shared, ...allColIds.filter((id) => { const p = parseMatrixColId(id); return !!p && kinds.includes(p.kind) })]
    return [
      { id: ALL_VIEW_ID, label: 'Everything', description: 'Every coordinate, every cell', columns: allColIds },
      { id: 'inventory', label: 'Inventory', description: 'Stock and the inventory lane: Fulfilment · Mode · Qty · Buffer · Sync', columns: byKind(INVENTORY_KINDS, [STOCK_COL]) },
      { id: 'pricing', label: 'Pricing', description: 'Base price and every coordinate\'s Price and Sale', columns: byKind(PRICING_KINDS, [BASE_PRICE_COL]) },
      { id: 'listings', label: 'Listings', description: 'Status and every coordinate\'s Listing state', columns: byKind(['listing'], [STATUS_COL]) },
    ]
  }, [allColIds])

  const visibleColIds = useCallback((): string[] => {
    const api = getGridApi()
    return api ? api.getAllDisplayedColumns().map((c) => c.getColId()).filter((id) => allColIds.includes(id)) : allColIds
  }, [getGridApi, allColIds])
  const [activePresetId, setActivePresetId] = useState<string | null>(ALL_VIEW_ID)
  const applyVisible = useCallback((keys: readonly string[]) => {
    const api = getGridApi()
    if (!api) return
    const want = new Set([IDENTITY_COL, ...keys])
    api.applyColumnState({ state: allColIds.map((colId) => ({ colId, hide: !want.has(colId) })) })
  }, [getGridApi, allColIds])
  const applyPreset = useCallback((preset: GridViewPreset) => { applyVisible(preset.columns); setActivePresetId(preset.id); views.markActive(null) }, [applyVisible]) // eslint-disable-line react-hooks/exhaustive-deps
  const applyColumnsView = useCallback((payload: ColumnsViewPayload) => { applyVisible(payload.columns); setActivePresetId(null) }, [applyVisible])
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
    if (v.payload && isColumnsViewPayload(v.payload)) { landedDefault.current = v.id; applyColumnsView(v.payload); views.markActive(v.id) }
  }, [views, applyColumnsView, getGridApi])

  /* ── Customise: the ONE PreferencesModal ────────────────────────────────────────────────── */

  const [prefs, setPrefs] = useState<PreferencesValue | null>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const preferenceColumns = useMemo<PreferencesColumnSpec[]>(() => {
    const out: PreferencesColumnSpec[] = [
      { key: IDENTITY_COL, label: 'Product', locked: true, group: 'Product' },
      { key: BASE_PRICE_COL, label: 'Base price', group: 'Shared' },
      { key: STOCK_COL, label: 'Stock', group: 'Shared' },
      { key: STATUS_COL, label: 'Status', group: 'Shared' },
    ]
    for (const c of visibleCoordinates) {
      if (!c.connected || c.cells.length === 0) { out.push({ key: matrixColId(c.key, 'notListed'), label: MATRIX_COPY.notListed, group: c.label }); continue }
      for (const k of c.cells) out.push({ key: matrixColId(c.key, k), label: MATRIX_CELL_LABELS[k], group: c.label })
    }
    return out
  }, [visibleCoordinates])
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
        keyOf: (colId) => (parseMatrixColId(colId) ? colId : colId === BASE_PRICE_COL ? 'basePrice' : colId === STATUS_COL ? 'status' : colId === STOCK_COL ? null : null),
        valueOf: (colId, row) => {
          const p = parseMatrixColId(colId)
          if (!p) return colId === STOCK_COL ? matrix.rowOf(row.id)?.stock.available ?? null : undefined
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
  }, [getGridApi, read, sheet, productId, matrix, search, chipBar.activeId, toast, previewMode])

  /* ── lifecycle ───────────────────────────────────────────────────────────────────────────── */

  const onGridReady = useCallback((e: GridReadyEvent<StudioRow>) => { bindGridApi(e.api); bindGrid(e.api); views.bind(e.api as unknown as GridApi) }, [bindGridApi, bindGrid, views])
  const onGridPreDestroyed = useCallback((e: { api: GridApi<StudioRow> }) => { releaseGrid(e); bindGrid(null) }, [releaseGrid, bindGrid])
  const onReload = useCallback(() => { matrix.reload(); reload(); projectionsQuery.reload() }, [matrix, reload, projectionsQuery])

  const [pending, setPending] = useState(0)
  useEffect(() => writer.subscribe(() => setPending(writer.pending)), [writer])
  const [refused, setRefused] = useState(0)
  useEffect(() => tracker.subscribe(() => {
    let n = 0
    for (const row of rowsRef.current) for (const c of visibleCoordinates) for (const k of c.cells) if (tracker.get(row.id, matrixColId(c.key, k))?.state === 'refused') n++
    setRefused(n)
  }), [tracker, visibleCoordinates])

  const total = rows.length
  const variants = rows.filter((r) => !r.isParent).length
  const hasParent = rows.some((r) => r.isParent)
  const busy = loading || matrix.status === 'loading'
  const emptyState = useMemo(() => sheetEmptyState(total, () => { setSearch(''); chipBar.setActive(null) }, onReload), [total, chipBar, onReload])
  const coordinateOptions = useMemo(() => (read ? read.coordinates.filter((c) => c.connected && c.cells.includes('price')).map((c) => ({ value: c.key, label: c.label })) : []), [read])
  const currency = verb?.targets[0] ? read?.coordinates.find((c) => c.key === verb.targets[0]!.coordinateKey)?.currency ?? 'EUR' : 'EUR'
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
          />
        }
        footer={
          !busy && !error && (
            <>
              <MatrixSelectionBar rows={selectedRows} verbs={verbSpecs} scopeLabel={selectionLabel} busy={run.busy} onVerb={onSelectionVerb} onClear={() => getGridApi()?.deselectAll()} />
              <GridSheetStatus rows={visibleRows.length} selected={selectedRows.length} pending={pending} refused={refused} saving={writer.busy} lastSavedAt={lastSavedAt}>
                <span className="nds-cell-muted">{variants} {variants === 1 ? 'variant' : 'variants'}</span>
                {euGroups.map((g) => (
                  <span key={g.key} className="nds-cell-muted" title={MATRIX_COPY.sharedEu(g.sharedInventoryWith!)}>Amazon EU: quantity is shared by {g.sharedInventoryWith!.length} markets</span>
                ))}
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
              onGridPreDestroyed={onGridPreDestroyed}
              onCellValueChanged={onCellValueChanged}
              onCellDoubleClicked={onCellDoubleClicked}
              onCellKeyDown={onCellKeyDown}
              onCellFocused={onCellFocused}
              loading={busy}
              columnDialog={columnDialog}
            />
          </>
        )}
      </GridSheet>

      <VerbDialog
        open={!!verb}
        spec={verb?.spec ?? null}
        targets={verb?.targets ?? []}
        targetLabel={verb?.label ?? ''}
        read={read}
        initial={verb?.initial}
        coordinateOptions={coordinateOptions}
        currency={currency}
        previewRun={matrix.previewVerbRun}
        busy={run.busy}
        onApply={applyVerb}
        onClose={() => setVerb(null)}
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
