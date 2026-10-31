/**
 * ProtectedValue (B-W2b-28) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that
 * barrel into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/components/ProtectedValue` in the web, `@nexus/ui/components/ProtectedValue/index` by package path).
 */
export { ProtectedValue, type ProtectedValueProps } from './ProtectedValue'
export { PROTECTED_VALUE_LABELS, type ProtectedValueLabels } from './ProtectedValueLabels'
export { protectedValueView, type ProtectedInput, type ProtectedView } from './protectedValueModel'
