'use client'

import { useVariantTransfer } from '../../import/VariantTransfer'
import { useVariantRowMenu } from '../useVariantRowMenu'
import { FamilySelectionBar } from '../../sheet/master/FamilySelectionBar'
import { SheetLoadError } from '../../sheet/SheetLoadError'

/** Channel projection of the family, using the shared Information read, controls and writers. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Banner, type MenuItemDef } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { PreferencesModal, type PreferencesColumnSpec, type PreferencesValue } from '@/design-system/patterns'
import {
  GridLoadingOverlay, GridNoRowsOverlay, GridSheet, GridSheetStatus, NexusGrid, SHEET_GRID_OPTIONS,
  columnStateToPrefs, gridGeometry, gridSelection, prefsToColumnState, useGridLifetime, type GridApi,
} from '@/design-system/grid'

import { useRegisterViewChip, useStudioProduct, useStudioScope, useViewChips, type ViewChip } from '../../contracts'
import { MappingBand } from './MappingBand'
import { MappingDock } from './MappingDock'
import { ProjectionPreflight } from './ProjectionPreflight'
import { ProjectionToolbar } from './ProjectionToolbar'
import { CHIP_LABELS } from './copy'
import { commitPin, planPin } from './pinValue'
import { liveSource } from './source'
import { chipCells, chipRowIds, matchesSearch, projectionCounts, projectionRows, projectionActionRow, type ProjectionRow } from './rows'
import { columnSignature, projectionColumns, type ProjectionCellContext, type ProjectionCellHost } from './projectionColumns'
import { useProjection } from './useProjection'
import type { ProjectionPage, ProjectionSource } from './types'

import './variants-channel.css'

export function ChannelProjection() {
  const product = useStudioProduct()
  const { coordinate, accountId, destination, locale } = useStudioScope()
  const aliasKey = destination.status === 'ready' ? destination.data.aliasKey : null
  const productId = product.id

  /* One source per coordinate. Memoised on the coordinate's own fields, because the hook's read
     effect depends on its identity — a fresh object every render would refetch forever. */
  const source = useMemo<ProjectionSource | null>(() => {
    if (!coordinate) return null
    return liveSource({
      productId,
      channel: coordinate.channel,
      market: coordinate.marketplace,
      locale: locale ?? undefined,
      accountId: accountId ?? null,
      aliasKey,
    })
  }, [coordinate, productId, accountId, aliasKey, locale])

  if (!source) return null
  return (
    <Projection
      /* Remounting on a coordinate change is deliberate, as the channel sheet does it: an in-flight
         write belongs to the coordinate it was made on, and carrying a half-saved panel across to
         another market would paint one market's draft over another's. */
      key={`${productId}:${coordinate?.channel}:${coordinate?.marketplace}:${accountId ?? ''}:${aliasKey ?? ''}:${locale ?? ''}`}
      source={source}
      productId={productId}
    />
  )
}

