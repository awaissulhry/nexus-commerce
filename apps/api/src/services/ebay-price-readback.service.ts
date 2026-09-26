/**
 * P4.4 (CX) — eBay price confirmation: the one channel P4.4e left without a price read-back.
 *
 * Two arms, both REPORT-ONLY:
 *   B1 — after an Inventory-lane price write (`syncToEbay` step 7b) the offer is read back once through
 *        the same account and its price compared, to the cent and in its currency, with what we sent —
 *        after the queue row has its answer, outside its dispatch budget;
 *   B2 — the Trading sweep's GetItem (already made every 30 min for quantity) now also carries StartPrice,
 *        compared with `SharedListingMembership.price` — the operative Trading price — or, when a membership
 *        has none, with the product's eBay listing price it falls back to.
 *
 * 🔴 Neither arm heals. A price correction is a money write made by a machine; the Owner has not ruled
 * on it (`priceHealEnabled()`), so a mismatch becomes a `CHANNEL_PRICE_READBACK` conflict ("price
 * unconfirmed") and nothing is re-sent, re-queued or retried.
 */
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { priceDrift, priceDriftMessage, type PriceDrift } from './price-readback.service.js'
import { marketCurrency, marketCurrencyRows, type MarketCurrencyRow } from './pim/market-currency.js'
import type { ItemQuantityReadback } from './ebay-trading-api.service.js'
import { ebayTransport } from './gateway/ebay.js'

/** Money compares to the cent. A float comparison does not (0.1 + 0.2 !== 0.3). */
const cents = (value: number): number => Math.round(value * 100)

/** A price as a number, or null when it is absent or not a plain decimal. Never 0 for "absent". */
export function moneyValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  return /^\d+(\.\d+)?$/.test(text) ? Number(text) : null
}

const currencyCode = (raw: unknown): string | null => {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  return /^[A-Z]{3}$/.test(value) ? value : null
}

/** A market code or eBay id ('DE', 'UK', 'EBAY_IT', 'EBAY_GB') as eBay's marketplace id, or null. */
export function ebayMarketplaceIdOf(value: string | null | undefined): string | null {
  const upper = (value ?? '').trim().toUpperCase()
  if (!upper) return null
  const code = upper.startsWith('EBAY_') ? upper.slice(5) : upper
  if (!/^[A-Z]{2}$/.test(code)) return null
  return code === 'UK' || code === 'GB' ? 'EBAY_GB' : `EBAY_${code}`
}

// ── B1: the offer to price, and the verdict on what eBay holds after the write ──────────────────────

export type EbayPriceOfferPick =
  | { offer: Record<string, any>; reason?: undefined; status?: undefined }
  | { offer: null; reason: string; status: 404 | 409 }

/**
 * The ONE fixed-price offer of this SKU on this marketplace, or a refusal before the price write.
 *
 * `getOffers` returns an auction and a fixed-price offer side by side when both exist, and eBay's own
 * docs say its `marketplace_id` filter has "no practical use" — so the query's filter is not trusted:
 * each returned offer must itself name this marketplace and FIXED_PRICE. Zero → refused (publish
 * first); more than one → refused, never "the first" (the old `offers[0]`).
 */
/** Every FIXED_PRICE offer of this marketplace in a getOffers answer (the auction offer that may sit beside it is not). */
function fixedPriceOffers(offers: unknown, marketplaceId: string): Array<Record<string, any>> {
  return (Array.isArray(offers) ? offers : []).filter((o): o is Record<string, any> => !!o && typeof o === 'object'
    && typeof o.offerId === 'string' && o.offerId !== ''
    && String(o.marketplaceId ?? '').toUpperCase() === marketplaceId.toUpperCase()
    && String(o.format ?? '').toUpperCase() === 'FIXED_PRICE')
}

/**
 * CX (review 2026-09-26) — the ONE fixed-price offer of this marketplace, or null (none, or several). For the
 * offer lookups that carry quantity (bulk update, 25004 heal, variation offer writers): they took `offers[0]`,
 * which is the auction offer whenever eBay lists it first.
 */
