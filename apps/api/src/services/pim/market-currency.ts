/**
 * P4.4a — the currency a market prices in, from the `Marketplace` row that
 * already holds it.
 *
 * 🔴 `Marketplace.currency` is a REQUIRED column and it has been right all
 * along: on the development database all 20 rows carry a currency, including
 * `AMAZON/PL = PLN`, `AMAZON/SE = SEK`, `AMAZON/TR = TRY` and `AMAZON/US = USD`.
 * Several screens already read it. **Every outbound price write ignored it** and
 * re-derived the currency from the market code instead, and a derived census
 * found that fact re-implemented in **seven** places — including two functions
 * with the identical name `currencyForMarket` in two different files, neither
 * importing the other.
 *
 * All of them agree with the table on EUR and GBP and disagree on everything
 * else, so a price pushed to Amazon Poland, Sweden or Turkey carried **EUR**.
 *
 * 🔴 And one of them writes the false fact down as its justification:
 *
 *     // EU marketplaces (IT, DE, FR, ES, NL, BE, SE, PL) all use EUR
 *     // when listing on Amazon.
 *
 * SE is SEK and PL is PLN. A comment can assert a property of the WORLD that is
 * not true, and then the code is wrong for as long as the comment is believed.
 *
 * It REFUSES rather than guessing, exactly like `marketLanguages` on the same
 * table: an unconfigured market is an operator-fixable configuration fact
 * (`statusCode: 400`), not a reason to invent EUR. A wrong currency is a money
 * defect that no channel error reports — Amazon accepts a number.
 */
import prisma from '../../db.js'

export interface MarketCurrencyRow {
  channel: string
  code: string
  currency: string | null
}

/** UK and GB are the same market; the table stores UK. */
const marketCode = (code: string) => (code ?? '').toUpperCase() === 'GB' ? 'UK' : (code ?? '').toUpperCase()

/** `EBAY_IT` → `IT`. A channel-prefixed marketplace id names the same market. */
const bareCode = (channel: string, code: string) => {
  const c = (channel ?? '').toUpperCase()
  const m = (code ?? '').toUpperCase()
  return marketCode(m.startsWith(`${c}_`) ? m.slice(c.length + 1) : m)
}

export function marketCurrency(channel: string, code: string, rows: readonly MarketCurrencyRow[]): string
export function marketCurrency(channel: string, code: string): Promise<string>
export function marketCurrency(channel: string, code: string, rows?: readonly MarketCurrencyRow[]): string | Promise<string> {
  const coordinate = { channel: (channel ?? '').toUpperCase(), code: bareCode(channel, code) }
  const read = (row: Pick<MarketCurrencyRow, 'currency'> | null | undefined) => {
    const value = (row?.currency ?? '').trim().toUpperCase()
    // A blank is the same as no row: we do not know, so we do not send a price.
    if (!/^[A-Z]{3}$/.test(value)) {
      throw Object.assign(
        new Error(`No currency is configured for ${coordinate.channel}/${coordinate.code}. Set it on the marketplace before pricing there.`),
        { statusCode: 400, code: 'market_currency_unconfigured' },
      )
    }
    return value
  }
  if (rows) return read(rows.find(row => (row.channel ?? '').toUpperCase() === coordinate.channel && marketCode(row.code) === coordinate.code))
  return prisma.marketplace.findFirst({ where: coordinate, select: { currency: true } }).then(read)
}

/** Every configured market currency for a channel, for batch callers that price
 *  many markets in one pass (the flat file, the syndication grid). */
export async function marketCurrencyRows(channel: string): Promise<MarketCurrencyRow[]> {
  return prisma.marketplace.findMany({
    where: { channel: (channel ?? '').toUpperCase() },
    select: { channel: true, code: true, currency: true },
  })
}

/**
 * P4.4a — for callers that know a MARKET but not a channel.
 *
 * The propagation preview's entries carry only `marketplace`, and the automation
 * rule context compares currencies across a product's listings. Every channel
 * that configures this market must AGREE; two channels disagreeing is refused
 * rather than resolved by picking one, because picking one is how a guess gets
 * written down as a fact.
 */
export function marketCurrencyAcrossChannels(code: string, rows: readonly MarketCurrencyRow[]): string {
  const wanted = marketCode(code)
  const found = [...new Set(
    rows.filter(row => marketCode(row.code) === wanted)
      .map(row => (row.currency ?? '').trim().toUpperCase())
      .filter(value => /^[A-Z]{3}$/.test(value)),
  )]
  if (found.length === 1) return found[0]
  throw Object.assign(
    new Error(found.length === 0
      ? `No currency is configured for the ${wanted} market. Set it on the marketplace before pricing there.`
      : `The ${wanted} market is configured with more than one currency (${found.join(', ')}). Make them agree before pricing there.`),
    { statusCode: 400, code: 'market_currency_unconfigured' },
  )
}

/** Every configured market currency, for a caller that spans channels. */
export async function allMarketCurrencyRows(): Promise<MarketCurrencyRow[]> {
  return prisma.marketplace.findMany({ select: { channel: true, code: true, currency: true } })
}
