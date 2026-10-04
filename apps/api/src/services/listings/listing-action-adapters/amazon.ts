/**
 * Sheet publish parity, step 7 (build shape v2, P3) — Amazon.
 *
 * - Pause offer = remove THIS market's offer, Resume offer = put it back. Both reuse SCT.6 (`closeMarketOffers` /
 *   `reopenMarketOffers`): the live offer is captured before the close, waiting quantity pushes are cancelled, the
 *   reopen checks the shared EU quantity. Never quantity 0 — Amazon EU keeps one quantity per SKU for every EU market,
 *   so 0 would stop all of them. FBA offers may be paused too (`allowFba`): only the offer goes; Amazon's FBA quantity
 *   is never sent or changed, and a reopen replays the offer without rejoining the stock pool or sending any quantity.
 * - Delete listing = delete the listing in THIS marketplace only (`deleteAmazonListingOnChannel`, the hard-delete
 *   cascade's own channel half), variations first and a main product last. An FBA offer may be deleted too (Owner D2 A,
 *   2026-10-04): the review warned with Amazon's unit count; Amazon's own fulfilment answer is read first and kept on the
 *   audit record, never a reason to refuse. Then the row goes back to the inert draft shape and reads Not listed until
 *   its Status column lists it again (Active or Inactive, then Publish).
 * No End or Relist on Amazon. Sync Control's audit row is kept for Pause and Resume.
 */
import { AMAZON_NO_END, deleteDoneSentence, SHEET_PAUSE_REASON, type ListingAction } from '@nexus/shared/listing-actions'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import prisma from '../../../db.js'
import { isFbaCoordinate } from '../../../lib/amazon-fulfillment.js'
import { getAmazonSellerId } from '../../../lib/amazon-sp-client.js'
import { closeMarketOffers, reopenMarketOffers, type MarketOfferResult, type MarketOfferRowResult } from '../../amazon-market-offer.service.js'
import { readAmazonOfferLive } from '../../amazon/purchasable-offer.js'
import { MARKETPLACE_ID_MAP } from '../../amazon/flat-file.service.js'
import { deleteAmazonListingOnChannel } from '../../channel-delist.service.js'
import { logger } from '../../../utils/logger.js'
import { returnToDraft } from './hold.js'
import type { ActionContext, ActionListing, AdapterRowResult, ListingActionAdapter } from './types.js'
import { messageOf, rowResult } from './types.js'

function outcomeOf(action: ListingAction, row: MarketOfferRowResult): Pick<AdapterRowResult, 'outcome' | 'message'> {
  switch (row.action) {
    case 'CLOSED': return { outcome: 'DONE', message: row.fba
      ? 'Offer removed in this market. Amazon keeps your FBA units and their quantity; other markets keep selling.'
      : 'Offer removed in this market. Other markets keep selling.' }
    case 'REOPENED': return { outcome: 'DONE', message: row.fromNexus
      ? (row.fba ? 'Offer added at Nexus\'s price (this listing was created inactive). Amazon keeps its own FBA quantity; Nexus sent none.'
        : 'Offer added at Nexus\'s price (this listing was created inactive); Nexus queued its current stock.')
      : row.fba ? 'Offer put back at its saved price. Amazon keeps its own FBA quantity; Nexus sent none.'
        : 'Offer put back at its saved price; Nexus queued its current stock.' }
    case 'DRY_RUN': return { outcome: 'NOT_SENT', message: 'Amazon writes are in preview mode on this server. Nothing changed.' }
    case 'SKIPPED_FBA': return { outcome: 'SKIPPED', message: 'Amazon runs this offer (FBA); Nexus did not change it.' }
    case 'SKIPPED_ALREADY': return { outcome: 'SKIPPED', message: 'Already inactive.' }
    case 'SKIPPED_NOT_CLOSED': return { outcome: 'SKIPPED', message: 'Not inactive.' }
    case 'SKIPPED_NO_LISTING': return { outcome: 'SKIPPED', message: 'No Amazon listing for this SKU here.' }
    default: return { outcome: 'FAILED', message: row.detail ? `Amazon refused: ${row.detail}` : `${action === 'pause' ? 'Pausing' : 'Resuming'} failed.` }
  }
}

const isFba = (row: ActionListing) => isFbaCoordinate({ fulfillmentMethod: row.fulfillmentMethod, platformAttributes: row.platformAttributes, product: { fulfillmentMethod: row.productFulfillmentMethod } })

