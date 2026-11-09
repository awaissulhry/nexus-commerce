/**
 * VersionCompare (B-W2b-207) — an entry point of its own, NOT re-exported by the patterns barrel (the web pulls that barrel
 * into its pages; this part brings its own stylesheet). Import this folder (`@/design-system/patterns/VersionCompare` in
 * the web, `@nexus/ui/patterns/VersionCompare/index` by package path).
 */
export { VersionCompare, type VersionCompareProps } from './VersionCompare'
export { VERSION_COMPARE_LABELS, type VersionCompareLabels } from './VersionCompareLabels'
export {
  quantityDelta,
  quantityOf,
  versionChangeNote,
  versionHasChanges,
  versionLineViews,
  versionSummary,
  type VersionField,
  type VersionFieldChange,
  type VersionHead,
  type VersionLine,
  type VersionLineKind,
  type VersionLineSide,
  type VersionLineView,
  type VersionNoteWords,
  type VersionSizeChange,
  type VersionSummary,
  type VersionTotal,
} from './versionCompareModel'
