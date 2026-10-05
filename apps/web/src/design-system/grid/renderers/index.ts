export { formatGridValue, EMPTY_DASH, type GridValueKind, type FormatOptions, type FormattedValue } from './format'
export { GridEmptyCellsContext, useGridEmptyCells, BLANK_CELL_LABEL, type GridEmptyCells } from './emptyCells'
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
  ScopeReadinessCell,
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
  type ScopeReadinessValue,
  type FollowsCellParams,
  type IdentityChipProps,
  type IdentityChipTone,
  type ExpandButtonProps,
} from './cells'
export { GridLoadingOverlay, GridNoRowsOverlay, type GridLoadingOverlayParams, type GridNoRowsOverlayParams } from './overlays'
// PES.2 — media cells (PES.7's matrices): the picture lives in the cell VALUE, handlers in context.
export { mediaCellState, mediaCellClasses, mediaCellTitle, mediaCellAcceptsDrop, mediaRenditionWidth, type MediaCellState, type MediaCellValue } from './mediaCell'
export { MediaCell, MediaCellProvider, MEDIA_MATRIX_GRID_OPTIONS, type MediaCellHandlers } from './MediaCellView'
// Progress columns (2026-09-26) — colour rule A, the card model, the meter cell and its card.
export { progressTone, progressPercent, combinedPercent, progressDetailModel, progressTriggerLabel, progressText, progressListKey, progressAge, PROGRESS_TONE_WORD, OPTIONAL_NOT_RECORDED, REQUIRED_NAMES_NOT_RECORDED, type ProgressTone, type ProgressField, type ProgressValue, type ProgressAction, type ProgressDetailItem, type ProgressDetailGroup, type ProgressDetailModel } from './progress'
export { ProgressCell, type ProgressCellParams } from './ProgressCell'
export { ProgressDetailCard, type ProgressDetailCardProps } from './ProgressDetailCard'
// PES.2 — readiness: the ONE tone/label source for BOTH vocabularies (programme §3).
export { readinessMeta, readyPillTone, ROW_READINESS_STATES, SCOPE_READINESS_STATES, type ReadinessMeta, type ReadinessTone, type ReadinessStateName, type RowReadinessState, type ScopeReadinessState } from './readiness'
// VP.5 — the PROJECTION vocabulary: a third table whose every tone is READ from readinessMeta.
export { projectionMeta, isProjectionState, PROJECTION_STATES, type ProjectionState, type ProjectionMeta } from './projection'
export { ProjectionCell, type ProjectionFacts, type ProjectionCellParams } from './ProjectionCell'
// PES.2 — cell provenance: the verdict (pure, tested) and the glyph that draws it.
export { describeCellSource, classifyProvenance, provenanceTooltip, provenanceClassRules, provenanceLabel, strongestProvenance, PROVENANCE_PRECEDENCE, type CellProvenance, type ProvenanceLike } from './provenance'
export { ProvenanceMark, type ProvenanceMarkProps } from './provenanceMark'
export { MarkedValue, type MarkedValueProps } from './MarkedValue'
export {
  VariationThemeValue, variationThemeText, variationThemeTooltip, variationThemeState, variationThemeUnsetTone,
  variationThemeProvenance, variationThemeProvenanceMember, isMasterProjection, VARIATION_THEME_CHILD_REASON,
  type VariationThemeCell, type VariationThemeAxis, type VariationThemeState, type VariationThemeValueParams,
} from './variationTheme'
// PES.2 #662 — the cell's ONE tooltip: renderers contribute a line, the column composes.
export { composeCellTooltip, longTextTooltipLine } from './cellTooltip'
export { CellSaveReason } from './cells'
// AM.1 (2026-09-05) — the list and measure shapes, as pure rules both builders and both renderers call.
export { asList, asMeasure, isMeasure, isEmptyShape, isShaped, formatList, formatMeasure, listSummary, unitSymbol, unitChoiceLabels, shapeTooltipLine, shapeValidation, LIST_SEPARATOR, type CellShape, type MeasureValue, type ShapeColumnLike } from './shapeFormat'
export { ListChipValue, MeasureCellValue, ShapeValue } from './shapeCells'
// 2026-09-24 — a store field drawn by its type (Shopify's metafield type vocabulary): the rules and the renderer.
export { metafieldDisplay, referenceKindOf, isReferenceType, METAFIELD_INVALID_TEXT, type MetafieldDisplay, type MetafieldDisplayOptions, type MetafieldReference, type MetafieldReferenceKind } from './metafieldDisplay'
export { MetafieldValue, type MetafieldValueProps } from './MetafieldValue'
// MX.G (2026-09-13) — the eight Matrix cell kinds: the rules (pure, tested) and the renderers that draw them.
export {
  MATRIX_CELL_COPY, MATRIX_CELL_CLASSES, MATRIX_FILLABLE_KINDS, MATRIX_DASH, MATRIX_OVERSOLD_SENTENCE,
  matrixCellState, matrixCellText, matrixCellTone, matrixCellToneFrom, matrixCellClasses, matrixCellTooltip,
  matrixCellEditable, matrixCellValue, matrixApplyValue, matrixCoerceValue, matrixCompare, matrixFillAllowed,
  matrixFulfilmentOptions, matrixMoney, matrixDay, matrixAgo, matrixSaleText, matrixModeWord, matrixQueueWord, matrixQueueGlyph, matrixQtyText,
  isMatrixCellKind, isSaleEditorValue, matrixGuardDiffers, matrixReportedDiffers,
  type MatrixCellState, type MatrixToneSource, type MatrixEditability, type SaleEditorValue,
} from './matrixCells'
export {
  ListingStateCell, FulfilmentCell, SyncModeCell, SyncQtyCell, SyncBufferCell, SyncStateCell, PriceCell, SaleCell,
  MATRIX_CELL_RENDERERS, type MatrixCellParams, type MatrixCellProps,
} from './MatrixCellViews'

