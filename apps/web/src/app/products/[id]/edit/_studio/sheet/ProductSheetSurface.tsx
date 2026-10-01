'use client'

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
import type { ProductSheetModel } from './productSheetModel'
import './product-sheet.css'

/** The only Information sheet renderer, for Shared product and every channel. */
export function ProductSheetSurface<Row, Page, DrawerRow extends SheetRow>(model: ProductSheetModel<Row, Page, DrawerRow>) {
  const chips = useViewChips()
  const scope = useStudioScope()
  const columns = model.columns
  const channel = model.scope === 'channel'
  /* 2026-09-26 — an EDITING grid: an empty cell is a value nobody entered, so it draws nothing
     (`emptyCells="blank"`; a cell that does not apply carries the engine's hatch instead). */
  /* 2026-09-27 — while only the languages change, the last sheet stays on screen: dimmed, and `inert`, so no edit can
     land in a language that is about to be replaced. The wrapper is always there (it is `display: contents`), so the
     grid is never remounted when it turns on or off. */
  const grid = <div className={`nds-sheet-hold${model.switching ? ' is-held' : ''}`} inert={model.switching || undefined} aria-busy={model.switching || undefined}><NexusGrid<Row>
    {...SHEET_GRID_OPTIONS}
    {...SHEET_STATE_OVERLAYS}
    {...model.grid}
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
  /></div>
  const drawer = model.drawer && <StudioDock {...model.drawer} />
  const preferences = <>
    {model.beforePreferences}
    {model.preferences && <PreferencesModal {...model.preferences} />}
    {model.afterPreferences}
  </>
  return <>
    {model.before}
    {/* The row height is the operator's (toolbar, or a saved view). `GridSheet` provides it to the rows,
        the thumbnails and the loading skeleton alike; its own default is Compact, and so is ours. */}
    <GridSheet
      density={columns.density}
      toolbar={<><SheetToolbar
        {...model.toolbar}
        saveStatus={model.saveStatus}
        views={columns.gridState}
        presets={columns.presets}
        activePresetId={columns.activePresetId}
        languagesView={(scope.locales?.length ?? 0) > 1}
        onApplyPreset={columns.applyPreset}
        viewsEmptyLabel={columns.emptyLabel}
        activeCount={columns.activeCount}
        myLayout={columns.myLayout}
        myLayoutActive={columns.active.kind === 'custom'}
        onApplyMyLayout={columns.applyMyLayout}
        narrowToMatches={columns.narrowToMatches}
        onNarrowToMatches={columns.setNarrowToMatches}
        onSaveCurrentView={columns.saveCurrentAs}
        onUpdateCurrentView={columns.updateView}
        describeView={columns.describeView}
        productType={columns.productType}
        viewColumnCount={columns.viewColumnCount}
        density={columns.density}
        onDensity={columns.setDensity}
        chips={chips.chips}
        activeChipId={chips.activeId}
        onChipToggle={chips.setActive}
      />{model.toolbarExtra}</>}
      footer={!model.loading && !model.unavailable && <>
        {model.footerBefore}
        <GridSheetStatus {...model.status} source={model.saveStatus}>
          {model.footerLead}
          <SheetFooterNote {...model.footerNote} source={model.saveStatus} />
          {model.footerExtra}
        </GridSheetStatus>
      </>}
    >
      {model.unavailable ? <SheetLoadError label={model.errorLabel} message={model.errorMessage} unavailable={model.backendMissing} onRetry={model.retry} /> : <>
        {model.notice}
        {channel ? <>
          {drawer}
          <div className="cs-sheet-body">
            <TooltipPortalProvider disabled>{grid}</TooltipPortalProvider>
            {model.gridOverlay}
          </div>
          {model.afterGrid}
          {preferences}
        </> : grid}
      </>}
    </GridSheet>
    {!channel && <>{model.afterGrid}{drawer}{preferences}</>}
    {model.after}
  </>
}
