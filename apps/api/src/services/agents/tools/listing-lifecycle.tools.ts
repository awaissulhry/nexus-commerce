/**
 * MCP full control, phase 3 (T1) — end-listing / relist-listing / delete-listing are the product page's End listing
 * (Status Ended + Publish), Relist (Status Active on an Ended row + Publish) and Delete listing (Action Delete + Publish):
 * THE listing-action engine (`services/listings/listing-lifecycle.service.ts` → listing-action.service.ts), the same
 * plan, adapters, gates, audit and deletion records as the screen. They stay with a person: each waits for a person to
 * approve it in Nexus (alwaysAsk, ask at most), needs the products.delete permission as the screen does for End and
 * Delete, and takes the family SKU typed (`confirmSku`), as the screen asks before it ends or deletes.
 *
 *   end-listing     eBay ends the whole item (every variation; the item number is kept) · Shopify archives the product
 *                   in every market of the store. Amazon and Etsy have no End. Undo: relist-listing (partly: eBay gives
 *                   a NEW item number).
 *   relist-listing  an Ended eBay or Shopify listing sells again · eBay under a NEW item number · Shopify active in every
 *                   market of the store. Undo: end-listing.
 *   delete-listing  Amazon: this market only (FBA warned) · eBay Trading: end, then Nexus forgets the item number · eBay
 *                   Inventory: withdraw and delete this market's offers · Shopify: the product and all its variants in
 *                   every market · Etsy: not available. Cannot be undone. The row then reads Not listed, and
 *                   publish-listing keeps it Not listed until a person lists it again on the product page.
 *
 * The plan → approval → run flow and the 250-listing cap are close-listing's; the run re-plans and refuses a plan that
 * moved since it was approved.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import type { LifecycleAction, LifecyclePlan } from '../../listings/listing-lifecycle.service.js'

const lifecycleService = () => import('../../listings/listing-lifecycle.service.js')

const listingIdsInput = z.array(z.string().trim().min(1).max(64)).min(1).max(250)
  .describe('Nexus listing ids from listing-coordinates, all of ONE product family on one channel, market and account. On eBay and Shopify the change reaches the whole item or product (every variation), whichever of its listings is named')
const confirmSkuInput = z.string().trim().min(1).max(200)
  .describe('the family SKU (the main product\'s SKU; a product without variations: its own SKU), as the person typed it to confirm — the product page asks for it before it ends or deletes; it must match exactly')
const reasonInput = z.string().trim().min(1).max(300).optional().describe('why, kept on the change\'s audit record')

const inputOf = () => z.object({ listingIds: listingIdsInput, confirmSku: confirmSkuInput, reason: reasonInput })

const TO_STATE: Record<LifecycleAction, string> = { end: 'Ended', relist: 'Active', delete: 'Not listed (deleted)' }
const GONE = 'This cannot be undone.'
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One sentence: what happens, where, to how many listings. */
function summaryOf(plan: LifecyclePlan): string {
  const sku = plan.family!.sku
  const where = plan.where!
  const n = plural(plan.rows.filter((r) => r.does !== 'skip').length, 'listing')
  switch (`${plan.action}:${plan.model}`) {
    case 'end:ebay-trading':
    case 'end:ebay-inventory':
      return `End ${sku} on ${where} (${n}): eBay ends the whole item, every variation; the item number is kept. relist-listing sells it again under a NEW item number.`
    case 'end:shopify':
      return `End ${sku} on Shopify (${n}): Shopify archives the product in every market of the store. relist-listing makes it active again.`
    case 'relist:ebay-trading':
    case 'relist:ebay-inventory':
      return `Relist ${sku} on ${where} (${n}) under a NEW eBay item number; the old item number stays ended. Nexus then sends the current stock.`
    case 'relist:shopify':
      return `Relist ${sku} on Shopify (${n}): the product becomes active again in every market of the store, and Nexus sends the current stock.`
    case 'delete:amazon':
      return `Delete ${n} of ${sku} on ${where} only; other Amazon markets keep their listings. ${GONE}`
    case 'delete:ebay-trading':
      return `Delete ${sku} on ${where} (${n}): eBay ends the item if it is still live, then Nexus forgets its item number. ${GONE}`
    case 'delete:ebay-inventory':
      return `Delete ${sku} on ${where} (${n}): eBay withdraws it and deletes this marketplace's offers; the inventory items stay for other marketplaces. ${GONE}`
    case 'delete:shopify':
      return `Delete ${sku} on Shopify (${n}): Shopify deletes the product and all its variants in every market of the store. ${GONE}`
    default:
      return plan.consequence
  }
}

