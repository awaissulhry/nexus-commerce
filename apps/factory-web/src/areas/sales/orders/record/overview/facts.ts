import type { Order } from '../../api'
import type { Phrase } from '../../model'

/**
 * F-OO-100 (order overview lane: one file per section) — Order facts: the card's one rule, moved out of the view unchanged
 * (F-SA-233). The card itself is view/overview/FactsCard.tsx.
 */

/** The order's language in words (`overview.facts.lang.*`): English for `en`, Italian for any other code. */
export const languageOf = (order: Pick<Order, 'language'>): Phrase => ({ key: `overview.facts.lang.${order.language === 'en' ? 'en' : 'it'}` })
