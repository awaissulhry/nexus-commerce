/**
 * P1.1 — what differs per channel, in one place: the publish mode, the production and sandbox hosts,
 * the login and market headers, the rate-limit reading, and the operation group a rate bucket is per.
 * The gateway (gateway.ts) runs the same steps for every channel and asks this table for the parts.
 */
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { getShopifyPublishMode } from '../shopify-publish-gate.service.js'
import { tryGetChannelSpec, type ChannelKey } from '../cx/catalog.js'
import type { GatewayChannel } from './vocabulary.js'
import prisma from '../../db.js'
import { languageTag, marketLanguages } from '../pim/market-languages.js'
import { normalizeLanguage } from '../pim/content-language.js'

export type PublishMode = 'gated' | 'dry-run' | 'sandbox' | 'live'

export const SPEC_KEY: Record<GatewayChannel, ChannelKey> = {
  EBAY: 'EBAY', AMAZON_SP: 'AMAZON_SP', SHOPIFY: 'SHOPIFY', AMAZON_ADS: 'AMAZON_ADS',
}

/** The publish mode that governs WRITES on this channel today. */
export function publishModeOf(channel: GatewayChannel): PublishMode {
  switch (channel) {
    case 'EBAY': return getEbayPublishMode()
    case 'AMAZON_SP': return getAmazonPublishMode()
    case 'SHOPIFY': return getShopifyPublishMode()
    // Amazon Ads keeps its own write gate (ads-write-gate.ts: allowlist, caps, pins); the gateway only
    // honours its sandbox switch here, so a sandbox Ads write never reaches the live host.
    // Same rule as ads-api-client.ts `adsMode()` (exact 'live', else sandbox).
    case 'AMAZON_ADS': return process.env.NEXUS_AMAZON_ADS_MODE === 'live' ? 'live' : 'sandbox'
  }
}

const SANDBOX_HOSTS: Record<GatewayChannel, Array<[RegExp, (m: RegExpMatchArray) => string]>> = {
  EBAY: [
    [/^api\.ebay\.com$/, () => 'api.sandbox.ebay.com'],
    [/^apiz\.ebay\.com$/, () => 'apiz.sandbox.ebay.com'],
  ],
  AMAZON_SP: [[/^sellingpartnerapi-(na|eu|fe)\.amazon\.com$/, (m) => `sandbox.sellingpartnerapi-${m[1]}.amazon.com`]],
  // Shopify has no sandbox host: a development store is a different shop, chosen by the account.
  SHOPIFY: [],
  AMAZON_ADS: [[/^advertising-api(-eu|-fe)?\.amazon\.com$/, () => 'advertising-api-test.amazon.com']],
}

/** The URL in sandbox mode, or null when the channel has no sandbox host for it (then: no call). */
export function sandboxUrlOf(channel: GatewayChannel, url: string): string | null {
  const parsed = new URL(url)
  if (/sandbox|-test\./.test(parsed.hostname)) return url
  for (const [pattern, to] of SANDBOX_HOSTS[channel]) {
    const match = parsed.hostname.match(pattern)
    if (match) { parsed.hostname = to(match); return parsed.toString() }
  }
  return null
}

export function authHeadersOf(channel: GatewayChannel, token: string): Record<string, string> {
  switch (channel) {
    case 'EBAY': return { Authorization: `Bearer ${token}` }
    case 'AMAZON_SP': return { 'x-amz-access-token': token }
    case 'SHOPIFY': return { 'X-Shopify-Access-Token': token }
    case 'AMAZON_ADS': return { Authorization: `Bearer ${token}` }
  }
}

/**
 * P1.5 (folded in here) — eBay's three market headers, from the Marketplace row. Before this, one helper
 * turned EBAY_IT into en-US, bulk and the old service hard-coded en-US, the image publisher hard-coded
 * it-IT and the wizard sent no marketplace header at all.
 *
 * No market→language table here (LX.2: `Marketplace.languages` is the only authority). The row gives the
 * marketplace id (`EBAY_IT`) and the ordered languages; the first is the default, or the caller names one
 * of them. eBay wants the regional tag with a hyphen (`it-IT`, `en-GB`).
 */
export class MarketUnconfigured extends Error {
  constructor(message: string) { super(message); this.name = 'MarketUnconfigured' }
}

