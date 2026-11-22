/**
 * F-OM-101 — the words the Money tab's pure models hand its views: a message key of the `orders` catalogue and its values, each value
 * kept in its own kind so a model never formats (no locale, no currency here) and a test reads plain numbers and days:
 *
 *   params     plain values (a count, a number, a name)
 *   money      minor units, said in the order's currency (only ever filled for a reader with the price grain)
 *   days       business days (YYYY-MM-DD), said as that day
 *   instants   instants (ISO), said as their day in the site's zone (a paidAt is an instant, a dueDate a day: never mixed)
 *   pcts       percent strings ("30"), said as "30.0 %"
 *   words      another word, said first (the "what" inside "next: {what}, due {date}")
 */
export interface MoneyWord {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly money?: Readonly<Record<string, number>>
  readonly days?: Readonly<Record<string, string>>
  readonly instants?: Readonly<Record<string, string>>
  readonly pcts?: Readonly<Record<string, string>>
  readonly words?: Readonly<Record<string, MoneyWord>>
}

/** A word: its key and what it holds. */
export const word = (key: string, values: Omit<MoneyWord, 'key'> = {}): MoneyWord => ({ key, ...values })

/** Every amount a word says (and the words inside it): the money wall's test reads them. */
export function amountsOf(said: MoneyWord): number[] {
  return [...Object.values(said.money ?? {}), ...Object.values(said.words ?? {}).flatMap(amountsOf)]
}