/** Delete in this marketplace: variations first; a main product only once no variation of it is left on Amazon here. */
async function deleteRows(targets: ActionListing[], ctx: ActionContext): Promise<AdapterRowResult[]> {
  const marketplaceId = MARKETPLACE_ID_MAP[ctx.destination.marketplace.toUpperCase()]
  if (!marketplaceId) return targets.map(row => rowResult(row, 'FAILED', `Amazon has no marketplace ${ctx.destination.marketplace}.`))
  let sellerId: string
  try {
    sellerId = await getAmazonSellerId(ctx.destination.accountId)
    if (!sellerId) throw new Error('no seller id')
  } catch (err) {
    return targets.map(row => rowResult(row, 'NOT_SENT', `The Amazon account of this destination has no seller id (${messageOf(err)}). Nothing was sent.`))
  }
  const results = new Map<string, AdapterRowResult>()
  const deleted: ActionListing[] = []
  const ordered = [...targets.filter(row => !row.isParent), ...targets.filter(row => row.isParent)]
  for (const row of ordered) {
    if (row.isParent) {
      const left = ctx.family.filter(other => !other.isParent && !isStillDraftListing(other) && !deleted.some(gone => gone.id === other.id))
      if (left.length) {
        results.set(row.id, rowResult(row, 'SKIPPED', `Kept: ${left.length} variation${left.length === 1 ? ' is' : 's are'} still on Amazon here (${left.slice(0, 3).map(other => other.sku).join(', ')}${left.length > 3 ? ', …' : ''}). The main product is deleted after them.`))
        continue
      }
    }
    // Amazon's own fulfilment answer, kept on the audit record (an FBA offer is deleted too; its relist sends no quantity).
    const live = await readAmazonOfferLive({ sellerId, sku: row.sku, marketplaceId })
    const fulfillmentChannels = live?.read === 'ok' ? live.fulfillmentChannels.filter(Boolean) : null
    const answer = await deleteAmazonListingOnChannel({ sellerId, sku: row.sku, marketplaceId })
    if (answer.dryRun || answer.outcome === 'NOT_SENT') { results.set(row.id, rowResult(row, 'NOT_SENT', 'Amazon writes are in preview mode on this server. Nothing changed.')); continue }
    if (!answer.success) { results.set(row.id, rowResult(row, 'UNKNOWN', answer.error ?? 'Amazon did not confirm the delete. Check the listing on Amazon.')); continue }
    deleted.push(row)
    results.set(row.id, rowResult(row, 'DONE', `${deleteDoneSentence(`Amazon · ${ctx.destination.marketplace}`)} Other markets keep their listings.`,
      { oldExternalListingId: row.externalListingId, marketplaceId, submissionId: answer.submissionId ?? null, fba: isFba(row), fulfillmentChannels }))
  }
  await returnToDraft(ctx, deleted)
  return targets.map(row => results.get(row.id)!)
}

export const amazonListingActions: ListingActionAdapter = {
  async run(action, targets, ctx) {
    if (action === 'end' || action === 'relist') return targets.map(row => rowResult(row, 'NOT_SENT', AMAZON_NO_END))
    if (!targets.length) return []
    if (action === 'delete') return deleteRows(targets, ctx)
    const { marketplace, accountId, aliasKey } = ctx.destination
    const coordinates = targets.map(row => ({ productId: row.productId, marketplace, channelConnectionId: accountId, aliasKey }))
    let result: MarketOfferResult
    try {
      result = action === 'pause'
        ? await closeMarketOffers({ targets: coordinates, actor: ctx.actor, reason: SHEET_PAUSE_REASON, allowFba: true })
        : await reopenMarketOffers({ targets: coordinates, actor: ctx.actor, allowFba: true })
    } catch (err) {
      // The first row failed before anything was changed (SCT.6 throws only then).
      return targets.map(row => rowResult(row, 'FAILED', `Nothing was changed: ${messageOf(err)}`))
    }
    const byProduct = new Map(result.results.map(r => [r.productId, r]))
    const done = result.results.filter(r => r.action === 'CLOSED' || r.action === 'REOPENED')
    const snapshots = done.length ? await prisma.channelListing.findMany({
      where: { id: { in: targets.filter(t => byProduct.get(t.productId)?.action === 'CLOSED' || byProduct.get(t.productId)?.action === 'REOPENED').map(t => t.id) } },
      select: { id: true, offerCloseSnapshot: true },
    }) : []
    const snapshotOf = new Map(snapshots.map(s => [s.id, s.offerCloseSnapshot]))
    const rows = targets.map(row => {
      const answer = byProduct.get(row.productId)
      if (!answer) return rowResult(row, 'FAILED', result.error ? `Not attempted: ${result.error}` : 'Not attempted.')
      const { outcome, message } = outcomeOf(action, answer)
      return rowResult(row, outcome, message, outcome === 'DONE' ? { amazon: answer.action, fba: answer.fba === true, offerSnapshot: snapshotOf.get(row.id) ?? null } : undefined)
    })
    // Sync Control's own history, as its CLOSE_OFFER / REOPEN_OFFER write it (routes/sync-control.routes.ts).
    if (done.length) {
      try {
        await prisma.syncControlAudit.createMany({ data: done.map(r => ({
          actor: ctx.actor, scopeType: 'LISTING', scopeId: `${r.productId}:AMAZON:${r.marketplace}`, scopeName: `${r.sku ?? '?'}@AMAZON:${r.marketplace}`,
          field: 'offerClosed', after: { closed: r.action === 'CLOSED' } as object, reason: `Product sheet: ${action === 'pause' ? 'Pause offer' : 'Resume offer'}`,
        })) })
      } catch (err) { logger.warn('[listing-action] sync control audit write failed', { error: messageOf(err) }) }
    }
    return rows
  },
}

export type { ActionListing }
