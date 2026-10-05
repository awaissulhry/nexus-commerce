/**
 * Step S7 (plan docs/sheet-ids-sku-rows/PLAN.md) — a listing's own channel SKU on the paths that READ a channel back
 * (FBA stock reports, read-backs, reconcile jobs, live reads) and on the FBA paths that NAME an item to Amazon (inbound
 * plans, FNSKU labels, Multi-Channel Fulfilment). No rule of its own: everything comes from the S2 resolver
 * (`channel-sku.pure.ts`, `channel-sku.ts`).
 *
 * Parity is the point: a listing with no SKU of its own (no `channelSku`/`liveChannelSku`, no other value in the old
 * stores) answers its product SKU here, so every caller does exactly what it did before for it. Only a listing that
 * has its own SKU changes anything, and two listings that claim one SKU are reported, never picked.
 */
import type { Prisma } from '@prisma/client'
import { channelLabel } from '@nexus/shared/channel-label'
import { MARKET_CATALOGUE } from '../pim/market-catalogue.js'
import { liveChannelSku, wantedChannelSku, type ChannelSkuAnswer, type ChannelSkuListing, type ChannelSkuSource } from './channel-sku.pure.js'
import { CHANNEL_SKU_LISTING_SELECT, productForChannelSku } from './channel-sku.js'

type Db = Prisma.TransactionClient

/**
 * The SKU the channel knows this listing by: the live one (`liveChannelSku`); for a listing that is still a Nexus
 * draft, the one Publish would send (`wantedChannelSku`). With no own SKU anywhere, that is the product SKU.
 */
export function reportedSkuOf(listing: ChannelSkuListing, productSku: string | null | undefined): ChannelSkuAnswer {
  return liveChannelSku(listing, productSku) ?? wantedChannelSku(listing, productSku)
}

/** A product named by a listing's OWN SKU, or two products that both claim the SKU (then never picked). */
export type OwnSkuMatch =
  | { ambiguous: false; productId: string; listingId: string | null; via: ChannelSkuSource }
  | { ambiguous: true; productIds: string[]; sentence: string }

/**
 * Which product a SKU a channel reported names through a listing's own SKU, on ONE connected account (and market,
 * when given): the confirmed SKU, the wanted SKU, or an old store (`productForChannelSku`). Null when no listing holds
 * it, and also when only a product's master SKU matches: the caller then runs its existing lookup unchanged, so a
 * listing without its own SKU is matched exactly as before. Another business or another account is never read.
 */
export async function productByOwnSku(db: Db, input: { channel: string; channelConnectionId: string | null | undefined; marketplace?: string | null; sku: string | null | undefined }): Promise<OwnSkuMatch | null> {
  const sku = String(input.sku ?? '').trim()
  if (!sku || !input.channelConnectionId) return null
  const match = await productForChannelSku(db, { channel: input.channel, channelConnectionId: input.channelConnectionId, marketplace: input.marketplace, sku })
  if (!match) return null
  if ('productIds' in match) {
    return { ambiguous: true, productIds: match.productIds,
      sentence: `${sku} is the SKU of ${match.productIds.length} products on this ${channelLabel(input.channel) || 'channel'} account. Nexus did not pick one: give each listing its own SKU.` }
  }
  if (match.via === 'product') return null
  return { ambiguous: false, productId: match.productId, listingId: match.listingId, via: match.via }
}

/**
 * The account an Amazon call that names none uses (`amazonAccount()`: the same chooser the SP-API client runs), or
 * null when none resolves. With a seller id (a notification names one): that seller's account only.
 */
export async function amazonAccountIdFor(sellerId?: string | null): Promise<string | null> {
  try {
    const { amazonAccount } = await import('../../lib/amazon-sp-client.js')
    return (await amazonAccount(sellerId ? { sellerId } : {})).id
  } catch {
    return null
  }
}

/** Listing rows of one connected account, plus unattributed older rows (they may be its own). No account: no filter. */
export const onAccount = (accountId: string | null | undefined): Prisma.ChannelListingWhereInput =>
  accountId ? { OR: [{ channelConnectionId: accountId }, { channelConnectionId: null }] } : {}

/** The 2-letter market an Amazon marketplace id names (`Marketplace` row first, then the market catalogue). */
export async function amazonMarketCode(db: Db, marketplaceId: string): Promise<string | null> {
  const id = String(marketplaceId ?? '').trim()
  if (!id) return null
  const row = await db.marketplace.findFirst({ where: { channel: 'AMAZON', marketplaceId: id }, select: { code: true } })
  return row?.code ?? MARKET_CATALOGUE.find(m => m.channel === 'AMAZON' && m.marketplaceId === id)?.code ?? null
}

/** What Amazon knows a product by in one market of one account; `NO_LISTING` and `CONFLICT` carry one plain sentence. */
export type AmazonSkuInMarket =
  | { ok: true; sku: string; listingId: string | null; own: boolean }
  | { ok: false; code: 'NO_LISTING' | 'CONFLICT'; sentence: string }

/**
 * For each product, the seller SKU of its main Amazon listing (not an extra listing) in one market of one account: the
 * live SKU (`reportedSkuOf`). With no account, every account's listing counts and they must agree. `own` is true when
 * that SKU is not the product SKU. No listing → `NO_LISTING` (the caller decides: most keep sending the product SKU, as
 * before); no single SKU, or two listings that disagree → `CONFLICT`, never a guess.
 */
export async function amazonSkusInMarket(db: Db, input: {
  accountId: string | null
  marketplace: string
  products: ReadonlyArray<{ id: string; sku: string }>
}): Promise<Map<string, AmazonSkuInMarket>> {
  const market = String(input.marketplace ?? '').trim().toUpperCase()
  const out = new Map<string, AmazonSkuInMarket>()
  if (!input.products.length) return out
  const rows = await db.channelListing.findMany({
    where: { channel: 'AMAZON', marketplace: market, aliasKey: '', productId: { in: input.products.map(p => p.id) }, ...onAccount(input.accountId) },
    select: { ...CHANNEL_SKU_LISTING_SELECT, channelConnectionId: true },
    orderBy: { id: 'asc' },
  })
  for (const product of input.products) {
    const mine = rows.filter(row => row.productId === product.id)
    const own = mine.filter(row => input.accountId && row.channelConnectionId === input.accountId)
    const listings = own.length ? own : mine
    if (!listings.length) {
      out.set(product.id, { ok: false, code: 'NO_LISTING', sentence: `${product.sku} has no Amazon ${market} listing in Nexus.` })
      continue
    }
    const answers = listings.map(row => reportedSkuOf(row, product.sku))
    const refused = answers.find(answer => answer.sku === null)
    if (refused?.conflict) {
      const values = refused.conflict.candidates.map(c => c.sku)
      out.set(product.id, { ok: false, code: 'CONFLICT', sentence: values.length
        ? `${product.sku}: its Amazon ${market} listing has more than one seller SKU on record (${values.join(', ')}). Nexus did not pick one: set the listing's own SKU first.`
        : `${product.sku}: ${refused.conflict.sentence}` })
      continue
    }
    const skus = [...new Set(answers.map(answer => answer.sku as string))]
    if (skus.length > 1) {
      out.set(product.id, { ok: false, code: 'CONFLICT',
        sentence: `${product.sku} has Amazon ${market} listings with different seller SKUs (${skus.join(', ')}). Nexus did not pick one.` })
      continue
    }
    out.set(product.id, { ok: true, sku: skus[0], listingId: listings.length === 1 ? listings[0].id : null, own: skus[0] !== product.sku.trim() })
  }
  return out
}
