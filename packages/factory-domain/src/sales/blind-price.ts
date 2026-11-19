import { DomainError } from '../core/errors'

/**
 * B-CP-026 (customer page lane; Owner answer A of 2026-11-19 to cp-2's MA1 open point 2; the money wall, Owner O1): the acts that
 * change a price their maker cannot see are HELD for a person without the price grain — refused 403 in words, nothing changed —
 * and done by a price holder (the Owner, or a person he names):
 *
 *   1. replacing a quote template's lines while one of them holds a unit price (the body of a person without the grain carries
 *      none: the grain filter refuses one), so the replace would drop or null it
 *   2. saving a line's product options when what the options add changes and the line's price is kept: on an order (the
 *      accepted price kept, `keepPrice`, gives the surcharge away; without it the amendment's words name an amount), on a quote
 *      line that is not priced again (its price typed by hand, a unit or a fee line: the surcharge would stay out of the price)
 *   3. accepting a customer's request whose counter-offer it agreed carries a price (its fee)
 *   4. deciding a return line's credit (a credit-only decision, or any line whose credit is more than nothing): the amount the
 *      person cannot see
 *
 * A person who may do the act otherwise still may when no price moves (a template with no typed price, options that add the same,
 * a counter-offer of a date or words, a repair or a replacement). The web holds the same buttons in words (a later step).
 */

/** The refusal code (`refusal/BLIND_PRICE` in a 403's issues). */
export const BLIND_PRICE = 'BLIND_PRICE' as const

/** The words of the hold (it: "tu", the office). */
export const BLIND_PRICE_WORDS = Object.freeze({
  it: 'Cambia un prezzo che non vedi: lo fa chi vede i prezzi.',
  en: 'It changes a price you cannot see: someone who sees prices does it.',
})

/** 403 in words: the act changes a price the person cannot see (nothing is changed); `path` names the field it rests on. */
export function blindPriceHeld(path?: string): DomainError {
  return new DomainError('forbidden', BLIND_PRICE_WORDS.en, [{ path: `refusal/${BLIND_PRICE}`, message: BLIND_PRICE_WORDS.en }, ...(path ? [{ path, message: BLIND_PRICE_WORDS.en }] : [])])
}
