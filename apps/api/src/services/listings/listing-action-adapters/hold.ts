/**
 * Sheet publish parity, step 7 (build shape v2, P3) — the Nexus side of the selling actions, shared by the adapters.
 *
 * - The HOLD (Pause offer on eBay, Shopify and Etsy): once the channel confirmed the pause, the listing row carries
 *   `offerClosedAt` (reason `sheet-pause`), so the push lock (`assertPushAllowed`, packages/shared/push-lock.ts) refuses
 *   every later stock push until Resume lifts it. Written only on the exact rows the channel confirmed.
 * - Resume: lift the sheet's own hold and send the CURRENT stock (never a remembered number: that could oversell). An
 *   eBay listing an OLDER Claude close-listing paused (pinned at 0, no hold — `oldClosePause`) gets its pin lifted
 *   back to Follow instead, as that close's own reopen did.
 * - Delete: the row goes back to the inert draft shape (as `draftListingFields` makes a draft); the old channel id is
 *   kept on the row's audit record (the engine's ChannelListingSnapshot). That record and the draft shape make the row
 *   read Not listed (`readListingDeletions`) until its Status column lists it again.
 * Amazon keeps SCT.6's own close/reopen (amazon-market-offer.service.ts), which writes the hold fields itself.
 */
import { SHEET_PAUSE_REASON } from '@nexus/shared/listing-actions'
import prisma from '../../../db.js'
import { isFbaCoordinate } from '../../../lib/amazon-fulfillment.js'
import { syncActivatedListings } from '../../listing-activation-sync.service.js'
import { logger } from '../../../utils/logger.js'
import type { ActionContext, ActionListing, AdapterRowResult } from './types.js'
import { messageOf, rowResult } from './types.js'

const coordinate = (ctx: ActionContext) => ({
  channel: ctx.destination.channel, marketplace: ctx.destination.marketplace,
  channelConnectionId: ctx.destination.accountId, aliasKey: ctx.destination.aliasKey,
})

/** Hold the rows the channel confirmed paused, and cancel the stock pushes already waiting for them. */
export async function holdRows(ctx: ActionContext, rows: Array<{ id: string; evidence?: Record<string, unknown> }>) {
  if (!rows.length) return
  const now = new Date()
  for (const row of rows) {
    await prisma.channelListing.updateMany({
      where: { id: row.id, ...coordinate(ctx) },
      data: {
        offerClosedAt: now, offerClosedBy: ctx.actor, offerCloseReason: SHEET_PAUSE_REASON, offerActive: false,
        offerCloseSnapshot: { channel: ctx.destination.channel, source: 'product-sheet', previewId: ctx.previewId, ...(row.evidence ?? {}) } as never,
      },
    })
  }
  await prisma.outboundSyncQueue.updateMany({
    where: { channelListingId: { in: rows.map(r => r.id) }, syncStatus: 'PENDING' },
    data: { syncStatus: 'CANCELLED', errorMessage: 'Paused from the product sheet' },
  })
}

/** A row held by something other than Pause offer (an Amazon SCT.6 close, an old flat-file action): not lifted here. */
export const heldElsewhere = (row: Pick<ActionListing, 'offerClosedAt' | 'offerCloseReason'>) =>
  !!row.offerClosedAt && row.offerCloseReason !== SHEET_PAUSE_REASON
export const heldElsewhereSentence = (row: Pick<ActionListing, 'offerCloseReason'>) =>
  `Held by "${row.offerCloseReason ?? 'an earlier action'}", not by Pause offer. Change it where it was set.`

/** Lift the sheet's own hold on exactly these rows (compare-and-set on the reason). Returns the ids it lifted. */
export async function liftHoldOn(ctx: ActionContext, rows: Array<Pick<ActionListing, 'id'>>): Promise<string[]> {
  const lifted: string[] = []
  for (const row of rows) {
    const saved = await prisma.channelListing.updateMany({
      where: { id: row.id, ...coordinate(ctx), offerCloseReason: SHEET_PAUSE_REASON },
      data: { offerClosedAt: null, offerClosedBy: null, offerCloseReason: null, offerActive: true },
    })
    if (saved.count) lifted.push(row.id)
  }
  return lifted
}

/**
 * Resume sends the CURRENT stock. A row that follows the stock gets it from the activation lane (pool, buffer, policy:
 * `syncActivatedListings`). A hand-pinned row keeps its pin — the pause never changed it — but the activation lane
 * sends nothing for a pin, so its pinned quantity is queued here, on the same instant lane (the dispatchers still clamp
 * it to what is available). FBA never: Amazon owns that quantity.
 */
export async function sendCurrentStock(listingIds: string[]): Promise<void> {
  if (!listingIds.length) return
  await syncActivatedListings(listingIds)
  try {
    const pinned = await prisma.channelListing.findMany({
      where: { id: { in: listingIds }, followMasterQuantity: false, offerClosedAt: null, syncPaused: false },
      select: { id: true, productId: true, channel: true, region: true, marketplace: true, externalListingId: true, quantity: true,
        quantityOverride: true, fulfillmentMethod: true, platformAttributes: true, product: { select: { fulfillmentMethod: true } } },
    })
    const rows = pinned
      .map(row => ({ row, quantity: row.quantityOverride ?? row.quantity }))
      .filter(({ row, quantity }) => Number.isSafeInteger(quantity) && (quantity as number) >= 0 && !isFbaCoordinate(row))
      .map(({ row, quantity }) => ({
        productId: row.productId, channelListingId: row.id, targetChannel: row.channel, targetRegion: row.region ?? undefined,
        syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING', externalListingId: row.externalListingId ?? undefined,
        payload: { quantity, source: 'LISTING_RESUMED', marketplace: row.marketplace }, retryCount: 0, maxRetries: 3, holdUntil: new Date(Date.now() + 5_000),
      }))
    if (!rows.length) return
    const { enqueueOutboundRowsInstant } = await import('../../outbound-enqueue.js')
    await enqueueOutboundRowsInstant(prisma, rows, { source: 'LISTING_RESUMED' })
  } catch (err) {
    logger.warn('[listing-action] pinned quantity after resume was not queued', { error: messageOf(err), listingIds: listingIds.slice(0, 10) })
  }
}

