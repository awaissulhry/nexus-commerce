import { fitsDecimal, isCurrencyCode } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { Dec, parseDecimal, type Decimal } from '../../tax/decimal'
import { EURO } from './currencies'

/**
 * Exchange rates (B-W2b-389; PLT-133; factory-db currency.prisma ExchangeRate), pure.
 *
 *   a rate       how many units of the quote currency one unit of the base buys, as the ECB quotes it: 1 EUR = 1.0850 USD
 *                (base EUR, quote USD, rate 1.0850). Above 0, at most eight decimals (Decimal(18, 8)).
 *   sources      ECB: the ECB's euro reference rates of a day (its daily public file; base EUR; never changed);
 *                MANUAL: a person's override of a day (any base and quote); it wins over the ECB's rate of that day.
 *   the day's    the rate a document of a day takes: the latest day on or before it, at most LOOKBACK_DAYS earlier (the
 *   rate         ECB publishes on TARGET working days only, so a Saturday takes Friday's and an Easter Monday the Thursday's);
 *                on that day the manual rate wins. Read both ways (a USD→EUR rate is 1 ÷ the EUR→USD one) and, when
 *                neither currency is the euro, across the euro (GBP→USD = EUR→USD ÷ EUR→GBP, each the day's, dated the
 *                older of the two). A worked-out rate keeps eight decimals, rounded half up. None found: null — a
 *                document then waits for a rate, in words; a figure is never made up.
 *   revaluation  stays the accountant's: a document keeps the rate and the day it used (Invoice.exchangeRate + rateDate,
 *                PurchaseOrder.rateAtOrder), and a later rate never changes it.
 */

export const RATE_SOURCES = ['ECB', 'MANUAL'] as const
export type RateSource = (typeof RATE_SOURCES)[number]

/** Decimal(18, 8): the column's shape. */
export const RATE_SHAPE = { precision: 18, scale: 8 } as const

/** How many days before a document's day its rate may be (weekends and TARGET holidays have no ECB rate). */
export const LOOKBACK_DAYS = 7

/** One stored rate of a day, as the table holds it. */
export interface RateRow {
  readonly base: string
  readonly quote: string
  readonly rateDate: BusinessDate
  /** A plain decimal string (Decimal(18, 8)). */
  readonly rate: string
  readonly source: RateSource
}

/** The rate a document of a day takes: 1 `base` = `rate` `quote`, of `rateDate`, from `source`. */
export interface DayRate {
  readonly base: string
  readonly quote: string
  /** Eight decimals. */
  readonly rate: string
  readonly rateDate: BusinessDate
  /** ECB or MANUAL; a rate worked out across the euro from a manual leg is MANUAL. */
  readonly source: RateSource
  /** How it was found: as stored, read the other way round, or across the euro. */
  readonly how: 'STORED' | 'INVERSE' | 'CROSS'
}

/** The row's key, as ExchangeRate.key holds it: "<base>:<quote>:<YYYY-MM-DD>:<source>". */
export const rateKey = (row: Pick<RateRow, 'base' | 'quote' | 'rateDate' | 'source'>): string => `${row.base}:${row.quote}:${row.rateDate}:${row.source}`

/** A business day moved by whole days (UTC arithmetic on the date only). */
export const addDays = (day: BusinessDate, days: number): BusinessDate => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10)

const eight = (value: Decimal): string => value.toDecimalPlaces(RATE_SHAPE.scale, Dec.ROUND_HALF_UP).toFixed(RATE_SHAPE.scale)

/** A typed rate in its stored form (eight decimals), or null when it is not one. */
export function normalRate(rate: string): string | null {
  const text = rate.trim()
  const parsed = parseDecimal(text)
  if (parsed === null || !fitsDecimal(text, RATE_SHAPE.precision, RATE_SHAPE.scale) || !parsed.greaterThan(0)) return null
  return eight(parsed)
}

