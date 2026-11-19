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
 * Only a SENT request is decided, once; the customer may withdraw it before that. A DRAFT is the customer's to write (the
 * database refuses an office edit of it). B-CP-071 (customer page plan D10, K9 reversed): the office READS a draft from its
 * first save — per customer, read-only, its thread too — and decides nothing on it until it is sent; a draft is never in
 * Incoming, Home › Approvals or any count. `draftReadiness` is the draft's checklist (12 §2: seven parts) as the office's
 * Drafts view and the portal's page read it.
 */

export const ACCEPT_AS = ['ORDER', 'QUOTE'] as const
export type AcceptAs = (typeof ACCEPT_AS)[number]

/** Why a request cannot be decided now, in words (null: it can). */
export function decisionProblem(status: RequestStatus): string | null {
  if (status === 'SENT') return null
  if (status === 'DRAFT') return "This is still the customer's draft: it is decided once they send it." // B-CP-071
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

// ---- B-CP-071 (D10): a draft's checklist -----------------------------------------------------------------------------------

/** The seven parts of a draft order, in the page's order (customer page plan 12 §2). */
export const DRAFT_PARTS = ['NEED', 'LOGOS', 'REFERENCES', 'PEOPLE', 'DATE', 'PRICE', 'NOTES'] as const
export type DraftPart = (typeof DRAFT_PARTS)[number]

/** A part's state: Ready, Sending later, Missing (a required part left empty), Optional (an optional part left empty). */
export const DRAFT_PART_STATES = ['READY', 'LATER', 'MISSING', 'OPTIONAL'] as const
export type DraftPartState = (typeof DRAFT_PART_STATES)[number]

/** The parts the customer may mark "we send it later" (PortalOrderRequest.laterParts, B-CP-075). */
export const DRAFT_LATER_PARTS = ['LOGOS', 'REFERENCES', 'PEOPLE'] as const
export type DraftLaterPart = (typeof DRAFT_LATER_PARTS)[number]

export interface DraftFacts {
  readonly lines: number
  /** Lines that ask no piece yet (a line is ready with a size grid above zero). */
  readonly linesWithoutPieces: number
  readonly logos: number
  readonly references: number
  readonly requestedDate: boolean
  /** The header's own problems (a date that passed, an address no longer active): the date part is missing while one is left. */
  readonly headerProblems: number
  readonly note: boolean
  readonly later: readonly DraftLaterPart[]
  /**
   * Part 6 "Your price": null for a reader WITHOUT the price grain — the part is not counted for them at all (review B4: no
   * money fact reaches a no-price reader, not even "priced: yes"); else how many lines carry the customer's own price.
   */
  readonly pricedLines: number | null
  /** Every problem that holds the send (the header's and the lines'). */
  readonly problems: number
}

export interface DraftReadiness {
  readonly parts: readonly { readonly part: DraftPart; readonly state: DraftPartState }[]
  /** Parts READY. */
  readonly done: number
  /** Parts counted: 7, or 6 for a reader without the price grain. */
  readonly of: number
  readonly problems: number
}

/** The draft's checklist: each part's state, how many are ready of how many, and the problems that hold the send. */
export function draftReadiness(facts: DraftFacts): DraftReadiness {
  const optional = (present: boolean, part: DraftLaterPart | null): DraftPartState => (present ? 'READY' : part !== null && facts.later.includes(part) ? 'LATER' : 'OPTIONAL')
  const people: DraftPartState = facts.lines > 0 && facts.linesWithoutPieces === 0 ? 'READY' : facts.later.includes('PEOPLE') ? 'LATER' : 'MISSING'
  const parts: { part: DraftPart; state: DraftPartState }[] = [
    { part: 'NEED', state: facts.lines > 0 ? 'READY' : 'MISSING' },
    { part: 'LOGOS', state: optional(facts.logos > 0, 'LOGOS') },
    { part: 'REFERENCES', state: optional(facts.references > 0, 'REFERENCES') },
    { part: 'PEOPLE', state: people },
    { part: 'DATE', state: facts.headerProblems > 0 ? 'MISSING' : facts.requestedDate ? 'READY' : 'OPTIONAL' },
    ...(facts.pricedLines === null ? [] : [{ part: 'PRICE' as const, state: facts.lines > 0 && facts.pricedLines >= facts.lines ? ('READY' as const) : ('OPTIONAL' as const) }]),
    { part: 'NOTES', state: facts.note ? 'READY' : 'OPTIONAL' },
  ]
  return { parts, done: parts.filter((entry) => entry.state === 'READY').length, of: parts.length, problems: facts.problems }
}
// ---- end B-CP-071
