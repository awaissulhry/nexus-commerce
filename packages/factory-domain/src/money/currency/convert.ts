import { fromMinorUnits, toMinorUnits, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { Dec } from '../../tax/decimal'
import { rateWords, type DayRate, type RateSource } from './rates'

/**
 * Converting an amount and adding amounts of several currencies (B-W2b-389; PLT-132), pure.
 *
 *   convert   an amount in minor units of one currency into another at a day's rate (1 base = rate quote): × rate from
 *             the base to the quote, ÷ rate the other way; ONE rounding, half up, at the target currency's minor unit
 *             (core/money toMinorUnits). The same currency is the amount itself.
 *   totals    a total never adds two currencies (PLT-132): amounts are summed per currency; a total in one currency
 *             converts each other currency's sum at a NAMED rate (its day, its source), or says which currencies have no
 *             rate and gives no total (null, never a guess).
 */

/** `amount` (minor units of `from`) in `to`, at `rate` (it must be between the two, either way round). */
export function convertMinor(amount: MinorUnits, from: string, to: string, rate: Pick<DayRate, 'base' | 'quote' | 'rate'>): MinorUnits {
  if (from === to) return amount
  const value = fromMinorUnits(amount, from)
  if (rate.base === from && rate.quote === to) return toMinorUnits(value.times(new Dec(rate.rate)), to)
  if (rate.base === to && rate.quote === from) return toMinorUnits(value.dividedBy(new Dec(rate.rate)), to)
  throw new RangeError(`the rate ${rate.base}→${rate.quote} does not convert ${from} into ${to}`)
}

/** A unit price or cost (a decimal string of six places) in another currency at a rate, six places, half up. */
export function convertUnit(unit: string, from: string, to: string, rate: Pick<DayRate, 'base' | 'quote' | 'rate'>): string {
  if (from === to) return new Dec(unit).toFixed(6)
  if (rate.base === from && rate.quote === to) return new Dec(unit).times(new Dec(rate.rate)).toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed(6)
  if (rate.base === to && rate.quote === from) return new Dec(unit).dividedBy(new Dec(rate.rate)).toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed(6)
  throw new RangeError(`the rate ${rate.base}→${rate.quote} does not convert ${from} into ${to}`)
}

export interface CurrencyAmount {
  readonly amount: MinorUnits
  readonly currency: string
}

/** The sums per currency, by code (a currency summing to 0 stays, it was there). */
export function sumPerCurrency(values: readonly CurrencyAmount[]): CurrencyAmount[] {
  const sums = new Map<string, number>()
  for (const value of values) sums.set(value.currency, (sums.get(value.currency) ?? 0) + value.amount)
  return [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount }))
}

/** How one currency's sum entered a converted total: its rate, named. */
export interface ConvertedPart {
  readonly currency: string
  readonly amount: MinorUnits
  /** The part in the total's currency. */
  readonly converted: MinorUnits
  readonly rate: string
  readonly rateDate: BusinessDate
  readonly source: RateSource
  /** "1 EUR = 1.085 USD". */
  readonly words: string
}

export interface TotalIn {
  /** Null when a currency has no rate: no total (the parts and the missing currencies say why). */
  readonly amount: MinorUnits | null
  readonly currency: string
  /** Each other currency's sum and the rate it was converted at. */
  readonly converted: readonly ConvertedPart[]
  /** The currencies with no rate to the total's currency. */
  readonly missing: readonly string[]
}

/**
 * The total of amounts of several currencies in `currency`: each other currency's sum converted at the rate `rateOf` gives
 * (between the two, either way round); one without a rate makes the total null and is listed in `missing`.
 */
export function totalIn(values: readonly CurrencyAmount[], currency: string, rateOf: (from: string) => DayRate | null): TotalIn {
  let amount = 0
  const converted: ConvertedPart[] = []
  const missing: string[] = []
  for (const part of sumPerCurrency(values)) {
    if (part.currency === currency) {
      amount += part.amount
      continue
    }
    const rate = rateOf(part.currency)
    if (!rate) {
      missing.push(part.currency)
      continue
    }
    const value = convertMinor(part.amount, part.currency, currency, rate)
    amount += value
    converted.push({ currency: part.currency, amount: part.amount, converted: value, rate: rate.rate, rateDate: rate.rateDate, source: rate.source, words: rateWords(rate) })
  }
  return { amount: missing.length > 0 ? null : amount, currency, converted, missing }
}