function Projection({ source, productId }: { source: ProjectionSource; productId: string }) {
  const product = useStudioProduct()
  const state = useProjection(source)
  const { page } = state
  const currentScope = useStudioScope()
  const transfer = useVariantTransfer({ productId, market: currentScope.coordinate?.marketplace ?? '', channel: currentScope.coordinate?.channel, locale: currentScope.locale ?? undefined, accountId: currentScope.accountId, aliasKey: currentScope.destination.status === 'ready' ? currentScope.destination.data.aliasKey : null }, state.reload)
  const rowActions = useVariantRowMenu(productId, state.reload)
  const [search, setSearch] = useState('')
  const [selectedRows, setSelectedRows] = useState<ProjectionRow[]>([])
  const rowSelection = useMemo(() => gridSelection<ProjectionRow>(), [])
  const { gridApi, getApi, bind, onGridPreDestroyed } = useGridLifetime<GridApi<ProjectionRow>>()
  const onSelectionChanged = useCallback((event: { api: GridApi<ProjectionRow> }) => setSelectedRows(event.api.getSelectedRows()), [])
  const clearSelection = useCallback(() => getApi()?.deselectAll(), [getApi])
  const [dockOpen, setDockOpen] = useState(false)
  const [preflightOpen, setPreflightOpen] = useState(false)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [prefs, setPrefs] = useState<PreferencesValue | null>(null)
  const [pinError, setPinError] = useState<string | null>(null)
  const [pinning, setPinning] = useState<ReadonlySet<string>>(() => new Set())
  const { activeId, setActive } = useViewChips()

  const counts = useMemo(() => page ? projectionCounts(page) : null, [page])

  /* §4.2's three chips, through the frame's registry — the same mechanism the sheet uses, so a
     chip is one `useRegisterViewChip()` call and never a control in someone else's toolbar. */
  const excludedChip = useMemo<ViewChip | null>(() => page && counts ? {
    id: 'vp-excluded', label: CHIP_LABELS.excluded, noun: 'variants', hideWhenZero: false, count: counts.excluded, tone: 'neutral',
    note: 'Variants that are not part of this listing',
    cells: { byRow: chipCells(page, 'vp-excluded') },
  } : null, [page, counts])
  const pinnedChip = useMemo<ViewChip | null>(() => page && counts ? {
    id: 'vp-pinned', label: CHIP_LABELS.pinned, compactLabel: 'Pinned', noun: 'variants', hideWhenZero: false, count: counts.pinned, tone: 'info',
    note: 'Variants with a value pinned for this channel',
    cells: { byRow: chipCells(page, 'vp-pinned') },
  } : null, [page, counts])
  /* 🔴 `cells` is EMPTY here and that is the truth: a mapping error is a property of the MAPPING,
     not of any row, so there are no cells to mark. The chip's job is to carry the count and open
     the dock (below), which is the only place the error can be fixed. */
  const mappingChip = useMemo<ViewChip | null>(() => counts ? {
    id: 'vp-mapping-errors', label: CHIP_LABELS.mappingErrors, compactLabel: 'Mapping', noun: 'axes', hideWhenZero: false, count: counts.mappingErrors, tone: 'warning',
    note: 'Shared axes with no target on this channel — fix them in Edit mapping', cells: { byRow: {} },
  } : null, [counts])
  useRegisterViewChip('vp-excluded', excludedChip)
  useRegisterViewChip('vp-pinned', pinnedChip)
  useRegisterViewChip('vp-mapping-errors', mappingChip)

  /* The mapping-errors chip narrows nothing on the grid (the error is on the MAPPING, not on a
     row), so selecting it opens the place it can be fixed and clears itself. A chip that filters
     to zero rows and says nothing is the silent shape this studio keeps being bitten by. */
  useEffect(() => {
    if (activeId !== 'vp-mapping-errors') return
    setDockOpen(true)
    setActive(null)
  }, [activeId, setActive])

  /**
   * §4.3's parent row.
   *
   * VP.2 ships `parent` since 2026-09-11 19:1x, carrying the PARENT listing's own external id —
   * never folded up from the children, which is exactly what this surface declined to infer while
   * the field did not exist. The fallback below survives for the window where a coordinate answers
   * without one: it shows the listing COUNT and no state and no id, because "every child carries
   * the same ItemID, therefore that is the family's" is an inference and this row is where an
   * inference would be read as a fact.
   */

  const rows = useMemo<ProjectionRow[]>(() => {
    if (!page) return []
    const all = projectionRows(page)
    const narrow = chipRowIds(page, activeId)
    return all.filter(row => (row.kind === 'parent' || !narrow || narrow.has(row.rowId)) && matchesSearch(row, search))
  }, [page, activeId, search])

  /**
   * §4.3's one click — through `commitChannelRow`, the channel sheet's own write path.
   *
   * 🔴 The result is a RESULT, never a toast that scrolls away: a refusal lands in `writeError` and
   * stays on screen with the server's sentence. On success the projection is RE-READ rather than
   * patched locally — the pin changes `source`, the value, the per-axis counts in the dock and the
   * `Pinned values` chip at once, and a local edit of one of those four would leave the other three
   * stating the old answer.
   */
  const onPinToggle = useCallback((childId: string, axisKey: string) => {
    const current = live.current
    if (!current) return
    const child = current.page.children.find(c => c.id === childId)
    const cell = child?.values[axisKey]
    if (!child || !cell) return
    const plan = planPin({ child, axisKey, cell, coordinate: current.page.coordinate, inheritedValue: cell.inheritedValue })
    if (plan.heldReason) { setPinError(plan.heldReason); return }
    setPinError(null)
    setPinning(prev => new Set(prev).add(`${childId}:${axisKey}`))
    void commitPin({ child, axisKey, cell, coordinate: current.page.coordinate, inheritedValue: cell.inheritedValue }, plan)
      .then(result => {
        setPinning(prev => { const next = new Set(prev); next.delete(`${childId}:${axisKey}`); return next })
        if (result.ok) { state.reload(); return }
        /* 🔴 `unreachable` is not a refusal. The request never reached a verdict, so the write may
           still have applied — the operator is told to re-read rather than told it failed
           (reference_transport_failure_write_is_unknown_outcome). */
        setPinError(result.unreachable
          ? `${result.reason ?? 'The connection dropped'} — this change may or may not have been saved. Reload this page to see what the server holds.`
          : result.cells?.[axisKey]?.reason ?? result.reason ?? 'The server refused this change.')
      })
  }, [state])

  const onValueChange = useCallback((childId: string, axisKey: string, value: string) => {
    const current = live.current
    const child = current?.page.children.find(c => c.id === childId)
    const cell = child?.values[axisKey]
    if (!current || !child || !cell?.write || current.pinning.has(`${childId}:${axisKey}`)) return
    setPinError(null)
    setPinning(previous => new Set(previous).add(`${childId}:${axisKey}`))
    void commitPin({ child, axisKey, cell: { ...cell, value }, coordinate: current.page.coordinate, inheritedValue: cell.inheritedValue }, { intent: 'pin', heldReason: null, actionLabel: 'Save channel value' })
      .then(result => {
        if (!result.ok) setPinError(result.cells?.[axisKey]?.reason ?? result.reason ?? 'The value could not be saved.')
        state.reload()
      }).finally(() => setPinning(previous => { const next = new Set(previous); next.delete(`${childId}:${axisKey}`); return next }))
  }, [state])

  /**
   * 🔴 The cells read their data through a HOST whose identity never changes, and the column model
   * is rebuilt only when the column SET does.
   *
   * AG re-runs the whole column model for every new `cellRendererParams` identity (GDS decision 12,
   * reference_ag_react_inline_options_rerun_column_model), and this surface's context changes on
   * every optimistic include/exclude — the pending set moves. Memoising the context on its own
   * fields would therefore rebuild the columns on each tick, which is the exact churn the rule
   * forbids. So the live values go in a ref that render keeps current, the host is `useMemo(…, [])`,
   * and `columnSignature` decides when the columns genuinely differ.
   */
  const live = useRef<ProjectionCellContext | null>(null)
  live.current = page ? { page, pending: state.pending, pinning, rowMenu: rowActions.menu, onValueChange, onIncludedChange: state.setIncluded, onPinToggle } : null
  const host = useMemo<ProjectionCellHost>(() => ({ get: () => live.current! }), [])

  const signature = columnSignature(page)
  const columns = useMemo(
    () => live.current ? projectionColumns(host, live.current.page) : [],
    // The signature IS the dependency: `page` changes on every write, the column set does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host, signature],
  )

  /* Stable grid callbacks — an inline literal is a new identity every render, which AG treats as a
     new option (the same decision 12, asserted by `scripts/check-grid-option-identity.mjs`). */
  const getRowId = useCallback((p: { data: ProjectionRow }) => p.data.rowId, [])
  /**
   * §4.3 — an excluded row's mapped values read muted, and its checkbox stays live.
   *
   * The rule is the ENGINE's (`nds-row-is-quiet`, with `cellClass: 'nds-cell-full-strength'` opting
   * the identity band and the Included tick back out). This lane's first version reached for
   * `.nds-vp-row-excluded .ag-cell` in a page stylesheet; `check-ag-grid-import-boundary` refused
   * it, VP.5 put the rule where grid chrome belongs, and the selector would have been wrong anyway.
   */
  const rowClassRules = useMemo(() => ({
    'nds-row-is-quiet': (p: { data?: ProjectionRow }) => p.data?.kind === 'variant' && p.data.child?.included === false,
  }), [])
  const onGridReady = useCallback((e: { api: GridApi<ProjectionRow> }) => bind(e.api), [bind])

  // These renderers also show facts that are not their scalar cell value: inclusion, source,
  // completeness and pending writes. Repaint after those facts change without rebuilding columns.
  useEffect(() => { getApi()?.refreshCells({ force: true }) }, [getApi, gridApi, page, state.pending, pinning])

  /* The ONE Customise dialog — the DS `PreferencesModal`, the same component the sheets open, never
     a page-local fork (reference_customize_dialog_is_ds_preferences_modal). This page has a fixed
     column SET (§1.5), so what the dialog offers here is order, visibility and the left pin of
     those columns; there is no view to save it into, and the hint says so rather than implying a
     persistence this page does not have. */
  const prefsColumns = useMemo<PreferencesColumnSpec[]>(() => page ? preferenceColumns(page) : [], [page])
  /* The bridge takes the KEY and the lock, nothing else — one list, two shapes, derived rather
     than declared twice (a second hand-kept list is how a dialog and a grid start disagreeing). */
  const bridge = useMemo(() => ({ columns: prefsColumns.map(c => ({ key: c.key, locked: c.locked })) }), [prefsColumns])

  const openCustomise = useCallback(() => {
    const api = getApi()
    if (!api) return
    setPrefs(current => columnStateToPrefs(api.getColumnState(), current ?? EMPTY_PREFS, bridge))
    setPrefsOpen(true)
  }, [bridge, getApi])

  const applyPrefs = useCallback(async (value: PreferencesValue) => {
    const api = getApi()
    if (!api) return
    api.applyColumnState({ state: prefsToColumnState(value, bridge), applyOrder: true })
    setPrefs(value)
  }, [bridge, getApi])

  const overflow = useMemo<MenuItemDef[]>(() => overflowVerbs(() => setPreflightOpen(true), page), [page])

  if (state.backendMissing || (state.error && !page)) return <SheetLoadError label="channel variants" unavailable={state.backendMissing} onRetry={state.reload} />

  return (
    <div className="nds-vp-channel" data-dock-open={dockOpen ? 'true' : 'false'}>
      {page && <MappingBand page={page} editing={dockOpen} onEditMapping={() => setDockOpen(true)} />}

      <GridSheet
        className="nds-vp-sheet"
        toolbar={
          <ProjectionToolbar
            page={page}
            visible={rows.length}
            selected={selectedRows.length}
            counts={counts}
            loading={state.loading}
            search={search}
            onSearch={setSearch}
            activeChipId={activeId}
            onChipToggle={setActive}
            onCustomise={openCustomise}
            onExport={() => void transfer.download()}
            onImport={transfer.open}
            exportDisabled={!page}
            onReload={state.reload}
            overflow={overflow}
          />
        }
        footer={
          <>
          {page && <FamilySelectionBar rows={selectedRows.map(row => projectionActionRow(row, page))} actions={rowActions.actions} onClear={clearSelection} onDone={state.reload} />}
          <GridSheetStatus rows={rows.length} selected={selectedRows.length} saving={state.saving}>
            {counts && <span className="nds-vp-foot">{counts.total} variants · {counts.included} included</span>}
          </GridSheetStatus>
          </>
        }
      >
        <NexusGrid<ProjectionRow>
          fill
          {...SHEET_GRID_OPTIONS}
          rows="media-line"
          /* 🔴 §2's 30px column-group strip, from the engine's own token.
             Without it AG falls back to `headerHeight` and the strip renders at 28 — measured here
             at 28 against VP.3's 30 on the SAME engine, same token, same page, which is what told
             this apart from an engine defect. `gridGeometry.stripH` rather than a literal, so the
             strip and `--nds-grid-strip-h` cannot drift. */
          groupHeaderHeight={gridGeometry.stripH}
          rowData={rows}
          rowSelection={rowSelection}
          onSelectionChanged={onSelectionChanged}
          columnDefs={columns}
          getRowId={getRowId}
          onGridReady={onGridReady}
          onGridPreDestroyed={onGridPreDestroyed}
          loading={state.loading}
          loadingOverlayComponent={GridLoadingOverlay}
          noRowsOverlayComponent={GridNoRowsOverlay}
          rowClassRules={rowClassRules}
          suppressMovableColumns={false}
        />
      </GridSheet>

      {page && (
        <MappingDock
          page={page}
          parentSku={product.sku}
          open={dockOpen}
          saving={state.saving}
          writeError={state.writeError}
          onClose={() => setDockOpen(false)}
          onSave={state.saveMapping}
        />
      )}

      {preflightOpen && page && (
        <ProjectionPreflight
          productId={productId}
          channel={page.coordinate.channel}
          marketplace={page.coordinate.market}
          accountId={page.coordinate.accountId ?? undefined}
          locale={currentScope.locale ?? undefined}
          aliasKey={page.coordinate.aliasKey}
          label={page.coordinate.label}
          onClose={() => setPreflightOpen(false)}
        />
      )}

      <PreferencesModal
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        value={prefs ?? EMPTY_PREFS}
        onConfirm={applyPrefs}
        allColumns={prefsColumns}
        defaultVisible={prefsColumns.map(c => c.key)}
        pageSizeChoices={[]}
        sortFieldOptions={[]}
        showSticky={false}
        title="Customise columns"
        listHint="This page shows a fixed set of columns — the product, the mapped axes and the listing. Choose their order and which are on screen; the arrangement lasts until you leave the page."
      />

      {transfer.element}
      {rowActions.elements}

      {/* A write refusal that is not about the dock still has to be stated where the operator is
          looking — the grid's own include/exclude writes land here. */}
      {(state.writeError || pinError) && !dockOpen && (
        <div className="nds-vp-notice">
          <Banner
            tone="danger"
            action={<Button size="sm" onClick={() => { state.dismissWriteError(); setPinError(null) }}>Dismiss</Button>}
          >{state.writeError ?? pinError}</Banner>
        </div>
      )}
    </div>
  )
}