export function ebayFixedPriceOfferOf(offers: unknown, marketplaceId: string): Record<string, any> | null {
  const matches = fixedPriceOffers(offers, marketplaceId)
  return matches.length === 1 ? matches[0] : null
}

export function pickEbayPriceOffer(offers: unknown, marketplaceId: string, sku: string): EbayPriceOfferPick {
  const list = (Array.isArray(offers) ? offers : []).filter((o): o is Record<string, any> => !!o && typeof o === 'object')
  const matches = fixedPriceOffers(list, marketplaceId)
  if (matches.length === 1) return { offer: matches[0] }
  if (matches.length === 0) {
    const seen = list.map((o) => `${o.marketplaceId ?? '?'}/${o.format ?? '?'}`).join(', ')
    return {
      offer: null,
      status: 404,
      reason: `No fixed-price eBay offer for SKU "${sku}" on ${marketplaceId}${seen ? ` (eBay returned: ${seen})` : ''} — publish the listing on this marketplace before syncing price. The price was not written.`,
    }
  }
  return {
    offer: null,
    status: 409,
    reason: `${matches.length} fixed-price eBay offers for SKU "${sku}" on ${marketplaceId} (${matches.map((o) => o.offerId).join(', ')}) — refusing to guess which one to price. The price was not written.`,
  }
}

export type EbayOfferPriceReadback =
  | { outcome: 'CONFIRMED'; channelPrice: number; channelCurrency: string }
  | { outcome: 'PRICE_MISMATCH'; channelPrice: number; channelCurrency: string; drift: PriceDrift }
  | { outcome: 'CURRENCY_MISMATCH'; channelPrice: number | null; channelCurrency: string }
  /** eBay still shows the offer's PRE-write price: the write is not visible yet (Inventory lag), not drift. */
  | { outcome: 'STALE_READ'; channelPrice: number; channelCurrency: string }
  | { outcome: 'UNREADABLE'; reason: string }
  | { outcome: 'READ_FAILED'; reason: string }

/** An offer's own `pricingSummary.price`, as numbers — the PRE-write price when read from the picked offer. */
export function offerPriceOf(offer: unknown): { price: number | null; currency: string | null } {
  const price = (offer as { pricingSummary?: { price?: { value?: unknown; currency?: unknown } } } | null)?.pricingSummary?.price
  return { price: moneyValue(price?.value), currency: currencyCode(price?.currency) }
}

/**
 * Pure verdict on `GET /offer/{offerId}` after the price PUT: integer cents AND currency.
 * A missing or unreadable price is UNREADABLE — never "eBay says 0". A read equal to the offer's
 * PRE-write price (`previous`) and not to what was sent is STALE_READ: eBay's Inventory Service is
 * eventually consistent (ebay-variation-push.service.ts documents the lag), so it is "not yet visible".
 */
export function ebayOfferPriceReadback(
  expected: { price: number; currency: string },
  offer: unknown,
  previous?: { price: number | null; currency: string | null },
): Exclude<EbayOfferPriceReadback, { outcome: 'READ_FAILED' }> {
  return priceReadbackVerdict(expected, offerPriceOf(offer), previous)
}

/** The same verdict over a price already read (an offer's, or a GetItem variation's StartPrice). */
export function priceReadbackVerdict(
  expected: { price: number; currency: string },
  observed: { price: number | null; currency: string | null },
  previous?: { price: number | null; currency: string | null },
): Exclude<EbayOfferPriceReadback, { outcome: 'READ_FAILED' }> {
  const { price: channelPrice, currency: channelCurrency } = observed
  if (channelCurrency === null) return { outcome: 'UNREADABLE', reason: 'the offer carries no readable price currency' }
  const sameCurrency = channelCurrency === expected.currency.toUpperCase()
  if (channelPrice === null) {
    return sameCurrency ? { outcome: 'UNREADABLE', reason: 'the offer carries no readable price' } : { outcome: 'CURRENCY_MISMATCH', channelPrice, channelCurrency }
  }
  if (sameCurrency && cents(channelPrice) === cents(expected.price)) return { outcome: 'CONFIRMED', channelPrice, channelCurrency }
  // Another currency is a finding of its own, even when it is the offer's old one.
  if (!sameCurrency) return { outcome: 'CURRENCY_MISMATCH', channelPrice, channelCurrency }
  if (previous?.price != null && previous.currency === channelCurrency && cents(previous.price) === cents(channelPrice)) {
    return { outcome: 'STALE_READ', channelPrice, channelCurrency }
  }
  return {
    outcome: 'PRICE_MISMATCH', channelPrice, channelCurrency,
    drift: { channelPrice, intendedPrice: expected.price, difference: (cents(channelPrice) - cents(expected.price)) / 100 },
  }
}

