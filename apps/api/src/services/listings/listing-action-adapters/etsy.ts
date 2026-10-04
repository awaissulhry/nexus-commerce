/**
 * Build shape v2 (P3) — Etsy: Pause offer = Etsy's own "inactive", Resume offer = "active". Never quantity 0: a
 * sold-out Etsy listing costs a renewal fee to sell again. One Etsy listing carries the whole family, so every row of
 * it on this shop moves together (reach 'listing'). No End or Relist; Delete is not available yet.
 *
 * Through `setEtsyListingState` (etsy/listing-write.service.ts → the Etsy write client → the channel gateway: publish
 * mode, account state, rate bucket, ledger) — the writer close-listing used before (#251). Once Etsy accepted the
 * change, the rows read INACTIVE and carry the Nexus hold (`offerClosedAt`, reason `sheet-pause`, hold.ts), so no stock
 * push reaches an inactive listing. Resume makes it active (Etsy may set its quantity to 1 and charge a renewal; the
 * caller accepted that by choosing Resume), lifts the hold and sends the current stock. A row held by something other
 * than Pause offer is not touched.
 */
import { ETSY_DELETE_NOT_YET, ETSY_NO_END } from '@nexus/shared/listing-actions'
import prisma from '../../../db.js'
import { etsyWriteRefusal } from '../../etsy-publish-gate.service.js'
import { setEtsyListingState } from '../../etsy/listing-write.service.js'
import { heldElsewhere, heldElsewhereSentence, holdRows, liftHoldOn, sendCurrentStock } from './hold.js'
import type { ActionContext, ActionListing, AdapterRowResult, ListingActionAdapter } from './types.js'
import { messageOf, rowResult } from './types.js'

/** A refusal the gateway or the writer made before sending → not sent; no answer → unknown; Etsy's own no → failed. */
function outcomeOfError(err: unknown): Pick<AdapterRowResult, 'outcome' | 'message'> {
  const name = (err as { name?: string } | null)?.name
  const message = messageOf(err)
  if (name === 'GatewayRefusal' || name === 'EtsyWriteRefusedError' || name === 'EtsyListingContentError')
    return { outcome: 'NOT_SENT', message: /nothing was sent/i.test(message) ? message : `${message.replace(/\.?\s*$/, '.')} Nothing was sent.` }
  if (name === 'EtsyWriteError') return { outcome: 'FAILED', message }
  return { outcome: 'UNKNOWN', message: `No answer from Etsy (${message}). Check the listing on Etsy before trying again.` }
}

const where = (ctx: ActionContext, ids: string[]) => ({
  id: { in: ids }, channel: 'ETSY', marketplace: ctx.destination.marketplace, channelConnectionId: ctx.destination.accountId, aliasKey: ctx.destination.aliasKey,
})

export const etsyListingActions: ListingActionAdapter = {
  async run(action, targets, ctx) {
    if (action === 'delete') return targets.map(row => rowResult(row, 'NOT_SENT', ETSY_DELETE_NOT_YET))
    if (action !== 'pause' && action !== 'resume') return targets.map(row => rowResult(row, 'NOT_SENT', ETSY_NO_END))
    const refusal = etsyWriteRefusal()
    if (refusal) return targets.map(row => rowResult(row, 'NOT_SENT', refusal))

    const results: AdapterRowResult[] = []
    const listings = new Map<string, ActionListing[]>()
    for (const row of targets) {
      const listingId = row.externalListingId?.trim() ?? ''
      if (!/^[1-9]\d*$/.test(listingId)) { results.push(rowResult(row, 'FAILED', 'This listing has no Etsy listing number.')); continue }
      listings.set(listingId, [...(listings.get(listingId) ?? []), row])
    }
    for (const [listingId, rows] of listings) {
      const family = ctx.family.filter(row => row.externalListingId?.trim() === listingId)
      const blocked = family.find(heldElsewhere)
      if (blocked) { results.push(...rows.map(row => rowResult(row, 'NOT_SENT', `${heldElsewhereSentence(blocked)} Nothing was sent.`))); continue }
      try {
        await setEtsyListingState({ accountId: ctx.destination.accountId, listingId,
          change: action === 'pause' ? { state: 'inactive' } : { state: 'active', acceptRenewalAndQuantityReset: true } })
      } catch (err) {
        const { outcome, message } = outcomeOfError(err)
        results.push(...rows.map(row => rowResult(row, outcome, message)))
        continue
      }
      const ids = family.map(row => row.id)
      if (action === 'pause') {
        await prisma.channelListing.updateMany({ where: where(ctx, ids), data: { listingStatus: 'INACTIVE' } })
        await holdRows(ctx, family.map(row => ({ id: row.id, evidence: { etsyListingId: listingId, state: 'inactive' } })))
        results.push(...rows.map(row => rowResult(row, 'DONE', 'Inactive on Etsy: buyers cannot find or buy it; the listing stays. Nexus holds its stock pushes.', { etsyListingId: listingId, state: 'inactive' })))
        continue
      }
      await prisma.channelListing.updateMany({ where: where(ctx, ids), data: { listingStatus: 'ACTIVE', isPublished: true } })
      // Rows paused before the hold existed (close-listing wrote only INACTIVE) have nothing to lift; they get the stock too.
      await liftHoldOn(ctx, family.filter(row => row.offerClosedAt))
      await sendCurrentStock(family.filter(row => !row.isParent).map(row => row.id))
      results.push(...rows.map(row => rowResult(row, 'DONE', 'Active on Etsy again. Etsy may have set its quantity to 1; Nexus queued the current stock.', { etsyListingId: listingId, state: 'active' })))
    }
    return results
  },
}