/** What cannot be undone, what reaches beyond the listings named or beyond one market, and what may cost money. */
function warningOf(plan: LifecyclePlan): string {
  const parts: string[] = []
  const reached = plan.rows.filter((r) => r.reached && r.does !== 'skip').map((r) => r.sku)
  const ebay = plan.model === 'ebay-trading' || plan.model === 'ebay-inventory'
  if (plan.action === 'delete') parts.push(GONE)
  if (plan.action === 'end') parts.push(ebay
    ? 'Buyers can no longer buy it here. eBay ends the whole item; to sell it again, relist-listing gives it a NEW item number.'
    : 'Shopify archives the whole product in EVERY market of the store, not one market: buyers can no longer buy it there.')
  if (plan.action === 'relist') parts.push(ebay
    ? 'eBay gives it a NEW item number; the old number stays ended. eBay may charge an insertion fee, as for a new listing.'
    : 'Shopify makes the whole product active again in EVERY market of the store.')
  if (plan.action === 'delete') {
    if (plan.model === 'shopify') parts.push('Shopify deletes the product and all its variants in EVERY market of the store, not one market.')
    if (plan.model === 'ebay-trading') parts.push('Nexus forgets the eBay item number: listed again, it becomes a new eBay item.')
    if (plan.model === 'ebay-inventory') parts.push('eBay deletes this marketplace\'s offers: listed again, it gets new ones.')
    for (const row of plan.rowWarnings) parts.push(`${row.sku}: ${row.warning}`)
    parts.push('Afterwards it reads Not listed and publish-listing leaves it out; only a person lists it again (Status Active, then Publish, on the product page).')
  }
  if (reached.length) parts.push(`It also reaches listings not named: ${reached.slice(0, 10).join(', ')}${reached.length > 10 ? ` and ${reached.length - 10} more` : ''}.`)
  return parts.join(' ')
}

async function previewFor(action: LifecycleAction, args: Record<string, unknown>): Promise<ToolResult> {
  const ids = [...new Set(args.listingIds as string[])]
  const { planListingLifecycle } = await lifecycleService()
  const plan = await planListingLifecycle(ids, action, String(args.confirmSku ?? ''))
  if (plan.refusals.length) return { ok: false, error: `${plan.refusals.slice(0, 10).join(' ')} Nothing was queued.` }
  const { channel, marketplace: market, accountId, aliasKey } = plan.destination!
  return {
    ok: true,
    preview: {
      action: `${action}-listing`,
      summary: summaryOf(plan),
      how: plan.consequence,
      family: plan.family,
      destination: { channel, market, accountId, aliasKey },
      listings: plan.rows.map((r) => ({ listingId: r.listingId, sku: r.sku, channel, market, does: r.does, note: r.note, ...(r.reached ? { reached: true } : {}) })),
      changes: plan.rows.filter((r) => r.does !== 'skip').map((r) => ({ sku: r.sku, channel, market, field: 'status', from: r.state, to: TO_STATE[action] })),
      warning: warningOf(plan),
      ...(plan.checkedAtSend ? { checkedWhenSending: plan.checkedAtSend } : {}),
      confirmSku: plan.family!.sku,
      ...(args.reason ? { reason: args.reason } : {}),
    },
  }
}

async function runFor(action: LifecycleAction, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const ids = [...new Set(args.listingIds as string[])]
  const { LIFECYCLE_VERB, LIST_AGAIN_AFTER_DELETE, planListingLifecycle, runListingLifecycle } = await lifecycleService()
  const approved = ctx.approvedPreview as { listings?: Array<{ listingId?: unknown; does?: unknown }> } | undefined
  if (!Array.isArray(approved?.listings)) return { ok: false, error: `${action}-listing runs only after a person approved its preview. Nothing changed.` }
  // The plan must still be the one the person approved: each listing, and what is done to it.
  const fresh = await planListingLifecycle(ids, action, String(args.confirmSku ?? ''))
  const same = !fresh.refusals.length && JSON.stringify(fresh.rows.map((r) => [r.listingId, r.does])) === JSON.stringify(approved.listings.map((l) => [l.listingId, l.does]))
  if (!same) return { ok: false, error: `${fresh.refusals.slice(0, 5).join(' ') || 'These listings changed since it was approved.'} Nothing changed; ask Claude again.` }
  const { outcomes, message } = await runListingLifecycle(fresh, { actor: ctx.userId ?? 'claude', reason: (args.reason as string | undefined) ?? null })
  const done = outcomes.filter((o) => o.done)
  const verb = LIFECYCLE_VERB[action].ed
  if (!done.length) return { ok: false, error: `Nothing ${verb}: ${outcomes.slice(0, 10).map((o) => `${o.sku}: ${o.detail ?? 'not done'}`).join(' · ')}` }
  const doneIds = done.map((o) => o.listingId)
  const familySku = fresh.family!.sku
  return {
    ok: true,
    data: {
      [verb]: done.map((o) => ({ sku: o.sku, ...(o.detail ? { detail: o.detail } : {}) })),
      notDone: outcomes.filter((o) => !o.done).map((o) => ({ sku: o.sku, detail: o.detail })),
      ...(message ? { message } : {}),
      ...(action === 'delete' ? { next: `They read Not listed now. ${LIST_AGAIN_AFTER_DELETE}` } : {}),
    },
    change: action === 'delete'
      ? { before: { listingIds: doneIds, deleted: false }, after: { listingIds: doneIds, deleted: true } }
      : { before: { listingIds: doneIds, ended: action !== 'end', familySku }, after: { listingIds: doneIds, ended: action === 'end', familySku } },
  }
}

