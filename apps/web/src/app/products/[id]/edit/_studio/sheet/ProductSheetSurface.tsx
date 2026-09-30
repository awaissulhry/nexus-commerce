'use client'

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { GridSheet, GridSheetStatus, NexusGrid, SHEET_GRID_OPTIONS, gridGeometry } from '@/design-system/grid'
import { PreferencesModal } from '@/design-system/patterns'
import { TooltipPortalProvider } from '@/design-system/primitives'
import { StudioDock } from '../drawer/StudioDock'
import { useStudioScope, useViewChips } from '../contracts'
import type { SheetRow } from '../drawer/types'
import { SheetToolbar } from './SheetToolbar'
import { SheetFooterNote } from './SheetFooterNote'
import { SheetLoadError } from './SheetLoadError'
import { SHEET_STATE_OVERLAYS } from './sheetGridStates'
import { stabilize, valueAt } from './stableProps'
import type { ProductSheetModel } from './productSheetModel'
import './product-sheet.css'

/**
 * Audit B32 — `value` as it was handed out last time wherever nothing in it changed (`stableProps.ts`): the adapter
 * rebuilds its model on every save-status change, and without this every part of the sheet re-rendered with it.
 */
function useStable<T>(value: T, maxDepth: number): T {
  const latest = useRef(value)
  latest.current = value
  const last = useRef<{ raw: unknown; stable: unknown } | null>(null)
  const resolve = useCallback((path: ReadonlyArray<string | number>) => valueAt(latest.current, path), [])
  const stable = stabilize(last.current?.raw, last.current?.stable, value, resolve, { maxDepth })
  last.current = { raw: value, stable }
  return stable
}

interface FooterParts { before?: ReactNode; status: ProductSheetModel<unknown, unknown>['status']; lead?: ReactNode; note: ProductSheetModel<unknown, unknown>['footerNote']; extra?: ReactNode }

