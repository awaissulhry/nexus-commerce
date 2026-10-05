/**
 * Sheet publish parity, step 7 — eBay listings held by the Trading API (one ItemID per family and market).
 *
 * - Pause: quantity 0 on the chosen SKUs, then the Nexus hold. Only when the ITEM's own out-of-stock control is on —
 *   read with GetItem right before the change. With it off (or unknown), quantity 0 would END the item, so nothing is
 *   sent and End is the honest choice. When every variation of the item is chosen, the hard-delete unpublish does it
 *   (`unpublishEbay`, channel-delist.service.ts); a part of the item gets the same calls for its SKUs only.
 * - Resume: lift the hold and send the real stock (hold.ts).
 * - End: EndFixedPriceItem. The item number is KEPT on the listing (Relist needs it); the listing reads Ended.
 * - Relist: RelistFixedPriceItem. eBay answers with a NEW item number, written on this business's rows of this
 *   destination only (account + alias), then the current stock is sent.
 * - Delete: End (when the item is still live; an item eBay already ended needs no call), then Nexus forgets the item
 *   number: every row of the item on this destination goes back to the inert draft shape and reads Not listed until its
 *   Status column lists it again (a new item number). The old item number stays on each row's audit record.
 * Every call goes through `callTradingApi` → the channel gateway (account state, rate bucket, ledger, publish mode).
 * S4 (per-channel SKU) — a variation is named by the SKU eBay holds for its row (`ActionListing.sku`, `listingSendSku`):
 * the product SKU unless the row has its own confirmed SKU.
 */
import { deleteDoneSentence } from '@nexus/shared/listing-actions'
import prisma from '../../../db.js'
import { ebayAuthService } from '../../ebay-auth.service.js'
import { tryResolveConnection } from '../../connection-resolver.service.js'
import { ENDED_CONFIRMED, parseOutOfStockControl, unpublishEbay } from '../../channel-delist.service.js'
import {
  buildReviseInventoryStatusBatchXml, buildReviseInventoryStatusXml, callTradingApi, endFixedPriceItem, escapeXml,
  parseGetItemQuantities, relistFixedPriceItem, REVISE_INVENTORY_STATUS_MAX_ENTRIES, siteIdForMarket, type TradingCallContext,
} from '../../ebay-trading-api.service.js'
import { holdRows, liftHolds, returnToDraft, sendCurrentStock } from './hold.js'
import type { ActionContext, ActionListing, AdapterRowResult, ListingActionAdapter } from './types.js'
import { messageOf, rowResult } from './types.js'

const ACK_OK = new Set(['Success', 'Warning'])
const NOT_ENABLED = 'The real eBay API is not enabled on this server. Nothing was sent.'
const isGateRefusal = (err: unknown) => (err as { name?: string } | null)?.name === 'EbayWriteRefusedError'
  || (err as { code?: string } | null)?.code === 'EBAY_WRITE_REFUSED'
/** A received refusal ("eBay X Failure: …") is a failure; anything else is a lost answer, so the outcome is unknown. */
const failureOrUnknown = (row: ActionListing, err: unknown, call: string): AdapterRowResult => {
  const message = messageOf(err)
  if (isGateRefusal(err)) return rowResult(row, 'NOT_SENT', `eBay writes are switched off on this server. Nothing was sent.`)
  return new RegExp(`^eBay ${call} Failure:`, 'i').test(message)
    ? rowResult(row, 'FAILED', message.replace(/^eBay \w+ Failure:\s*/i, 'eBay refused: '))
    : rowResult(row, 'UNKNOWN', `No answer from eBay (${message}). Check the listing on eBay before trying again.`)
}

