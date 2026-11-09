/**
 * SizeColumns (B-W2b-207) — an entry point of its own, NOT re-exported by the grid barrel (the web pulls that barrel into
 * its pages; this kind brings its own stylesheet and editor). Import this folder (`@/design-system/grid/size-columns` in
 * the web, `@nexus/ui/grid/size-columns/index` by package path).
 */
export { sizeColumns, sizeColumnGroup, sizeColumnSize, SIZE_COLUMN_CLASSES, type SizeColumnsOptions } from './sizeColumns'
export { SizeFill, type SizeFillProps } from './SizeFill'
export { SizeValueEditor, type SizeValueEditorParams } from './SizeValueEditor'
export { SIZE_COLUMNS_LABELS, type SizeColumnsLabels } from './SizeColumnsLabels'
export {
  addSizeValues,
  compareSizeValues,
  decimalComma,
  fillFromBase,
  parseSizeValue,
  pasteSizeRow,
  sizeEditText,
  sizeTotals,
  sizeValueOf,
  sizeValueText,
  subtractSizeValues,
  timesSizeValue,
  type ParseSizeOptions,
  type ParsedSizeValue,
  type SizeFillChange,
  type SizeFillInput,
  type SizeFillResult,
  type SizePasteResult,
  type SizeValue,
} from './sizeColumnsModel'
