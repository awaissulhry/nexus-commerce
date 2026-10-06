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
 *
 * E2 (D6, Owner 2026-10-05) — ONE variation of a live listing can be hidden and shown (the engine's reach 'row', or the
 * main row's Active when nothing is paused at listing level). Hide/show is Etsy's offering `is_enabled`, written by the
 * inventory writer (`writeEtsyInventory`: one fresh read under the listing lock → one PUT → read-back, through the
 * gateway); the listing's `state` is never PATCHed for it. A hidden variation carries its own Nexus hold (reason
 * ETSY_VARIATION_HIDDEN_REASON), so its stock pushes are held and the listing-level Pause/Resume neither overwrites
 * nor lifts it. Showing it needs Etsy order import (it sells again, and Nexus then sends its current stock).
 */
import { ETSY_DELETE_NOT_YET, ETSY_DRAFT_NO_LIVE, ETSY_DRAFT_NO_PAUSE, ETSY_NO_END, ETSY_VARIATION_HIDDEN_REASON, SHEET_PAUSE_REASON } from '@nexus/shared/listing-actions'
import prisma from '../../../db.js'
import { etsyWriteRefusal } from '../../etsy-publish-gate.service.js'
import { setEtsyListingState } from '../../etsy/listing-write.service.js'
import { writeEtsyInventory, type EtsyInventoryWriteResult } from '../../etsy/inventory-write.service.js'
import { etsyStockWriteRefusal } from '../../etsy/order-ingest-switch.js'
import { heldElsewhere, heldElsewhereSentence, holdRows, liftHoldOn, sendCurrentPrice, sendCurrentStock } from './hold.js'
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

/**
 * E2 (D6) — the inventory writer's own refusals, all raised before its PUT: the listing busy (another write holds its
 * lock), the SKU not on the listing, an inventory Nexus cannot echo, a stock rule; and a failed read of the inventory
 * before anything is built. Nothing was sent for any of them.
 */
const NOT_SENT_BEFORE_PUT = new Set(['EtsyListingBusy', 'EtsyOfferingNotFound', 'EtsyInventoryShapeError', 'EtsyQuantityRefusal', 'EtsyReadError'])
function variationOutcomeOfError(err: unknown): Pick<AdapterRowResult, 'outcome' | 'message'> {
  const name = (err as { name?: string } | null)?.name
  // Review m4 — counted on Etsy's own inventory, read under the lock just before the PUT (etsy/inventory.ts).
  if (name === 'EtsyLastOfferingRefusal') return { outcome: 'NOT_SENT', message: ETSY_HIDE_ALL }
  if (name && NOT_SENT_BEFORE_PUT.has(name)) {
    const message = messageOf(err)
    return { outcome: 'NOT_SENT', message: /nothing was sent/i.test(message) ? message : `${message.replace(/\.?\s*$/, '.')} Nothing was sent.` }
  }
  return outcomeOfError(err)
}

const where = (ctx: ActionContext, ids: string[]) => ({
  id: { in: ids }, channel: 'ETSY', marketplace: ctx.destination.marketplace, channelConnectionId: ctx.destination.accountId, aliasKey: ctx.destination.aliasKey,
})

/** E3 — a row whose listing is a draft on Etsy (Nexus made it, or someone on etsy.com): a listing number, and Nexus marks it DRAFT. */
export const etsyDraftRow = (row: Pick<ActionListing, 'externalListingId' | 'listingStatus'>) =>
  !!row.externalListingId?.trim() && String(row.listingStatus ?? '').toUpperCase() === 'DRAFT'

/** E2 (D6) — a row hidden on its own (one variation), as opposed to the whole listing paused. */
export const variationHidden = (row: Pick<ActionListing, 'offerClosedAt' | 'offerCloseReason'>) =>
  !!row.offerClosedAt && row.offerCloseReason === ETSY_VARIATION_HIDDEN_REASON

/** E2 (D6) — is the Etsy listing paused as a whole (Pause offer, or an older close that wrote only INACTIVE)? */
export const etsyListingPaused = (family: Array<Pick<ActionListing, 'listingStatus' | 'offerClosedAt' | 'offerCloseReason'>>) =>
  family.some(row => row.listingStatus === 'INACTIVE' || (!!row.offerClosedAt && row.offerCloseReason === SHEET_PAUSE_REASON))

/**
 * E2 (D6) — does this run hide or show variations rather than change the listing's state? A row-level plan does; so
 * does a Resume while nothing is paused at listing level (the main row's Active from Mixed shows the hidden
 * variations, and never PATCHes `state`). Never for a caller that named listings, not variations (`wholeListing`:
 * Claude's close/reopen-listing — review m8).
 */
