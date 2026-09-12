/**
 * PES.8 — what the drafts endpoint returns, as the studio sees it.
 *
 * Mirrors `DraftOverlayRow` in `apps/api/src/services/ai/enrichment/draft.service.ts`. Kept as a
 * hand-written mirror rather than a shared type because the two apps do not share a package for
 * this, and a drifted field would be visible immediately: every one of these is rendered.
 */

/** The lifecycle a draft moves through. Only `pending` and `failed` reach the review surface. */
export type AiDraftStatus = 'pending' | 'approved' | 'rejected' | 'superseded' | 'failed'

/** One finding from the server-side validator, against the channel's own caps. */
export interface AiDraftViolation {
  kind:
    | 'over_max_length'
    | 'over_max_bytes'
    | 'off_list'
    | 'deprecated_option'
    | 'empty'
    | 'wrong_type'
  /** `error` = we refuse to offer it; `warn` = offerable, flagged in review. */
  severity: 'error' | 'warn'
  message: string
  limit?: number
  actual?: number
}

/** The constraint snapshot the prompt was built from, as it stood for THIS draft. */
export interface AiDraftCaps {
  maxLength?: number | null
  maxBytes?: number | null
  capFrom?: string | null
  mode?: 'strict' | 'open' | null
  requiredBy?: string[] | null
  optionCount?: number | null
}

export interface AiDraft {
  id: string
  productId: string
  /** The sheet coordinate as one comparable string — `master:name`, `AMAZON:IT:amazon_title`. */
  cellKey: string
  /** What `PATCH /api/products/bulk` expects in `changes[].field`. */
  writeField: string
  /** The sheet column key (bare attribute name, no `attr_` prefix). */
  columnKey: string
  channel: string | null
  marketplace: string | null
  aliasId: string | null
  locale: string | null
  draftValue: unknown
  baseValue: unknown
  baseSource: string | null
  status: AiDraftStatus
  confidence: 'high' | 'medium' | null
  rationale: string | null
  violations: AiDraftViolation[] | null
  capsUsed: AiDraftCaps | null
  runId: string
  provider: string
  model: string
  createdAt: string
  /** The stored cell moved since this draft was generated — approving overwrites an edit. */
  stale: boolean
  /**
   * The draft's address no longer resolves to one stored row (its listing alias is gone), so
   * `stale` is UNKNOWN rather than false. Approval refuses these outright.
   */
  unverified: boolean
  /** What the cell holds right now, when `stale`. */
  currentValue?: unknown
  /** Why the last approval attempt was refused by the bulk PATCH, if one was. */
  lastApplyError: string | null
}

export interface AiDraftsResponse {
  drafts: AiDraft[]
  counts: { total: number; pending: number; failed: number; stale: number }
}

export interface ApproveResponse {
  approved: string[]
  refused: Array<{ id: string; reason: string }>
  changesSent: number
}
