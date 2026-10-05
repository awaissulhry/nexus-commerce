/**
 * S8 (docs/sheet-ids-sku-rows/PLAN.md) — a channel SKU that arrives WITHOUT a listing (an Amazon issue notification, a
 * feed report, an ad read back from Amazon Ads) matched to the listings and products that answer to it, through the one
 * resolver (`channel-sku.ts` / `channel-sku.pure.ts`): a listing may carry its own channel SKU (per channel AND market:
 * `ChannelListing.channelSku`, confirmed `liveChannelSku`), and the old stores hold SKUs the product SKU does not name.
 *
 * The store lookup itself is `listingsThatMayHoldSkus` in channel-sku.ts (one statement, filtered in SQL). It reads the
 * JSON stores, so it is for these report paths, not for a per-write hot path: the write guards (write-account-guard.ts,
 * listing-push-controls.ts) match the indexed `channelSku` / `liveChannelSku` columns only.
 *
 * Business scope: row-level security plus the explicit workspace filter of the channel-sku reads. Nothing here calls a
 * channel.
 */
import { Prisma } from '@prisma/client'
import { CHANNEL_SKU_LISTING_SELECT, listingsThatMayHoldSkus, productForChannelSku, type ChannelSkuListingRow } from './channel-sku.js'
import { liveChannelSku, wantedChannelSku, type ChannelSkuAnswer, type ChannelSkuListing } from './channel-sku.pure.js'

/** The caller's client: the root client or a transaction. */
type Db = Prisma.TransactionClient

/**
 * True when `listing` answers to `sku` (trimmed, exact) by the resolver: it is the SKU Nexus sends for it
 * (`wantedChannelSku`) or the SKU the channel holds for it (`liveChannelSku`). A listing with no single SKU (a conflict)
 * answers to each SKU on record for it — a channel's report about one of them is about this listing.
 */
export function listingAnswersToSku(listing: ChannelSkuListing, productSku: string | null | undefined, sku: string): boolean {
  const want = sku.trim()
  if (!want) return false
  const holds = (answer: ChannelSkuAnswer | null) => !!answer
    && (answer.sku === want || (!answer.sku && answer.conflict.candidates.some(c => c.sku === want)))
  return holds(wantedChannelSku(listing, productSku)) || holds(liveChannelSku(listing, productSku))
}

/**
 * The listings of one channel and market (optionally: of these accounts) that answer to each SKU by the resolver
 * (`listingAnswersToSku`): the wide `listingsThatMayHoldSkus` read (channel-sku.ts), then the pure rule decides. The
 * product-SKU match of a listing without its own SKU stays the caller's. Two reads.
 */
export async function listingsAnsweringToSkus(db: Db, input: {
  skus: ReadonlyArray<string | null | undefined>
  channel: string
  marketplace?: string | null
  channelConnectionIds?: ReadonlyArray<string> | null
}): Promise<Map<string, ChannelSkuListingRow[]>> {
  const out = new Map<string, ChannelSkuListingRow[]>()
  const accounts = input.channelConnectionIds ? new Set(input.channelConnectionIds) : null
  const channel = String(input.channel ?? '').trim().toUpperCase() || null
  const held = (await listingsThatMayHoldSkus(db, { skus: input.skus, channel, marketplace: input.marketplace, limit: 2000 }))
    .filter(row => !accounts || (row.channelConnectionId !== null && accounts.has(row.channelConnectionId)))
  if (!held.length) return out
  const rows: ChannelSkuListingRow[] = await db.channelListing.findMany({ where: { id: { in: [...new Set(held.map(row => row.listingId))] } }, select: CHANNEL_SKU_LISTING_SELECT })
  const byId = new Map(rows.map(row => [row.id, row]))
  for (const { sku, listingId } of held) {
    const row = byId.get(listingId)
    if (!row || !listingAnswersToSku(row, row.product?.sku, sku)) continue
    out.set(sku, [...(out.get(sku) ?? []), row])
  }
  return out
}

/** The accounts this business lists on in one channel (and market): what a channel SKU without a named account may be on. */
export async function listingAccounts(db: Db, input: { channel: string; marketplace?: string | null }): Promise<string[]> {
  const rows = await db.channelListing.findMany({
    where: {
      channel: String(input.channel ?? '').trim().toUpperCase(), channelConnectionId: { not: null },
      ...(input.marketplace ? { marketplace: input.marketplace } : {}),
    },
    select: { channelConnectionId: true },
    distinct: ['channelConnectionId'],
    orderBy: { channelConnectionId: 'asc' },
  })
  return rows.map(row => row.channelConnectionId).filter((id): id is string => !!id)
}

/** A channel SKU matched on several accounts: one product (and the accounts it matched on), or two products (ambiguous). */
export type AccountsSkuMatch =
  | { ambiguous?: false; productId: string; connectionIds: string[] }
  | { ambiguous: true; productIds: string[] }

/**
 * `productForChannelSku` (the resolver: confirmed SKU → own SKU → old stores → product SKU) asked on each of these
 * accounts, for a channel SKU that arrives without its account (an ads report, a feed): the same product on every
 * account that answers → that product; two products → ambiguous, never a pick. Null when no account answers.
 */
export async function productForChannelSkuOnAccounts(db: Db, input: {
  channel: string
  sku: string
  marketplace?: string | null
  connectionIds: ReadonlyArray<string>
}): Promise<AccountsSkuMatch | null> {
  const matched = new Map<string, string[]>()
  for (const channelConnectionId of input.connectionIds) {
    const match = await productForChannelSku(db, { channel: input.channel, channelConnectionId, marketplace: input.marketplace, sku: input.sku })
    if (!match) continue
    if ('productIds' in match) return { ambiguous: true, productIds: match.productIds }
    matched.set(match.productId, [...(matched.get(match.productId) ?? []), channelConnectionId])
  }
  if (matched.size > 1) return { ambiguous: true, productIds: [...matched.keys()].sort() }
  const [only] = matched
  return only ? { productId: only[0], connectionIds: only[1] } : null
}
