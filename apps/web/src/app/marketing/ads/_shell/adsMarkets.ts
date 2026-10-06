/**
 * Ads wave 4c (F3) — the ads console's ONE list of Amazon Ads markets, as pure functions.
 *
 * About thirty screens carried their own `['IT', 'DE', 'ES', 'FR']`, so a market the Owner switched on stayed invisible
 * on Rules & Automation, the grids, Reporting and two builders. They now read the list the API derives from the
 * connections (`GET /advertising/connections` → `markets`, apps/api ads-markets.service.ts), through
 * `AdsMarketplaceProvider`:
 *
 *   read   Nexus reads this market's ads data (the Owner's "Read this market's data" switch).
 *   write  Nexus may change ads here: read, production, writes enabled, and Amazon's limits known — the write gate's
 *          own checks. A read-only market shows its data; its write controls are off and say why.
 *
 * Pure and React-free, so every rule is a vitest case (`adsMarkets.vitest.test.ts`).
 */
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'

/** Flags and names for every Amazon marketplace code an Ads account can have. Facts about Amazon, not a market list. */
export const FLAG: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱',
  SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪', TR: '🇹🇷', US: '🇺🇸',
  CA: '🇨🇦', MX: '🇲🇽', JP: '🇯🇵', AU: '🇦🇺',
}
export const MARKET_NAME: Record<string, string> = {
  IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom',
  NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland', TR: 'Türkiye', US: 'United States',
  CA: 'Canada', MX: 'Mexico', JP: 'Japan', AU: 'Australia',
}

/** A code Amazon uses for a marketplace. Used to judge a `?market=` before the connection list has loaded. */
export const isAmazonMarketCode = (code: string | null | undefined): boolean => !!code && Object.prototype.hasOwnProperty.call(MARKET_NAME, code)

/** The analytics sentinel. */
export const ALL_MARKETS = 'all'

/** What a screen shows beside a write control on a market Nexus only reads. */
export const READING_ONLY = 'Reading only — writes are off for this market'

/** The part of a reading-only reason after the shared title, capitalised ("The UK account is in sandbox mode."). */
export function readingOnlyDetail(reason: string | null | undefined): string {
  const r = (reason ?? '').startsWith(`${READING_ONLY}: `) ? (reason ?? '').slice(READING_ONLY.length + 2) : (reason ?? '')
  return r ? r[0].toUpperCase() + r.slice(1) : ''
}

/** Only used to break a tie when nothing is chosen — never to fabricate a market. */
export const PREFERRED_MARKET = 'IT'

export interface AdsMarket {
  code: string
  label: string
  /**
   * CC-19 — a campaign launched here can reach Amazon: the write gate's market checks (read, production, writes on,
   * Amazon's limits known). The API's `write`.
   */
  launchable: boolean
  mode: string
  writesEnabled: boolean
  /** Why this market is not launchable / writable, in a sentence (absent when it is). */
  whyNot?: string | null
  /** The same in two or three words, for a menu row. */
  whyNotShort?: string | null
  /** Nexus reads this market's ads data (the Owner's read switch). An analytics scope may show it. */
  readable?: boolean
  /** ISO 4217 code Amazon bills this account in; null when unknown. */
  currency?: string | null
  /** A short note beside a SELECTABLE row (an analytics filter): "reading only" for a market Nexus does not change. */
  note?: string | null
}

/** One market of `GET /advertising/connections` → `markets.markets` (apps/api ads-markets.service.ts). */
export interface WireMarket {
  code: string
  read: boolean
  write: boolean
  mode: string
  writesEnabled: boolean
  limitsKnown: boolean
  currency: string | null
  whyNoWrite: string | null
}

export interface WireConnection {
  marketplace?: string
  accountLabel?: string | null
  mode?: string
  isActive?: boolean
  writesEnabledAt?: string | null
}

function shortWhy(m: WireMarket): string | null {
  if (m.write) return null
  if (!m.read) return 'not read'
  if (m.mode !== 'production') return 'reading only'
  if (!m.writesEnabled) return 'reading only · writes off'
  if (!m.limitsKnown) return 'reading only · limits not known'
  return 'reading only'
}

/**
 * The console's market list from the API answer, in the order the API gives (`compareMarkets`). `fallback` builds the list from the rows alone for an API without `markets`.
 */
/** The order the live markets have always had in the ads console. */
export const LIVE_MARKET_ORDER: readonly string[] = ['IT', 'DE', 'ES', 'FR']

/**
 * The Owner's order, the API's too (`compareAdsMarkets`): writable markets first — IT, DE, ES, FR, then any other
 * writable market alphabetically — then reading-only markets alphabetically, then the rest.
 */
export function compareMarkets(a: Pick<AdsMarket, 'code' | 'launchable' | 'readable'>, b: Pick<AdsMarket, 'code' | 'launchable' | 'readable'>): number {
  if (a.launchable !== b.launchable) return a.launchable ? -1 : 1
  if (!!a.readable !== !!b.readable) return a.readable ? -1 : 1
  if (a.launchable) {
    const n = LIVE_MARKET_ORDER.length
    const ia = LIVE_MARKET_ORDER.indexOf(a.code)
    const ib = LIVE_MARKET_ORDER.indexOf(b.code)
    if (ia !== ib) return (ia === -1 ? n : ia) - (ib === -1 ? n : ib)
  }
  return a.code.localeCompare(b.code)
}

/**
 * A page's market codes (the read list plus any market its rows name) in the Owner's order. A code the connections do
 * not know goes last, alphabetically.
 */
