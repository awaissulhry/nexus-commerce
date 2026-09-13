/**
 * GDS — what sits above and below a grid. The toolbar itself is the DS pattern (`GridToolbar`:
 * count · children · right), re-exported here so a page imports its whole grid from one place.
 */
export { GridToolbar, type GridToolbarProps } from '../../patterns/GridToolbar'
export { GridPager, GRID_PAGE_SIZES, DEFAULT_GRID_PAGE_SIZE, type GridPagerProps } from './GridPager'
export { GridFooterStrip, GridFooterSpacer } from './GridFooterStrip'
export { GridDensityToggle, GRID_DENSITY_OPTIONS, type GridDensityToggleProps } from './GridDensityToggle'
export { GridSelectionActions, SelectionLabel, SelectionNote, GridSearchSlot } from './GridSelectionActions'
// LX.F2 / R-LX-18 — the toolbar's overflow rule, measured. The reasoning and the numbers are in the file.
// CLOSE.1 / R-LX-27 — `useToolbarStatusCompaction` is the fold's LAST TIER (status pills go
// icon-only when the two cheaper folds have already run and the bar is still over).
export { GridToolbarFold, useToolbarOverflow, useToolbarStatusCompaction, nextToolbarOverflowWidth, type GridToolbarFoldProps } from './GridToolbarFold'
// PES.2 — extracted from /products/next so every rebuilt surface shares one views menu.
export { GridViewsMenu, type GridViewsMenuProps } from './GridViewsMenu'
// DS.1 — the sheet's honest message in the footer strip (v2 §6.2 r6 / §6.3, ruling #230).
// Two kinds, kind owns the glyph and tone, and no dismiss prop exists by design.
export { GridSheetNote, type GridSheetNoteProps, type GridSheetNoteKind } from './GridSheetNote'
