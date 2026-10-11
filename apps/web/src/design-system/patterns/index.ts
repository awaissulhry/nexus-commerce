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
export { FilterBar, type FilterBarProps, type FilterBarOption, type FilterDimension } from './FilterBar'
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
export { Builder, type BuilderProps, type BuilderSection } from './Builder'
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
// Bid page polish round 2 (2026-10-10) — a row's detail in a centered dialog: tabs, Prev / Next (K / J), stacked reviews.
export { DetailModal, type DetailModalProps, type DetailNav } from './DetailModal'
export {
  detailPosition, detailNavHeld, detailNavLabel, detailNavKey, detailBodyState, DETAIL_NAV_KEYS,
  type DetailPosition, type DetailDirection, type KeyTargetKind,
} from './detailModalModel'
