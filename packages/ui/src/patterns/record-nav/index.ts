/**
 * RecordNav (B-W2b-09, D13) — an entry point of its own, NOT re-exported by the patterns barrel (the web pulls that
 * barrel into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/patterns/record-nav` in the web, `@nexus/ui/patterns/record-nav/index` by package path).
 */
export { RecordNav, type RecordNavLinkComponent, type RecordNavProps } from './RecordNav'
export { RECORD_NAV_LABELS, type RecordNavLabels } from './RecordNavLabels'
export { RECORD_NAV_KEYS, recordNavKey, recordNavView, type RecordNavDirection, type RecordNavStep, type RecordNavView } from './recordNavModel'
