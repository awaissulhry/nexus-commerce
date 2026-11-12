import type { PreviewChange } from '../../approvals/rules'
import { fromMinorUnits } from '../../core/money'
import { STATUS_WORDS, type PurchaseOrderStatus } from '../orders'

/**
 * Purchase order approvals (B-W2b-305; SCM-078 approval rules, SCM-080 re-approval on change), the pure part. The engine
 * (B-W2b-282) holds the rules, the requests and the decisions; this file holds what a purchase order adds to it:
 *
 *   the change a request shows   the order DRAFT → SENT; from its second revision on, the revision and the order's value
 *                                from the revision sent before to this one (a cost: shown only with the cost grain), so the
 *                                approver sees what changed since the last yes; and the words the buyer wrote in the Send
 *                                dialog (the mail's subject and text, its copies, the confirm-by time, the change note),
 *                                kept on the request until the yes sends the order with them
 *   the order's approval          how the order stands with its latest request, in words
 *   the facts a rule tests        beyond B-W2b-282's: the revision, and the value added since the revision sent before
 *                                (null on the first revision: a rule on it does not hold, so "ask again when it grows by
 *                                more than 500" asks only on a change)
 */

/** What the Send dialog may say beyond the order (POST /purchasing/orders/:id/send): kept on the request while it waits. */
export interface SendOptions {
  /** When the supplier is asked to answer by (an instant); null: the default at the send (48 h, longer by its closed days). */
  readonly confirmBy: string | null
  readonly subject: string | null
  readonly message: string | null
  /** The copies; null: the default (the other contacts who receive orders). */
  readonly cc: readonly string[] | null
  /** A later revision's note to the supplier. */
  readonly changeNote: string | null
}

export const NO_SEND_OPTIONS: SendOptions = Object.freeze({ confirmBy: null, subject: null, message: null, cc: null, changeNote: null })

/** The change fields that carry the send's words on a request (the order's own fields are status, revision, orderValue). */
export const SEND_OPTION_FIELDS = Object.freeze({ confirmBy: 'confirmBy', subject: 'mailSubject', message: 'mailMessage', cc: 'mailCopies', changeNote: 'changeNote' } as const)

export interface AskChangesInput {
  readonly revision: number
  /** The revision sent before and its value (major units, decimal text); null for a first revision. */
  readonly previous: { readonly revision: number; readonly value: string } | null
  /** The order's value now (major units, decimal text). */
  readonly value: string
  readonly options: SendOptions
}

/** The change a purchase order's request shows and its fingerprint covers (SCM-078, SCM-080). */
export function askChanges(input: AskChangesInput): PreviewChange[] {
  const changes: PreviewChange[] = [{ field: 'status', from: 'DRAFT', to: 'SENT', grain: null }]
  if (input.previous) {
    changes.push({ field: 'revision', from: input.previous.revision, to: input.revision, grain: null })
    changes.push({ field: 'orderValue', from: input.previous.value, to: input.value, grain: 'cost' })
  }
  const { options } = input
  if (options.confirmBy !== null) changes.push({ field: SEND_OPTION_FIELDS.confirmBy, from: null, to: options.confirmBy, grain: null })
  if (options.subject !== null) changes.push({ field: SEND_OPTION_FIELDS.subject, from: null, to: options.subject, grain: null })
  if (options.message !== null) changes.push({ field: SEND_OPTION_FIELDS.message, from: null, to: options.message, grain: null })
  if (options.cc !== null) changes.push({ field: SEND_OPTION_FIELDS.cc, from: null, to: [...options.cc], grain: null })
  if (options.changeNote !== null) changes.push({ field: SEND_OPTION_FIELDS.changeNote, from: null, to: options.changeNote, grain: null })
  return changes
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null)