/** Why a manual rate cannot be kept, or null (the database holds the same rules: base ≠ quote, ISO, above 0, no future day). */
export function manualRateProblem(input: { readonly base: string; readonly quote: string; readonly day: string; readonly rate: string }, today: BusinessDate): { readonly path: string; readonly message: string } | null {
  if (!isCurrencyCode(input.base)) return { path: 'base', message: 'The base is an ISO 4217 code: three capital letters (EUR).' }
  if (!isCurrencyCode(input.quote)) return { path: 'quote', message: 'The quote is an ISO 4217 code: three capital letters (USD).' }
  if (input.base === input.quote) return { path: 'quote', message: 'A rate is between two different currencies.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) return { path: 'day', message: 'The day is a date (YYYY-MM-DD).' }
  if (input.day > today) return { path: 'day', message: 'A rate is kept for today or a day before: the future has no rate yet.' }
  if (normalRate(input.rate) === null) return { path: 'rate', message: 'A rate is a plain decimal above 0 with at most eight decimals (1.0850).' }
  return null
}

/** The rate the other way round: 1 ÷ rate, eight decimals. */
export const inverseRate = (rate: string): string => eight(new Dec(1).dividedBy(new Dec(rate)))

/** The rate in words: "1 EUR = 1.085 USD" (trailing zeros dropped). */
export const rateWords = (rate: Pick<DayRate, 'base' | 'quote' | 'rate'>): string => `1 ${rate.base} = ${new Dec(rate.rate).toString()} ${rate.quote}`

interface Leg {
  readonly rate: Decimal
  readonly rateDate: BusinessDate
  readonly source: RateSource
  readonly how: 'STORED' | 'INVERSE'
}

/**
 * The latest leg base → quote on or before `day` (within the lookback), from the rows stored either way round; on one day
 * the manual rate wins over the ECB's, and a rate stored this way round over one read the other way.
 */
function legOf(rows: readonly RateRow[], base: string, quote: string, day: BusinessDate): Leg | null {
  const earliest = addDays(day, -LOOKBACK_DAYS)
  let best: Leg | null = null
  const rank = (leg: Leg) => `${leg.rateDate}|${leg.source === 'MANUAL' ? 1 : 0}|${leg.how === 'STORED' ? 1 : 0}`
  for (const row of rows) {
    if (row.rateDate > day || row.rateDate < earliest) continue
    const direct = row.base === base && row.quote === quote
    const inverse = row.base === quote && row.quote === base
    if (!direct && !inverse) continue
    const value = parseDecimal(row.rate)
    if (value === null || !value.greaterThan(0)) continue
    const leg: Leg = { rate: direct ? value : new Dec(1).dividedBy(value), rateDate: row.rateDate, source: row.source, how: direct ? 'STORED' : 'INVERSE' }
    if (best === null || rank(leg) > rank(best)) best = leg
  }
  return best
}

/** The rate a document of `day` takes from base to quote (1 base = rate quote), or null when none is found. */
export function dayRateFrom(rows: readonly RateRow[], base: string, quote: string, day: BusinessDate): DayRate | null {
  if (base === quote) return { base, quote, rate: eight(new Dec(1)), rateDate: day, source: 'ECB', how: 'STORED' }
  const leg = legOf(rows, base, quote, day)
  if (leg) return { base, quote, rate: eight(leg.rate), rateDate: leg.rateDate, source: leg.source, how: leg.how }
  if (base === EURO || quote === EURO) return null
  const toBase = legOf(rows, EURO, base, day)
  const toQuote = legOf(rows, EURO, quote, day)
  if (!toBase || !toQuote) return null
  return {
    base,
    quote,
    rate: eight(toQuote.rate.dividedBy(toBase.rate)),
    rateDate: toBase.rateDate < toQuote.rateDate ? toBase.rateDate : toQuote.rateDate,
    source: toBase.source === 'MANUAL' || toQuote.source === 'MANUAL' ? 'MANUAL' : 'ECB',
    how: 'CROSS',
  }
}

/** The pairs of stored rows a day rate of base → quote may read: both ways, and each currency against the euro. */
export function pairsFor(base: string, quote: string): readonly (readonly [string, string])[] {
  const pairs: [string, string][] = [
    [base, quote],
    [quote, base],
  ]
  if (base !== EURO && quote !== EURO) pairs.push([EURO, base], [base, EURO], [EURO, quote], [quote, EURO])
  return pairs
}

/** One effective rate of a day per base, quote and day: the manual one when kept, else the ECB's (the rates table). */
export interface DayRow {
  readonly base: string
  readonly quote: string
  readonly rateDate: BusinessDate
  readonly ecb: string | null
  readonly manual: string | null
  /** The rate that day's documents take. */
  readonly rate: string
  readonly source: RateSource
}

/** The stored rows grouped per base, quote and day, newest day first, then by quote. */
export function dayRowsOf(rows: readonly RateRow[]): DayRow[] {
  const groups = new Map<string, { base: string; quote: string; rateDate: BusinessDate; ecb: string | null; manual: string | null }>()
  for (const row of rows) {
    const key = `${row.base}:${row.quote}:${row.rateDate}`
    const group = groups.get(key) ?? { base: row.base, quote: row.quote, rateDate: row.rateDate, ecb: null, manual: null }
    if (row.source === 'ECB') group.ecb = row.rate
    else group.manual = row.rate
    groups.set(key, group)
  }
  return [...groups.values()]
    .map((group) => ({ ...group, rate: (group.manual ?? group.ecb)!, source: group.manual !== null ? ('MANUAL' as const) : ('ECB' as const) }))
    .sort((a, b) => (a.rateDate === b.rateDate ? (a.quote === b.quote ? a.base.localeCompare(b.base) : a.quote.localeCompare(b.quote)) : b.rateDate.localeCompare(a.rateDate)))
}

/** Whether a manual rate differs much from the ECB's of the same day (more than 5 %): a typing slip is likely. */
export function farFromEcb(manual: string, ecb: string | null): boolean {
  if (ecb === null) return false
  const m = parseDecimal(manual)
  const e = parseDecimal(ecb)
  if (m === null || e === null || !e.greaterThan(0)) return false
  return m.minus(e).abs().dividedBy(e).greaterThan(new Dec('0.05'))
}
