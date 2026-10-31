/**
 * TraceTree (B-W2b-09) — an entry point of its own, NOT re-exported by the patterns barrel (the web pulls that barrel
 * into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/patterns/trace-tree` in the web, `@nexus/ui/patterns/trace-tree/index` by package path).
 */
export { TraceTree, type TraceLevel, type TraceNode, type TraceTreeLinkComponent, type TraceTreeProps } from './TraceTree'
export { TRACE_TREE_LABELS, type TraceTreeLabels } from './TraceTreeLabels'
export {
  TRACE_KEYS, traceCheck, traceDefaultOpen, traceFind, traceLevels, traceMove, traceReach, traceRows, traceToggle,
  type TraceCheck, type TraceKey, type TraceLevelCount, type TraceRow, type TraceTreeNode,
} from './traceTreeModel'
