export { Card, type CardProps } from './Card'
export { Disclosure, type DisclosureProps } from './Disclosure'
export { EmptyState, type EmptyStateProps } from './EmptyState'
export { Field, type FieldProps } from './Field'
// CX.2 — the `<dl>` term/value grid; the fourth local spelling of one was the trigger.
export { KeyValue, type KeyValueProps, type KeyValueItem } from './KeyValue'
export { Tabs, tabIds, tabPanelProps, type TabItem, type TabsProps, type TabLinkComponent } from './Tabs'
export { activeTabFromPath } from './tabsRoute'
export { Pagination, type PaginationProps } from './Pagination'
export { ProgressBar, type ProgressBarProps } from './ProgressBar'
export { SourceIndicator, type SourceIndicatorProps, type ValueSourceKind } from './SourceIndicator'
export { Modal, type ModalProps } from './Modal'
export { type Size } from '../primitives/size'
export { Drawer, type DrawerProps } from './Drawer'
export { DrawerOverlayCard, type DrawerOverlayCardProps } from './DrawerOverlayCard'
export { Menu, type MenuProps, type MenuItemDef } from './Menu'
export { ToastProvider, useToast, type ToastApi } from './Toast'
export { MultiSelect, type MultiSelectProps, type MultiSelectOption } from './MultiSelect'
export { OptionList, SEARCH_THRESHOLD, nextSelection, type OptionListProps, type OptionListItem } from './OptionList'
export { Combobox, type ComboboxProps, type ComboboxOption } from './Combobox'
export { Listbox, type ListboxProps, type ListboxOption } from './Listbox'
export { ListboxPanel, LISTBOX_SEARCH_THRESHOLD, type ListboxPanelProps, type ListboxPanelOption } from './ListboxPanel'
export { AsyncListboxPanel, type AsyncListboxPanelProps } from './AsyncListboxPanel'
// Keyword Harvest DS lane (2026-10-10) — H1 commands under a list, H4 one phone breakpoint, H7 a Portfolio › Campaign › Ad group path.
export type { ListboxPanelAction } from './ListboxPanel'
export { useNarrow, NARROW_QUERY } from './useNarrow'
export { EntityPath, type EntityPathProps } from './EntityPath'
export { entityPathSteps, entityPathText, entityPathPlace, compareEntityPath, ENTITY_PATH_SEPARATOR, type EntityPathPlace } from './entityPathModel'
export { DateField, type DateFieldProps, type DateFormat } from './DateField'
export { DateTimeField, timeZoneWords, type DateTimeFieldProps } from './DateTimeField'
export { MetricStrip, type MetricStripProps, type Metric, type MetricLinkComponent } from './MetricStrip'
export { HoverCard, type HoverCardProps } from './HoverCard'
export { DateRangePicker, type DateRangePickerProps, type DateRange } from './DateRangePicker'
export { PerformanceGraph, type PerformanceGraphProps, type ChartSeries } from './PerformanceGraph'
// BSP.1 — single-axis cumulative chart. Separate from PerformanceGraph on purpose: that one is
// dual-axis, and a burn-down's series are all one unit.
export { BurnDownChart, type BurnDownChartProps, type BurnDownPoint } from './BurnDownChart'
export { Heatmap, type HeatmapProps } from './Heatmap'
export { SavedChip, type SavedChipProps, type SavedChipAction } from './SavedChip'
// The grid's props and column types, shared by both tables. The AG `DataGrid` is `design-system/grid/datagrid`, where
// every web page imports it from; the HTML-table one (`./DataGrid`) is the factory's, imported by its path.
export type { DataGridProps, Column } from './dataGridTypes'
export { ImageUpload, type ImageUploadProps, type ImageUploadCriterion } from './ImageUpload'
export { Banner, type BannerProps } from './Banner'
export { Stepper, type StepperProps, type StepperStep } from './Stepper'
export { FileDropzone, type FileDropzoneProps } from './FileDropzone'
export { useClickAway } from './useClickAway'
// A strip that scrolls sideways is marked `data-overflows` so its CSS keeps the scrollbar off its labels (2026-10-05).
export { useHorizontalOverflow, type HorizontalOverflowOptions } from './useHorizontalOverflow'
export type { HorizontalOverflow } from '../lib/horizontal-overflow'
export { ColumnGroupModal, type ColumnGroupModalProps, type ColumnGroupProps, type ColumnGroup } from './ColumnGroupModal'
// MAP.1 — top-right account identity. Replaces the hard-coded marketplace
// chips in the app's dead components/layout/TopBar.tsx (deleted in TB.2) with real state.
export {
  AccountSwitcher,
  type AccountSwitcherProps,
  type AccountsPayload,
  type AccountRow as AccountSwitcherRow,
  type AccountHealth,
} from './AccountSwitcher'

// MAP.4 — the accounts of each channel, and what you can do to them.
export { AccountsPanel, type AccountsPanelProps } from './AccountsPanel'
export { BenchmarkBar } from './BenchmarkBar'
export type { BenchmarkBarProps, BenchmarkVerdict } from './BenchmarkBar'

// The channel footprint that counts the norm and names the exception — so a grid column does not
// grow by 22px every time a channel is connected.
export { CoverageSummary } from './CoverageSummary'
export type { CoverageSummaryProps, CoverageChannel, CoverageState } from './CoverageSummary'

