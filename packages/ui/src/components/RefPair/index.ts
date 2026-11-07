/**
 * RefPair (B-W2b-155) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that barrel
 * into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/components/RefPair` in the web, `@nexus/ui/components/RefPair/index` by package path).
 */
export { RefPair, type RefPairProps } from './RefPair'
export { REF_PAIR_LABELS, type RefPairLabels } from './RefPairLabels'
export { refMatchParts, refPairSides, refPairText, type MatchPart, type RefSide } from './refPairModel'
export { COPIED_FOR_MS, useCopyText, type CopyState } from './useCopyText'
