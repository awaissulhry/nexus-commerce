/**
 * Sheet publish parity, step 7 — eBay listings held by the Inventory API (offers per SKU and marketplace).
 *
 * - Pause: the offer of THIS marketplace gets availableQuantity 0 (bulk_update_price_quantity, offers only — the
 *   inventory item's own quantity is shared by every marketplace and is not touched), then the Nexus hold. Only when
 *   the ACCOUNT's out-of-stock preference is on; otherwise eBay would end the listing at 0, so nothing is sent.
 * - Resume: lift the hold and send the real stock (hold.ts).
 * - End: withdraw — the whole item group for a family, the one offer for a single SKU.
 * - Relist: publish again — eBay answers with the listing id, written on this business's rows of this destination.
 * - Delete: withdraw (unless eBay already ended it), then delete THIS marketplace's offer of every SKU; the inventory
 *   items and the item group stay (other marketplaces share them). Rows whose offer is gone go back to the inert draft
 *   shape (their saved offer id for this marketplace is forgotten) and read Not listed until their Status column lists
 *   them again (Active or Inactive, then Publish).
 * Every call goes through `ebaySend` → the channel gateway (account token, state, rate bucket, ledger, publish mode).
 */
import { deleteDoneSentence } from '@nexus/shared/listing-actions'
import prisma from '../../../db.js'
import { ebaySend } from '../../gateway/ebay.js'
import { ebayListingLanguage } from '../../gateway/channels.js'
import { readEbayOutOfStockPreference } from '../../channel-delist.service.js'
import { ebayFixedPriceOfferOf, ebayMarketplaceIdOf } from '../../ebay-price-readback.service.js'
import { ebayHostOf, ebayWriteRefusal } from '../../ebay-publish-gate.service.js'
import { holdRows, liftHolds, returnToDraft, sendCurrentStock } from './hold.js'
import type { ActionContext, ActionListing, AdapterRowResult, ListingActionAdapter } from './types.js'
import { messageOf, object, rowResult } from './types.js'

const BULK_MAX = 25

