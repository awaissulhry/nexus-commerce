/**
 * PrintView (B-W2b-09) — an entry point of its own, NOT re-exported by the patterns barrel (the web pulls that barrel
 * into every page's first load; this part brings its own print stylesheet). Import this folder
 * (`@/design-system/patterns/print-view` in the web, `@nexus/ui/patterns/print-view/index` by package path).
 */
export { PrintSection, PrintView, type PrintViewLinkComponent, type PrintViewProps } from './PrintView'
export { PRINT_VIEW_LABELS, type PrintViewLabels } from './PrintViewLabels'
export { PRINT_HIDE_ATTR, forceLight, printFiltersLine, printHide, printedLine, type PrintFilter, type ThemeRoot } from './printViewModel'
