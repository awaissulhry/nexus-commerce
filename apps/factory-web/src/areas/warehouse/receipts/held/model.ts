import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { TaskRow } from '../../../home/approvals/api'
import type { Receipt, ReceiptLine } from '../api'

/**
 * A goods receipt that waits for a yes (B-W2b-382, the screen gap B-W2b-377 left; SCM-061). The office records a receipt whose
 * line brings more than its delivery tolerance allows (the tolerance says "needs a yes"): POST /inventory/receipts answers 202,
 * the receipt is OPEN with its lines and nothing is posted (no lot, no move, the order does not move); each such line is held
 * (`heldForApprovalAt`) and asks a RECEIPT_OVER_TOLERANCE yes in Home › Approvals (`held[]`: the line and its request).
 *
 *   waiting   a line is held: the screens say which lines and why, who is asked (when the reader sees approvals), and offer
 *             Cancel (POST …/cancel {reason}: the receipt CANCELLED, its requests withdrawn)
 *   refused   a held line's request was refused: the receipt will not be posted — Cancel it and receive within the tolerance
 *   released  no line is held any more: the worker posts it for the person who recorded it; if it stays open (a closed month,
 *             a right that changed), Post (POST …/post) posts it as it was recorded
 *   none      not a receipt of this hold (posted, reversed, cancelled, or goods without a purchase order)
 *
 * A screen never says "posted" for a receipt that waits. PURE.
 */

export const WORDS_NS = 'words-followups-w2b5'
export const MAX_CANCEL_REASON = 1000

export type HeldState = 'none' | 'waiting' | 'refused' | 'released'

/** The lines that wait for a yes. */
export const heldLinesOf = (receipt: Pick<Receipt, 'lines'>): ReceiptLine[] => receipt.lines.filter((line) => Boolean(line.heldForApprovalAt))

/** The newest request of each held line (by line id), from the approval engine's tasks the reader may see. */
export type HeldRequests = Readonly<Record<string, Pick<TaskRow, 'id' | 'status' | 'approver' | 'decidedAt'>>>

export function heldStateOf(receipt: Pick<Receipt, 'status' | 'purchaseOrder' | 'lines'>, requests: HeldRequests | null = null): HeldState {
  if (receipt.status !== 'OPEN' || !receipt.purchaseOrder) return 'none'
  const held = heldLinesOf(receipt)
  if (held.length === 0) return 'released'
  return held.some((line) => requests?.[line.id]?.status === 'REJECTED') ? 'refused' : 'waiting'
}

/** The words of a held line's request: who is asked, who refused, or (requests not readable) only that it waits. */
export function requestWordsOf(request: HeldRequests[string] | undefined): { key: string; params?: Record<string, string> } {
  if (!request) return { key: 'held.state.unread' }
  if (request.status === 'REJECTED') return { key: 'held.state.REJECTED' }
  if (request.status === 'PENDING') return { key: 'held.state.PENDING', params: { who: request.approver.name } }
  return { key: 'held.state.unread' }
}

/** The line's request id: from the 202's `held[]` when the screen has it, else from the tasks read. */
export const taskOf = (lineId: string, held: readonly { readonly lineId: string; readonly taskId: string }[], requests: HeldRequests | null): string | null =>
  held.find((entry) => entry.lineId === lineId)?.taskId ?? requests?.[lineId]?.id ?? null

/** Home › Approvals opened on one request. */
export const requestHref = (prefix: string, taskId: string): string => `${prefix}/home/approvals?open=${encodeURIComponent(taskId)}`

/** Why Cancel or Post waits, or null. */
export function heldActionHeld(input: { readonly receive: boolean; readonly offline: boolean; readonly busy: boolean }): string | null {
  if (!input.receive) return 'held.noReceive'
  if (input.offline) return 'held.offline'
  if (input.busy) return 'held.busy'
  return null
}

/** The cancel's reason as sent, or the key that says why not. */
export function cancelReasonOf(text: string): { reason: string } | { problem: string } {
  const reason = text.trim()
  if (reason.length === 0 || reason.length > MAX_CANCEL_REASON) return { problem: 'held.problem.reason' }
  return { reason }
}

/** A refusal of Cancel or Post in this page's words (a key of words-followups-w2b5); `reload`: read the receipt again. */
export function heldProblem(error: unknown): { key: string; reload: boolean } {
  if (!isApiError(error)) return { key: 'held.problem.failed', reload: false }
  const paths = error.issues.map(issuePath)
  if (paths.some((path) => /^lines\/\d+\/held$/.test(path))) return { key: 'held.problem.held', reload: true }
  if (paths.some((path) => path.includes('reason'))) return { key: 'held.problem.reason', reload: false }
  if (error.kind === 'conflict') return { key: 'held.problem.state', reload: true }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'held.noReceive', reload: false }
  if (error.kind === 'not_found') return { key: 'held.problem.gone', reload: false }
  if (error.kind === 'unavailable') return { key: 'held.offline', reload: false }
  return { key: 'held.problem.failed', reload: false }
}

/** Is it the record's refusal that a receipt needing a yes has nobody to ask (409 refusal/NO_APPROVER)? */
export const noApproverOf = (paths: readonly string[]): boolean => paths.some((path) => path === 'refusal/NO_APPROVER')
