/**
 * MilestoneTracker (B-W2b-155) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that
 * barrel into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/components/MilestoneTracker` in the web, `@nexus/ui/components/MilestoneTracker/index` by package path).
 */
export { MilestoneTracker, type MilestoneTrackerProps } from './MilestoneTracker'
export { MILESTONE_TRACKER_LABELS, type MilestoneTrackerLabels } from './MilestoneTrackerLabels'
export {
  milestoneCurrentIndex,
  milestoneViews,
  promiseMoves,
  type MilestonePromise,
  type MilestoneShownState,
  type MilestoneState,
  type MilestoneStep,
  type MilestoneView,
  type MilestoneWords,
  type PromiseMove,
} from './milestoneTrackerModel'
