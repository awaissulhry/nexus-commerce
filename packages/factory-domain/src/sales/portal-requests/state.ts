import type { InquiryStatus } from '../inquiries/rules'
import type { Words } from './rules'

/**
 * The real state of a customer's request as the customer reads it (B-TH-011; threads plan N24, L2-G05, L2-G19, review R-01:
 * "never 'Quote sent' for a draft"), pure: the request's own state, then its quote's, then its order's. One mapping for the
 * portal's request page, its list and tiles, and the office's "Customer sees" line.
 *
 *   SENT                  NEW: nobody has taken it yet
 *   BEING_REVIEWED        ASSIGNED: someone in the office works on it
 *   NEED_INFO             NEED_INFO: we asked the customer something ("We need something from you")
 *   QUOTE_BEING_PREPARED  QUOTED, its quote not sent yet (DRAFT, PENDING_APPROVAL, APPROVED)
 *   QUOTE_SENT            its quote SENT (the customer has it by e-mail or link)
 *   QUOTE_ACCEPTED        its quote ACCEPTED, no order yet
 *   ORDER_WAITING         its order waits for the office's yes (PENDING_APPROVAL): never "confirmed" (L2-G06)
 *   ORDER_CONFIRMED       its order CONFIRMED or further on
 *   DECLINED              DECLINED: we said no
 *   CLOSED                LOST, its quote DECLINED / EXPIRED / CANCELLED, or its order CANCELLED; B-TH-043: DECLINED as "Not an
 *                         order" (it asked nothing to make: the customer is not told "declined")
 *   WITHDRAWN             B-TH-095 (N20): WITHDRAWN — the customer withdrew it before the office decided (the same word as a
 *                         catalogue order withdrawn: "Withdrawn")
 *
 * OPEN (the "Open requests" tile and the default list): SENT up to ORDER_WAITING. Done: ORDER_CONFIRMED (the order carries
 * on in Orders), DECLINED, CLOSED and WITHDRAWN (under "Closed", never vanished).
 */

// B-TH-095: WITHDRAWN, the customer's own withdrawal before the office decided.
export const PORTAL_REQUEST_STATES = ['SENT', 'BEING_REVIEWED', 'NEED_INFO', 'QUOTE_BEING_PREPARED', 'QUOTE_SENT', 'QUOTE_ACCEPTED', 'ORDER_WAITING', 'ORDER_CONFIRMED', 'DECLINED', 'CLOSED', 'WITHDRAWN'] as const
export type PortalRequestState = (typeof PORTAL_REQUEST_STATES)[number]

export const OPEN_REQUEST_STATES: readonly PortalRequestState[] = Object.freeze(['SENT', 'BEING_REVIEWED', 'NEED_INFO', 'QUOTE_BEING_PREPARED', 'QUOTE_SENT', 'QUOTE_ACCEPTED', 'ORDER_WAITING'])
export const isOpenRequest = (state: PortalRequestState): boolean => OPEN_REQUEST_STATES.includes(state)

export const REQUEST_STATE_WORDS: Readonly<Record<PortalRequestState, Words>> = Object.freeze({
  SENT: { en: 'Sent', it: 'Inviata' },
  BEING_REVIEWED: { en: 'Being reviewed', it: 'In esame' },
  NEED_INFO: { en: 'We need something from you', it: 'Ci serve qualcosa da voi' },
  QUOTE_BEING_PREPARED: { en: 'Quote being prepared', it: 'Preventivo in preparazione' },
  QUOTE_SENT: { en: 'Quote sent (see your e-mail)', it: 'Preventivo inviato (vedete la vostra e-mail)' },
  QUOTE_ACCEPTED: { en: 'Quote accepted', it: 'Preventivo accettato' },
  ORDER_WAITING: { en: 'Order waiting for approval', it: 'Ordine in attesa di approvazione' },
  ORDER_CONFIRMED: { en: 'Order confirmed', it: 'Ordine confermato' },
  DECLINED: { en: 'Declined', it: 'Rifiutata' },
  CLOSED: { en: 'Closed', it: 'Chiusa' },
  WITHDRAWN: { en: 'Withdrawn', it: 'Ritirata' }, // B-TH-095
})

