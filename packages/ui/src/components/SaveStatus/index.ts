/**
 * SaveStatus (B-W2b-09, D6) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that
 * barrel into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/components/SaveStatus` in the web, `@nexus/ui/components/SaveStatus/index` by package path).
 */
export { SaveStatus, type SaveStatusProps } from './SaveStatus'
export { SAVE_STATUS_LABELS, type SaveStatusLabels } from './SaveStatusLabels'
export { defaultSaveTime, saveStatusView, type SaveStatusState, type SaveStatusTone, type SaveStatusView } from './saveStatusModel'
