/**
 * Meta step 18 — the units of every amount a settings change writes, ONE helper per field (tests:
 * settings-units.vitest.test.ts). A request names amounts in MINOR units of the account currency (`…Cents`, as every Nexus
 * read answers them: money.ts); Meta reads them in its OFFSET unit — "Value specified in basic unit of the currency, for
 * example 'cents' for USD" — 100 for most currencies, 1 for CLP, COP, CRC, HUF, ISK, IDR, JPY, KRW, PYG, TWD and VND
 * (marketing-api/currencies "Offset"). Where the two differ (BHD and JOD have 3 decimals, Meta counts hundredths) an amount
 * Meta cannot hold is refused, never rounded.
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…):
 *   - reference/ad-campaign-group.md: campaign daily_budget / lifetime_budget (int64), spend_cap "integer value of
 *     subunit in your currency with a minimum value of $100 USD … Set the value to 922337203685478 to remove the spend cap".
 *   - reference/ad-campaign.md: ad set daily_budget / lifetime_budget, daily/lifetime_min_spend_target, _spend_cap ("in
 *     your account currency", numeric string; remove a cap with 922337203685478 — facts F1 M3-11), bid_amount ("cents for
 *     currencies like USD, EUR, and the basic unit for currencies like JPY, KRW"; per 1,000 impressions when billing on
 *     impressions — the number is the same, only its meaning changes: bidAmountMeaning).
 *   - bidding/overview/bid-strategy.md: roas_average_floor = ROAS × 10,000 (1.5 → 15000), 100 … 10,000,000.
 *   - reference/ad-campaign/budget_schedules.md: budget_value "Actual budget increase, unit defined by BudgetValueType
 *     (e.g. 140 could be $140 or 140%)"; high-demand-period.md: "you enter an increase of $20" on a $100 daily budget, and
 *     "the total budget cannot exceed 8 times the daily budget". The unit of ABSOLUTE is NOT documented (facts F1 X4,
 *     UNVERIFIED): Nexus sends WHOLE currency units — Meta's own two examples read that way, and if Meta read the number
 *     as cents the increase would be 100 times SMALLER (the safe side), never 100 times larger. LIVE-PROBES CMP-057.
 *   - the account spend cap is a different call in WHOLE units (AA lane, not here).
 */
import { currencyExponent, metaOffset } from './money.js'
import { META_NO_CAP } from '../../gateway/meta-settings-rules.js'

export class MetaUnitError extends Error {
  constructor(message: string) { super(message); this.name = 'MetaUnitError' }
}

/** Minor units of the account currency → Meta's offset unit (an integer string), or a refusal when Meta cannot hold it. */
function minorToMetaUnits(cents: number, currency: string | null, what: string): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new MetaUnitError(`${what} is a whole number of minor units of the account currency (cents for EUR).`)
  const exponent = currencyExponent(currency)
  const offset = metaOffset(currency)
  // minor → micros → Meta units, in integers only.
  const micros = BigInt(cents) * 10n ** BigInt(Math.max(0, 6 - exponent))
  const per = BigInt(1_000_000 / offset)
  if (micros % per !== 0n) throw new MetaUnitError(`${what}: Meta counts ${currency ?? 'this currency'} in ${offset === 1 ? 'whole units' : 'hundredths'}, so ${cents} minor units cannot be sent exactly.`)
  return String(micros / per)
}

/** Meta's offset-unit amount (as it reads it back) → minor units of the account currency; null when none. */
export function metaUnitsToMinor(value: unknown, currency: string | null): number | null {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  if (!/^\d{1,16}$/.test(text)) return null
  const micros = BigInt(text) * BigInt(1_000_000 / metaOffset(currency))
  const per = 10n ** BigInt(Math.max(0, 6 - currencyExponent(currency)))
  return Number(micros / per)
}

/** Campaign and ad set daily_budget / lifetime_budget (CMP-036, AS-044, AS-045). */
export function budgetParam(cents: number, currency: string | null): string {
  if (cents < 1) throw new MetaUnitError('A budget is at least 1 minor unit.')
  return minorToMetaUnits(cents, currency, 'The budget')
}