// A product image in a cell, sized by the grid's density (GDS Phase 2 — lifted from grid-lens).
export { Thumbnail, type ThumbnailProps } from './Thumbnail'

// TB — filed from the top-bar gap: `.nds-tbtn` had no owner, and the DS had no
// "looks like a field, behaves like a button" control. See DS-GAPS.md.
export { ToolbarButton, type ToolbarButtonProps } from './ToolbarButton'
export { SearchTrigger, type SearchTriggerProps } from './SearchTrigger'
export { PressableRow, type PressableRowProps } from './PressableRow'

export { OrderedList, type OrderedListProps } from './OrderedList'
export { usePointerReorder } from './usePointerReorder'
export { MediaCard, MediaGallery, type MediaCardProps, type MediaGalleryProps, type MediaGalleryItem } from './MediaGallery'
export { MediaPreview, MediaTypeIcon, mediaTypeLabel, mediaUrl, type MediaPreviewProps, type MediaSource, type MediaCaption } from './MediaPreview'
export { MediaStrip, type MediaStripProps, type MediaStripItem } from './MediaStrip'
export { MediaMark, MEDIA_MARK_PX, type MediaMarkProps, type MediaChoice } from './MediaChoice'
export { MediaPickList, type MediaPickListProps, type MediaPickListHandle } from './MediaPickList'
export { MediaChipField, type MediaChipFieldProps, type MediaChipItem } from './MediaChipField'
export { MediaOrderedList, type MediaOrderedListProps, type MediaListItem } from './MediaOrderedList'
export { ResourcePickerDialog, type ResourcePickerDialogProps } from './ResourcePickerDialog'
export { MediaBoard, MEDIA_BOARD_EXTERNAL_TYPE, type MediaBoardProps, type MediaBoardRow, type MediaBoardItem, type MediaBoardMove } from './MediaBoard'
export { CellAction, type CellActionProps } from './CellAction'

export { RecordListInput, type RecordListInputProps, type RecordListField } from './RecordListInput'

export { SummaryTable, type SummaryTableProps } from './SummaryTable'

export { ActionConfirm, canConfirmAction, useActionConfirm, type ActionConfirmProps, type ActionConfirmApi } from './ActionConfirm'
// Sheet publish parity (2026-10-04) — the typed confirmation, shared by ActionConfirm, the Publish window and the selling dialogs.
export { ConfirmPhraseField, phraseMatches, phraseMatchState, PHRASE_STATE_TEXT, type ConfirmPhraseFieldProps, type PhraseMatchState } from './ConfirmPhraseField'
export { AsOf, type AsOfProps } from './AsOf'
// Approvals grid G7 (2026-10-05) — a live countdown ("Runs in 14 s"): one shared timer for the page, onDone once at zero.
export { Countdown, type CountdownProps } from './Countdown'
export { countdownText, countdownNextTick, countdownStep, countdownSnapshot, readCountdownSnapshot, countdownTarget, createCountdownTicker, countdownTicker, COUNTDOWN_SECONDS_UNDER, COUNTDOWN_SLOW_TICK, type CountdownStep, type CountdownView, type CountdownClock, type CountdownTicker } from './countdownTicker'
export { PresenceMark, type PresenceMarkProps } from './PresenceMark'
export { DetailPopover, type DetailPopoverProps } from './DetailPopover'
export { ChangeReview, type ChangeReviewProps, type ChangeReviewItem } from './ChangeReview'
// PSIE — the picked file before/while it is read, and a background job's progress in a dialog.
export { FileRow, type FileRowProps } from './FileRow'
export { JobProgress, jobPercent, type JobProgressProps } from './JobProgress'
// Sheet publish parity (2026-10-02) — a read-only record of steps; Stepper is wizard navigation.
export { Timeline, type TimelineProps, type TimelineStep } from './Timeline'
// Bid page DS lane (2026-10-10) — a small step chart (promoted from the parked BidSpark), and what a row works on as links.
export { Sparkline, type SparklineProps } from './Sparkline'
export { sparkGeometry, sparkSummary, sparkWords, SPARK_BOX, type SparkShape, type SparkValue, type SparkBox, type SparkGeometry } from './sparklineModel'
export { EntityLinks, type EntityLinksProps, type EntityLinkComponent } from './EntityLinks'
export { entityLinksView, entityLinksText, entityCountWords, compareEntityLinks, type EntityRef, type EntityNoun, type EntityLinksView } from './entityLinksModel'
// Reviews parts (2026-10-26) — stars for a rating (read or pick), and how ratings spread over 5…1 stars as filter bars.
export { StarRating, type StarRatingProps } from './StarRating'
export { starFills, starWords, ratingCountWords, starChoiceWords, clampRating, starInputValue, starTabStop, starKeyTarget, type StarFill } from './starRatingModel'
export { RatingBars, type RatingBarsProps } from './RatingBars'
export { ratingBarRows, ratingPercents, ratingTotal, nextRatingFilter, defaultZeroReason, type RatingBarRow, type RatingCounts, type RatingStars } from './ratingBarsModel'
export { metricKind, metricMinWidth, type MetricKind } from './metricStripModel'
export { heatKey, isHeatMarked, heatMax, heatAlpha, heatCellWords } from './heatmapModel'
