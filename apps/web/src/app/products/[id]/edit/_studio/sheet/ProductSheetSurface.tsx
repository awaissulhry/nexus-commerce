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

/** The only Information sheet renderer, for Shared product and every channel. */
export function ProductSheetSurface<Row, Page, DrawerRow extends SheetRow>(model: ProductSheetModel<Row, Page, DrawerRow>) {
  const chips = useViewChips()
  const scope = useStudioScope()
  const columns = model.columns
  const channel = model.scope === 'channel'
  const grid = <NexusGrid<Row>
    {...SHEET_GRID_OPTIONS}
    {...SHEET_STATE_OVERLAYS}
    {...model.grid}
    fill
    rows="media-line"
    treeData
    groupHeaderHeight={gridGeometry.stripH}
  />
  const drawer = model.drawer && <StudioDock {...model.drawer} />
  const preferences = <>
    {model.beforePreferences}
    {model.preferences && <PreferencesModal {...model.preferences} />}
    {model.afterPreferences}
  </>
  return <>
    {model.before}
    <GridSheet
      toolbar={<><SheetToolbar
        {...model.toolbar}
        views={columns.gridState}
        presets={columns.presets}
        activePresetId={columns.activePresetId}
        languagesView={scope.locales !== null}
        onApplyPreset={columns.applyPreset}
        viewsEmptyLabel={columns.emptyLabel}
        onSaveCurrentView={columns.saveCurrentAs}
        onUpdateCurrentView={columns.updateView}
        describeView={columns.describeView}
        chips={chips.chips}
        activeChipId={chips.activeId}
        onChipToggle={chips.setActive}
      />{model.toolbarExtra}</>}
      footer={!model.loading && !model.unavailable && <>
        {model.footerBefore}
        <GridSheetStatus {...model.status}>
          {model.footerLead}
          <SheetFooterNote {...model.footerNote} />
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
