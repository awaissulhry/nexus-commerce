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
 * Answers to people and tools are in MINOR units: the currency's decimals as Intl (CLDR) counts them (EUR 2, JPY 0 — and,
 * unlike ISO 4217, HUF, COP and IDR 0; BHD and JOD 3, where Meta counts hundredths), as Google's reads: `…Cents`.
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

/** The currency's own number of decimals as Intl (CLDR) knows it — the web uses the same rule: EUR 2, JPY 0, HUF 0, BHD 3. */
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

/**
 * Step 3 — the ad account's `spend_cap` as Meta READS it: offset units ("Value specified in basic unit of the currency,
 * for example 'cents' for USD", reference/ad-account fields); "0" means no cap → null. Meta WRITES the same cap
 * differently (POST /act_<id> spend_cap: "standard denomination of the currency, e.g. 23.50 for USD $23.50" — facts F1
 * X4): that is the account change's own helper, never this one.
 */
export function metaAccountSpendCapMicros(value: unknown, currency: string | null | undefined): bigint | null {
  const micros = metaUnitsToMicros(value, currency)
  return micros === null || micros === 0n ? null : micros
}

/**
 * Step 3 — minor units of the account currency (what Nexus's tools take) → Meta's offset units (what minimum_budgets'
 * bid_amount, budgets and bids take): EUR 1250 → 1250, JPY 1250 → 1250, BHD 1250 (1.250) → 125. Null when it is not a
 * whole number of Meta's units (BHD 1255) or not a whole number at all. NEVER for the account's spend_cap: Meta writes
 * that in standard units (minorToMetaStandard).
 */
export function minorToMetaUnits(minor: number, currency: string | null | undefined): number | null {
  if (!Number.isSafeInteger(minor)) return null
  const micros = BigInt(minor) * 10n ** BigInt(Math.max(0, 6 - currencyExponent(currency)))
  const per = BigInt(1_000_000 / metaOffset(currency))
  return micros % per === 0n ? Number(micros / per) : null
}

/**
 * Step 3 — Meta's CurrencyAmount (credit lines, credit allocations, an invoice's amount due: `{ amount,
 * amount_in_hundredths, currency, offsetted_amount }`, SDK currencyamount.py — Meta's node page answers 404) in micros of
 * ITS OWN currency (a credit line is "measured in USD at the top level", reference extended-credit): offsetted_amount
 * (Meta's offset units of that currency) when it is a whole number, else amount (a decimal of the currency). Null when
 * neither is usable or no currency is named. Which of the two Meta fills is settled live (LIVE-PROBES BM-026).
 */
export function currencyAmountMicros(value: unknown): { micros: bigint; currency: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const currency = typeof v.currency === 'string' && /^[A-Za-z]{3}$/.test(v.currency.trim()) ? v.currency.trim().toUpperCase() : null
  if (!currency) return null
  const micros = metaUnitsToMicros(v.offsetted_amount, currency) ?? decimalToMicros(v.amount)
  return micros === null ? null : { micros, currency }
}

/**
 * Step 3 review A3 — for set-meta-spend-cap (step 40): minor units of the account currency → the decimal string Meta
 * takes when the ad account's spend_cap is WRITTEN ("standard denomination of the currency, e.g. 23.50 for USD $23.50",
 * reference/ad-account Updating): EUR 50000 → "500.00", JPY 1250 → "1250", BHD 1250 → "1.250". The currency's own
 * decimals (currencyExponent). Null when not a whole number of minor units. Read back with metaAccountSpendCapMicros.
 */
export function minorToMetaStandard(minor: number, currency: string | null | undefined): string | null {
  if (!Number.isSafeInteger(minor)) return null
  const exponent = currencyExponent(currency)
  const digits = String(Math.abs(minor))
  if (exponent === 0) return `${minor < 0 ? '-' : ''}${digits}`
  const padded = digits.padStart(exponent + 1, '0')
  return `${minor < 0 ? '-' : ''}${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`
}
