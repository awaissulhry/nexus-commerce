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

/**
 * Step 3 review round 2 — every currency an ad account can have, with Meta's offset, exactly as Meta's table lists them
 * (developers.facebook.com/documentation/ads-commerce/marketing-api/currencies.md, "Supported currencies", columns Code and
 * Offset; read 2026-10-21). Offset 100: Meta counts hundredths of the currency (USD 1 = 100); offset 1: whole units (JPY 1
 * = 1). Bahraini and Jordanian dinar (BHD, JOD) are offset 100 although they have 3 decimals; Costa Rican colón and
 * Taiwan dollar (CRC, TWD) offset 1 although they have 2. A currency not in this table is not one Meta knows.
 */
export const META_CURRENCY_OFFSETS: Readonly<Record<string, 1 | 100>> = {
  DZD: 100, ARS: 100, AUD: 100, BHD: 100, BDT: 100, BOB: 100, BGN: 100, BRL: 100, GBP: 100, CAD: 100, CLP: 1, CNY: 100,
  COP: 1, CRC: 1, HRK: 100, CZK: 100, DKK: 100, EGP: 100, EUR: 100, GTQ: 100, HNL: 100, HKD: 100, HUF: 1, ISK: 1,
  INR: 100, IDR: 1, ILS: 100, JPY: 1, JOD: 100, KES: 100, KRW: 1, LVL: 100, LTL: 100, MOP: 100, MYR: 100, MXN: 100,
  NZD: 100, NIO: 100, NGN: 100, NOK: 100, PKR: 100, PYG: 1, PEN: 100, PHP: 100, PLN: 100, QAR: 100, RON: 100, RUB: 100,
  SAR: 100, RSD: 100, SGD: 100, SKK: 100, ZAR: 100, SEK: 100, CHF: 100, TWD: 1, THB: 100, TRY: 100, AED: 100, UAH: 100,
  USD: 100, UYU: 100, VEF: 100, VND: 1, FBZ: 100, VES: 100,
}

/** Meta's offset for a currency of its table; null for no currency or one Meta does not list. */
export function metaCurrencyOffset(currency: string | null | undefined): 1 | 100 | null {
  return currency ? META_CURRENCY_OFFSETS[currency.trim().toUpperCase()] ?? null : null
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
 * Step 3 — THE READ HELPER: the ad account's `spend_cap` as Meta READS it: offset units ("Value specified in basic unit
 * of the currency, for example 'cents' for USD", reference/ad-account fields); "0" means no cap → null. Meta WRITES the
 * same cap differently (POST /act_<id> spend_cap: "standard denomination of the currency, e.g. 23.50 for USD $23.50" —
 * facts F1 X4): that is minorToMetaStandard, never this one.
 */
export function metaAccountSpendCapMicros(value: unknown, currency: string | null | undefined): bigint | null {
  const micros = metaUnitsToMicros(value, currency)
  return micros === null || micros === 0n ? null : micros
}

/**
 * Minor units of the account currency (what Nexus's tools take) → Meta's offset units (what minimum_budgets' bid_amount,
 * budgets and bids take): EUR 1250 → 1250, JPY 1250 → 1250, BHD 1250 (1.250) → 125, TWD 1200 (12.00) → 12. Null when it
 * is not a whole number of Meta's units (BHD 1255, TWD 1250), not a whole number at all, below 0, or no currency is named
 * (a currency Nexus has not read is never assumed: the caller refuses). The ONE helper (step 9's live-targeting.ts uses it
 * too, step 3 review round 2). NEVER for the account's spend_cap: Meta writes that in standard units (minorToMetaStandard).
 *
 * "Minor units" are the currency's decimals as Nexus counts them everywhere (currencyExponent: Intl/CLDR — EUR 2, JPY 0,
 * HUF 0, TWD 2, BHD / JOD 3). Step 9 review fix A4, checked 2026-10-21 on documentation/ads-commerce/marketing-api/
 * currencies.md: Meta's offset is 1 for CLP, COP, CRC, HUF, ISK, IDR, JPY, KRW, PYG, TWD, VND and 100 for the rest —
 * BHD and JOD included (Meta counts hundredths of a dinar, so 3-decimal amounts must end in 0); KWD, OMR and TND are not
 * Meta ad-account currencies at all.
 */
export function minorToMetaUnits(minor: number, currency: string | null | undefined): number | null {
  if (!Number.isSafeInteger(minor) || minor < 0 || !currency) return null
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
 * Step 3 — THE WRITE HELPER for set-meta-spend-cap (step 40): minor units of the account currency → the decimal string
 * Meta takes when the ad account's spend_cap is WRITTEN (POST /act_<id> spend_cap: "Value specified in standard
 * denomination of the currency, e.g. 23.50 for USD $23.50", reference/ad-account Updating). Read the cap back with
 * metaAccountSpendCapMicros (Meta READS it in offset units).
 *
 * Formatted from Meta's OFFSET (META_CURRENCY_OFFSETS, Meta's currencies page), never from the currency's own decimals:
 * offset 100 → two decimals of Meta's hundredths, offset 1 → whole units, no decimals. EUR 50000 → "500.00", JPY 1250 →
 * "1250", BHD 1250 (1.250) → "1.25", BHD 12500 → "12.50", CRC 125000 (1250.00) → "1250", TWD 1200 (12.00) → "12".
 *
 * Null — the caller refuses, nothing is sent — when:
 *   - minor ≤ 0: "A value of 0 signifies no spending-cap" (reference/ad-account), so a cap of 0 would REMOVE the cap,
 *     and a negative cap is no cap at all. Removing the cap is its own change, spend_cap_action=delete (reference/
 *     ad-account Updating: "removes the spend_cap from the account"), and it SPENDS MONEY (the account then spends
 *     without a limit); never this helper;
 *   - the currency is missing or not one of Meta's (META_CURRENCY_OFFSETS);
 *   - it is not a whole number of Meta's units (minorToMetaUnits null: BHD 5 = 0.005, TWD 1250 = 12.50) or not a whole
 *     number at all.
 */
export function minorToMetaStandard(minor: number, currency: string | null | undefined): string | null {
  if (!Number.isSafeInteger(minor) || minor <= 0) return null
  const offset = metaCurrencyOffset(currency)
  if (offset === null) return null
  const units = minorToMetaUnits(minor, currency)
  if (units === null) return null
  if (offset === 1) return String(units)
  return `${Math.trunc(units / 100)}.${String(units % 100).padStart(2, '0')}`
}
