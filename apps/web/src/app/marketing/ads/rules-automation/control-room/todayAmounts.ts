/**
 * 7b (review 8.6) — the Today board's money, one currency at a time.
 *
 * The waste figure added euros, pounds and kronor into one "€" number. The API now sends each currency apart
 * (`amounts` on a row, `wasted` on the headline) and never adds them; these say them as they are. An older API sent
 * only `amountCents`, which was always euros.
 */
export interface Amount { currency: string; cents: number }

export const money = (a: Amount): string =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: a.currency }).format(a.cents / 100)

/** A row's price, one entry per currency; empty when it has none. */
export function rowAmounts(e: { amountCents: number | null; amounts?: Amount[] }): Amount[] {
  if (e.amounts?.length) return e.amounts
  return e.amountCents == null ? [] : [{ currency: 'EUR', cents: e.amountCents }]
}

/** The headline figure: each currency on its own ("€247.61 · £12.30"), or a dash when there is no waste. */
export function headlineAmount(h: { wastedSpend30dCents: number | null; wasted?: Amount[] }): string {
  const list = h.wasted?.length ? h.wasted : h.wastedSpend30dCents == null ? [] : [{ currency: 'EUR', cents: h.wastedSpend30dCents }]
  return list.length ? list.map(money).join(' · ') : '—'
}
