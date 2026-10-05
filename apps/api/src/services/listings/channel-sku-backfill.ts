/**
 * Per-listing channel SKU — the one-off backfill from the old stores (plan docs/sheet-ids-sku-rows/PLAN.md, step S2).
 * The script `apps/api/scripts/backfill-channel-sku.ts` runs this once per business; it is here so it can be tested.
 *
 * For each listing of a live product in the CURRENT business whose old stores hold exactly one SKU that differs from
 * `Product.sku` (`legacyChannelSku`): `channelSku` is set to it when empty and, when the listing is not a draft (so the
 * channel holds it), `liveChannelSku` too. A listing whose old stores disagree is left empty and listed; so is an
 * Amazon alias with no SKU of its own. A column that already has a value is never overwritten, so a second run writes
 * nothing. Dry run unless `apply`. Values are copied as the channel has them (no character rule: they are already live).
 *
 * The answers the resolvers give do not change: before, they read the old stores; after, the column holds the same
 * value. So no listing version is bumped.
 */
import type { Prisma } from '@prisma/client'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { CHANNEL_SKU_LISTING_SELECT } from './channel-sku.js'
import { legacyChannelSku, type ChannelSkuProblem } from './channel-sku.pure.js'

export interface ChannelSkuBackfillCounts {
  /** Listings looked at (live products only). */
  listings: number
  /** No own SKU in the old stores, or the same as the product SKU: nothing to store. */
  followsProduct: number
  channelSkuSet: number
  liveChannelSkuSet: number
  /** An own SKU, already in the columns (a second run). */
  alreadySet: number
  /** The old stores disagree (two SKUs, or more than one active Amazon offer): left empty, listed. */
  conflicts: number
  /** An Amazon alias with no SKU of its own: left empty, listed (Publish refuses it today). */
  needsOwnSku: number
  /** Changed by someone else between the read and the write: left as it is. */
  changedMeanwhile: number
}

export interface ChannelSkuBackfillProblem {
  listingId: string
  productSku: string
  channel: string
  marketplace: string
  code: ChannelSkuProblem
  candidates: string[]
  sentence: string
}

export interface ChannelSkuBackfillReport {
  workspaceId: string
  apply: boolean
  /** Per channel (AMAZON, EBAY, SHOPIFY, …). */
  byChannel: Record<string, ChannelSkuBackfillCounts>
  problems: ChannelSkuBackfillProblem[]
}

const emptyCounts = (): ChannelSkuBackfillCounts => ({
  listings: 0, followsProduct: 0, channelSkuSet: 0, liveChannelSkuSet: 0, alreadySet: 0, conflicts: 0, needsOwnSku: 0, changedMeanwhile: 0,
})

/** Backfill the current business (the caller's workspace context). */
export async function backfillChannelSkus(db: Prisma.TransactionClient, options: { apply?: boolean; batchSize?: number } = {}): Promise<ChannelSkuBackfillReport> {
  const apply = options.apply === true
  const take = Math.max(1, Math.min(options.batchSize ?? 500, 2000))
  const report: ChannelSkuBackfillReport = { workspaceId: workspaceIdForQuery(), apply, byChannel: {}, problems: [] }
  let after: string | undefined
  for (;;) {
    const page = await db.channelListing.findMany({
      where: { product: { deletedAt: null }, ...(after ? { id: { gt: after } } : {}) },
      select: CHANNEL_SKU_LISTING_SELECT, orderBy: { id: 'asc' }, take,
    })
    for (const listing of page) {
      const counts = (report.byChannel[listing.channel] ??= emptyCounts())
      counts.listings++
      const productSku = listing.product?.sku ?? ''
      const answer = legacyChannelSku(listing, productSku)
      if (answer.conflict) {
        if (answer.conflict.code === 'ALIAS_NEEDS_OWN_SKU') counts.needsOwnSku++
        else counts.conflicts++
        report.problems.push({ listingId: listing.id, productSku, channel: listing.channel, marketplace: listing.marketplace,
          code: answer.conflict.code, candidates: answer.conflict.candidates.map(c => c.sku), sentence: answer.conflict.sentence })
        continue
      }
      const own = answer.source !== 'product' && answer.sku !== productSku.trim() ? answer.sku : null
      if (!own) { counts.followsProduct++; continue }
      const data: { channelSku?: string; liveChannelSku?: string } = {}
      if (!listing.channelSku?.trim()) data.channelSku = own
      if (!listing.liveChannelSku?.trim() && !isStillDraftListing(listing)) data.liveChannelSku = own
      if (!data.channelSku && !data.liveChannelSku) { counts.alreadySet++; continue }
      if (apply) {
        const written = await db.channelListing.updateMany({
          where: { id: listing.id, ...(data.channelSku ? { channelSku: listing.channelSku } : {}), ...(data.liveChannelSku ? { liveChannelSku: listing.liveChannelSku } : {}) },
          data,
        })
        if (written.count !== 1) { counts.changedMeanwhile++; continue }
      }
      if (data.channelSku) counts.channelSkuSet++
      if (data.liveChannelSku) counts.liveChannelSkuSet++
    }
    if (page.length < take) break
    after = page[page.length - 1].id
  }
  return report
}
