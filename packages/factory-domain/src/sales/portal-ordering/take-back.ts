import type { RequestStatus } from './rules'

/**
 * "Take it back" (owb- order workflow, S1 po1.2; design order-workflow § 5zi, § 5h "after Send a green line + Take it back until the
 * factory confirms"; build plan.md § 4 G1; the S1 lead's settle 2: the Sent order's ONE primary). A SENT order request that the
 * factory has not answered goes back to DRAFT: the customer edits it again and sends it again under the SAME number (a number once
 * given never changes: the database's G1 guard). Refused, in the customer's words, once the factory answered it (accepted or
 * refused) or started work on it (a style draft made for it, `styleIds` not empty: G1 (c2)). The API checks this BEFORE the write, so
 * the customer reads these words, never the database's.
 *
 * Pure: the API reads the facts — the status in the partner scope, the style drafts in the tenant's scope as a yes/no only.
 * The Italian says "voi" (the portal's words).
 */

export const TAKE_BACK_WORDS = Object.freeze({
  ANSWERED: { en: 'The factory has already answered this order.', it: 'La fabbrica ha già risposto a questo ordine.' },
  STARTED: { en: 'The factory has already started work on this order: ask the factory.', it: 'La fabbrica ha già iniziato a lavorare su questo ordine: chiedete alla fabbrica.' },
  NOT_SENT: { en: 'This order is still a draft: there is nothing to take back.', it: 'Questo ordine è ancora una bozza: non c’è niente da riprendere.' },
  WITHDRAWN: { en: 'This order was withdrawn: it cannot be taken back.', it: 'Questo ordine è stato ritirato: non si può riprendere.' },
} as const)

export type TakeBackRefusal = keyof typeof TAKE_BACK_WORDS

export interface TakeBackFacts {
  readonly status: RequestStatus
  /** The factory named a style draft for it (`styleIds` not empty): work started. */
  readonly designStarted: boolean
}

/** Why the request cannot be taken back now (null: it can). */
export function takeBackProblem(facts: TakeBackFacts): TakeBackRefusal | null {
  switch (facts.status) {
    case 'SENT':
      return facts.designStarted ? 'STARTED' : null
    case 'DRAFT':
      return 'NOT_SENT'
    case 'WITHDRAWN':
      return 'WITHDRAWN'
    case 'ACCEPTED':
    case 'REFUSED':
      return 'ANSWERED'
  }
}

/** The refusal's HTTP code word: answered or started is a 409 `conflict` (the brief's words); a wrong state a 409 `invalid_state`. */
export const takeBackCodeOf = (refusal: TakeBackRefusal): 'conflict' | 'invalid_state' => (refusal === 'ANSWERED' || refusal === 'STARTED' ? 'conflict' : 'invalid_state')