const EMPTY_PREFS: PreferencesValue = {
  visibleColumns: [], lockedColumns: [], stickyFirstColumn: true, stickyLastColumn: false,
  pageSize: 0, sortBy: '', sortDir: 'asc',
}

/**
 * The Customise dialog's column list. Identity is LOCKED — a projection with no identity column is
 * a grid of values belonging to nobody — and the bridge's `locked` is what keeps it out of the
 * togglable set rather than a rule the dialog has to be told twice.
 */
function preferenceColumns(page: ProjectionPage): PreferencesColumnSpec[] {
  const mapped = [...page.mapping].filter(m => m.target !== null).sort((a, b) => a.order - b.order)
  return [
    { key: '__identity', label: 'Product', locked: true },
    { key: '__included', label: 'Included' },
    ...mapped.map(m => ({ key: `axis:${m.axisKey}`, label: m.target ?? m.axisLabel })),
    { key: '__listing', label: 'Listing' },
  ]
}

/**
 * §4.2's ⋯ — the CH.1 channel verbs. `Reload` is `SheetToolbar`'s own and is added there.
 *
 * 🔴 `+ Add listing alias` is RENDERED AND HELD, not omitted: alias creation is inert until
 * PES.5-ii lands (§4.4.3), and an operator who cannot find the verb concludes the product cannot do
 * it. The reason is on the item, where the click lands.
 */
function overflowVerbs(openPreflight: () => void, page: ProjectionPage | null): MenuItemDef[] {
  return [
    {
      id: 'preflight',
      label: 'Preflight',
      description: 'What a send would carry, checked by the server. Nothing is sent.',
      disabled: !page,
      onSelect: openPreflight,
    },
    {
      id: 'add-alias',
      label: '+ Add listing alias',
      description: page?.split.heldReason ?? 'Listing aliases are not available for this family.',
      disabled: true,
    },
  ]
}
