import type { Words } from '../model'
import type { Estimates, EstimateLineKind } from './api'
import type { AnswerDraft, LineDraft, LineField, TermsDraft } from './model'

/**
 * What a repair's Estimate tab draws (B-W2b-352), nothing it fetches: the revisions (null while the first read runs), the
 * revision shown, each cell's save state, the one dialog that may be open. `use-estimate.ts` fills it; the design cases
 * fill it with made-up data.
 */

export type EstimateDialog =
  | { readonly kind: 'line'; readonly draft: LineDraft; readonly showProblems: boolean }
  | { readonly kind: 'new'; readonly replaces: string | null }
  | { readonly kind: 'send' }
  | { readonly kind: 'answer'; readonly draft: AnswerDraft; readonly showProblems: boolean }
  | { readonly kind: 'withdraw'; readonly reason: string }
  | { readonly kind: 'terms'; readonly draft: TermsDraft }

export interface EstimateModel {
  readonly value: Estimates | null
  readonly problem: string | null
  /** The revision on screen (null: the newest). */
  readonly shownId: string | null
  /** Each cell's save state, `<lineId>:<field>`. */
  readonly marks: Readonly<Record<string, { readonly state: 'saving' | 'refused'; readonly words?: Words }>>
  readonly dialog: EstimateDialog | null
  readonly busy: boolean
  readonly dialogProblem: Words | null
}

export const EMPTY_ESTIMATE: EstimateModel = Object.freeze({ value: null, problem: null, shownId: null, marks: {}, dialog: null, busy: false, dialogProblem: null })

export interface EstimateActions {
  onEstimateShow?: (estimateId: string) => void
  onEstimateCell?: (lineId: string, field: LineField, text: string) => void
  onEstimateRemove?: (lineIds: readonly string[]) => void
  onEstimateDialog?: (dialog: EstimateDialog | null) => void
  onEstimateSubmit?: () => void
  onEstimateRetry?: () => void
  onEstimateAdd?: (kind: EstimateLineKind) => void
}
