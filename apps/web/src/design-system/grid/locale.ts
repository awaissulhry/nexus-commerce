/**
 * AG's own words in the DS's voice (grid audit E14, 2026-10-13): sentence case and UK spelling, so a header menu reads
 * as one list — "Pin column" above "Customise columns…", not "Pin Column". Only words AG shows by itself; a page that
 * passes its own `localeText` replaces the whole table.
 */
export const GRID_LOCALE_TEXT: Readonly<Record<string, string>> = {
  pinColumn: 'Pin column',
  pinLeft: 'Pin left',
  pinRight: 'Pin right',
  noPin: 'No pin',
  pinRow: 'Pin row',
  autosizeThisColumn: 'Autosize this column',
  autosizeAllColumns: 'Autosize all columns',
  resetColumns: 'Reset columns',
  columnChooser: 'Choose columns',
  columnFilter: 'Column filter',
  expandAll: 'Expand all row groups',
  collapseAll: 'Collapse all row groups',
  copyWithHeaders: 'Copy with headers',
  copyWithGroupHeaders: 'Copy with group headers',
  csvExport: 'CSV export',
  excelExport: 'Excel export',
  sortAscending: 'Sort ascending',
  sortDescending: 'Sort descending',
  sortUnSort: 'Clear sort',
  // The engine's empty state says the same (renderers/overlays.tsx `GridNoRowsOverlay`).
  noRowsToShow: 'Nothing here',
}