/** The send's words back from a request's changes (what the yes sends the order with). */
export function sendOptionsOf(changes: readonly PreviewChange[]): SendOptions {
  const to = (field: string): unknown => changes.find((change) => change.field === field)?.to ?? null
  const cc = to(SEND_OPTION_FIELDS.cc)
  return {
    confirmBy: textOf(to(SEND_OPTION_FIELDS.confirmBy)),
    subject: textOf(to(SEND_OPTION_FIELDS.subject)),
    message: textOf(to(SEND_OPTION_FIELDS.message)),
    cc: Array.isArray(cc) ? cc.filter((entry): entry is string => typeof entry === 'string') : null,
    changeNote: textOf(to(SEND_OPTION_FIELDS.changeNote)),
  }
}

/** A value in minor units as the request shows it: major units, plain decimal text ("6000", "12.5"). */
export const valueText = (minor: number, currency: string): string => fromMinorUnits(minor, currency).toFixed()

/** The value added since the revision sent before (negative: it went down); null on a first revision. */
export const valueIncreaseOf = (minor: number, previousMinor: number | null, currency: string): string | null => (previousMinor === null ? null : valueText(minor - previousMinor, currency))

// ---- the order's approval, in words ---------------------------------------------------------------------------------------

export const ORDER_APPROVAL_STATES = ['NONE', 'WAITING', 'APPROVED', 'SENT_WITH_YES', 'REJECTED', 'WITHDRAWN', 'STALE'] as const
export type OrderApprovalState = (typeof ORDER_APPROVAL_STATES)[number]

/**
 * How an order stands with its latest request (PURCHASE_ORDER): none asked; waiting for the yes; approved (still to go:
 * the yes sends it right after, or the buyer's Send when that send was held); sent with the yes; refused, taken back or
 * changed since it was asked (the order is a draft again: its next Send asks again).
 */
export function orderApprovalOf(order: { readonly status: PurchaseOrderStatus; readonly approvalTaskId: string | null }, task: { readonly id: string; readonly status: string } | null): { state: OrderApprovalState; words: string } {
  if (!task) return { state: 'NONE', words: 'No yes was asked for this order.' }
  const own = order.approvalTaskId === task.id
  switch (task.status) {
    case 'PENDING':
      return own && order.status === 'PENDING_APPROVAL'
        ? { state: 'WAITING', words: 'It waits for a yes before it is sent: nothing in it changes meanwhile.' }
        : { state: 'WAITING', words: 'A yes was asked for it as it is now: Send sends it once it is given.' }
    case 'APPROVED':
      if (order.status === 'PENDING_APPROVAL') return { state: 'APPROVED', words: 'Approved: it goes to the supplier now (when it cannot go, Send sends it once the reason is fixed).' }
      if (order.status === 'DRAFT') return { state: 'APPROVED', words: 'Approved as it is: Send sends it without asking again, unless it changes first.' }
      return { state: 'SENT_WITH_YES', words: 'Sent with its yes.' }
    case 'REJECTED':
      return { state: 'REJECTED', words: 'Refused: change it and send it again (the send asks a new yes).' }
    case 'WITHDRAWN':
      return { state: 'WITHDRAWN', words: 'The request was taken back: the order is a draft again.' }
    default:
      return { state: 'STALE', words: 'It changed after the yes was asked: the next Send asks again.' }
  }
}

/** Taking the request back to change the order (PENDING_APPROVAL → DRAFT): only while it waits. */
export function withdrawProblem(status: PurchaseOrderStatus): string | null {
  if (status === 'PENDING_APPROVAL') return null
  if (status === 'DRAFT') return 'The order waits for no yes: it is a draft already.'
  return `The order is ${STATUS_WORDS[status]}: no request of it waits for a yes.`
}

export const PO_APPROVAL_WORDS = Object.freeze({
  waiting: (approver: string | null) => `The order waits for a yes${approver ? ` from ${approver}` : ''} before it is sent: take the request back to change it.`,
  noLongerAsked: 'No approval rule asks for a yes on this order any more: send it again.',
  notCurrent: 'The approved order changed since its yes: send it again to ask a new one.',
  heldSend: (reasons: string) => `It was approved, but it could not be sent: ${reasons} Fix it and press Send: the yes still stands while the order does not change.`,
  backToDraft: { REJECTED: 'Refused: the order is a draft again.', WITHDRAWN: 'The request was taken back: the order is a draft again.', STALE: 'It changed since the yes was asked: the order is a draft again.' },
})
