/**
 * PortalActionBar (B-W2b-155) — an entry point of its own, NOT re-exported by the patterns barrel (the web pulls that
 * barrel into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/patterns/PortalActionBar` in the web, `@nexus/ui/patterns/PortalActionBar/index` by package path).
 */
export { PortalActionBar, type PortalAction, type PortalActionBarProps } from './PortalActionBar'
export { PORTAL_ACTION_BAR_LABELS, type PortalActionBarLabels } from './PortalActionBarLabels'
