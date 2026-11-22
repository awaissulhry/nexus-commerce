import type { PriceCheckTotal } from './match'

/**
 * B-OM-020 (order money tab; Owner D4, reversing the customer page's "no agreed-anyway button"): a price difference of an order
 * accepted by hand, pure. An acceptance keeps the two nets as they were checked; it is IN FORCE only while it is not taken back,
 * the order's check still reads NOT_EQUAL and both nets still equal the check now — any change of our price or the customer's
 * reopens the difference by itself (the row stays, the screen asks again). One rule for the price check, the orders list's
 * columns and "Not equal" filter, and the customer's "Prices differ on N orders" (apps/factory-api sales/brand-prices).
 */

export interface Words {
  readonly en: string
  readonly it: string
}

export interface PriceAcceptanceFacts {
  readonly ourNet: number
  readonly brandNet: number
  readonly withdrawnAt: Date | string | null
}

/** Whether an accepted difference still holds for the check as it reads now. */
export function acceptanceInForce(total: Pick<PriceCheckTotal, 'priceMatch' | 'ourPrice' | 'brandPrice'>, acceptance: PriceAcceptanceFacts | null | undefined): boolean {
  return acceptance !== null && acceptance !== undefined && acceptance.withdrawnAt === null && total.priceMatch === 'NOT_EQUAL' && acceptance.ourNet === total.ourPrice && acceptance.brandNet === total.brandPrice
}

export const PRICE_ACCEPT_REFUSALS = ['CLOSED', 'NOTHING_TO_ACCEPT', 'STALE', 'ACCEPTED_ALREADY', 'NOT_ACCEPTED'] as const
export type PriceAcceptRefusal = (typeof PRICE_ACCEPT_REFUSALS)[number]

/** The refusals in words (409 `priceAccept/<CODE>`; Italian "tu"). */
export const PRICE_ACCEPT_WORDS: Readonly<Record<PriceAcceptRefusal, Words>> = Object.freeze({
  CLOSED: { en: 'A closed or cancelled order keeps its price check as it was.', it: "Un ordine chiuso o annullato tiene il controllo prezzi com'era." },
  NOTHING_TO_ACCEPT: { en: 'The prices are not different: there is nothing to accept.', it: 'I prezzi non sono diversi: non c’è nulla da accettare.' },
  STALE: { en: 'A price changed since you read the check: read it again, then accept.', it: 'Un prezzo è cambiato da quando hai letto il controllo: rileggilo, poi accetta.' },
  ACCEPTED_ALREADY: { en: 'This difference is accepted already.', it: 'Questa differenza è già accettata.' },
  NOT_ACCEPTED: { en: 'No difference of this order is accepted: there is nothing to take back.', it: 'Nessuna differenza di questo ordine è accettata: non c’è nulla da ritirare.' },
})

/** The words an acceptance is taken back with when a price changed and the office accepts the new difference. */
export const REACCEPTED_WORDS = 'The prices changed since it was accepted; the new difference is accepted.'