export { CellSaveMark, type CellSaveMarkProps } from './CellSaveMark'
export { intentMeta, factMeta, verdictMeta, presenceVerdict, presenceLine, PRESENCE_INTENTS, CHANNEL_FACTS, PRESENCE_VERDICTS, type Presence, type PresenceIntent, type ChannelFact, type PresenceVerdict, type PresenceMeta } from './presence'
export { listingStatusMeta, LISTING_STATUSES, type ListingStatusMeta } from './listingStatus'
// Sheet publish parity (2026-10-02) — the ONE publish status vocabulary, and the "Last publish" cell and its card.
export { publicationStatusMeta, publishResultMeta, publishFamilyMeta, publishCellModel, publishCardModel, publishShortTime, publishFullTime, publishShownStatus, NO_PUBLISH, CREATE_FIELD, PUBLICATION_STATUSES, PUBLISH_RESULT_STATUSES, type PublishStatusMeta, type PublicationStatus, type PublishResultStatus, type PublishIssue, type PublishLast, type PublishFamilyCounts, type PublishStatusValue, type PublishCellState, type PublishCellModel, type PublishCardIssue, type PublishCardModel } from './publishStatus'
export { PublishStatusCell, PublishStatusView, PublishStatusCard, PublishStatusPill, type PublishStatusCellParams, type PublishStatusViewProps, type PublishStatusCardProps } from './PublishStatusCell'
// Sheet publish parity, build shape v2 (2026-10-04) — the Status column (selling state + a target waiting for Publish,
// the inactive row-start mark) and the Action column (Partial update quiet; Full update / Delete waiting), with their
// editor options. Words equal to @nexus/shared/listing-actions and publish-actions; only types come from there.
export {
  sellingStatusModel, statusEditorOptions, rowCarriesInactiveMark, isInactiveSellingState, waitingWhen, waitingSetPhrase,
  SELLING_STATE_WORD, STATUS_TARGET_WORD, STATUS_TARGET_SELLING_STATE, SELLING_STATE_TONE, STATUS_TARGET_TONE, SELLING_STATE_HINT,
  SELLING_READ_ONLY_STATES, SELLING_ROW_MARK_CLASS, STATUS_NOW_NOTE, STATUS_REFUSED_FALLBACK,
  // New listings (2026-10-04): a row not on the channel yet chooses what Publish creates.
  newListingEditorOptions, newListingPill, newListingAside, NEW_LISTING_MARK, NEW_LISTING_MARK_MAIN, NEW_LISTING_AS_MAIN, NEW_CHOICE_MAIN,
  NEW_CHOICE_DEFAULT, NEW_CHOICE_DELETED, NEW_SOURCE_SENTENCE, RELIST_MARK,
  // Item ID control (2026-10-05): a row Nexus unlinked is never listed as new ("unlinked 5 Oct").
  NEW_CHOICE_UNLINKED, UNLINKED_MARK,
  type SellingState, type StatusTarget, type WaitingBy, type SellingStatusValue, type SellingCellKind, type SellingPillMeta,
  type SellingStatusModel, type StatusChoiceLike, type NewListingCellFacts, type NewListingTarget, type NewListingSource,
} from './sellingStatus'
export { SellingStatusCell, SellingStatusView, SellingStatePill, type SellingStatusViewProps } from './SellingStatusCell'
export {
  publishActionModel, sendModeEditorOptions, SEND_MODE_WORD, SEND_MODE_TONE, SEND_MODE_HINT, SEND_MODE_GROUP,
  SEND_MODE_DEFAULT_NOTE, SEND_MODE_REFUSED_FALLBACK, sendModeDefaultNote,
  // A row not on the channel (new, or deleted by Nexus) reads Full update: sent whole (simplify, 2026-10-04).
  NEW_ROW_SENT_WHOLE, NEW_ROW_LEFT_OUT_HINT, DELETED_ROW_LEFT_OUT_HINT, UNLINKED_ROW_LEFT_OUT_HINT, NEW_ROW_FULL_NOTE,
  type SendMode, type PublishActionValue, type PublishActionKind, type PublishActionModel, type SendModeChoiceLike,
} from './publishAction'
export { PublishActionCell, PublishActionView, type PublishActionViewProps } from './PublishActionCell'