/**
 * Clear the presence marks an OLDER Claude close-listing wrote (`endedAt`, `endedBy`, `endedReason`; raw-SQL migration
 * 20260913180000_pr_presence, not in the generated client), where the database has them.
 */
export async function clearOldCloseMarks(listingIds: string[]): Promise<void> {
  if (!listingIds.length) return
  const has = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ChannelListing' AND column_name IN ('endedAt', 'endedBy', 'endedReason')`)
  if ((has[0]?.n ?? 0) !== 3) return
  await prisma.$executeRawUnsafe(`UPDATE "ChannelListing" SET "endedAt" = NULL, "endedBy" = NULL, "endedReason" = NULL WHERE id = ANY($1::text[]) AND "endedAt" IS NOT NULL`, listingIds)
}

/**
 * Build shape v2 (P13) — Resume of an eBay listing an OLDER Claude close-listing paused (`oldClosePause`): that close
 * pinned the quantity at 0 through the Matrix and held nothing, so there is no hold to lift — the pin goes back to
 * Follow, as its own reopen did (`set-follow`), and its presence mark is cleared. Compare-and-set on the pin at 0, on
 * this exact coordinate: a pin someone changed since is left alone. The caller sends the current stock.
 */
async function liftOldClosePin(ctx: ActionContext, row: ActionListing): Promise<boolean> {
  const saved = await prisma.channelListing.updateMany({
    where: { id: row.id, ...coordinate(ctx), offerClosedAt: null, followMasterQuantity: false,
      OR: [{ quantityOverride: 0 }, { quantityOverride: null, quantity: 0 }] },
    data: { followMasterQuantity: true, quantityOverride: null },
  })
  if (!saved.count) return false
  try { await clearOldCloseMarks([row.id]) } catch (err) {
    logger.warn('[listing-action] older close mark not cleared; the listing follows the stock anyway', { error: messageOf(err), listingId: row.id })
  }
  return true
}

/**
 * Resume = lift the sheet's own hold and send the current stock (the normal quantity lane, through the gateway).
 * A row held by something else is not lifted here. An eBay row an older Claude close paused gets its pin lifted.
 */
export async function liftHolds(targets: ActionListing[], ctx: ActionContext): Promise<AdapterRowResult[]> {
  const results: AdapterRowResult[] = []
  const lifted: string[] = []
  for (const row of targets) {
    if (!row.offerClosedAt && row.oldClosePause) {
      if (await liftOldClosePin(ctx, row)) {
        lifted.push(row.id)
        results.push(rowResult(row, 'DONE', 'Pin at 0 lifted (an earlier Claude close set it): the listing follows the stock again. Nexus queued the current stock for the channel; it arrives within a minute.'))
      } else results.push(rowResult(row, 'SKIPPED', 'Changed while resuming. Open the sheet again.'))
      continue
    }
    if (!row.offerClosedAt) { results.push(rowResult(row, 'SKIPPED', 'Not inactive.')); continue }
    if (heldElsewhere(row)) { results.push(rowResult(row, 'SKIPPED', heldElsewhereSentence(row))); continue }
    const [id] = await liftHoldOn(ctx, [row])
    if (id) {
      lifted.push(id)
      results.push(rowResult(row, 'DONE', 'Hold lifted. Nexus queued the current stock for the channel; it arrives within a minute.'))
    } else results.push(rowResult(row, 'SKIPPED', 'Changed while resuming. Open the sheet again.'))
  }
  await sendCurrentStock(lifted)
  return results
}

/**
 * After a confirmed Delete: the rows go back to the inert draft shape — DRAFT, not published, no channel id, stock sync
 * held (`draftListingFields`, pim/draft-listing.service.ts; `STILL_DRAFT_LISTING`, push-lock.ts) — on this exact
 * coordinate only, and their waiting pushes are cancelled. `extra` adds per-row fields (dead channel ids to forget).
 */
export async function returnToDraft(ctx: ActionContext, rows: ActionListing[], extra?: (row: ActionListing) => Record<string, unknown>) {
  if (!rows.length) return
  for (const row of rows) {
    await prisma.channelListing.updateMany({
      where: { id: row.id, ...coordinate(ctx) },
      data: {
        listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true,
        offerActive: true, offerClosedAt: null, offerClosedBy: null, offerCloseReason: null,
        version: { increment: 1 },
        ...(extra?.(row) ?? {}),
      } as never,
    })
  }
  await prisma.outboundSyncQueue.updateMany({
    where: { channelListingId: { in: rows.map(r => r.id) }, syncStatus: 'PENDING' },
    data: { syncStatus: 'CANCELLED', errorMessage: 'Listing deleted from the channel' },
  })
}
