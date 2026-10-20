/**
 * Meta ads M1 — money, converted ONCE when read and stored in micros of the account currency (never converted between
 * currencies).
 *
 * Meta sends two kinds of amount (checked 2026-10-20 on developers.facebook.com):
 *   - budgets, bids, spend caps, amount spent, balance (`daily_budget`, `lifetime_budget`, `bid_amount`, `spend_cap`,
 *     `amount_spent`, `min_daily_budget` …): integers in the currency's OFFSET unit — "Value specified in basic unit of
 *     the currency, for example 'cents' for USD" (reference/ad-account `spend_cap`). The offset is 100 for most
 *     currencies and 1 for CLP, COP, CRC, HUF, ISK, IDR, JPY, KRW, PYG, TWD and VND
 *     (/documentation/ads-commerce/marketing-api/currencies, "Offset");
 *   - insights `spend` (and action values): a decimal string in the currency's own unit ("12.34").
 * Answers to people and tools are in MINOR units of the currency's ISO 4217 exponent (EUR 2, JPY 0), as Google's
 * reads: `…Cents`.
 */

/** Currencies whose Meta offset is 1 (Meta's currencies page); every other currency's is 100. */
export const META_OFFSET_ONE: ReadonlySet<string> = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND'])

export function metaOffset(currency: string | null | undefined): 1 | 100 {
  return currency && META_OFFSET_ONE.has(currency.toUpperCase()) ? 1 : 100
}

/** A Meta offset-unit integer (number or numeric string) → micros; null for no value or not a whole number. */
export function metaUnitsToMicros(value: unknown, currency: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null
  const text = typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : '') : String(value).trim()
  if (!/^-?\d{1,18}$/.test(text)) return null
  return BigInt(text) * BigInt(1_000_000 / metaOffset(currency))
}

/** A decimal string or number in currency units ("12.34") → micros, rounded half away from zero past 6 decimals. */
export function decimalToMicros(value: unknown): bigint | null {
  if (value === null || value === undefined || value === '') return null
  const text = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(6) : '') : String(value).trim()
  const match = /^(-?)(\d{1,15})(?:\.(\d+))?$/.exec(text)
  if (!match) return null
  const [, sign, whole, fraction = ''] = match
  let micros = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
  if (fraction.length > 6 && Number(fraction[6]) >= 5) micros += 1n
  return sign === '-' ? -micros : micros
}

/** The currency's own number of decimals (ISO 4217, as Intl knows it — the web uses the same rule): EUR 2, JPY 0. */
export function currencyExponent(currency: string | null | undefined): number {
  if (!currency) return 2
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** Micros → the currency's minor units, rounded half away from zero: 12,345,000 EUR micros → 1235 cents. */
export function microsToMinor(micros: bigint, exponent: number): number {
  const per = 10n ** BigInt(Math.max(0, 6 - exponent))
  const half = per / 2n
  return Number(micros >= 0n ? (micros + half) / per : -((-micros + half) / per))
}

/** Micros (or null) → minor units of the currency (or null). */
export function minorOf(micros: bigint | null | undefined, currency: string | null | undefined): number | null {
  return micros === null || micros === undefined ? null : microsToMinor(micros, currencyExponent(currency))
}
