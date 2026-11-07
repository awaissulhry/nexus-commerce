import { ORDERING_LIMITS, type RequestStatus } from './rules'

/**
 * The office's side of a portal order request (B-W2b-190, SAL-074 "portal orders arrive as requests"; design
 * home.approvals, sales.orders "the request waits there as Requested"). A SENT request waits in Home › Approvals for the
 * people who take orders for its company and customer (orders.manage); they decide it on its record:
 *
 *   accept as an ORDER   the sales orders' own manual create (prices again from the customer's list today, or the prices
 *                        the office types; the customer's terms, addresses and deposit), then ACCEPTED naming the order —
 *                        one command, so a request never names an order that was not made
 *   accept as a QUOTE    a new quote with the request's lines (the quotes' own copy: list prices today, sizes still
 *                        offered), then ACCEPTED naming the quote (quotes.manage too)
 *   refuse               REFUSED with the reason in words, which the customer reads
 *
 * Only a SENT request is decided, once; the customer may withdraw it before that. A DRAFT is the customer's alone (the
 * database refuses an office edit of it).
 */

export const ACCEPT_AS = ['ORDER', 'QUOTE'] as const
export type AcceptAs = (typeof ACCEPT_AS)[number]

/** Why a request cannot be decided now, in words (null: it can). */
export function decisionProblem(status: RequestStatus): string | null {
  if (status === 'SENT') return null
  if (status === 'DRAFT') return 'The customer is still writing this request: it is decided once they send it.'
  if (status === 'WITHDRAWN') return 'The customer withdrew this request.'
  return `This request was already ${status === 'ACCEPTED' ? 'accepted' : 'refused'}.`
}

/** Why the customer cannot withdraw it now (null: they can). */
export function withdrawProblem(status: RequestStatus): string | null {
  if (status === 'SENT') return null
  if (status === 'DRAFT') return 'A draft is discarded, not withdrawn.'
  if (status === 'WITHDRAWN') return 'You already withdrew this request.'
  return 'The factory already decided this request: ask us if something should change.'
}

/** The refusal's words: 1 to 1000 characters after trimming. */
export function refuseReasonProblem(reason: string): string | null {
  const text = reason.trim()
  if (text.length === 0) return 'Say why the request is refused: the customer reads it.'
  if (text.length > ORDERING_LIMITS.reason) return `At most ${ORDERING_LIMITS.reason} characters.`
  return null
}