/** Ad set bid_amount (AS-049) and each ad set's bid in a campaign's adset_bid_amounts (CMP-043). */
export function bidAmountParam(cents: number, currency: string | null): string {
  if (cents < 1) throw new MetaUnitError('A bid is at least 1 minor unit.')
  return minorToMetaUnits(cents, currency, 'The bid')
}

/** What a bid_amount means on this ad set: per 1,000 impressions when it is billed on impressions (or reach). */
export function bidAmountMeaning(billingEvent: string | null): string {
  return billingEvent === 'IMPRESSIONS' || billingEvent === 'REACH' ? 'per 1,000 impressions' : 'per result'
}

/** Campaign spend_cap (CMP-044) in minor units; null removes it (CMP-045, Meta's 922337203685478). */
export function campaignSpendCapParam(cents: number | null, currency: string | null): string {
  if (cents === null) return META_NO_CAP
  if (cents < 1) throw new MetaUnitError('A spend cap is at least 1 minor unit (Meta asks about USD 100 at least).')
  return minorToMetaUnits(cents, currency, 'The spend cap')
}

/** An ad set's daily_spend_cap / lifetime_spend_cap under campaign budget (AS-052); null removes it. */
export function adSetSpendCapParam(cents: number | null, currency: string | null): string {
  if (cents === null) return META_NO_CAP
  if (cents < 1) throw new MetaUnitError('A spend cap is at least 1 minor unit.')
  return minorToMetaUnits(cents, currency, 'The spend cap')
}

/** An ad set's daily_min_spend_target / lifetime_min_spend_target under campaign budget (AS-047); 0 removes it. */
export function minSpendTargetParam(cents: number, currency: string | null): string {
  return cents === 0 ? '0' : minorToMetaUnits(cents, currency, 'The minimum spend')
}

/** A minimum ROAS (2.5 = 2.5× the spend back) → Meta's roas_average_floor (× 10,000; 100 … 10,000,000) (AS-050). */
export function roasFloorParam(roas: number): number {
  const floor = Math.round(roas * 10_000)
  if (!Number.isFinite(roas) || Math.abs(roas * 10_000 - floor) > 1e-6) throw new MetaUnitError('A ROAS goal has at most 4 decimals (Meta writes it × 10,000).')
  if (floor < 100 || floor > 10_000_000) throw new MetaUnitError('A ROAS goal is between 0.01 and 1000 (Meta: 100 … 10,000,000 after × 10,000).')
  return floor
}

/** Meta's roas_average_floor back to a plain ROAS (15000 → 1.5). */
export const roasOfFloor = (floor: number): number => floor / 10_000

/**
 * A scheduled budget increase by an AMOUNT (budget_value_type ABSOLUTE): whole currency units (see the header — the unit
 * Meta does not document; the safe reading). The amount is named in minor units and must be whole units.
 */
export function scheduleAbsoluteParam(cents: number, currency: string | null): string {
  const per = 10 ** currencyExponent(currency)
  if (!Number.isSafeInteger(cents) || cents < per) throw new MetaUnitError(`An increase by an amount is at least one whole ${currency ?? 'currency unit'} (${per} minor units).`)
  if (cents % per !== 0) throw new MetaUnitError(`An increase by an amount is in whole ${currency ?? 'currency units'}: Meta does not document its smallest unit for it, so Nexus sends whole units only (${cents} minor units is not whole).`)
  return String(cents / per)
}

/** Meta's ABSOLUTE budget_value back to minor units (the same whole-unit reading). */
export const scheduleAbsoluteCents = (value: number, currency: string | null): number => value * 10 ** currencyExponent(currency)

/** A scheduled increase by a PERCENTAGE (MULTIPLIER): Meta's "140 could be … 140%" — 1 … 700 (the total stays ≤ 8× the daily budget). */
export function schedulePercentParam(percent: number): string {
  if (!Number.isInteger(percent) || percent < 1 || percent > 700) throw new MetaUnitError('An increase by a percentage is a whole number from 1 to 700 (Meta: the total stays at most 8 times the daily budget).')
  return String(percent)
}

/** An ISO time (or a Date) → UTC Unix seconds, as Meta's start_time, end_time and time_start / time_end take them. */
export function unixSecondsParam(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) throw new MetaUnitError(`"${iso}" is not a time (ISO 8601, e.g. 2026-11-01T08:00:00Z).`)
  return String(Math.floor(ms / 1000))
}
