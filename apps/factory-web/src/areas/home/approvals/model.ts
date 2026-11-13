import type { ApprovalRow, QuoteDetail } from '../../sales/quotes/api'
import type { Grains, QuoteAbilities, Tone } from '../../sales/quotes/model'
import type { Loaded } from '../../sales/quotes/record/record-model'
import type { ReviewState } from '@nexus/ui/patterns'
import type { ApprovalHistoryActions, ApprovalHistoryModel } from '../../../shell/panels/approvals/model'
import type { RejectReason, TaskDetail } from './api'
import type { InboxControls, InboxCounts, InboxRow } from './inbox'
import type { RequestFacts } from './words/request-words'

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

// ---- B-W2b-307: the inbox of every request (PLT-085) ---------------------------------------------------------------------

/** The catalogue of the inbox in depth (the W1 quote review keeps `approvals`). */
export const DEPTH_NS = 'approvals-depth'

/** The review of an engine request (`?open=<task id>`): the request read now, and its record's approval history. */
export interface TaskReviewModel {
  id: string
  detail: Loaded<TaskDetail>
  history: ApprovalHistoryModel | null
  /** The comment typed with the yes. */
  comment?: string
  /** The tab open (design: Change · Context · Conversation · History). */
  tab?: ReviewTab
  /** B-W2b-382: the page of the request's record (its parent's for a subject with no page), also when its row is not listed. */
  recordHref?: string | null
}

export const REVIEW_TABS = ['change', 'context', 'conversation', 'history'] as const
export type ReviewTab = (typeof REVIEW_TABS)[number]

/** One row of Approve N, re-read before the yes: current (approved with the others), or left out with the reason. */
export interface BulkLine {
  key: string
  /** The request's id and version as re-read (the yes sends them). */
  id: string
  version: number
  /** B-W2b-382: the request's kind and record as re-read, said in words by the view (never the API's English summary). */
  request: RequestFacts
  /** null: still current; else why it is left out (an `inbox.held.` key of approvals-depth). */
  leftOut: string | null
}

export type InboxDialog =
  | { readonly kind: 'sign'; readonly busy: boolean; readonly problem: string | null }
  | { readonly kind: 'reject'; readonly reasons: Loaded<readonly RejectReason[]>; readonly busy: boolean }
  | { readonly kind: 'bulk'; readonly keys: readonly string[]; readonly lines: readonly BulkLine[] | null; readonly state: ReviewState }
  | { readonly kind: 'help' }

export interface InboxViewModel {
  /** `/w/<company>` */
  prefix: string
  me: string
  grains: Grains
  /** quotes (W1), the engine's requests (approvals.view, approvals.decide), Today's approvals (home.view), the rules page. */
  can: { quotes: QuoteAbilities; tasks: boolean; decide: boolean; today: boolean; rules: boolean }
  controls: InboxControls
  /** The view's rows from every source (the view filters them); null while the first read runs. */
  rows: { items: readonly InboxRow[] | null; problem: string | null }
  counts: InboxCounts
  /** Requests on this view that changed since they were asked (design notice). */
  changedSinceAsked: number
  /** A source stopped at its limit: the list says so. */
  capped: boolean
  /** The companies by id (the Company column, when the person works in several). */
  companies: Readonly<Record<string, string>>
  asOf: string | null
  offline: boolean
  busy: boolean
  /** B-W2b-382: `request` — the decided request, said in words as the notice's `{request}`. */
  notice: { key: string; tone: Tone; params?: Record<string, string | number>; request?: RequestFacts } | null
  /** W1's quote review (`?open=<quote approval id>`) and its reject dialog. */
  quoteReview: { id: string; quote: Loaded<QuoteDetail> } | null
  quoteRejecting: boolean
  taskReview: TaskReviewModel | null
  dialog: InboxDialog | null
  /** Design cases: the rows ticked, the row that has the focus. */
  selected?: readonly string[]
  focusRow?: number
}

export interface InboxActions {
  onControls?: (next: Partial<InboxControls>) => void
  onRetry?: () => void
  onDismissNotice?: () => void
  /** Open a review (`?open=`), or close it (null). */
  onOpen?: (id: string | null) => void
  onRetryReview?: () => void
  onTab?: (tab: ReviewTab) => void
  onComment?: (comment: string) => void
  /** Approve the open request: a signed one opens the sign dialog first. */
  onApprove?: () => void
  onSign?: (code: string) => void
  onReject?: () => void
  onRejectConfirm?: (reasonCode: string, reason: string) => void
  onRetryReasons?: () => void
  onCloseDialog?: () => void
  /** Approve N of one kind: the review re-reads each first. */
  onBulk?: (keys: readonly string[]) => void
  onBulkConfirm?: () => void
  onHelp?: () => void
  /** W1's quote review. */
  quote?: ApprovalsActions
  history?: ApprovalHistoryActions
}