async function tradingContext(ctx: ActionContext): Promise<TradingCallContext | string> {
  const connection = await tryResolveConnection({ accountId: ctx.destination.accountId })
  if (!connection || connection.channelType !== 'EBAY') return 'The eBay account of this destination is not connected.'
  let siteId: string
  try { siteId = siteIdForMarket(ctx.destination.marketplace) } catch { return `eBay has no site for ${ctx.destination.marketplace}.` }
  try {
    const oauthToken = await ebayAuthService.getValidToken(connection.id)
    return { oauthToken, siteId, connectionId: ctx.destination.accountId, market: ctx.destination.marketplace }
  } catch (err) {
    return `eBay did not accept the account's login (${messageOf(err)}). Reconnect the eBay account.`
  }
}

/** Rows grouped by their eBay item number; rows without a valid one fail on their own. */
function byItem(targets: ActionListing[]) {
  const items = new Map<string, ActionListing[]>()
  const missing: ActionListing[] = []
  for (const row of targets) {
    const itemId = row.externalListingId?.trim()
    if (!itemId || !/^\d+$/.test(itemId)) { missing.push(row); continue }
    items.set(itemId, [...(items.get(itemId) ?? []), row])
  }
  return { items, missing }
}

function itemGetXml(itemId: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel><OutputSelector>Item.ItemID,Item.Quantity,Item.SellingStatus.QuantitySold,Item.SellingStatus.ListingStatus,Item.Variations.Variation.SKU,Item.Variations.Variation.Quantity,Item.Variations.Variation.SellingStatus.QuantitySold,Item.OutOfStockControl</OutputSelector></GetItemRequest>`
}

/** Quantity 0 on SOME variations of one item (the rest keep selling). */
async function pausePart(itemId: string, rows: ActionListing[], tctx: TradingCallContext): Promise<{ results: AdapterRowResult[]; held: Array<{ id: string; evidence: Record<string, unknown> }> }> {
  let raw: string
  try {
    const read = await callTradingApi('GetItem', itemGetXml(itemId), tctx)
    if (read.itemId?.startsWith('DRYRUN-')) return { results: rows.map(row => rowResult(row, 'NOT_SENT', NOT_ENABLED)), held: [] }
    raw = read.raw ?? ''
  } catch (err) {
    return { results: rows.map(row => rowResult(row, 'NOT_SENT', `Nexus could not read the listing on eBay (${messageOf(err)}). Nothing was sent.`)), held: [] }
  }
  const outOfStockControl = parseOutOfStockControl(raw, 'OutOfStockControl')
  if (outOfStockControl !== 'ON') {
    const message = outOfStockControl === 'OFF'
      ? 'This eBay listing\'s out-of-stock control is off, so quantity 0 would end it. Nothing was sent; use End listing instead.'
      : 'eBay did not say whether this listing\'s out-of-stock control is on, so nothing was sent.'
    return { results: rows.map(row => rowResult(row, 'NOT_SENT', message)), held: [] }
  }
  const item = parseGetItemQuantities(raw)
  if (item.listingStatus !== 'Active') return { results: rows.map(row => rowResult(row, 'NOT_SENT', `The listing is not active on eBay (${item.listingStatus ?? 'no status'}). Nothing was sent.`)), held: [] }
  const onItem = new Map(item.variations.map(v => [v.sku, v.available]))
  const results: AdapterRowResult[] = []
  const send: ActionListing[] = []
  for (const row of rows) {
    if (!item.variations.length) { send.push(row); continue }
    if (!onItem.has(row.sku)) results.push(rowResult(row, 'FAILED', `eBay item ${itemId} has no variation ${row.sku}.`))
    else send.push(row)
  }
  const held: Array<{ id: string; evidence: Record<string, unknown> }> = []
  const chunks: ActionListing[][] = []
  for (let i = 0; i < send.length; i += REVISE_INVENTORY_STATUS_MAX_ENTRIES) chunks.push(send.slice(i, i + REVISE_INVENTORY_STATUS_MAX_ENTRIES))
  for (const chunk of chunks) {
    const xml = item.variations.length
      ? buildReviseInventoryStatusBatchXml({ itemId, entries: chunk.map(row => ({ sku: row.sku, quantity: 0 })) })
      : buildReviseInventoryStatusXml({ itemId, sku: chunk[0].sku, quantity: 0 })
    try {
      const res = await callTradingApi('ReviseInventoryStatus', xml, tctx)
      if (res.itemId?.startsWith('DRYRUN-')) { results.push(...chunk.map(row => rowResult(row, 'NOT_SENT', NOT_ENABLED))); continue }
      if (!ACK_OK.has(res.ack)) { results.push(...chunk.map(row => rowResult(row, 'UNKNOWN', `eBay answered "${res.ack}". Check the listing on eBay.`))); continue }
      for (const row of chunk) {
        const evidence = { itemId, outOfStockControl, remainingBefore: item.variations.length ? onItem.get(row.sku) ?? null : item.itemAvailable }
        held.push({ id: row.id, evidence })
        results.push(rowResult(row, 'DONE', 'eBay shows quantity 0; the listing and its item number stay. Nexus holds its stock pushes.', evidence))
      }
    } catch (err) {
      results.push(...chunk.map(row => failureOrUnknown(row, err, 'ReviseInventoryStatus')))
    }
  }
  return { results, held }
}

/** Every variation (or the single SKU) of one item: the hard-delete unpublish makes exactly these calls. */
async function pauseWhole(itemId: string, rows: ActionListing[], tctx: TradingCallContext) {
  const answer = await unpublishEbay(itemId, { oauthToken: tctx.oauthToken, siteId: tctx.siteId, connectionId: tctx.connectionId, market: tctx.market ?? '' })
  const evidence = { itemId, ...(answer.evidence ?? {}) }
  if (answer.dryRun || answer.outcome === 'NOT_SENT') return { results: rows.map(row => rowResult(row, 'NOT_SENT', NOT_ENABLED)), held: [] }
  if (answer.success) {
    return {
      results: rows.map(row => rowResult(row, 'DONE', 'eBay shows quantity 0; the listing and its item number stay. Nexus holds its stock pushes.', evidence)),
      held: rows.map(row => ({ id: row.id, evidence })),
    }
  }
  if (answer.outcome === 'REFUSED') return { results: rows.map(row => rowResult(row, 'NOT_SENT', answer.error ?? 'eBay would end this listing at quantity 0. Nothing was sent.')), held: [] }
  // A partial failure: the SKUs eBay confirmed at 0 are held, the rest report the failure.
  const zeroed = new Set(Array.isArray(answer.evidence?.zeroed) ? (answer.evidence?.zeroed as string[]) : [])
  const done = rows.filter(row => zeroed.has(row.sku) || zeroed.has(itemId))
  return {
    results: rows.map(row => done.includes(row)
      ? rowResult(row, 'DONE', 'eBay shows quantity 0. Nexus holds its stock pushes.', evidence)
      : rowResult(row, answer.outcome === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED', answer.error ?? 'eBay did not confirm quantity 0.')),
    held: done.map(row => ({ id: row.id, evidence })),
  }
}

const coordinateWhere = (ctx: ActionContext, itemId: string) => ({
  id: { in: ctx.family.filter(row => row.externalListingId === itemId).map(row => row.id) },
  channel: 'EBAY', marketplace: ctx.destination.marketplace, channelConnectionId: ctx.destination.accountId, aliasKey: ctx.destination.aliasKey,
})

export const ebayTradingListingActions: ListingActionAdapter = {
  async run(action, targets, ctx) {
    if (action === 'resume') return liftHolds(targets, ctx)
    const tctx = await tradingContext(ctx)
    if (typeof tctx === 'string') return targets.map(row => rowResult(row, 'NOT_SENT', tctx))
    const { items, missing } = byItem(targets)
    const results: AdapterRowResult[] = missing.map(row => rowResult(row, 'FAILED', 'This listing has no eBay item number.'))

    for (const [itemId, rows] of items) {
      if (action === 'pause') {
        // The whole item when every listed variation of it is chosen (or it is a single SKU).
        const sellable = ctx.family.filter(row => row.externalListingId === itemId && !row.isParent)
        const whole = sellable.every(row => rows.some(target => target.id === row.id))
        const done = whole ? await pauseWhole(itemId, rows, tctx) : await pausePart(itemId, rows, tctx)
        await holdRows(ctx, done.held)
        results.push(...done.results)
        continue
      }
      if (action === 'end' || action === 'delete') {
        // Delete of an item eBay already ended (the listing reads Ended here) needs no End call.
        const alreadyEnded = action === 'delete' && ctx.family.some(row => row.externalListingId === itemId && String(row.listingStatus).toUpperCase() === 'ENDED')
        if (!alreadyEnded) {
          try {
            const ack = await endFixedPriceItem({ itemId, endingReason: 'NotAvailable' }, tctx)
            if (ack.itemId?.startsWith('DRYRUN-')) { results.push(...rows.map(row => rowResult(row, 'NOT_SENT', NOT_ENABLED))); continue }
            if (!ACK_OK.has(ack.ack)) { results.push(...rows.map(row => rowResult(row, 'UNKNOWN', `eBay answered "${ack.ack}". Check the listing on eBay.`))); continue }
          } catch (err) {
            if (!ENDED_CONFIRMED.some(pattern => pattern.test(messageOf(err)))) { results.push(...rows.map(row => failureOrUnknown(row, err, 'EndFixedPriceItem'))); continue }
          }
        }
        if (action === 'delete') {
          // Nexus forgets the item number on every row of the item here; it reads Not listed until its Status lists it again.
          await returnToDraft(ctx, ctx.family.filter(row => row.externalListingId === itemId))
          results.push(...rows.map(row => rowResult(row, 'DONE', `${deleteDoneSentence(`eBay · ${ctx.destination.marketplace}`)} (${alreadyEnded ? 'Item' : 'eBay ended item'} ${itemId}${alreadyEnded ? ' was already ended' : ''}; listing it again makes a new item number.)`,
            { oldExternalListingId: itemId, endedNow: !alreadyEnded })))
          continue
        }
        // The whole item ended: every row of it on this destination reads Ended. The item number stays for Relist.
        await prisma.channelListing.updateMany({ where: coordinateWhere(ctx, itemId),
          data: { listingStatus: 'ENDED', offerActive: false, offerClosedAt: null, offerClosedBy: null, offerCloseReason: null } })
        await prisma.outboundSyncQueue.updateMany({ where: { channelListingId: { in: coordinateWhere(ctx, itemId).id.in }, syncStatus: 'PENDING' },
          data: { syncStatus: 'CANCELLED', errorMessage: 'Listing ended from the product sheet' } })
        results.push(...rows.map(row => rowResult(row, 'DONE', `Ended on eBay. Relist makes a new item number.`, { itemId })))
        continue
      }
      // relist
      try {
        const answer = await relistFixedPriceItem({ itemId }, tctx)
        if (answer.newItemId?.startsWith('DRYRUN-')) { results.push(...rows.map(row => rowResult(row, 'NOT_SENT', NOT_ENABLED))); continue }
        if (!ACK_OK.has(answer.ack) || !answer.newItemId || !/^\d+$/.test(answer.newItemId)) {
          results.push(...rows.map(row => rowResult(row, 'UNKNOWN', `eBay did not return a new item number (${answer.ack}). Check eBay before trying again.`)))
          continue
        }
        const where = coordinateWhere(ctx, itemId)
        await prisma.channelListing.updateMany({ where,
          data: { externalListingId: answer.newItemId, listingStatus: 'ACTIVE', isPublished: true, offerActive: true, offerClosedAt: null, offerClosedBy: null, offerCloseReason: null } })
        await sendCurrentStock(where.id.in)
        results.push(...rows.map(row => rowResult(row, 'DONE', `Relisted on eBay with item number ${answer.newItemId}. Nexus queued its stock.`, { oldItemId: itemId, newItemId: answer.newItemId })))
      } catch (err) {
        results.push(...rows.map(row => failureOrUnknown(row, err, 'RelistFixedPriceItem')))
      }
    }
    return results
  },
}
