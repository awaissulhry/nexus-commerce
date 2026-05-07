// S.0 / C-3 — Inline channel pull for the /api/listings/:id/resync route.
//
// Why this exists
// ───────────────
// Phase 1 audit found the resync endpoint was a placebo: it set
// syncStatus='PENDING' and no worker ever read that flag. This service
// implements the *single-listing* inline pull path — operator clicks
// "Resync" in the drawer, we hit the channel synchronously, merge the
// result into the ChannelListing row, return the fresh state.
//
// Single-listing only. Bulk resync (>1 listing) is deferred to S.4
// where we'll either repurpose OutboundSyncQueue with an INBOUND_REFRESH
// syncType or stand up a sibling InboundSyncQueue. See TECH_DEBT.
//
// Channel coverage today
// ──────────────────────
//   AMAZON       — implemented via amazonService.getListingState()
//   EBAY         — NotImplementedError (no fetch-listing-state primitive
//                  on ebay.service.ts yet; S.4 picks this up)
//   SHOPIFY      — NotImplementedError
//   WOOCOMMERCE  — NotImplementedError
//   ETSY         — NotImplementedError
//
// The 501 surfaces honestly to the operator as "Resync is not yet
// supported on this channel" — better than the previous behaviour where
// the button claimed success but did nothing.

import prisma from '../../db.js'
import { AmazonService } from '../marketplaces/amazon.service.js'

/** Fields returned by every channel adapter's pull primitive. Any field
 * the marketplace doesn't surface comes back as null and the route
 * leaves the corresponding column unchanged on the listing. */
export interface RemoteListingState {
  price: number | null
  quantity: number | null
  listingStatus: string | null
  title: string | null
  /** Channel-specific identifier echoed back (Amazon ASIN, eBay ItemID,
   * etc.). Used to detect "remote no longer recognises this listing"
   * cases where the externalListingId on our row is stale. */
  externalId: string | null
}

export class ChannelNotSupportedError extends Error {
  constructor(channel: string) {
    super(`Resync is not yet implemented for channel "${channel}".`)
    this.name = 'ChannelNotSupportedError'
  }
}

export class ResyncTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Channel did not respond within ${timeoutMs}ms.`)
    this.name = 'ResyncTimeoutError'
  }
}

interface PullInput {
  channel: string
  marketplace: string
  externalListingId: string
}

interface PullOptions {
  /** Hard cap on the channel call. Default 10s — Amazon SP-API P50 is
   * <2s, P99 around 8s; longer than that and we'd rather surface a
   * timeout than block the operator's HTTP request. */
  timeoutMs?: number
}

/**
 * Fetch the live state of a listing from its channel and return the
 * normalised shape every channel adapter conforms to.
 *
 * Throws:
 *   - ChannelNotSupportedError → caller should reply 501
 *   - ResyncTimeoutError       → caller should reply 504
 *   - generic Error            → caller should reply 502 with message
 */
export async function pullListingFromChannel(
  input: PullInput,
  options: PullOptions = {},
): Promise<RemoteListingState> {
  const timeoutMs = options.timeoutMs ?? 10_000

  return withTimeout(timeoutMs, async () => {
    switch (input.channel) {
      case 'AMAZON':
        return pullFromAmazon(input)
      case 'EBAY':
      case 'SHOPIFY':
      case 'WOOCOMMERCE':
      case 'ETSY':
        throw new ChannelNotSupportedError(input.channel)
      default:
        throw new ChannelNotSupportedError(input.channel)
    }
  })
}

/* ──────────────────────────────────────────────────────────────────── */
/*  AMAZON                                                              */
/* ──────────────────────────────────────────────────────────────────── */

async function pullFromAmazon(input: PullInput): Promise<RemoteListingState> {
  // The ChannelListing row holds a marketplace *code* like 'IT' or 'DE'.
  // SP-API needs the marketplaceId GUID (e.g. 'APJ6JRA9NG5V4' for IT).
  // The Marketplace table is the source of truth for that mapping.
  const mp = await prisma.marketplace.findFirst({
    where: { channel: 'AMAZON', code: input.marketplace },
    select: { marketplaceId: true },
  })
  if (!mp?.marketplaceId) {
    throw new Error(
      `No Marketplace row for AMAZON/${input.marketplace} or marketplaceId missing — seed the Marketplace table.`,
    )
  }

  const amazonService = new AmazonService()
  // For Amazon, externalListingId on our row is the seller SKU (per
  // listing-publish convention). SP-API getListingsItem is keyed by
  // (sellerId, sku, marketplaceIds[]), not ASIN — so we pass the SKU.
  const remote = await amazonService.getListingState(
    input.externalListingId,
    mp.marketplaceId,
  )

  return {
    price: remote.price,
    quantity: remote.quantity,
    listingStatus: remote.listingStatus,
    title: remote.title,
    externalId: remote.asin,
  }
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Timeout wrapper                                                     */
/* ──────────────────────────────────────────────────────────────────── */

function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ResyncTimeoutError(ms)), ms)
    fn().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
