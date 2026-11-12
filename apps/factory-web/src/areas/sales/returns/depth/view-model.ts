import type { Words } from '../model'
import type { CreditPreview, FeePreview, PolicyCheck, ReturnDepth, ReturnOutcomes } from './api'
import type { CreditDraft, PolicyDraft } from './model'

/**
 * What the W2b parts of a return draw (B-W2b-352), nothing they fetch: the return in depth and its outcomes (each read on
 * its own; a part whose read failed says so and the rest of the record stays usable), the decision's fee preview, and the
 * one dialog of these parts that may be open. `use-rma-depth.ts` fills it; the design cases fill it with made-up data.
 */

export type DepthDialog =
  | { readonly kind: 'credit'; readonly draft: CreditDraft; readonly preview: CreditPreview | null; readonly previewing: boolean }
  | { readonly kind: 'policy'; readonly draft: PolicyDraft; readonly check: PolicyCheck | null }
  | { readonly kind: 'split'; readonly lineId: string }

export interface RmaDepthModel {
  readonly depth: { readonly value: ReturnDepth | null; readonly problem: string | null }
  readonly outcomes: { readonly value: ReturnOutcomes | null; readonly problem: string | null }
  /** The fee each drafted decision would withhold (null: none drafted, no policy, or not read). */
  readonly fees: FeePreview | null
  readonly dialog: DepthDialog | null
  readonly busy: boolean
  readonly problem: Words | null
  /** The papers are being made (the scan code, then the PDF). */
  readonly printing: boolean
}

export const EMPTY_DEPTH: RmaDepthModel = Object.freeze({
  depth: { value: null, problem: null },
  outcomes: { value: null, problem: null },
  fees: null,
  dialog: null,
  busy: false,
  problem: null,
  printing: false,
})

export interface RmaDepthActions {
  onDepthDialog?: (dialog: DepthDialog | null) => void
  onDepthSubmit?: () => void
  onPrintPapers?: () => void
  onDepthRetry?: () => void
}
