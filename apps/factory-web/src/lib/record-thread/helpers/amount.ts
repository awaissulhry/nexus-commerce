import { MESSAGE_AMOUNT_MAX, priceInWords } from '@nexus/factory-domain/threads/price-check'

/**
 * B-TH-236 (B-TH-049; threads plan T8-F04 "Amount field", T5-F06 "For the floor", PL8-F03): money stays out of words, pure. A price
 * goes in its own field on an office note — never in the text, because field security can hide a field and not free text — and only
 * for a person holding the price grain (money.price: the API refuses the field otherwise and drops it from every other reader's
 * answer; a portal, a link and the floor never read it). A note for the floor whose words look like a price is held before it goes,
 * with what looked like one (the API holds it again: 409 refusal/FLOOR_PRICE). A supplier PO thread may talk prices: the check runs
 * on floor notes only.
 */

/** The currencies the field offers (ISO 4217); the company's own comes first. */
export const AMOUNT_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'] as const

/** The field is offered on an office note to a person who sees prices (money.price); a reply or a portal message never carries one. */
export const amountOffered = (mode: string, canPrice: boolean | undefined): boolean => mode === 'note' && canPrice === true

/**
 * A typed amount in minor units (cents): "1.250,00", "1,250.00", "1250.5", "1 250" → 125000 / 125050 / 125000; '' → null; anything
 * else → NaN. The last "," or "." followed by one or two digits is the decimal mark; the other marks group thousands.
 */
export function amountMinor(text: string): number | null {
  const typed = text.replace(/[\s '’]/g, '').replace(/[€$£]|eur|usd|gbp|chf/gi, '')
  if (typed === '') return null
  if (!/^\d[\d.,]*$/.test(typed)) return Number.NaN
  const decimal = /[.,](\d{1,2})$/.exec(typed)
  const whole = (decimal ? typed.slice(0, decimal.index) : typed).replace(/[.,]/g, '')
  if (!/^\d+$/.test(whole)) return Number.NaN
  const cents = decimal ? Number(decimal[1]!.padEnd(2, '0')) : 0
  const value = Number(whole) * 100 + cents
  return Number.isSafeInteger(value) ? value : Number.NaN
}

/** Why the typed amount cannot go (a key of record-thread-helpers), or null: empty, or a whole number of cents in range. */
export function amountProblem(text: string | undefined, facts: { readonly forFloor: boolean }): { key: string; params?: Record<string, string | number> } | null {
  if (text === undefined || text.trim() === '') return null
  if (facts.forFloor) return { key: 'amount.floor' }
  const value = amountMinor(text)
  if (value === null) return null
  if (Number.isNaN(value)) return { key: 'amount.invalid' }
  if (value > MESSAGE_AMOUNT_MAX) return { key: 'amount.tooLarge' }
  return null
}

/** What POST …/notes takes: `{ value, currency }` in minor units, or nothing (empty, or not valid: Send is held then). */
export function amountBody(text: string | undefined, currency: string | undefined): { value: number; currency: string } | null {
  if (text === undefined) return null
  const value = amountMinor(text)
  if (value === null || Number.isNaN(value) || value > MESSAGE_AMOUNT_MAX) return null
  return { value, currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : AMOUNT_CURRENCIES[0] }
}

/** The words of a floor note that look like a price (as written, at most 40 characters), or null: the note may go to the tablets. */
export function floorPriceFound(body: string, forFloor: boolean): string | null {
  return forFloor ? priceInWords(body) : null
}