/** B32 — the status line's parts, published by the surface; only the line itself re-renders when a save moves. */
function createFooterStore(initial: FooterParts) {
  let parts = initial
  const listeners = new Set<() => void>()
  return {
    get: () => parts,
    set(next: FooterParts) { if (next !== parts) { parts = next; for (const fn of listeners) fn() } },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
}

function SheetStatusLine({ store }: { store: ReturnType<typeof createFooterStore> }) {
  const parts = useSyncExternalStore(store.subscribe, store.get, store.get)
  return <>
    {parts.before}
    <GridSheetStatus {...parts.status}>
      {parts.lead}
      <SheetFooterNote {...parts.note} />
      {parts.extra}
    </GridSheetStatus>
  </>
}

/** The only Information sheet renderer, for Shared product and every channel. */
export function ProductSheetSurface<Row, Page, DrawerRow extends SheetRow>(model: ProductSheetModel<Row, Page, DrawerRow>) {
  const chips = useViewChips()
  const scope = useStudioScope()
  const columns = model.columns
  const channel = model.scope === 'channel'
  /* B32 — each part of the sheet is rebuilt only when what it shows changed: a save's status change repaints the status
     line (and the toolbar's "saving" flag), not the toolbar's menus, the grid host or the drawer. The grid's props are
     compared one level deep (its rows and columns by identity: a changed row array always reaches the grid). */
  const toolbarProps = useStable({
    ...model.toolbar,
    views: columns.gridState,
    presets: columns.presets,
    activePresetId: columns.activePresetId,
    languagesView: (scope.locales?.length ?? 0) > 1,
    onApplyPreset: columns.applyPreset,
    viewsEmptyLabel: columns.emptyLabel,
    activeCount: columns.activeCount,
    myLayout: columns.myLayout,
    myLayoutActive: columns.active.kind === 'custom',
    onApplyMyLayout: columns.applyMyLayout,
    narrowToMatches: columns.narrowToMatches,
    onNarrowToMatches: columns.setNarrowToMatches,
    onSaveCurrentView: columns.saveCurrentAs,
    onUpdateCurrentView: columns.updateView,
    describeView: columns.describeView,
    productType: columns.productType,
    viewColumnCount: columns.viewColumnCount,
    density: columns.density,
    onDensity: columns.setDensity,
    chips: chips.chips,
    activeChipId: chips.activeId,
    onChipToggle: chips.setActive,
  }, 4)
  const chrome = useStable({
    toolbarExtra: model.toolbarExtra, status: model.status, footerNote: model.footerNote, footerBefore: model.footerBefore,
    footerLead: model.footerLead, footerExtra: model.footerExtra, notice: model.notice, gridOverlay: model.gridOverlay,
    drawer: model.drawer, preferences: model.preferences, before: model.before, afterGrid: model.afterGrid,
    beforePreferences: model.beforePreferences, afterPreferences: model.afterPreferences, after: model.after,
    retry: model.retry,
  }, 4)
  const gridProps = useStable(model.grid, 1)
  const switching = !!model.switching

  /* 2026-09-26 — an EDITING grid: an empty cell is a value nobody entered, so it draws nothing
     (`emptyCells="blank"`; a cell that does not apply carries the engine's hatch instead). */
  /* 2026-09-27 — while only the languages change, the last sheet stays on screen: dimmed, and `inert`, so no edit can
     land in a language that is about to be replaced. The wrapper is always there (it is `display: contents`), so the
     grid is never remounted when it turns on or off. */
  const grid = useMemo(() => <div className={`nds-sheet-hold${switching ? ' is-held' : ''}`} inert={switching || undefined} aria-busy={switching || undefined}><NexusGrid<Row>
    {...SHEET_GRID_OPTIONS}
    {...SHEET_STATE_OVERLAYS}
    {...gridProps}
    fill
    rows="media-line"
    emptyCells="blank"
    treeData
    /* The VIEW owns the column order (`useSheetColumns` applies it). Without this, AG reverts to the columnDefs order
       whenever they are rebuilt — a progress refresh, a readiness read — and the variation theme slid behind the
       identity fields (measured 2026-09-27 after a scope round trip). */
    maintainColumnOrder
    /* A header drag is kept like a Customise Save (`useSheetColumns.onColumnMoved`). */
    onColumnMoved={columns.onColumnMoved}
    onColumnPinned={columns.onColumnPinned}
    /* The sheet's locks freeze a column at the LEFT; a right pin could not be kept, so it is not offered. */
    pinSides="left"
    groupHeaderHeight={gridGeometry.stripH}
  /></div>, [gridProps, switching, columns.onColumnMoved, columns.onColumnPinned])
  const drawer = useMemo(() => chrome.drawer && <StudioDock {...chrome.drawer} />, [chrome.drawer])
  const preferences = useMemo(() => <>
    {chrome.beforePreferences}
    {chrome.preferences && <PreferencesModal {...chrome.preferences} />}
    {chrome.afterPreferences}
  </>, [chrome.beforePreferences, chrome.preferences, chrome.afterPreferences])
  const toolbar = useMemo(() => <><SheetToolbar {...toolbarProps} />{chrome.toolbarExtra}</>, [toolbarProps, chrome.toolbarExtra])
  const showFooter = !model.loading && !model.unavailable
  /* The status line reads its parts from a store the surface publishes to, so a save's status change re-renders the
     line alone — not `GridSheet` and its providers around the grid. */
  const footerParts = useMemo<FooterParts>(() => ({ before: chrome.footerBefore, status: chrome.status, lead: chrome.footerLead, note: chrome.footerNote, extra: chrome.footerExtra }),
    [chrome.footerBefore, chrome.status, chrome.footerLead, chrome.footerNote, chrome.footerExtra])
  const [footerStore] = useState(() => createFooterStore(footerParts))
  useLayoutEffect(() => { footerStore.set(footerParts) }, [footerStore, footerParts])
  const footer = useMemo(() => showFooter && <SheetStatusLine store={footerStore} />, [showFooter, footerStore])
  const body = useMemo(() => model.unavailable ? <SheetLoadError label={model.errorLabel} message={model.errorMessage} unavailable={model.backendMissing} onRetry={chrome.retry} /> : <>
    {chrome.notice}
    {channel ? <>
      {drawer}
      <div className="cs-sheet-body">
        <TooltipPortalProvider disabled>{grid}</TooltipPortalProvider>
        {chrome.gridOverlay}
      </div>
      {chrome.afterGrid}
      {preferences}
    </> : grid}
  </>, [model.unavailable, model.errorLabel, model.errorMessage, model.backendMissing, chrome.retry, chrome.notice, channel, drawer, grid, chrome.gridOverlay, chrome.afterGrid, preferences])
  return <>
    {chrome.before}
    {/* The row height is the operator's (toolbar, or a saved view). `GridSheet` provides it to the rows,
        the thumbnails and the loading skeleton alike; its own default is Compact, and so is ours. */}
    <GridSheet density={columns.density} toolbar={toolbar} footer={footer}>{body}</GridSheet>
    {!channel && <>{chrome.afterGrid}{drawer}{preferences}</>}
    {chrome.after}
  </>
}