export const etsyVariationLevel = (action: 'pause' | 'resume', reach: ActionContext['reach'], family: Parameters<typeof etsyListingPaused>[0], wholeListing = false) =>
  !wholeListing && (reach === 'row' || (action === 'resume' && !etsyListingPaused(family)))

export const ETSY_HIDE_ALL = 'Hiding every variation would leave nothing to buy on this Etsy listing. Set the main product Inactive instead.'
export const ETSY_HIDDEN_DONE = 'Hidden on Etsy: buyers cannot buy this variation; the rest of the listing sells. Nexus holds its stock pushes.'
export const ETSY_SHOWN_DONE = 'Shown on Etsy again; Nexus queued its current stock and price.'
/** Review m1 — the listing was paused or unpaused between the preview and the run: its meaning would change. */
export const ETSY_LISTING_CHANGED = 'The Etsy listing changed since this preview. Review it again.'
/** Review m8 — a whole-listing Resume (Claude's reopen-listing) of an Etsy listing that is not paused. */
export const ETSY_NOT_PAUSED = 'The Etsy listing is not paused, so there is nothing to resume. To show a hidden variation, set it Active on its own row.'
export const ETSY_NOT_HIDDEN_LISTING_INACTIVE = 'This variation is not hidden: the whole Etsy listing is inactive. Set the main product Active to sell it.'
export const ETSY_HIDDEN_LISTING_INACTIVE = 'The whole Etsy listing is inactive. Set the main product Active first; this variation stays hidden until you set it Active on its own row.'
export const ETSY_LISTING_RESUMED_VARIATION_HIDDEN = 'The listing is active again; this variation stays hidden. Set it Active on its own row to show it.'
const READ_BACK_NOT_YET = 'Etsy answered, but its read-back does not show the change yet. Check the listing on Etsy.'
const READ_BACK_UNREAD = 'Etsy answered, but Nexus could not read the listing back to confirm it. Check the listing on Etsy.'

/**
 * Which rows the write is confirmed for: nothing sent (Etsy already held it) or a read-back that matched, per SKU. A
 * SKU whose `is_enabled` differs after the write (or whose product the read-back lacks) is not confirmed; an unreadable
 * read-back confirms none.
 */
function confirmedRows(rows: ActionListing[], write: EtsyInventoryWriteResult): { confirmed: ActionListing[]; unconfirmed: Array<{ row: ActionListing; message: string }> } {
  if (!write.sent || write.confirmed) return { confirmed: rows, unconfirmed: [] }
  if (write.drift === null) return { confirmed: [], unconfirmed: rows.map(row => ({ row, message: READ_BACK_UNREAD })) }
  const off = new Set(write.drift.filter(d => d.field === 'is_enabled' || d.found === -1).map(d => d.product))
  return {
    confirmed: rows.filter(row => !off.has(row.sku)),
    unconfirmed: rows.filter(row => off.has(row.sku)).map(row => ({ row, message: READ_BACK_NOT_YET })),
  }
}

const ledgerOf = (rows: ActionListing[]) => ({ productId: rows[0]?.productId ?? null, listingId: rows[0]?.id ?? null, triggeredBy: 'manual' as const })

/** E2 (D6) — hide these variations of one live Etsy listing (one inventory PUT), then hold them. */
async function hideVariations(listingId: string, rows: ActionListing[], _family: ActionListing[], ctx: ActionContext): Promise<AdapterRowResult[]> {
  const results: AdapterRowResult[] = []
  const targets: ActionListing[] = []
  // The engine skips the SKU check for Etsy (one listing state names none); hiding an offering names its SKU.
  for (const row of rows) {
    if (row.skuRefusal) results.push(rowResult(row, 'NOT_SENT', row.skuRefusal))
    else targets.push(row)
  }
  if (!targets.length) return results
  // Hiding every variation is refused by the writer on Etsy's own inventory, read under the lock just before the PUT
  // (`EtsyLastOfferingRefusal` → ETSY_HIDE_ALL): it sees offerings hidden on etsy.com and variations only Etsy holds,
  // which Nexus rows cannot (review m4).

  let write: EtsyInventoryWriteResult
  try {
    write = await writeEtsyInventory({ accountId: ctx.destination.accountId, listingId, changes: targets.map(row => ({ sku: row.sku, isEnabled: false })), ledger: ledgerOf(targets) })
  } catch (err) {
    const { outcome, message } = variationOutcomeOfError(err)
    return [...results, ...targets.map(row => rowResult(row, outcome, message))]
  }
  const { confirmed, unconfirmed } = confirmedRows(targets, write)
  await holdRows(ctx, confirmed.map(row => ({ id: row.id, evidence: { etsyListingId: listingId, sku: row.sku, isEnabled: false } })), { reason: ETSY_VARIATION_HIDDEN_REASON })
  results.push(...confirmed.map(row => rowResult(row, 'DONE', ETSY_HIDDEN_DONE, { etsyListingId: listingId, sku: row.sku, isEnabled: false })))
  results.push(...unconfirmed.map(({ row, message }) => rowResult(row, 'UNKNOWN', message, { etsyListingId: listingId, sku: row.sku, isEnabled: false })))
  return results
}

