/**
 * PES.8 — the AI enrichment lane's public surface.
 *
 * Two things a consuming lane needs: `useAiDrafts` (which supplies the AI half of PES.2's
 * `ProvenanceLike` for any cell, via `provenanceFor`) and `AiDraftReview` (the diff + decision
 * surface PES.1's View-bar chip opens).
 *
 * `generate` is deliberately NOT exported anywhere in this lane — under hub ruling #13 the Owner
 * has held live generation, and a surface that cannot reach it beats one that declines to.
 */
export { AiDraftReview, type AiDraftReviewProps } from './AiDraftReview'
export { useAiDrafts, type UseAiDraftsInput, type UseAiDraftsValue } from './useAiDrafts'
export { useAiDraftLayer, type AiDraftLayer } from './useAiDraftLayer'
export {
  cellIndexKey,
  displayValue,
  groupByColumn,
  indexDrafts,
  isCleanlyApprovable,
  isNoOpDiff,
  measure,
  provenanceFor,
  splitViolations,
  toSheetDraft,
  type SheetAiDraft,
  type AiProvenance,
  type CellRef,
  type DraftColumnGroup,
} from './drafts'
export type { AiDraft, AiDraftStatus, AiDraftViolation, AiDraftsResponse } from './types'
