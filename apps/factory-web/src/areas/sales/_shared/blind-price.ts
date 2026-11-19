import { isApiError, issuePath } from '../../../lib/api/errors'

/**
 * F-CP-160 (customer page lane, the money wall; Owner answer A of 2026-11-19, the API's B-CP-026): the four acts that change a
 * price their maker cannot see are held for a reader without the price grain, in the API's words "It changes a price you cannot
 * see: someone who sees prices does it." — replacing a quote template's lines while one holds a typed price, saving a line's
 * options when what they add moves, accepting a request whose agreed counter-offer carries a fee, deciding a return's credit.
 * The API refuses them 403 with `refusal/BLIND_PRICE` (factory-domain `sales/blind-price` BLIND_PRICE); each screen says the
 * words from its own catalogue under `moneyWall.blindPrice` (sales, sales-configurator, approvals, sales-returns: the same words,
 * a test keeps them equal). Held, never hidden: the button stays and says why.
 *
 * Where the screen can see the act moves a price it holds before the click (a priced counter-offer: `counter.priced`; a
 * credit-only return line). Where it cannot (a template's typed prices and the options' surcharges are the price grain, dropped
 * for this reader) it holds after the API's first refusal, for the same draft.
 */

/** The API's refusal code (factory-domain sales/blind-price `BLIND_PRICE`). */
export const BLIND_PRICE_CODE = 'BLIND_PRICE'

/** The key of the words, in each of the four screens' catalogues. */
export const BLIND_PRICE_KEY = 'moneyWall.blindPrice'

/** The API refused the act because it changes a price this reader cannot see (403 `refusal/BLIND_PRICE`). */
export function isBlindPriceRefusal(error: unknown): boolean {
  if (!isApiError(error) || error.kind !== 'forbidden') return false
  return error.issues.some((issue) => issuePath(issue).replace(/\./g, '/') === `refusal/${BLIND_PRICE_CODE}`)
}