/** The read-back deadline: eight seconds, or shorter through NEXUS_EBAY_PRICE_READBACK_TIMEOUT_MS (never under 50 ms). */
export function priceReadbackTimeoutMs(): number {
  return Math.min(8_000, Math.max(50, Number(process.env.NEXUS_EBAY_PRICE_READBACK_TIMEOUT_MS) || 8_000))
}

/**
 * ONE time-limited channel read, shared by every price read-back (B1's offer GET, the variation GetItem). `read` gets
 * the abort signal: at `ms` it fires and this rejects, so a hung request or a slow body never outlives the deadline.
 * No retry here — callers pass a transport with retries off.
 */
export async function boundedRead<T>(ms: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const reading = read(abort.signal)
  reading.catch(() => { /* settled after the deadline: nothing to do */ })
  try {
    return await Promise.race([reading, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error(`read timed out after ${ms} ms`)) }, ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * B1 — after an accepted price PUT, the offer is read back ONCE through the same account (a gateway read, no
 * retries, bounded) and anything but a confirmation is recorded. The caller runs this only AFTER its queue row
 * has its answer (`SyncResult.afterAnswer`), so the read never spends the row's dispatch budget.
 * 🔴 Report-only: nothing is re-sent or retried. Never throws.
 */
export async function confirmEbayOfferPrice(args: {
  connectionId: string
  offerUrl: string
  headers: Record<string, string>
  expected: { price: number; currency: string }
  /** The offer's price before the PUT — a read still showing it is STALE_READ, not drift. */
  previous: { price: number | null; currency: string | null }
  sku: string
  marketplaceId: string
  offerId: string
  productId: string | null
  queueId: string
}): Promise<EbayOfferPriceReadback> {
  const ms = priceReadbackTimeoutMs()
  let readback: EbayOfferPriceReadback
  try {
    const send = ebayTransport(args.connectionId, { maxTransientRetries: 0, max429Retries: 0, timeoutMs: ms })
    readback = await boundedRead(ms, async (signal): Promise<EbayOfferPriceReadback> => {
      const res = await send(args.offerUrl, { method: 'GET', headers: args.headers, signal })
      return res.ok
        ? ebayOfferPriceReadback(args.expected, await res.json().catch(() => null), args.previous)
        : { outcome: 'READ_FAILED', reason: `offer GET ${res.status}` }
    })
  } catch (err) {
    readback = { outcome: 'READ_FAILED', reason: err instanceof Error ? err.message : String(err) }
  }
  if (readback.outcome !== 'CONFIRMED') {
    const message = ebayPriceUnconfirmedMessage({ sku: args.sku, marketplaceId: args.marketplaceId, offerId: args.offerId, expected: args.expected, readback })
    await recordEbayPriceUnconfirmed({
      productId: args.productId,
      source: 'INVENTORY_GET_OFFER',
      marketplace: args.marketplaceId,
      ref: `offer:${args.offerId}`,
      outcome: readback.outcome,
      sku: args.sku,
      message,
      localData: { sentPrice: args.expected.price, currency: args.expected.currency },
      remoteData: {
        offerId: args.offerId, marketplace: args.marketplaceId, queueId: args.queueId,
        ...('channelPrice' in readback ? { ebayPrice: readback.channelPrice, ebayCurrency: readback.channelCurrency } : { reason: readback.reason }),
      },
    })
  }
  return readback
}

/** The operator's sentence for an unconfirmed write-time price. */
export function ebayPriceUnconfirmedMessage(args: {
  sku: string
  marketplaceId: string
  /** The offer read back (B1), or the listing whose GetItem was read (variations). */
  offerId?: string
  itemId?: string
  expected: { price: number; currency: string }
  readback: Exclude<EbayOfferPriceReadback, { outcome: 'CONFIRMED' }>
}): string {
  const where = `(${args.marketplaceId}, ${args.offerId !== undefined ? `offer ${args.offerId}` : `item ${args.itemId}`})`
  const sent = `${args.expected.currency} ${args.expected.price.toFixed(2)}`
  const r = args.readback
  const what = r.outcome === 'PRICE_MISMATCH'
    ? priceDriftMessage({ channel: 'eBay', sku: args.sku, drift: r.drift, currency: r.channelCurrency })
    : r.outcome === 'CURRENCY_MISMATCH'
      ? `eBay holds ${args.sku} in ${r.channelCurrency}${r.channelPrice === null ? '' : ` ${r.channelPrice.toFixed(2)}`} but the write sent ${sent}.`
      : r.outcome === 'STALE_READ'
        ? `eBay still shows the previous ${r.channelCurrency} ${r.channelPrice.toFixed(2)} for ${args.sku} right after the write of ${sent} — possibly not yet visible (eBay's Inventory lag), possibly not applied. No later check re-reads this offer: confirm it on eBay.`
        : `eBay's ${args.offerId !== undefined ? 'offer' : 'listing'} could not be read back for ${args.sku} after the write of ${sent}: ${r.reason}.`
  return `Price unconfirmed after the eBay price write ${where}: ${what} Not re-sent.`
}

// ── B2: the Trading sweep's StartPrice against SharedListingMembership.price ─────────────────────

export interface TradingObservedPrice { value: number | null; currency: string | null }

export interface TradingPriceEntry {
  sku: string
  itemId: string
  marketplace: string
  productId: string | null
  /** The price compared: SharedListingMembership.price, else the listing price it falls back to; null = neither. */
  price: number | null
  /** Where `price` came from (absent = the membership's own). */
  priceSource?: 'MEMBERSHIP' | 'LISTING'
  channelConnectionId: string | null
}

export interface TradingPriceFinding {
  kind: 'PRICE_MISMATCH' | 'CURRENCY_MISMATCH'
  sku: string
  itemId: string
  marketplace: string
  productId: string
  intendedPrice: number
  channelPrice: number | null
  channelCurrency: string | null
  expectedCurrency: string | null
  drift: PriceDrift | null
  priceSource: 'MEMBERSHIP' | 'LISTING'
}

export interface TradingPriceDiff {
  compared: number
  findings: TradingPriceFinding[]
  /** Memberships of another account than the token's, or with no product: not compared. */
  skipped: number
  /** Memberships with no price of their own AND no single listing price to fall back to: counted, never compared (not "0"). */
  nullPrice: number
  /** Compared against the listing price a price-less membership falls back to. */
  fallback: number
  /** Read, but eBay's answer carried no StartPrice for this SKU: not compared. */
  unread: number
}

/**
 * Pure: every membership the sweep read is compared with ITS OWN listing's StartPrice (obsKey), and
 * only when it belongs to the account whose token made the read — another account's membership is
 * counted as skipped, never compared.
 */
export function diffTradingPriceReadback(
  entries: readonly TradingPriceEntry[],
  observed: ReadonlyMap<string, TradingObservedPrice>,
  opts: { accountId: string; keyOf: (itemId: string, sku: string) => string; currencyOf: (marketplace: string) => string | null },
): TradingPriceDiff {
  const out: TradingPriceDiff = { compared: 0, findings: [], skipped: 0, nullPrice: 0, fallback: 0, unread: 0 }
  for (const e of entries) {
    if (e.channelConnectionId !== opts.accountId || !e.productId) { out.skipped++; continue }
    if (e.price === null || !Number.isFinite(e.price)) { out.nullPrice++; continue }
    const seen = observed.get(opts.keyOf(e.itemId, e.sku))
    if (!seen || seen.value === null) { out.unread++; continue }
    out.compared++
    const priceSource = e.priceSource ?? 'MEMBERSHIP'
    if (priceSource === 'LISTING') out.fallback++
    const expectedCurrency = opts.currencyOf(e.marketplace)
    const base = { sku: e.sku, itemId: e.itemId, marketplace: e.marketplace, productId: e.productId, intendedPrice: e.price, channelPrice: seen.value, channelCurrency: seen.currency, expectedCurrency, priceSource }
    // A price in another currency is not "higher" or "lower": it is its own finding.
    if (seen.currency && expectedCurrency && seen.currency !== expectedCurrency) {
      out.findings.push({ ...base, kind: 'CURRENCY_MISMATCH', drift: null })
      continue
    }
    const drift = priceDrift({ channelPrice: seen.value, intendedPrice: e.price })
    if (drift) out.findings.push({ ...base, kind: 'PRICE_MISMATCH', drift })
  }
  return out
}

export function tradingPriceFindingMessage(f: TradingPriceFinding): string {
  const where = `(item ${f.itemId}, ${f.marketplace})`
  const basis = f.priceSource === 'LISTING' ? ` (no per-listing price: compared with the product's eBay listing price on ${f.marketplace})` : ''
  if (f.kind === 'CURRENCY_MISMATCH') {
    return `Price unconfirmed on eBay ${where}: eBay prices ${f.sku} in ${f.channelCurrency} but the market's currency is ${f.expectedCurrency}.${basis} Not re-sent.`
  }
  return `Price unconfirmed on eBay ${where}: ${priceDriftMessage({ channel: 'eBay', sku: f.sku, drift: f.drift as PriceDrift, currency: f.channelCurrency })}${basis} Not re-sent.`
}

export interface TradingPriceCounts {
  compared: number
  mismatches: number
  currencyMismatches: number
  logged: number
  /** Another account's membership (the reads used one account's token), or no product. */
  skipped: number
  nullPrice: number
  fallback: number
  unread: number
}

export const emptyTradingPriceCounts = (): TradingPriceCounts =>
  ({ compared: 0, mismatches: 0, currencyMismatches: 0, logged: 0, skipped: 0, nullPrice: 0, fallback: 0, unread: 0 })

/** The price arm's half of the cron line. "(heal off)" is unconditional: this arm has no heal path at all. */
export function tradingPriceSummary(p: TradingPriceCounts): string {
  return `price compared=${p.compared} mismatches=${p.mismatches} currency=${p.currencyMismatches} logged=${p.logged} skipped=${p.skipped} null=${p.nullPrice} fallback=${p.fallback} unread=${p.unread} (heal off)`
}

/** A membership as the sweep loaded it (price is Prisma's Decimal). */
export interface TradingPriceMembership {
  sku: string
  itemId: string
  marketplace: string
  productId: string | null
  price?: { toString(): string } | number | null
  channelConnectionId?: string | null
}

/** A product's eBay listing, as the price-less membership fallback reads it. */
export interface MembershipFallbackListing {
  productId: string
  region: string | null
  marketplace: string | null
  price: { toString(): string } | number | null
  channelConnectionId: string | null
}

const marketCodeOf = (value: string | null | undefined): string => {
  const code = (value ?? '').trim().toUpperCase().replace(/^EBAY_/, '')
  return code === 'GB' ? 'UK' : code
}

/**
 * CX (review 2026-09-26) — the price a membership with NO price of its own sells at: its product's eBay listing
 * price on the membership's market (schema: "null → fall back to child Product price"; the flat file shows that
 * listing's `<market>_price` on the membership's row). Several listings on the market → the membership's own
 * account's. Still not exactly one price → null: counted, never guessed.
 */
export function membershipFallbackPrice(
  m: { productId: string | null; marketplace: string; channelConnectionId?: string | null },
  listings: readonly MembershipFallbackListing[],
): number | null {
  if (!m.productId) return null
  const market = marketCodeOf(m.marketplace)
  const onMarket = listings.filter((l) => l.productId === m.productId && marketCodeOf(l.region ?? l.marketplace) === market)
  const own = m.channelConnectionId ? onMarket.filter((l) => l.channelConnectionId === m.channelConnectionId) : []
  const prices = new Set((own.length > 0 ? own : onMarket)
    .map((l) => moneyValue(l.price == null ? null : String(l.price)))
    .filter((p): p is number => p !== null)
    .map(cents))
  return prices.size === 1 ? [...prices][0] / 100 : null
}

/** One GetItem answer the sweep already holds (read OK, not ended). */
export interface TradingPriceRead { itemId: string; marketplace: string; prices?: ItemQuantityReadback['prices'] }

/**
 * The Trading sweep's price arm, over answers already in hand — no call of its own. Each membership of
 * a read listing is compared with ITS listing's StartPrice: per SKU on a variation listing (any
 * <Variations> block); the item price only on a single-SKU listing with one membership.
 * 🔴 It REPORTS and never heals: no fan-out, no queue row, no enqueue.
 */
export async function runTradingPriceArm(args: {
  memberships: readonly TradingPriceMembership[]
  reads: readonly TradingPriceRead[]
  accountId: string
  keyOf: (itemId: string, sku: string) => string
}): Promise<TradingPriceCounts> {
  const byListing = new Map<string, TradingPriceEntry[]>()
  for (const m of args.memberships) {
    const key = `${m.marketplace}:${m.itemId}`
    const list = byListing.get(key) ?? []
    list.push({ sku: m.sku, itemId: m.itemId, marketplace: m.marketplace, productId: m.productId, price: m.price == null ? null : Number(m.price), channelConnectionId: m.channelConnectionId ?? null })
    byListing.set(key, list)
  }
  const observed = new Map<string, TradingObservedPrice>()
  const entries: TradingPriceEntry[] = []
  for (const read of args.reads) {
    const listing = byListing.get(`${read.marketplace}:${read.itemId}`) ?? []
    entries.push(...listing)
    const prices = read.prices
    if (!prices) continue
    if (prices.hasVariations) {
      for (const v of prices.variations) observed.set(args.keyOf(read.itemId, v.sku), { value: v.value, currency: v.currency })
    } else if (prices.item && listing.length === 1) {
      observed.set(args.keyOf(read.itemId, listing[0].sku), prices.item)
    }
  }
  // CX (review 2026-09-26) — a price-less membership of a read listing is compared with the listing price it falls back to.
  const fallbackProductIds = [...new Set(entries.filter((e) => e.price === null && e.productId).map((e) => e.productId as string))]
  if (fallbackProductIds.length > 0) {
    let listings: MembershipFallbackListing[] = []
    try {
      listings = await prisma.channelListing.findMany({
        where: { channel: 'EBAY', productId: { in: fallbackProductIds } },
        select: { productId: true, region: true, marketplace: true, price: true, channelConnectionId: true },
      }) as MembershipFallbackListing[]
    } catch { /* not compared: counted as null */ }
    for (const e of entries) {
      if (e.price !== null) continue
      const fallback = membershipFallbackPrice(e, listings)
      if (fallback !== null) { e.price = fallback; e.priceSource = 'LISTING' }
    }
  }
  let currencyRows: MarketCurrencyRow[] = []
  try { currencyRows = await marketCurrencyRows('EBAY') } catch { /* compared without a currency check */ }
  const diff = diffTradingPriceReadback(entries, observed, {
    accountId: args.accountId,
    keyOf: args.keyOf,
    currencyOf: (marketplace) => { try { return marketCurrency('EBAY', marketplace, currencyRows) } catch { return null } },
  })
  const counts: TradingPriceCounts = {
    compared: diff.compared,
    mismatches: diff.findings.filter((f) => f.kind === 'PRICE_MISMATCH').length,
    currencyMismatches: diff.findings.filter((f) => f.kind === 'CURRENCY_MISMATCH').length,
    logged: 0,
    skipped: diff.skipped,
    nullPrice: diff.nullPrice,
    fallback: diff.fallback,
    unread: diff.unread,
  }
  for (const f of diff.findings) {
    const recorded = await recordEbayPriceUnconfirmed({
      productId: f.productId,
      source: 'TRADING_GETITEM',
      marketplace: f.marketplace,
      ref: `item:${f.itemId}/${f.sku}`,
      outcome: f.kind,
      sku: f.sku,
      message: tradingPriceFindingMessage(f),
      localData: f.priceSource === 'LISTING'
        ? { membershipPrice: null, listingPrice: f.intendedPrice, currency: f.expectedCurrency }
        : { membershipPrice: f.intendedPrice, currency: f.expectedCurrency },
      remoteData: { ebayPrice: f.channelPrice, ebayCurrency: f.channelCurrency, expectedCurrency: f.expectedCurrency, itemId: f.itemId, sku: f.sku, marketplace: f.marketplace, accountId: args.accountId },
    })
    if (recorded === 'logged') counts.logged++
  }
  return counts
}

// ── the record, shared by both arms ──────────────────────────────────────────────────────────────

export type PriceReadbackSource = 'INVENTORY_GET_OFFER' | 'TRADING_GETITEM' | 'VARIATION_GETITEM'

/**
 * Which findings may stand in for one another in the dedupe. A real finding (price or currency) is
 * never hidden behind an "unconfirmed" one (read failed, unreadable, not yet visible), nor vice versa.
 */
export function priceOutcomeClass(outcome: string): 'PRICE' | 'CURRENCY' | 'UNCONFIRMED' {
  return outcome === 'PRICE_MISMATCH' ? 'PRICE' : outcome === 'CURRENCY_MISMATCH' ? 'CURRENCY' : 'UNCONFIRMED'
}

/**
 * One `CHANNEL_PRICE_READBACK` conflict, deduped 24 h on (source, marketplace, offer / item+SKU,
 * outcome class) — stored as `conflictData.remote.dedupeKey` — so one listing's finding never hides
 * another's, and a product-less row has its own slot. Every occurrence is also logged (warn), recorded
 * or deduped, with no token or buyer data. Observability only: never throws, never writes to eBay.
 */
export async function recordEbayPriceUnconfirmed(args: {
  productId: string | null
  source: PriceReadbackSource
  marketplace: string
  /** `offer:<offerId>` (B1), `item:<itemId>/<sku>` (B2, variations) or `item:<itemId>` (a variation read that failed). */
  ref: string
  outcome: string
  sku: string
  message: string
  localData: Record<string, unknown>
  remoteData: Record<string, unknown>
}): Promise<'logged' | 'deduped' | 'failed'> {
  const dedupeKey = `${args.source}|${args.marketplace}|${args.ref}|${priceOutcomeClass(args.outcome)}`
  let recorded: 'logged' | 'deduped' | 'failed' = 'failed'
  try {
    const existing = await prisma.syncHealthLog.findFirst({
      where: {
        productId: args.productId,
        channel: 'EBAY',
        conflictType: 'CHANNEL_PRICE_READBACK',
        resolutionStatus: 'UNRESOLVED',
        createdAt: { gte: new Date(Date.now() - 24 * 3600e3) },
        conflictData: { path: ['remote', 'dedupeKey'], equals: dedupeKey },
      },
      select: { id: true },
    })
    if (existing) {
      recorded = 'deduped'
    } else {
      const { syncHealthService } = await import('./sync-health.service.js')
      await syncHealthService.logConflict({
        channel: 'EBAY',
        conflictType: 'CHANNEL_PRICE_READBACK',
        message: args.message,
        productId: args.productId ?? undefined,
        localData: args.localData,
        // Computed fields last: a caller's remoteData can never overwrite the key the dedupe matches on.
        remoteData: { ...args.remoteData, health: 'PRICE_UNCONFIRMED', source: args.source, outcome: args.outcome, dedupeKey },
      })
      recorded = 'logged'
    }
  } catch (err) {
    logger.warn('ebay-price-readback: could not record an unconfirmed price', { error: err instanceof Error ? err.message : String(err) })
  }
  logger.warn('ebay-price-readback: price unconfirmed', {
    source: args.source, marketplace: args.marketplace, ref: args.ref, sku: args.sku, productId: args.productId,
    outcome: args.outcome, recorded,
  })
  return recorded
}
