/**
 * The price the product's Pricing tab shows for one listing — pure, so it is tested by value (2026-10-01).
 *
 * The API prices a FOLLOWING listing by its rule from the master price (`@nexus/shared/listing-price`), and only in the
 * master currency: a market that sells in another currency is REFUSED, never converted (the master-price cascade and
 * the price door; `follower-price.ts` in the API). The tab showed the rule's price from the master — a EUR number —
 * formatted in the market's currency, so a UK listing read "£11.00" for a price Nexus never sends there. Now:
 *   - a pinned listing: its own price (`priceOverride`, else `price`);
 *   - a following listing in the master currency: the rule's price;
 *   - a following listing under Match Amazon, or with no master price: the price it holds;
 *   - a following listing in ANOTHER currency (or a market with no currency configured): the price it holds, in its own
 *     currency, and the refusal — the rule's price is not sent there.
 */
import { followerListingPrice } from '@nexus/shared/listing-price'

type Num = number | string | { toString(): string } | null | undefined

export interface MarketCurrencyRow {
  channel: string
  code: string
  currency: string | null
}

const toNumber = (v: Num): number | null => {
  if (v == null) return null
  const n = Number(typeof v === 'object' ? v.toString() : v)
  return Number.isFinite(n) ? n : null
}

/** UK and GB are one market; `EBAY_IT` names IT. The API's reading (`market-currency.ts`). */
const bareCode = (channel: string, code: string) => {
  const c = (channel ?? '').toUpperCase()
  const m = (code ?? '').toUpperCase()
  const bare = m.startsWith(`${c}_`) ? m.slice(c.length + 1) : m
  return bare === 'GB' ? 'UK' : bare
}

/** The market's configured currency (its `Marketplace` row), or null when none is configured — never a guess. */
export function marketCurrencyOf(channel: string, marketplace: string, rows: readonly MarketCurrencyRow[]): string | null {
  const ch = (channel ?? '').toUpperCase()
  const code = bareCode(channel, marketplace)
  const row = rows.find((r) => (r.channel ?? '').toUpperCase() === ch && bareCode(r.channel, r.code) === code)
  const value = (row?.currency ?? '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(value) ? value : null
}

/** The master currency: configuration (`NEXUS_MASTER_CURRENCY`), EUR by default — as the API reads it. */
export function masterCurrencyFrom(value: string | undefined): string {
  return (value ?? 'EUR').trim().toUpperCase() || 'EUR'
}

export interface TabListing {
  followMasterPrice: boolean | null
  pricingRule: string | null
  priceAdjustmentPercent: Num
  price: Num
  priceOverride: Num
  masterPrice: Num
}

export interface TabPrice {
  /** The number to show, in the market's own currency. */
  value: number | null
  /**
   * The rule's price is NOT sent to this market: it sells in another currency than the master's (or has none
   * configured), and Nexus refuses rather than converts. `market` null = no currency configured.
   */
  currencyRefused: { market: string | null; master: string } | null
}

export function pricingTabPrice(listing: TabListing, masterBase: number | null, marketCurrency: string | null, masterCurrency: string): TabPrice {
  const held = listing.followMasterPrice === false ? toNumber(listing.priceOverride) ?? toNumber(listing.price) : toNumber(listing.price)
  if (listing.followMasterPrice === false) return { value: held, currencyRefused: null }
  const rulePrice = followerListingPrice(masterBase ?? toNumber(listing.masterPrice), listing.pricingRule, toNumber(listing.priceAdjustmentPercent))
  if (rulePrice === null) return { value: held, currencyRefused: null }
  if (marketCurrency !== masterCurrency) return { value: held, currencyRefused: { market: marketCurrency, master: masterCurrency } }
  return { value: rulePrice, currencyRefused: null }
}
