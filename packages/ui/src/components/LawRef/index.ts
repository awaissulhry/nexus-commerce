/**
 * LawRef (B-W2b-28) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that barrel into
 * every page's first load; this part brings its own stylesheet). Import this folder (`@/design-system/components/LawRef`
 * in the web, `@nexus/ui/components/LawRef/index` by package path).
 */
export { LawRef, lawRefText, type LawRefProps } from './LawRef'
export { LAW_REF_LABELS, type LawRefLabels } from './LawRefLabels'
