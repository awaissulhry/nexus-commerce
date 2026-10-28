export {
  AppShell,
  type AppShellProps,
  type ShellNavItem,
  type ShellSubItem,
  type ShellNavGroup,
  type ShellNavEntry,
} from './AppShell'
export { PageHeader, type PageHeaderProps } from './PageHeader'
export { DetailHeader, DETAIL_HEADER_FOLD, type DetailHeaderProps } from './DetailHeader'
export {
  ScopeBar,
  type ScopeBarProps,
  type ScopeBarItem,
  type ScopeBarReadiness,
  type ScopeReadinessState,
} from './ScopeBar'
export { FilterPanel, FilterField, type FilterPanelProps } from './FilterPanel'
export { FilterBar, filtersButtonWords, type FilterBarProps, type FilterBarOption, type FilterDimension, type FilterBarLayout } from './FilterBar'
export { GridToolbar, type GridToolbarProps } from './GridToolbar'
export {
  PREFERENCES_DEFAULTS,
  type PreferencesAggFunc,
  type PreferencesColumnSpec,
  PreferencesModal,
  type PreferencesModalProps,
  type PreferencesPanesOptions,
  type PreferencesQuickPick,
  type PreferencesValue,
  type PreferencesViewSave,
  usePreferencesPanes,
} from './PreferencesModal'
export { addColumns, effectiveLocks, inViewCount, moveVisible, normalizeGroupedPreferences, orderedForDisplay, removeColumns, setHas, toggleColumn, toggleLock, togglableKeysOf } from './preferencesLogic'
export { BulkActionBar, type BulkActionBarProps } from './BulkActionBar'
export { EditModeBar, type EditModeBarProps } from './EditModeBar'
export { isSaveShortcut, saveKeyAction, warnBeforeLeaving, isMacPlatform, saveShortcutWords, type SaveKeyEvent } from './editModeBarKeys'
export { Builder, type BuilderProps, type BuilderSection } from './Builder'
export { spyActiveSection, scrolledToEnd, builderSectionId, type SectionVisibility } from './builderSpy'
export { ColumnCustomizer, type ColumnCustomizerProps, type CustomizableColumn } from './ColumnCustomizer'
export { WorkspaceGrid, AdsFilterBar, stripServerKeys, isServerKey, enabledRank } from './workspace-grid/WorkspaceGrid'
export type {
  GridPrefs, GridColumn, GridHierarchy, GridRangeFilter, GridSelectFilter, GridMultiSelectFilter, GridFilter,
  GridEditField, GridEditMode, RangeVal, FilterState, WorkspaceGridProps,
} from './workspace-grid/WorkspaceGrid'
export { SectionLayout, defaultSectionLayout, readSectionLayout, writeSectionLayout } from './SectionLayout'
export type { SectionLayoutProps, SectionLayoutValue, SectionSpec, SectionWidth } from './SectionLayout'
export { emitPrefsChanged, onPrefsChanged } from './prefs-bus'

export { WorkspaceSubheader, type WorkspaceSubheaderProps, type WorkspaceNavItem, type WorkspaceNavGroup } from './WorkspaceSubheader'
// Ads autonomy W1-4 (2026-10-06) — the fresh authenticator code before a raise; promoted from Settings › AI › Claude.
export { StepUpModal, type StepUpModalProps } from './StepUpModal'
// Bid page DS lane (2026-10-10) — the ONE review of a draft: one summary line, one table old → new, a counted Save, Done with Undo.
export { ReviewChangesModal, type ReviewChangesModalProps } from './ReviewChangesModal'
export {
  reviewTitle, saveWords, saveButtonWords, saveHeldReason, raiseCount, ackWords, reviewColumns, reviewNote, doneSummary, resultVerb,
  type ReviewChange, type ReviewResult, type ReviewConflict, type ReviewState,
} from './reviewChangesModel'
// Keyword Harvest page, lane HTO (2026-10-11) — the review body without the Modal: a review that is a STEP inside a window.
export { ReviewChangesPanel, type ReviewChangesPanelProps } from './ReviewChangesPanel'
export type { ReviewPanelChange, ReviewPanelResult, ReviewGroup } from './reviewChangesPanelModel'
// Bid page polish round 2 (2026-10-10) — a row's detail in a centered dialog: tabs, Prev / Next (K / J), stacked reviews.
export { DetailModal, type DetailModalProps, type DetailNav } from './DetailModal'
export {
  detailPosition, detailNavHeld, detailNavLabel, detailNavKey, detailBodyState, DETAIL_NAV_KEYS,
  type DetailPosition, type DetailPlace, type DetailDirection, type KeyTargetKind,
} from './detailModalModel'
// Reviews parts (2026-10-26) — one reply box for every channel (its limit, rule line, templates, AI draft, held send),
// and a review's photos one at a time.
export { ReplyComposer, type ReplyComposerProps, type ReplyTemplate, type ReplyAction } from './ReplyComposer'
export { replyHeldReason, replyOverWords, replyLengthWords, REPLY_SENT_HELD, REPLY_EMPTY_HELD, type ReplyHeldInput } from './replyComposerModel'
export { Lightbox, type LightboxProps, type LightboxItem } from './Lightbox'
export { lightboxCounter, lightboxStep, lightboxHeld, lightboxKey, photoAlt, lightboxThumbLabel, type LightboxDirection } from './lightboxModel'
