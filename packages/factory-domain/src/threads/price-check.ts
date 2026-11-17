import type { Issue } from '../core/errors'
import { isCurrencyCode } from '../core/money'

/**
 * B-TH-049 (threads plan TH-3, gap N7; features T8-F04 "Amount field", T5-F06 "For the floor", PL8-F03 "Nothing private or
 * costly"): money stays out of words, pure.
 *
 *   the amount field   a price typed in the composer goes in its own field (Message.amount, minor units, with its ISO 4217
 *                      currency), never in the text: field security can hide a field, not free text. Only an internal note that
 *                      stays in the office carries one (never a shared message, never a note for the floor: the database's rule
 *                      too); the API shows it only to readers who hold the price grain (the contract marks it money.price), and
 *                      the portal's and the floor's reads never select it.
 *   the floor check    a note for the floor (a work order's tablets) whose words look like they hold a price is HELD before it
 *                      goes, with the reason and the way out (the amount field, or take the price out). A supplier PO thread may
 *                      talk prices (C2): the check runs on floor notes only.
 *
 * Used by apps/factory-api's platform/threads (postNote). The words come in Italian and English.
 */

/** The largest amount one message carries, in minor units (the database column is a PostgreSQL integer). */
export const MESSAGE_AMOUNT_MAX = 2_000_000_000

export interface MessageAmount {
  /** Minor units (cents) of `currency`, 0 or more. */
  readonly value: number
  /** ISO 4217, three capital letters (EUR). */
  readonly currency: string
}

/** What is wrong with a typed amount on a note (empty: it may be written). `forFloor`: the note is ticked "For the floor". */
export function amountProblems(amount: MessageAmount, facts: { readonly forFloor: boolean }, at = 'body/amount'): Issue[] {
  const problems: Issue[] = []
  if (!Number.isInteger(amount.value) || amount.value < 0 || amount.value > MESSAGE_AMOUNT_MAX) problems.push({ path: `${at}/value`, message: `An amount is a whole number of cents from 0 to ${MESSAGE_AMOUNT_MAX}.` })
  if (!isCurrencyCode(amount.currency)) problems.push({ path: `${at}/currency`, message: 'Name the currency in ISO 4217 (three capital letters, e.g. EUR).' })
  if (facts.forFloor) problems.push({ path: at, message: AMOUNT_WORDS.FLOOR.en })
  return problems
}

/** The refusal codes of this module (`refusal/<CODE>` in a 409's issues). */
export const PRICE_REFUSALS = ['FLOOR_PRICE'] as const
export type PriceRefusal = (typeof PRICE_REFUSALS)[number]

export const AMOUNT_WORDS = Object.freeze({
  FLOOR: {
    it: "Un importo resta in ufficio: una nota per il reparto non ne porta mai. Togli la spunta 'Per il reparto' o l'importo.",
    en: "An amount stays in the office: a note for the floor never carries one. Untick 'For the floor' or remove the amount.",
  },
  SHARED: {
    it: "Un importo va solo in una nota d'ufficio, mai in un messaggio al cliente o al fornitore.",
    en: 'An amount goes on an office note only, never on a message to the customer or supplier.',
  },
})

const NUMBER = String.raw`\d(?:[\d.,'’ ]*\d)?`
const SIGN = String.raw`[€$£¥₣]`
/** Currency codes and words, Italian and English (the floor's notes are written in either). */
const CURRENCY_WORD = String.raw`(?:eur|euro|euros|usd|gbp|chf|jpy|cny|cad|aud|sek|nok|dkk|pln|czk|huf|ron|dollar[io]?|dollars|sterlin[ae]|franchi|francs?)`
/** Words that name money, followed by a figure: "prezzo 12", "price: 30", "costo di 5", "sconto 10%" (never "amount" or "totale":
 * on the floor they count pieces). */
const PRICE_WORD = String.raw`(?:prezz[oi]|prices?|priced|cost[oi]|costs?|tariff[ae]|listino|sconto|sconti|discount|importo|importi|imponibile)`
const LINK = String.raw`(?:\s*(?::|=|di|of|is|è|e'|a|at)\s*|\s+)`

const PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`${SIGN}\s*${NUMBER}`, 'iu'),
  new RegExp(String.raw`${NUMBER}\s*${SIGN}`, 'iu'),
  new RegExp(String.raw`(?<![\p{L}\p{N}])${CURRENCY_WORD}\.?\s*${NUMBER}`, 'iu'),
  new RegExp(String.raw`${NUMBER}\s*${CURRENCY_WORD}(?![\p{L}\p{N}])`, 'iu'),
  new RegExp(String.raw`(?<![\p{L}\p{N}])${PRICE_WORD}(?![\p{L}])${LINK}${NUMBER}`, 'iu'),
]

/** The words of a note that look like a price (the first found, as written, at most 40 characters), or null. */
export function priceInWords(text: string): string | null {
  let first: { index: number; text: string } | null = null
  for (const pattern of PATTERNS) {
    const found = pattern.exec(text)
    if (found && (first === null || found.index < first.index)) first = { index: found.index, text: found[0] }
  }
  if (first === null) return null
  const shown = first.text.replace(/\s+/g, ' ').trim()
  return shown.length <= 40 ? shown : `${shown.slice(0, 39)}…`
}

/** Why a note for the floor is held, in Italian and English, naming what looked like a price; null: it may go. */
export function floorPriceRefusal(text: string): { readonly code: PriceRefusal; readonly words: { readonly it: string; readonly en: string } } | null {
  const found = priceInWords(text)
  if (found === null) return null
  return {
    code: 'FLOOR_PRICE',
    words: {
      it: `Nota trattenuta: “${found}” sembra un prezzo, e il reparto non vede mai importi. Metti il prezzo nel campo importo (resta in ufficio) o toglilo.`,
      en: `Note held: “${found}” looks like a price, and the floor never sees money. Put the price in the amount field (it stays in the office) or take it out.`,
    },
  }
}
