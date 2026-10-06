/**
 * Ads wave 4c (F3) — the ONE list of Amazon Ads markets, from the connections.
 *
 * About forty files carried their own `['IT', 'DE', 'ES', 'FR']`: a market the Owner switched on stayed invisible on the
 * Rules & Automation pages, the bid, budget, negative and placement grids, the reporting views and two builders. Every
 * one of them now asks this file.
 *
 * The Owner's rule (decided 2026-10-06): Nexus READS the ads data of every Amazon Ads account he switches on ("Read
 * this market's data" = `AmazonAdsConnection.isActive`, ads-read-switch.service.ts), and SPENDS only where the write
 * gate would let a write through:
 *
 *   read   the market has an Amazon Ads account Nexus reads (`isActive`).
 *   write  read, AND the write gate's own resolver (`adsProfileFor`, ads-profile-resolver.ts) says the market's profile
 *          is `production` with writes enabled, AND Amazon's bid and budget limits for the market are known
 *          (`@nexus/shared/ads-market-limits`). The same three checks the gate makes before any write, so a screen
 *          never offers a write the gate refuses for the market as a whole.
 *
 * With today's accounts: IT, DE, FR and ES are read and written; UK, NL, PL, SE and BE are read only (sandbox).
 *
 * Every row belongs to the business of the request: `AmazonAdsConnection` and `ConnectionScope` are workspace-scoped
 * (row-level security), so a list never names another business's market.
 */
import prisma from '../../db.js'
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'
import { normalizeMarketplaceCode } from '../../utils/marketplace-code.js'
import { adsAccountStateOf, type AdsAccountState } from './ads-read-switch.service.js'

/** The words a screen shows beside a write control on a market Nexus only reads. */
export const READING_ONLY_REASON = 'Reading only — writes are off for this market'

export interface AdsMarketRow {
  profileId: string
  marketplace: string
  isActive: boolean
  mode: string
  writesEnabledAt: Date | string | null
}

/** The operator's decision for a market's profile, as the write gate sees it. Null when no profile serves it. */
export interface AdsMarketDecision {
  mode: string
  writesEnabledAt: Date | string | null
}

export interface AdsMarketAccess {
  /** Two-letter market code. */
  code: string
  /** Nexus reads this market's ads data. */
  read: boolean
  /** Nexus may change ads here (the gate's market checks pass). */
  write: boolean
  /** The account state the Settings screens show ("Live · writes on", "Reading only", "Not read"). */
  state: AdsAccountState
  mode: string
  writesEnabled: boolean
  /** Amazon's bid and budget limits for this market are in Nexus's checked table. */
  limitsKnown: boolean
  /** ISO 4217 code Amazon bills this account in; null when nothing knows. */
  currency: string | null
  /** Why Nexus does not change ads here, in a sentence; null when it does. */
  whyNoWrite: string | null
}

export interface AdsMarketLists {
  /** Markets whose data Nexus reads, in `compareAdsMarkets` order (IT, DE, ES, FR first, then reading-only). */
  read: string[]
  /** Markets where Nexus may change ads. Always a subset of `read`. */
  write: string[]
  markets: AdsMarketAccess[]
}

/**
 * The order every list and picker shows, so the Owner sees what he always saw: the markets Nexus writes in first, in
 * the order the ads console has always listed the live four (IT, DE, ES, FR; another writable market after them,
 * alphabetically), then the reading-only markets alphabetically, then markets Nexus does not read.
 */
export const LIVE_MARKET_ORDER: readonly string[] = ['IT', 'DE', 'ES', 'FR']

export function compareAdsMarkets(a: { code: string; read: boolean; write: boolean }, b: { code: string; read: boolean; write: boolean }): number {
  if (a.write !== b.write) return a.write ? -1 : 1
  if (a.read !== b.read) return a.read ? -1 : 1
  if (a.write) {
    const ia = LIVE_MARKET_ORDER.indexOf(a.code)
    const ib = LIVE_MARKET_ORDER.indexOf(b.code)
    if (ia !== ib) return (ia === -1 ? LIVE_MARKET_ORDER.length : ia) - (ib === -1 ? LIVE_MARKET_ORDER.length : ib)
  }
  return a.code.localeCompare(b.code)
}

/** A stored marketplace (a code, `AMAZON_IT` or an Amazon marketplace id) as its two-letter code. */
export function adsMarketCode(raw: string | null | undefined): string {
  const v = (raw ?? '').trim()
  if (!v) return ''
  return normalizeMarketplaceCode(v, '') || v.toUpperCase()
}

function whyNoWriteOf(code: string, read: boolean, decision: AdsMarketDecision | null, limitsKnown: boolean): string | null {
  if (!read) return `Nexus does not read the ${code} Amazon Ads account, so it changes nothing there. Switch on "Read this market's data" in Settings → Advertising first.`
  if (!decision) return `No Amazon Ads profile serves ${code}, so Nexus changes nothing there.`
  if (decision.mode !== 'production') return `${READING_ONLY_REASON}: the ${code} account is in ${decision.mode || 'sandbox'} mode.`
  if (decision.writesEnabledAt == null) return `${READING_ONLY_REASON}: writes are not enabled for the ${code} account (Settings → Advertising).`
  if (!limitsKnown) return `${READING_ONLY_REASON}: Amazon's bid and budget limits for ${code} are not known yet.`
  return null
}

