export { formatGridValue, EMPTY_DASH, type GridValueKind, type FormatOptions, type FormattedValue } from './format'
export { IdentityBand, CompletenessPill, type IdentityBandProps, type CompletenessPillProps } from './IdentityBand'
export { deriveBandWidth, deriveBandWidthFromDom, findKeyBearingBand, measureLongestSku, measureBandSlots, buildSkuFont, skuBudget, bandTruncatesSku, BAND_WIDTH_FLOOR, BAND_WIDTH_CEILING, type BandSlots } from './bandWidth'
export {
  EmptyValue,
  RequiredValue,
  NumericCell,
  DateCell,
  BadgeCell,
  LockedCell,
  LinkCell,
  StockCell,
  stockLevel,
  DeltaChip,
  GroupCell,
  TagsCell,
  CoverageCell,
  ActionsCell,
  IdentityCell,
  LongTextCell,
  ReadinessCell,
  FollowsCell,
  IdentityChip,
  TargetingChip,
  ProgramChip,
  SkuTag,
  ExpandButton,
  useExpanded,
  ExpandSlot,
  type EmptyValueProps,
  type NumericCellParams,
  type DateCellParams,
  type BadgeCellParams,
  type LockedCellParams,
  type LinkCellParams,
  type StockCellParams,
  type StockLevel,
  type GroupCellProps,
  type GridTag,
  type TagsCellParams,
  type ActionsCellParams,
  type IdentityCellProps,
  type LongTextCellParams,
  type ReadinessValue,
  type ReadinessState,
  type FollowsCellParams,
  type IdentityChipProps,
  type IdentityChipTone,
  type ExpandButtonProps,
} from './cells'
export { GridLoadingOverlay, GridNoRowsOverlay, type GridLoadingOverlayParams, type GridNoRowsOverlayParams } from './overlays'
// PES.2 — media cells (PES.7's matrices): the picture lives in the cell VALUE, handlers in context.
export { mediaCellState, mediaCellClasses, mediaCellTitle, mediaCellAcceptsDrop, mediaRenditionWidth, type MediaCellState, type MediaCellValue } from './mediaCell'
export { MediaCell, MediaCellProvider, MEDIA_MATRIX_GRID_OPTIONS, type MediaCellHandlers } from './MediaCellView'
// PES.2 — readiness: the ONE tone/label source for BOTH vocabularies (programme §3).
export { readinessMeta, readyPillTone, ROW_READINESS_STATES, SCOPE_READINESS_STATES, type ReadinessMeta, type ReadinessTone, type ReadinessStateName, type RowReadinessState, type ScopeReadinessState } from './readiness'
// VP.5 — the PROJECTION vocabulary: a third table whose every tone is READ from readinessMeta.
export { projectionMeta, isProjectionState, PROJECTION_STATES, type ProjectionState, type ProjectionMeta } from './projection'
export { ProjectionCell, type ProjectionFacts, type ProjectionCellParams } from './ProjectionCell'
// PES.2 — cell provenance: the verdict (pure, tested) and the glyph that draws it.
export { classifyProvenance, provenanceTooltip, provenanceClassRules, type CellProvenance, type ProvenanceLike } from './provenance'
export { ProvenanceMark, type ProvenanceMarkProps } from './provenanceMark'
// PES.2 #662 — the cell's ONE tooltip: renderers contribute a line, the column composes.
export { composeCellTooltip, longTextTooltipLine } from './cellTooltip'
export { CellSaveReason } from './cells'
// AM.1 (2026-09-05) — the list and measure shapes, as pure rules both builders and both renderers call.
export { asList, asMeasure, isMeasure, isEmptyShape, isShaped, formatList, formatMeasure, listSummary, unitSymbol, shapeTooltipLine, shapeValidation, LIST_SEPARATOR, type CellShape, type MeasureValue, type ShapeColumnLike } from './shapeFormat'
export { ListChipValue, MeasureCellValue, ShapeValue } from './shapeCells'