async function headersFor(marketplace: string, marketplaceId: string) {
  const lang = await ebayListingLanguage(marketplace)
  return { Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Language': lang, 'Accept-Language': lang, 'X-EBAY-C-MARKETPLACE-ID': marketplaceId }
}

/** The FIXED_PRICE offer of this marketplace: the id Nexus saved when it published, else eBay's own answer. */
async function offerIdOf(row: ActionListing, ctx: ActionContext, api: string, marketplaceId: string, headers: Record<string, string>): Promise<string | null> {
  const pa = object(row.platformAttributes)
  const saved = object(pa.__offerIds)[marketplaceId] ?? pa.offerId
  if (typeof saved === 'string' && saved) return saved
  const res = await ebaySend(ctx.destination.accountId, `${api}/sell/inventory/v1/offer?sku=${encodeURIComponent(row.sku)}&marketplace_id=${marketplaceId}`, { headers })
  if (!res.ok) return null
  return ebayFixedPriceOfferOf(((await res.json().catch(() => ({}))) as { offers?: unknown }).offers, marketplaceId)?.offerId ?? null
}

async function bodyText(res: Response) { return (await res.text().catch(() => '')).slice(0, 300) }

export const ebayInventoryListingActions: ListingActionAdapter = {
  async run(action, targets, ctx) {
    if (action === 'resume') return liftHolds(targets, ctx)
    const api = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'
    const refusal = ebayWriteRefusal(ebayHostOf(api))
    if (refusal) return targets.map(row => rowResult(row, 'NOT_SENT', `eBay writes are switched off on this server (${refusal}). Nothing was sent.`))
    const marketplaceId = ebayMarketplaceIdOf(ctx.destination.marketplace)
    if (!marketplaceId) return targets.map(row => rowResult(row, 'FAILED', `eBay has no marketplace for ${ctx.destination.marketplace}.`))
    const headers = await headersFor(ctx.destination.marketplace, marketplaceId)
    const send = (path: string, init: RequestInit = {}) => ebaySend(ctx.destination.accountId, `${api}${path}`, { ...init, headers })

    if (action === 'pause') {
      const preference = await readEbayOutOfStockPreference(ctx.destination.accountId, ctx.destination.marketplace)
      if (preference !== 'ON') {
        const message = preference === 'OFF'
          ? 'This eBay account\'s out-of-stock control is off, so quantity 0 would end the listing. Nothing was sent.'
          : 'Nexus could not confirm that this eBay account\'s out-of-stock control is on. Nothing was sent.'
        return targets.map(row => rowResult(row, 'NOT_SENT', message))
      }
      const results: AdapterRowResult[] = []
      const withOffer: Array<{ row: ActionListing; offerId: string }> = []
      for (const row of targets) {
        try {
          const offerId = await offerIdOf(row, ctx, api, marketplaceId, headers)
          if (offerId) withOffer.push({ row, offerId })
          else results.push(rowResult(row, 'FAILED', `eBay has no single fixed-price offer for ${row.sku} on ${marketplaceId}.`))
        } catch (err) { results.push(rowResult(row, 'FAILED', `Nexus could not read the eBay offer (${messageOf(err)}).`)) }
      }
      const held: Array<{ id: string; evidence: Record<string, unknown> }> = []
      for (let i = 0; i < withOffer.length; i += BULK_MAX) {
        const chunk = withOffer.slice(i, i + BULK_MAX)
        try {
          const res = await send('/sell/inventory/v1/bulk_update_price_quantity', { method: 'POST',
            body: JSON.stringify({ requests: chunk.map(({ row, offerId }) => ({ sku: row.sku, offers: [{ offerId, availableQuantity: 0 }] })) }) })
          const json = res.ok ? (await res.json().catch(() => ({}))) as { responses?: Array<{ sku?: string; statusCode?: number; errors?: Array<{ message?: string }> }> } : null
          if (!json) { const text = await bodyText(res); results.push(...chunk.map(({ row }) => rowResult(row, res.status >= 500 ? 'UNKNOWN' : 'FAILED', `eBay answered ${res.status}: ${text}`))); continue }
          for (const { row, offerId } of chunk) {
            const answer = json.responses?.find(r => r.sku === row.sku)
            if (answer && (answer.statusCode ?? 500) < 300) {
              const evidence = { offerId, marketplaceId, outOfStockPreference: preference }
              held.push({ id: row.id, evidence })
              results.push(rowResult(row, 'DONE', 'eBay shows quantity 0 on this marketplace; the offer stays. Nexus holds its stock pushes.', evidence))
            } else results.push(rowResult(row, answer ? 'FAILED' : 'UNKNOWN', answer?.errors?.map(e => e.message).join(' | ') || 'eBay did not confirm quantity 0.'))
          }
        } catch (err) { results.push(...chunk.map(({ row }) => rowResult(row, 'UNKNOWN', `No answer from eBay (${messageOf(err)}). Check the listing on eBay.`))) }
      }
      await holdRows(ctx, held)
      return results
    }

    // End, Relist and Delete reach the whole listing: the family's item group, or the one offer of a single SKU.
    const family = ctx.family
    const isGroup = family.some(row => !row.isParent) && family.some(row => row.isParent)
    const coordinateRows = { id: { in: family.map(row => row.id) }, channel: 'EBAY', marketplace: ctx.destination.marketplace,
      channelConnectionId: ctx.destination.accountId, aliasKey: ctx.destination.aliasKey }
    // Delete of a listing eBay already withdrew (every row reads Ended here) needs no withdraw.
    const listed = family.filter(row => row.externalListingId)
    const alreadyEnded = action === 'delete' && listed.length > 0 && listed.every(row => String(row.listingStatus).toUpperCase() === 'ENDED')
    if (alreadyEnded) return deleteOffers(targets, ctx, { marketplaceId, isGroup, send })
    let res: Response
    try {
      if (isGroup) {
        res = await send(`/sell/inventory/v1/offer/${action === 'relist' ? 'publish_by_inventory_item_group' : 'withdraw_by_inventory_item_group'}`, {
          method: 'POST', body: JSON.stringify({ inventoryItemGroupKey: ctx.familySku, marketplaceId }) })
      } else {
        const row = targets[0] ?? family[0]
        const offerId = row ? await offerIdOf(row, ctx, api, marketplaceId, headers) : null
        if (!offerId) return targets.map(target => rowResult(target, 'FAILED', `eBay has no fixed-price offer for ${target.sku} on ${marketplaceId}.`))
        res = await send(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/${action === 'relist' ? 'publish' : 'withdraw'}`, { method: 'POST', body: '{}' })
      }
    } catch (err) {
      return targets.map(row => rowResult(row, 'UNKNOWN', `No answer from eBay (${messageOf(err)}). Check the listing on eBay.`))
    }
    if (!res.ok && res.status !== 204) {
      const text = await bodyText(res)
      return targets.map(row => rowResult(row, res.status >= 500 ? 'UNKNOWN' : 'FAILED', `eBay answered ${res.status}: ${text}`))
    }
    if (action === 'delete') return deleteOffers(targets, ctx, { marketplaceId, isGroup, send })
    if (action === 'end') {
      await prisma.channelListing.updateMany({ where: coordinateRows,
        data: { listingStatus: 'ENDED', offerActive: false, offerClosedAt: null, offerClosedBy: null, offerCloseReason: null } })
      await prisma.outboundSyncQueue.updateMany({ where: { channelListingId: { in: coordinateRows.id.in }, syncStatus: 'PENDING' },
        data: { syncStatus: 'CANCELLED', errorMessage: 'Listing ended from the product sheet' } })
      return targets.map(row => rowResult(row, 'DONE', 'Withdrawn on eBay. Relist publishes it again.', { marketplaceId, group: isGroup }))
    }
    const answer = (await res.json().catch(() => ({}))) as { listingId?: unknown }
    const listingId = typeof answer.listingId === 'string' && /^\d+$/.test(answer.listingId) ? answer.listingId : null
    await prisma.channelListing.updateMany({ where: coordinateRows,
      data: { ...(listingId ? { externalListingId: listingId } : {}), listingStatus: 'ACTIVE', isPublished: true, offerActive: true, offerClosedAt: null, offerClosedBy: null, offerCloseReason: null } })
    await sendCurrentStock(coordinateRows.id.in)
    return targets.map(row => rowResult(row, 'DONE', listingId ? `Published on eBay again (item ${listingId}). Nexus queued its stock.` : 'Published on eBay again. Nexus queued its stock.', { marketplaceId, listingId }))
  },
}

/** Withdrawn: delete THIS marketplace's offer of every SKU (never the inventory items), then forget them here. */
async function deleteOffers(targets: ActionListing[], ctx: ActionContext, call: {
  marketplaceId: string; isGroup: boolean; send: (path: string, init?: RequestInit) => Promise<Response>
}): Promise<AdapterRowResult[]> {
  // A family's offers are its variations'; the main product of a group has none of its own.
  const sellable = ctx.family.filter(row => !(call.isGroup && row.isParent))
  const gone = new Map<string, string | null>()
  const failed = new Map<string, AdapterRowResult>()
  for (const row of sellable) {
    try {
      const offerId = await savedOrLiveOfferId(row, call)
      if (offerId === undefined) {
        failed.set(row.id, rowResult(row, 'UNKNOWN', 'Withdrawn, but Nexus could not read this SKU\'s offer on eBay, so it is kept here. Delete again.'))
        continue
      }
      if (!offerId) { gone.set(row.id, null); continue }
      const res = await call.send(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method: 'DELETE' })
      // 404: the offer is already gone, which is what Delete wants.
      if (res.ok || res.status === 204 || res.status === 404) { gone.set(row.id, offerId); continue }
      const text = await bodyText(res)
      failed.set(row.id, rowResult(row, res.status >= 500 ? 'UNKNOWN' : 'FAILED', `Withdrawn, but eBay kept the offer (${res.status}: ${text}). Delete again, or delete the offer on eBay.`))
    } catch (err) {
      failed.set(row.id, rowResult(row, 'UNKNOWN', `Withdrawn, but eBay did not answer the offer delete (${messageOf(err)}). Check the listing on eBay.`))
    }
  }
  // The main product of a group is forgotten with its last offer.
  const forget = ctx.family.filter(row => gone.has(row.id) || (call.isGroup && row.isParent && !failed.size))
  await returnToDraft(ctx, forget, row => {
    const pa = object(row.platformAttributes)
    const offerIds = { ...object(pa.__offerIds) }
    const deletedOffer = offerIds[call.marketplaceId] ?? gone.get(row.id) ?? null
    delete offerIds[call.marketplaceId]
    const next: Record<string, unknown> = { ...pa, __offerIds: offerIds }
    if (deletedOffer && pa.offerId === deletedOffer) delete next.offerId
    return { platformAttributes: next }
  })
  return targets.map(row => failed.get(row.id)
    ?? (forget.some(f => f.id === row.id)
      ? rowResult(row, 'DONE', `${deleteDoneSentence(`eBay · ${ctx.destination.marketplace}`)} The inventory item stays for other marketplaces.`,
        { oldExternalListingId: row.externalListingId, marketplaceId: call.marketplaceId, deletedOfferId: gone.get(row.id) ?? null })
      : rowResult(row, 'FAILED', 'Kept: an offer of this listing is still on eBay. Delete again.')))
}

/** The offer to delete: the id Nexus saved, else eBay's own answer; null = eBay has none here; undefined = unreadable. */
async function savedOrLiveOfferId(row: ActionListing, call: { marketplaceId: string; send: (path: string, init?: RequestInit) => Promise<Response> }): Promise<string | null | undefined> {
  const pa = object(row.platformAttributes)
  const saved = object(pa.__offerIds)[call.marketplaceId] ?? pa.offerId
  if (typeof saved === 'string' && saved) return saved
  const res = await call.send(`/sell/inventory/v1/offer?sku=${encodeURIComponent(row.sku)}&marketplace_id=${call.marketplaceId}`)
  if (res.status === 404) return null
  if (!res.ok) return undefined
  return ebayFixedPriceOfferOf(((await res.json().catch(() => ({}))) as { offers?: unknown }).offers, call.marketplaceId)?.offerId ?? null
}
