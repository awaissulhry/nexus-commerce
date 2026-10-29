import type { ApprovalRow, QuoteDetail } from '../../sales/quotes/api'
import type { Grains, QuoteAbilities, Tone } from '../../sales/quotes/model'
import type { Loaded } from '../../sales/quotes/record/record-model'

/**
 * Home › Approvals (SCR-030; design home.approvals, W1: quote approvals only): the queue of requests that wait for MY
 * yes, my own requests, and what was decided in the last 7 days — one view at a time, each a tile (the tile's number is
 * that view's total). A row opens in a centred review (DetailModal, `?open=<id>`, J / K) with the numbers behind each
 * broken rule; Approve and Reject are the quotes module's own (four eyes: never the requester; a margin-floor request
 * only with the margin grain — held with the reason before the click). After a decision the next request opens.
 */

export const APPROVAL_VIEWS = ['waiting', 'mine', 'decided'] as const
export type ApprovalView = (typeof APPROVAL_VIEWS)[number]

export function viewOf(asked: string | null | undefined): ApprovalView {
  return (APPROVAL_VIEWS as readonly string[]).includes(asked ?? '') ? (asked as ApprovalView) : 'waiting'
}

export interface ApprovalsViewModel {
  /** `/w/<company>` */
  prefix: string
  me: string
  grains: Grains
  can: QuoteAbilities
  view: ApprovalView
  rows: { items: ApprovalRow[] | null; problem: string | null }
  /** The tiles; null: not read yet (shown as "—", never 0). */
  counts: { waiting: number | null; mine: number | null; decided: number | null; capped: boolean }
  asOf: string | null
  /** The review open (`?open=`): the request's row and its quote read now (the re-check). */
  open: { id: string; quote: Loaded<QuoteDetail> } | null
  /** The reject reason dialog is open. */
  rejecting: boolean
  busy: boolean
  notice: { key: string; tone: Tone; params?: Record<string, string | number> } | null
  /** Design cases: the rows ticked, the row that has the focus. */
  selected?: readonly string[]
  focusRow?: number
}

export interface ApprovalsActions {
  onView?: (view: ApprovalView) => void
  onOpen?: (id: string | null) => void
  onRetry?: () => void
  onRetryReview?: () => void
  onApprove?: (note: string) => Promise<boolean>
  onReject?: (reason: string) => Promise<boolean>
  onRejecting?: (open: boolean) => void
  onDismissNotice?: () => void
  /** Approve the selected requests, one by one (the quotes module checks each); resolves true when all were approved. */
  onApproveMany?: (ids: readonly string[], note: string) => Promise<boolean>
}

/** Is the request still what was asked? Its quote waits for approval at the version the row was read with. */
export function recheck(row: Pick<ApprovalRow, 'status' | 'quoteVersion'>, quote: Pick<QuoteDetail, 'version' | 'current'> | null): 'current' | 'changed' | 'unknown' {
  if (!quote) return 'unknown'
  if (row.status !== 'PENDING') return 'changed'
  return quote.current.status === 'PENDING_APPROVAL' && quote.version === row.quoteVersion ? 'current' : 'changed'
}

/** Why the person may not decide this row now (a message key of `approvals`), or null. */
export function heldKey(row: Pick<ApprovalRow, 'held'>, busy: boolean): string | null {
  if (row.held) return `held.${row.held}`
  return busy ? 'held.busy' : null
}