export interface RequestStateFacts {
  readonly status: InquiryStatus
  /** The quote it became (QUOTED), as its status reads now; null: none, or not readable. */
  readonly quoteStatus: string | null
  /** The order made from that quote, as its status reads now; null: none yet. */
  readonly orderStatus: string | null
  /** B-TH-043: why it was declined (the office's column, read in the tenant scope; never shown): NOT_AN_ORDER reads "Closed". */
  readonly declineReason?: string | null
}

const QUOTE_BEING_PREPARED = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED']
const QUOTE_ENDED = ['DECLINED', 'EXPIRED', 'CANCELLED']

/** The customer's state of a request from its real states. */
export function requestStateOf(facts: RequestStateFacts): PortalRequestState {
  switch (facts.status) {
    case 'NEW':
      return 'SENT'
    case 'ASSIGNED':
      return 'BEING_REVIEWED'
    case 'NEED_INFO':
      return 'NEED_INFO'
    case 'DECLINED':
      return facts.declineReason === 'NOT_AN_ORDER' ? 'CLOSED' : 'DECLINED' // B-TH-043
    case 'LOST':
      return 'CLOSED'
    // B-TH-095 (N20): withdrawn by the customer before the office decided — its own word.
    case 'WITHDRAWN':
      return 'WITHDRAWN'
    // TH-2 (B-TH-022): made straight into an order: the order's own state (B-TH-025 reads it into orderStatus).
    case 'ORDERED':
      if (facts.orderStatus === 'PENDING_APPROVAL') return 'ORDER_WAITING'
      if (facts.orderStatus === 'CANCELLED') return 'CLOSED'
      return 'ORDER_CONFIRMED'
    case 'QUOTED':
      if (facts.orderStatus !== null) {
        if (facts.orderStatus === 'PENDING_APPROVAL') return 'ORDER_WAITING'
        if (facts.orderStatus === 'CANCELLED') return 'CLOSED'
        return 'ORDER_CONFIRMED'
      }
      if (facts.quoteStatus === null || QUOTE_BEING_PREPARED.includes(facts.quoteStatus)) return 'QUOTE_BEING_PREPARED'
      if (facts.quoteStatus === 'SENT') return 'QUOTE_SENT'
      if (facts.quoteStatus === 'ACCEPTED') return 'QUOTE_ACCEPTED'
      if (QUOTE_ENDED.includes(facts.quoteStatus)) return 'CLOSED'
      return 'QUOTE_BEING_PREPARED'
  }
}

// ---- B-TH-095 (threads plan TH-9, N20; X-P-CUS-REQ.state-F03; wall W37) --------------------------------------------------------
/**
 * The customer withdraws its own request from the portal, before the office decided (NEW, ASSIGNED, NEED_INFO): WITHDRAWN, final,
 * closed by the portal person (the database: only a portal person of the request's own customer). The words are the catalogue
 * order's ("You already withdrew this request." / "…already decided…"), in Italian and English; never naming another customer.
 */
export const WITHDRAW_REFUSALS = ['ALREADY_WITHDRAWN', 'DECIDED'] as const
export type WithdrawRefusal = (typeof WITHDRAW_REFUSALS)[number]

export const WITHDRAW_WORDS: Readonly<Record<WithdrawRefusal, Words>> = Object.freeze({
  ALREADY_WITHDRAWN: { en: 'You already withdrew this request.', it: 'Avete già ritirato questa richiesta.' },
  DECIDED: { en: 'The factory already decided this request: ask us if something should change.', it: 'La fabbrica ha già deciso su questa richiesta: chiedeteci se qualcosa deve cambiare.' },
})

/** The request states the customer may still withdraw from (the office has not decided yet). */
export const WITHDRAWABLE_STATUSES: readonly InquiryStatus[] = Object.freeze(['NEW', 'ASSIGNED', 'NEED_INFO'])

/** Why the request cannot be withdrawn now, or null when it can. */
export function withdrawRefusal(status: InquiryStatus): WithdrawRefusal | null {
  if (WITHDRAWABLE_STATUSES.includes(status)) return null
  return status === 'WITHDRAWN' ? 'ALREADY_WITHDRAWN' : 'DECIDED'
}
// ---- end B-TH-095