export function orderMarketCodes(codes: Iterable<string>, markets: readonly AdsMarket[]): string[] {
  const facts = (code: string) => {
    const m = markets.find((x) => x.code === code)
    return { code, launchable: !!m?.launchable, readable: m ? !!m.readable : false }
  }
  return [...new Set(codes)].filter(Boolean).map(facts).sort(compareMarkets).map((m) => m.code)
}

export function marketsFromWire(
  wire: { markets?: WireMarket[] } | null | undefined,
  items: readonly WireConnection[],
  fallback: (c: WireConnection & { code: string }) => AdsMarket,
): AdsMarket[] {
  const labelOf = (code: string) => items.find((c) => String(c.marketplace ?? '').toUpperCase() === code)?.accountLabel ?? ''
  if (wire?.markets) {
    return wire.markets.map((m) => ({
      code: m.code,
      label: labelOf(m.code),
      mode: m.mode,
      writesEnabled: m.writesEnabled,
      launchable: m.write,
      whyNot: m.whyNoWrite,
      whyNotShort: shortWhy(m),
      readable: m.read,
      currency: m.currency,
    }))
  }
  return items
    .filter((c) => c.marketplace)
    .map((c) => fallback({ ...c, code: String(c.marketplace).toUpperCase() }))
    .sort(compareMarkets)
}

export const readMarketsOf = (markets: readonly AdsMarket[]): string[] => markets.filter((m) => m.readable).map((m) => m.code)
export const writeMarketsOf = (markets: readonly AdsMarket[]): string[] => markets.filter((m) => m.launchable).map((m) => m.code)

/** The market a one-market page shows when nothing else says: the preferred one if it is read, else the first read. */
export function preferredMarket(read: readonly string[]): string {
  if (read.length === 0 || read.includes(PREFERRED_MARKET)) return PREFERRED_MARKET
  return read[0]
}

/** Is this a market the page may show? Before the list loads (empty), any Amazon marketplace code is taken on trust. */
export function isReadMarket(code: string, read: readonly string[]): boolean {
  return read.length === 0 ? isAmazonMarketCode(code) : read.includes(code)
}

/**
 * AM-28 — the market a page shows.
 *
 * `raw` is the page's `?market=` (null when absent). The URL wins, so a colleague's link opens on what it says. An
 * absent param means the viewer's SHARED choice (the provider's `scopeMarket`, remembered per viewer), so a market
 * picked on one ads page is the market on the next. A page that cannot serve "all markets" (`allowAll: false`) shows
 * one market instead: the shared one if it is a market, else the preferred read market.
 */
export function pageMarket(raw: string | null | undefined, o: { read: readonly string[]; shared: string; allowAll: boolean }): string {
  const one = () => (o.shared !== ALL_MARKETS && isReadMarket(o.shared, o.read) ? o.shared : preferredMarket(o.read))
  const pick = (v: string) => {
    if (v === ALL_MARKETS) return o.allowAll ? ALL_MARKETS : one()
    if (isReadMarket(v, o.read)) return v
    return o.allowAll ? ALL_MARKETS : one()
  }
  if (raw != null && raw !== '') return pick(raw)
  return pick(o.shared || ALL_MARKETS)
}

/** Can Nexus change ads in this market? `reason` says why not, in a sentence. Unknown list → no claim either way. */
export function writeAccessOf(markets: readonly AdsMarket[], code: string | null | undefined): { canWrite: boolean; reason: string | null } {
  if (!code || code === ALL_MARKETS) return { canWrite: true, reason: null }
  const m = markets.find((x) => x.code === code)
  if (!m) return markets.length === 0 ? { canWrite: true, reason: null } : { canWrite: false, reason: `Nexus has no Amazon Ads account for ${code}, so it changes nothing there.` }
  if (m.launchable) return { canWrite: true, reason: null }
  return { canWrite: false, reason: m.whyNot ?? READING_ONLY }
}

/**
 * The reason a write touching these markets cannot be sent (the first market that cannot be written), or null when
 * every one can — or when the list has not loaded (the server's write gate still refuses with its own reason).
 */
export function writeBlockFor(markets: readonly AdsMarket[], codes: Iterable<string | null | undefined>): string | null {
  for (const code of codes) {
    const a = writeAccessOf(markets, code)
    if (!a.canWrite) return a.reason
  }
  return null
}

/**
 * The currency of a market's account (#363 stores it per account), else the currency in Amazon's checked limits table
 * for that market (`@nexus/shared/ads-market-limits`: IT, DE, FR, ES = EUR) — so the euro markets read in euros even
 * before the list has loaded. Null when nothing knows: a screen then shows the amount without a symbol.
 */
export function currencyOf(markets: readonly AdsMarket[], code: string | null | undefined): string | null {
  if (!code) return null
  return markets.find((m) => m.code === code)?.currency ?? marketLimitsOf(code)?.currency ?? null
}

/**
 * CM-32 — a money amount in the market's own currency. Unknown currency: the number alone, never a made-up euro sign.
 */
export function formatMoney(amount: number | null | undefined, currency: string | null | undefined, digits = 2): string {
  if (amount == null || !Number.isFinite(amount)) return '—'
  if (!currency) return amount.toFixed(digits)
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)
  } catch {
    return `${amount.toFixed(digits)} ${currency}`
  }
}

/** The symbol alone ("€", "£"), for an input prefix; '' when unknown. */
export function currencySymbol(currency: string | null | undefined): string {
  if (!currency) return ''
  try {
    const part = new Intl.NumberFormat('en-IE', { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')
    return part?.value ?? currency
  } catch {
    return currency
  }
}