/**
 * Pure: the connection rows, the gate's decision per market and the currency per market → the two lists.
 * A market appears once, however many rows name it (a code on one row, an Amazon id on another).
 */
export function adsMarketListsOf(
  rows: readonly AdsMarketRow[],
  decisions: ReadonlyMap<string, AdsMarketDecision | null>,
  currencies: ReadonlyMap<string, string | null> = new Map(),
): AdsMarketLists {
  const byCode = new Map<string, AdsMarketRow[]>()
  for (const r of rows) {
    const code = adsMarketCode(r.marketplace)
    if (!code) continue
    byCode.set(code, [...(byCode.get(code) ?? []), r])
  }
  const markets: AdsMarketAccess[] = [...byCode.entries()].map(([code, own]) => {
    const read = own.some((r) => r.isActive)
    const decision = decisions.get(code) ?? null
    const limitsKnown = marketLimitsOf(code) != null
    const whyNoWrite = whyNoWriteOf(code, read, decision, limitsKnown)
    const write = whyNoWrite == null
    const mode = decision?.mode ?? own[0]?.mode ?? 'sandbox'
    const writesEnabled = (decision?.writesEnabledAt ?? null) != null
    return {
      code,
      read,
      write,
      state: adsAccountStateOf({ isActive: read, mode, writesEnabledAt: decision?.writesEnabledAt ?? null }),
      mode,
      writesEnabled,
      limitsKnown,
      currency: currencies.get(code) ?? null,
      whyNoWrite,
    }
  })
  markets.sort(compareAdsMarkets)
  return {
    read: markets.filter((m) => m.read).map((m) => m.code),
    write: markets.filter((m) => m.write).map((m) => m.code),
    markets,
  }
}

async function connectionRows(): Promise<AdsMarketRow[]> {
  return prisma.amazonAdsConnection.findMany({
    select: { profileId: true, marketplace: true, isActive: true, mode: true, writesEnabledAt: true },
    orderBy: { profileId: 'asc' },
  })
}

/**
 * The operator's decision per market, as the write gate's resolver answers it. If the resolver cannot answer at all,
 * each market's own active row says it (the resolver's legacy fallback), so a list never disappears because of it.
 */
async function decisionsFor(codes: string[], rows: readonly AdsMarketRow[]): Promise<{ decisions: Map<string, AdsMarketDecision | null>; profiles: Map<string, string | null> }> {
  const decisions = new Map<string, AdsMarketDecision | null>()
  const profiles = new Map<string, string | null>()
  try {
    const { adsProfilesForMarkets } = await import('./ads-profile-resolver.js')
    const refs = await adsProfilesForMarkets(codes)
    for (const code of codes) {
      const ref = refs.get(code) ?? null
      decisions.set(code, ref ? { mode: ref.mode, writesEnabledAt: ref.writesEnabledAt } : null)
      profiles.set(code, ref?.profileId ?? null)
    }
  } catch {
    for (const code of codes) {
      const row = rows.find((r) => r.isActive && adsMarketCode(r.marketplace) === code) ?? null
      decisions.set(code, row ? { mode: row.mode, writesEnabledAt: row.writesEnabledAt } : null)
      profiles.set(code, row?.profileId ?? null)
    }
  }
  return { decisions, profiles }
}

/**
 * The full answer, with the write gate's decision per market and (unless `currency: false`) the currency. For
 * GET /advertising/connections. Not cached: switching a market on or off takes effect on the next request.
 */
export async function adsMarketLists(opts: { currency?: boolean } = {}): Promise<AdsMarketLists> {
  const rows = await connectionRows()
  const codes = [...new Set(rows.map((r) => adsMarketCode(r.marketplace)).filter(Boolean))]
  const { decisions, profiles } = await decisionsFor(codes, rows)
  const currencies = new Map<string, string | null>()
  if (opts.currency !== false) {
    const { adsProfileCurrency } = await import('./ads-profile-facts.service.js')
    for (const code of codes) {
      const profileId = profiles.get(code) ?? rows.find((r) => adsMarketCode(r.marketplace) === code)?.profileId
      const found = profileId ? await adsProfileCurrency(profileId, code).catch(() => null) : null
      currencies.set(code, found?.currencyCode ?? null)
    }
  }
  return adsMarketListsOf(rows, decisions, currencies)
}

/**
 * The markets whose ads data Nexus reads, in the screens' order (IT, DE, ES, FR first, then reading-only markets):
 * what every read route validates `?market=` against and what "all markets" means.
 */
export async function adsReadMarkets(): Promise<string[]> {
  return (await adsMarketLists({ currency: false })).read
}

/**
 * The 400 answer for a `?market=` this page cannot serve; null when it can. `allowAll` says whether "all" is a scope
 * here (a page summing a per-market share refuses it). A comma list is the caller's to split.
 */
export function marketParamRefusal(market: string, read: readonly string[], opts: { allowAll: boolean }): string | null {
  if (opts.allowAll && market === 'all') return null
  if (read.includes(market)) return null
  const list = read.length ? read.join('/') : 'no market (no Amazon Ads account is read)'
  return opts.allowAll ? `market must be one of ${list} or "all"` : `market is required and must be one of ${list}`
}