export async function ebayMarketHeaders(market: string, contentLanguage?: string | null): Promise<Record<string, string>> {
  const code = market.trim().toUpperCase().replace(/^EBAY_/, '')
  if (!/^[A-Z]{2}$/.test(code)) throw new MarketUnconfigured(`"${market}" is not an eBay market code.`)
  const coordinate = { channel: 'EBAY', code: code === 'GB' ? 'UK' : code }
  const row = await prisma.marketplace.findFirst({ where: coordinate, select: { marketplaceId: true, languages: true, language: true } })
  if (!row) throw new MarketUnconfigured(`The eBay market ${coordinate.code} is not set up in Nexus.`)
  let languages: string[]
  try {
    languages = marketLanguages(coordinate.channel, coordinate.code, [{ ...coordinate, languages: row.languages, language: row.language }])
  } catch (err) {
    throw new MarketUnconfigured(err instanceof Error ? err.message : String(err))
  }
  const language = contentLanguage ? normalizeLanguage(contentLanguage) : languages[0]
  if (!languages.includes(language)) throw new MarketUnconfigured(`${language} is not a language of the eBay market ${coordinate.code} (${languages.join(', ')}).`)
  const tag = languageTag(language, coordinate.code).replace('_', '-')
  const marketplaceId = row.marketplaceId?.startsWith('EBAY_') ? row.marketplaceId : `EBAY_${tag.split('-')[1]}`
  return { 'X-EBAY-C-MARKETPLACE-ID': marketplaceId, 'Content-Language': tag, 'Accept-Language': tag }
}

/** The rate reading of an answer, through the connector spec (these parsers existed but nothing called them). */
export function rateReadingOf(channel: GatewayChannel, headers: Headers, status: number) {
  const spec = tryGetChannelSpec(SPEC_KEY[channel])
  try {
    return spec?.rateLimit.parse(headers, status) ?? null
  } catch {
    return null
  }
}

/**
 * Shopify GraphQL reports throttling and errors INSIDE an HTTP 200, and its headroom in the body
 * (`extensions.cost.throttleStatus`). Returns what the body says, or null for any other answer.
 */
export function shopifyGraphqlBodyOf(text: string): { errors: boolean; throttled: boolean; remaining: number | null; limit: number | null; restoreRate: number | null } | null {
  let body: any
  try { body = JSON.parse(text) } catch { return null }
  if (!body || typeof body !== 'object') return null
  const throttle = body.extensions?.cost?.throttleStatus
  const errors = Array.isArray(body.errors) && body.errors.length > 0
  const throttled = errors && body.errors.some((e: any) => e?.extensions?.code === 'THROTTLED')
  if (!errors && !throttle) return null
  return {
    errors,
    throttled,
    remaining: typeof throttle?.currentlyAvailable === 'number' ? throttle.currentlyAvailable : null,
    limit: typeof throttle?.maximumAvailable === 'number' ? throttle.maximumAvailable : null,
    restoreRate: typeof throttle?.restoreRate === 'number' ? throttle.restoreRate : null,
  }
}

/**
 * The operation group a rate bucket is per. Amazon limits each operation on its own, so the path with
 * ids dropped; the others limit per app / per account, so one group.
 */
export function bucketGroupOf(channel: GatewayChannel, method: string, url: string): string {
  if (channel !== 'AMAZON_SP') return 'all'
  // `/{api}/{version}/{resource}` — e.g. `/listings/2021-08-01/items`, `/orders/v0/orders` — never
  // the seller id or SKU that follow, so one bucket per operation family, not per SKU.
  const kept = new URL(url).pathname.split('/').filter(Boolean).slice(0, 3)
  return `${method.toUpperCase()} /${kept.join('/')}`
}

/** The API version a URL carries (`2021-08-01`, `v1`, `2026-07`), else the connector's declared one. */
export function apiVersionOf(channel: GatewayChannel, url: string): string | null {
  const match = new URL(url).pathname.match(/\/(v\d+(?:\.\d+)?|\d{4}-\d{2}(?:-\d{2})?)(?=\/|$)/)
  if (match) return match[1]
  return tryGetChannelSpec(SPEC_KEY[channel])?.apiVersion ?? null
}