/** C2 — each listing's state now, in the change's shape: all Ended (after an End), or none Ended (after a Relist). */
const undoOf = (inverse: 'end-listing' | 'relist-listing'): ToolUndo => ({
  async current(change) {
    const after = (change.after ?? {}) as { listingIds?: string[]; ended?: boolean }
    const ids = after.listingIds ?? []
    const { familySkuOf, lifecycleStates } = await lifecycleService()
    const states = (await lifecycleStates(ids)).map((s) => s.state)
    return { listingIds: ids, ended: after.ended ? states.every((s) => s === 'ended') : states.some((s) => s === 'ended'), familySku: await familySkuOf(ids) }
  },
  request(change) {
    const after = (change.after ?? {}) as { listingIds?: string[]; familySku?: string }
    if (!after.listingIds?.length) return { refusal: 'This change names no listing.' }
    if (!after.familySku) return { refusal: 'This change kept no family SKU to confirm with.' }
    return { tool: inverse, args: { listingIds: after.listingIds, confirmSku: after.familySku } }
  },
})

const REQUIRES = [F.listingsPublish, F.inventoryAdjust, F.productsDelete] as const

const endListing: AgentTool = {
  name: 'end-listing',
  title: 'End listing',
  input: inputOf(),
  requires: REQUIRES,
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — partly: relist-listing sells it again, but on eBay under a NEW item number, and buyers could not buy meanwhile.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: undoOf('relist-listing'),
  description:
    'End listing — the product page\'s Status → Ended + Publish, for eBay and Shopify (Amazon and Etsy have no End): eBay '
    + 'ends the whole item on that market, every variation, and keeps its item number; Shopify archives the product in '
    + 'every market of the store. Naming any listing of the family ends all of it there (the preview lists every row). '
    + 'Needs products.delete and confirmSku, the family SKU the person typed. relist-listing sells it again (eBay: under '
    + 'a NEW item number). Always waits for a person to approve it in Nexus.',
  handler: (args) => previewFor('end', args),
  execute: (args, ctx) => runFor('end', args, ctx),
}

const relistListing: AgentTool = {
  name: 'relist-listing',
  title: 'Relist',
  input: inputOf(),
  requires: REQUIRES,
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — partly: end-listing ends it again, but buyers could buy meanwhile and an eBay relist's new item number stays.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: undoOf('end-listing'),
  description:
    'Relist — the product page\'s Status → Active on an Ended listing + Publish, for eBay and Shopify: eBay lists the '
    + 'whole item again under a NEW item number (the old one stays ended; eBay may charge an insertion fee) and Nexus '
    + 'sends the current stock; Shopify makes the product active again in every market of the store. Only an Ended '
    + 'listing: an Inactive one is resumed with reopen-listing; a deleted one is listed again only by a person on the '
    + 'product page. Needs products.delete and confirmSku, the family SKU the person typed. Always waits for a person to '
    + 'approve it in Nexus.',
  handler: (args) => previewFor('relist', args),
  execute: (args, ctx) => runFor('relist', args, ctx),
}

const deleteListing: AgentTool = {
  name: 'delete-listing',
  title: 'Delete listing',
  input: inputOf(),
  requires: REQUIRES,
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Delete listing — the product page\'s Action → Delete + Publish. Cannot be undone. Amazon: deletes the listing in '
    + 'that market only (an FBA offer too: the preview names Amazon\'s unit count and Pan-European FBA). eBay: ends the '
    + 'item, then Nexus forgets its item number (an Inventory listing: withdrawn, this market\'s offers deleted). Shopify: '
    + 'deletes the product and all its variants in every market of the store. Etsy: not available. On eBay and Shopify '
    + 'naming any listing of the family deletes all of it there. The listing stays in Nexus as Not listed; publish-listing '
    + 'keeps it so until a person lists it again on the product page. Needs products.delete and confirmSku, the family '
    + 'SKU the person typed. Always waits for a person to approve it in Nexus.',
  handler: (args) => previewFor('delete', args),
  execute: (args, ctx) => runFor('delete', args, ctx),
}

export const LISTING_LIFECYCLE_TOOLS: AgentTool[] = [endListing, relistListing, deleteListing]