/** E2 (D6) — show these hidden variations again (one inventory PUT), lift their own hold and send their current stock. */
async function showVariations(listingId: string, rows: ActionListing[], family: ActionListing[], ctx: ActionContext): Promise<AdapterRowResult[]> {
  const results: AdapterRowResult[] = []
  const targets: ActionListing[] = []
  const listingPaused = etsyListingPaused(family)
  for (const row of rows) {
    if (!variationHidden(row)) {
      if (row.listingStatus === 'INACTIVE' || (!!row.offerClosedAt && row.offerCloseReason === SHEET_PAUSE_REASON)) results.push(rowResult(row, 'NOT_SENT', ETSY_NOT_HIDDEN_LISTING_INACTIVE))
      else if (row.offerClosedAt) results.push(rowResult(row, 'NOT_SENT', `${heldElsewhereSentence(row)} Nothing was sent.`))
      else results.push(rowResult(row, 'SKIPPED', 'Not inactive.'))
      continue
    }
    // Its hold would come off while the listing stays inactive, and stock pushes would reach an inactive listing.
    if (listingPaused) { results.push(rowResult(row, 'NOT_SENT', ETSY_HIDDEN_LISTING_INACTIVE)); continue }
    if (row.skuRefusal) { results.push(rowResult(row, 'NOT_SENT', row.skuRefusal)); continue }
    targets.push(row)
  }
  if (!targets.length) return results

  // A shown variation sells again: Etsy's sales must reach Nexus stock before Nexus sends its stock (Owner 2026-10-01).
  let refusal: Awaited<ReturnType<typeof etsyStockWriteRefusal>>
  try {
    refusal = await etsyStockWriteRefusal(ctx.destination.accountId)
  } catch (err) {
    const message = `Nexus could not read whether Etsy order import is activated for this account, so nothing was sent. (${messageOf(err)})`
    return [...results, ...targets.map(row => rowResult(row, 'NOT_SENT', message))]
  }
  if (refusal) return [...results, ...targets.map(row => rowResult(row, 'NOT_SENT', refusal!.sentence))]

  let write: EtsyInventoryWriteResult
  try {
    write = await writeEtsyInventory({ accountId: ctx.destination.accountId, listingId, changes: targets.map(row => ({ sku: row.sku, isEnabled: true })), ledger: ledgerOf(targets) })
  } catch (err) {
    const { outcome, message } = variationOutcomeOfError(err)
    return [...results, ...targets.map(row => rowResult(row, outcome, message))]
  }
  const { confirmed, unconfirmed } = confirmedRows(targets, write)
  const lifted = new Set(await liftHoldOn(ctx, confirmed, { reason: ETSY_VARIATION_HIDDEN_REASON }))
  await sendCurrentStock([...lifted])
  // Review m9 — its price pushes were refused while it was hidden: the price it carries now goes too (the price door).
  const prices = await sendCurrentPrice([...lifted], ctx.actor)
  const shownSentence = (row: ActionListing) => {
    const notSent = prices.get(row.id)
    return notSent == null ? ETSY_SHOWN_DONE : `Shown on Etsy again; Nexus queued its current stock. Its price was not sent: ${notSent.replace(/\.?\s*$/, '.')}`
  }
  for (const row of confirmed) {
    results.push(lifted.has(row.id)
      ? rowResult(row, 'DONE', shownSentence(row), { etsyListingId: listingId, sku: row.sku, isEnabled: true })
      // Etsy shows it, but its Nexus hold changed meanwhile and stays: no stock is queued for it. Said, never guessed.
      : rowResult(row, 'UNKNOWN', 'Shown on Etsy, but this row changed in Nexus meanwhile, so Nexus did not lift its hold or queue its stock. Open the sheet again and check it.', { etsyListingId: listingId, sku: row.sku, isEnabled: true }))
  }
  results.push(...unconfirmed.map(({ row, message }) => rowResult(row, 'UNKNOWN', message, { etsyListingId: listingId, sku: row.sku, isEnabled: true })))
  return results
}

