/**
 * CheckList (B-W2b-09; the design's CheckList and ReadinessChecklist) — an entry point of its own, NOT re-exported by
 * the patterns barrel (the web pulls that barrel into every page's first load; this part brings its own stylesheet).
 * Import this folder (`@/design-system/patterns/checklist` in the web, `@nexus/ui/patterns/checklist/index` by package
 * path).
 */
export { CheckList, type CheckFix, type CheckItem, type CheckListLinkComponent, type CheckListProps } from './CheckList'
export { CHECK_LIST_LABELS, type CheckListLabels } from './CheckListLabels'
export {
  BLOCKING_STATES, CHECK_STATES, checkBlocks, checkListButton, checkListHeld, checkListSummary,
  type CheckLike, type CheckListSummary, type CheckState,
} from './checkListModel'
