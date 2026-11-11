import type { Issue } from '../../core/errors'
import { MARKET_CODE, MARKET_CODE_MAX } from '../../compliance/markets/rules'

/**
 * The markets a style is sold in (B-W2b-283, follow-up FU1:01 of B-W2b-254 and -266; factory-db Style.marketCodes, schema
 * wave 34/44 of B-W2b-275), pure. A style names the market profiles (Compliance › Rules & markets) it is sold in, by code,
 * each once, at most 60; none named means every market, as before.
 *
 *   on the style's Overview   "Markets": a pick of the market profiles of the style's company and of every company (a
 *                             tenant-wide style: every market of the tenant); an archived market is never added, one that
 *                             is named already stays named (as the database: a code is checked when it is added)
 *   at the requirements gate  a market the style names: the rules of every market that read its languages (DoC, user
 *                             information, label) apply to goods going there (`sellsThere`); a market it does not name, or
 *                             no market named at all: those rules keep waiting, as B-W2b-254 decided (empty keeps today's
 *                             answer at every gate). A requirement for that one market applies wherever the goods go, as
 *                             before. Nothing here refuses goods going to a market the style is not sold in.
 *   on the status board       (B-W2b-288) a market the list leaves out is "Not sold there", not a gap
 *
 * No money, no person.
 */

export const STYLE_MARKETS_MAX = 60

/** Where a style stands in one market. */
export const MARKET_STANDINGS = ['EVERY_MARKET', 'SOLD_THERE', 'NOT_SOLD_THERE'] as const
export type MarketStanding = (typeof MARKET_STANDINGS)[number]

/**
 * EVERY_MARKET: the style names no market (sold everywhere, as before); SOLD_THERE: the market is one it names;
 * NOT_SOLD_THERE: it names others ("Not sold there").
 */
export function marketStanding(marketCodes: readonly string[], marketCode: string | null): MarketStanding {
  if (marketCodes.length === 0) return 'EVERY_MARKET'
  return marketCode !== null && marketCodes.includes(marketCode) ? 'SOLD_THERE' : 'NOT_SOLD_THERE'
}

/** The gate's `sellsThere`: the style names this market (an empty list keeps today's answer: the language rules wait). */
export const sellsThere = (marketCodes: readonly string[], marketCode: string | null): boolean => marketStanding(marketCodes, marketCode) === 'SOLD_THERE'

/** A market profile as the pick offers it. */
export interface MarketChoice {
  readonly code: string
  readonly name: string
  /** null: every company's market. */
  readonly companyId: string | null
  readonly status: 'ACTIVE' | 'ARCHIVED'
  readonly switchedOn: boolean
}

/** A market of the style's company or of every company (a tenant-wide style may name every market of the tenant). */
export const fitsStyle = (market: Pick<MarketChoice, 'companyId'>, styleCompanyId: string | null): boolean =>
  styleCompanyId === null || market.companyId === null || market.companyId === styleCompanyId

/** A code as it is stored: trimmed, its country part in capitals ("de" → "DE"); what follows a dash stays as typed. */
export function normaliseCode(code: string): string {
  const trimmed = code.trim()
  const dash = trimmed.indexOf('-')
  return dash < 0 ? trimmed.toUpperCase() : `${trimmed.slice(0, dash).toUpperCase()}${trimmed.slice(dash)}`
}

/** The list in the order the markets are offered (their column order), the ones no longer offered after them by code. */
export function orderedCodes(codes: readonly string[], markets: readonly Pick<MarketChoice, 'code'>[]): string[] {
  const order = new Map(markets.map((market, index) => [market.code, index]))
  return [...codes].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b, 'en'))
}

/** What a change adds and removes. */
export function marketChanges(before: readonly string[], after: readonly string[]): { readonly added: string[]; readonly removed: string[] } {
  return { added: after.filter((code) => !before.includes(code)), removed: before.filter((code) => !after.includes(code)) }
}

/**
 * Every rule of the database's Style_w2b5_market_codes in words, and the pick's own (paths `marketCodes` and
 * `marketCodes/<i>`): each code a market code, once, at most 60; a code ADDED is a market of the tenant that the style's
 * company may name, and not archived. A code the style named before stays, whatever its market's state.
 */
export function marketCodesProblems(input: {
  readonly codes: readonly string[]
  readonly before: readonly string[]
  readonly markets: ReadonlyMap<string, MarketChoice>
  readonly styleCompanyId: string | null
}): Issue[] {
  const issues: Issue[] = []
  if (input.codes.length > STYLE_MARKETS_MAX) issues.push({ path: 'marketCodes', message: `A style names at most ${STYLE_MARKETS_MAX} markets (none: every market).` })
  const seen = new Set<string>()
  input.codes.forEach((code, index) => {
    const at = `marketCodes/${index}`
    if (code.length > MARKET_CODE_MAX || !MARKET_CODE.test(code)) {
      issues.push({ path: at, message: `"${code}" is not a market code ("DE", "UK", "US-CA").` })
      return
    }
    if (seen.has(code)) issues.push({ path: at, message: `Market ${code} is named twice: name each market once.` })
    seen.add(code)
    if (input.before.includes(code)) return
    const market = input.markets.get(code)
    if (!market) issues.push({ path: at, message: `There is no market ${code} in Compliance › Rules & markets: add it there first.` })
    else if (!fitsStyle(market, input.styleCompanyId)) issues.push({ path: at, message: `Market ${code} is another company's market: this style's company does not sell there.` })
    else if (market.status !== 'ACTIVE') issues.push({ path: at, message: `Market ${code} is archived: restore it in Compliance › Rules & markets to add it.` })
  })
  return issues
}

/** "Every market (none picked)", "Sold in DE, FR", for an audit line or a notice. */
export function marketsWords(codes: readonly string[]): string {
  return codes.length === 0 ? 'every market (none picked)' : `sold in ${codes.join(', ')}`
}