export const etsyListingActions: ListingActionAdapter = {
  async run(action, targets, ctx) {
    if (action === 'delete') return targets.map(row => rowResult(row, 'NOT_SENT', ETSY_DELETE_NOT_YET))
    if (action !== 'pause' && action !== 'resume') return targets.map(row => rowResult(row, 'NOT_SENT', ETSY_NO_END))
    const refusal = etsyWriteRefusal()
    if (refusal) return targets.map(row => rowResult(row, 'NOT_SENT', refusal))

    const results: AdapterRowResult[] = []
    const listings = new Map<string, ActionListing[]>()
    for (const row of targets) {
      // E3 — a listing that is a draft on Etsy (Nexus's, or one made on etsy.com): Nexus cannot set it live yet, and a draft
      // has nothing to pause. Nothing is sent (a Resume would otherwise read as showing variations).
      if (etsyDraftRow(row)) {
        results.push(rowResult(row, 'NOT_SENT', action === 'resume' ? ETSY_DRAFT_NO_LIVE : ETSY_DRAFT_NO_PAUSE)); continue
      }
      const listingId = row.externalListingId?.trim() ?? ''
      if (!/^[1-9]\d*$/.test(listingId)) { results.push(rowResult(row, 'FAILED', 'This listing has no Etsy listing number.')); continue }
      listings.set(listingId, [...(listings.get(listingId) ?? []), row])
    }
    for (const [listingId, rows] of listings) {
      const family = ctx.family.filter(row => row.externalListingId?.trim() === listingId)
      const variationLevel = etsyVariationLevel(action, ctx.reach, family, ctx.wholeListing)
      // Review m1 — the preview decided the meaning (a renewal fee on one side, one variation on the other); a listing
      // paused or unpaused since then is refused, never switched silently.
      if (ctx.etsyLevel && ctx.etsyLevel !== (variationLevel ? 'variation' : 'listing')) {
        results.push(...rows.map(row => rowResult(row, 'NOT_SENT', ETSY_LISTING_CHANGED)))
        continue
      }
      if (variationLevel) {
        results.push(...await (action === 'pause' ? hideVariations : showVariations)(listingId, rows, family, ctx))
        continue
      }
      // Review m8 — a whole-listing Resume of a listing that is not paused: nothing to resume (and no renewal to risk).
      if (action === 'resume' && !etsyListingPaused(family)) {
        results.push(...rows.map(row => rowResult(row, 'SKIPPED', ETSY_NOT_PAUSED)))
        continue
      }
      // The listing level. A hidden variation is not a block: it is this adapter's own hold, and stays as it is.
      const blocked = family.find(row => heldElsewhere(row) && !variationHidden(row))
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
        // A hidden variation keeps its own hold (and reason): Resume of the listing must leave it hidden.
        await holdRows(ctx, family.filter(row => !variationHidden(row)).map(row => ({ id: row.id, evidence: { etsyListingId: listingId, state: 'inactive' } })))
        results.push(...rows.map(row => rowResult(row, 'DONE', 'Inactive on Etsy: buyers cannot find or buy it; the listing stays. Nexus holds its stock pushes.', { etsyListingId: listingId, state: 'inactive' })))
        continue
      }
      await prisma.channelListing.updateMany({ where: where(ctx, ids), data: { listingStatus: 'ACTIVE', isPublished: true } })
      // Rows paused before the hold existed (close-listing wrote only INACTIVE) have nothing to lift; they get the stock too.
      // Only Pause offer's own hold is lifted (compare-and-set on its reason); a hidden variation gets no stock.
      await liftHoldOn(ctx, family.filter(row => row.offerClosedAt))
      await sendCurrentStock(family.filter(row => !row.isParent && !variationHidden(row)).map(row => row.id))
      for (const row of rows) {
        results.push(variationHidden(row)
          ? rowResult(row, 'SKIPPED', ETSY_LISTING_RESUMED_VARIATION_HIDDEN, { etsyListingId: listingId, state: 'active' })
          : rowResult(row, 'DONE', 'Active on Etsy again. Etsy may have set its quantity to 1; Nexus queued the current stock.', { etsyListingId: listingId, state: 'active' }))
      }
    }
    return results
  },
}
