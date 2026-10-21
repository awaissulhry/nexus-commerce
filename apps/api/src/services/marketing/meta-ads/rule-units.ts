/**
 * Meta step 29 — the units of the money a rule change writes, ONE helper (tests: rule-units.vitest.test.ts). Meta reads
 * every amount in a rule — a filter's or trigger's value on a money field (spent, cost_per_…, cpc, budgets, bids), a
 * change_spec's amount in ACCOUNT_CURRENCY, its limit, a money target — in "the currency's base in the Marketing API. For
 * example, for USD, the base unit is the cent, which means that a value of 1000 for spent is equivalent to $10.00"
 * (ad-rules/overview/evaluation-spec.md "Insights Filters", checked 2026-10-21; change-spec.md: limit "5000 to represent
 * $50 USD"): Meta's offset unit (money.ts — 100 for most currencies, 1 for CLP, COP, CRC, HUF, ISK, IDR, JPY, KRW, PYG,
 * TWD and VND). Step 8 reads that unit back as minor units with metaBudgetCents (live-optimize.ts); this is its inverse. A
 * request names amounts in MINOR units of the account currency (`…Cents`); a negative amount is a cut (a change_spec);
 * an amount Meta cannot hold exactly (BHD and JOD have 3 decimals, Meta counts hundredths) is refused, never rounded.
 * Review B5 — change-spec.md's second example writes a cost target and its limits in WHOLE currency (`amount: 5.0`,
 * `limit: [2.0, 10.0]`), and so do the cost filters of the change-spec and rebalance samples (4.5, 3.0); but the same
 * page's table ("5000 to represent $50 USD"), the evaluation-spec "Insights Filters" note and the trigger guide's minimums
 * ("spent 1000 (cents)") say the currency's base unit. Nexus follows the base unit (LIVE-PROBES RU-010 reads one back).
 */
import { currencyExponent, metaOffset } from './money.js'
import { MetaUnitError } from './settings-units.js'

/** Minor units of the account currency → Meta's base unit of it (a whole number, its sign kept). */
export function ruleMoneyParam(cents: number, currency: string | null, what = 'The amount'): number {
  if (!Number.isSafeInteger(cents)) throw new MetaUnitError(`${what} is a whole number of minor units of the account currency (cents for EUR).`)
  const exponent = currencyExponent(currency)
  const offset = metaOffset(currency)
  const micros = BigInt(Math.abs(cents)) * 10n ** BigInt(Math.max(0, 6 - exponent))
  const per = BigInt(1_000_000 / offset)
  if (micros % per !== 0n) throw new MetaUnitError(`${what}: Meta counts ${currency ?? 'this currency'} in ${offset === 1 ? 'whole units' : 'hundredths'} in a rule, so ${cents} minor units cannot be sent exactly.`)
  const units = Number(micros / per)
  return cents < 0 ? -units : units
}

/** A [low, high] range of minor units → Meta's base unit (IN_RANGE / NOT_IN_RANGE values, a change_spec limit range). */
export function ruleMoneyRange(range: readonly [number, number], currency: string | null, what = 'The range'): [number, number] {
  return [ruleMoneyParam(range[0], currency, what), ruleMoneyParam(range[1], currency, what)]
}
