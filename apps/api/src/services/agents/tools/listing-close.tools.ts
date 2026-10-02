/**
 * MCP full control L9 — close a live listing and open it again (plan section 02, step 9), through
 * `services/listings/listing-close.service.ts`: Amazon closes the market's offer (never FBA), eBay hides the item at 0
 * (only while the account's out-of-stock option is ON), Etsy sets it inactive (only while Etsy publishing is live),
 * Shopify is refused. Reversible ends only (d5): a permanent end stays a click in Nexus. The local record always stays.
 * Each is the other's undo.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const closeService = () => import('../../listings/listing-close.service.js')
const readOption = async (accountId: string, market: string) => {
  const { readEbayOutOfStockPreference } = await import('../../channel-delist.service.js')
  return readEbayOutOfStockPreference(accountId, market)
}

const listingIdsInput = z.array(z.string().trim().min(1).max(64)).min(1).max(250)
  .describe('Nexus listing ids from listing-coordinates, all on one channel, market and account (a family\'s variations)')

type Action = 'close' | 'reopen'

async function previewFor(action: Action, args: Record<string, unknown>): Promise<ToolResult> {
  const ids = [...new Set(args.listingIds as string[])]
  const { planListingClose } = await closeService()
  const plan = await planListingClose(ids, action, action === 'close' ? readOption : undefined)
  if (plan.refusals.length) return { ok: false, error: `${plan.refusals.slice(0, 10).join(' ')} Nothing was queued.` }
  const how: Record<string, string> = {
    'amazon-offer': action === 'close' ? 'Amazon: the offer of this market is closed (a snapshot is kept to reopen it).' : 'Amazon: the offer is reopened from its snapshot and follows the stock.',
    'ebay-quantity': action === 'close' ? 'eBay: the item is hidden — its quantity pinned to 0 (the out-of-stock option is ON).' : 'eBay: the item follows the stock again (or the quantity named).',
    'etsy-state': action === 'close' ? 'Etsy: the listing is set inactive.' : 'Etsy: the listing is set active again — Etsy may set its quantity to 1 and charge a renewal.',
  }
  const doing = plan.rows.find((r) => r.does !== 'skip')!
  return {
    ok: true,
    preview: {
      action: `${action}-listing`,
      how: how[doing.does],
      listings: plan.rows.map((r) => ({ listingId: r.listingId, sku: r.sku, channel: r.channel, market: r.market, does: r.does, ...(r.note ? { note: r.note } : {}) })),
      ...(action === 'close' && args.reason ? { reason: args.reason } : {}),
      ...(action === 'reopen' && typeof args.quantity === 'number' ? { quantity: args.quantity } : {}),
      note: 'The listing stays in Nexus. Nothing is ended or deleted on the channel.',
    },
  }
}

async function runFor(action: Action, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const ids = [...new Set(args.listingIds as string[])]
  const approved = ctx.approvedPreview as { listings?: Array<{ listingId?: unknown; does?: unknown }> } | undefined
  if (!Array.isArray(approved?.listings)) return { ok: false, error: `A ${action} runs only after a person approved its preview. Nothing changed.` }
  const { planListingClose, runListingClose } = await closeService()
  // The plan must still be the one the person approved (each listing, and how it is closed or reopened).
  const fresh = await planListingClose(ids, action, action === 'close' ? readOption : undefined)
  const same = !fresh.refusals.length && JSON.stringify(fresh.rows.map((r) => [r.listingId, r.does])) === JSON.stringify(approved.listings.map((l) => [l.listingId, l.does]))
  if (!same) return { ok: false, error: `${fresh.refusals.slice(0, 5).join(' ') || 'These listings changed since it was approved.'} Nothing changed; ask Claude again.` }
  const { outcomes } = await runListingClose({ listingIds: ids, action, actor: ctx.userId ?? 'claude', reason: (args.reason as string | undefined) ?? null,
    ...(typeof args.quantity === 'number' ? { quantity: args.quantity } : {}), can: (p) => ctx.can(p as never), readOption })
  const done = outcomes.filter((o) => o.done)
  if (!done.length) return { ok: false, error: `Nothing ${action === 'close' ? 'closed' : 'reopened'}: ${outcomes.slice(0, 10).map((o) => `${o.sku}: ${o.detail ?? 'not done'}`).join(' · ')}` }
  const doneIds = done.map((o) => o.listingId)
  return {
    ok: true,
    data: { [action === 'close' ? 'closed' : 'reopened']: done.map((o) => o.sku), notDone: outcomes.filter((o) => !o.done).map((o) => ({ sku: o.sku, detail: o.detail })) },
    change: { before: { listingIds: doneIds, closed: action !== 'close' }, after: { listingIds: doneIds, closed: action === 'close' } },
  }
}

/** C2 — each listing's closed state now, in the change's shape: all closed (after a close), or all open (after a reopen). */
const undoOf = (inverse: 'close-listing' | 'reopen-listing'): ToolUndo => ({
  async current(change) {
    const after = (change.after ?? {}) as { listingIds?: string[]; closed?: boolean }
    const { closedState } = await closeService()
    const states = await closedState(after.listingIds ?? [])
    return { listingIds: after.listingIds ?? [], closed: after.closed ? states.every((s) => s.closed) : !states.every((s) => !s.closed) }
  },
  request(change) {
    const after = (change.after ?? {}) as { listingIds?: string[] }
    if (!after.listingIds?.length) return { refusal: 'This change names no listing.' }
    return { tool: inverse, args: { listingIds: after.listingIds } }
  },
})

const closeListing: AgentTool = {
  name: 'close-listing',
  title: 'Close a listing',
  input: z.object({
    listingIds: listingIdsInput,
    reason: z.string().trim().min(1).max(300).optional().describe('why, kept on the listing'),
  }),
  requires: [F.listingsPublish, F.inventoryAdjust],
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — partly: reopen-listing opens it again, but buyers saw it closed meanwhile (and an Etsy reopen costs a renewal).
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: undoOf('reopen-listing'),
  description:
    'Close live listings on one channel, market and account, reversibly: Amazon closes the offer in that market (never '
    + 'FBA), eBay hides the item at quantity 0 (only while the account\'s out-of-stock option is ON, else eBay would end '
    + 'it), Etsy sets it inactive. Shopify is not available yet. Nothing is ended or deleted: reopen-listing opens it again, '
    + 'and the listing stays in Nexus. Waits for a person to approve it in Nexus.',
  handler: (args) => previewFor('close', args),
  execute: (args, ctx) => runFor('close', args, ctx),
}

const reopenListing: AgentTool = {
  name: 'reopen-listing',
  title: 'Reopen a listing',
  input: z.object({
    listingIds: listingIdsInput,
    quantity: z.coerce.number().int().min(1).max(1_000_000).optional().describe('eBay only: pin this quantity instead of following the stock'),
  }),
  requires: [F.listingsPublish, F.inventoryAdjust],
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: undoOf('close-listing'),
  description:
    'Open listings a close closed, on one channel, market and account: Amazon reopens the market\'s offer from its '
    + 'snapshot (Amazon EU keeps one quantity for every EU market: a conflict refuses it), eBay follows the stock again '
    + '(or pins the quantity named), Etsy sets it active (Etsy may set the quantity to 1 and charge a renewal). Waits for a '
    + 'person to approve it in Nexus.',
  handler: (args) => previewFor('reopen', args),
  execute: (args, ctx) => runFor('reopen', args, ctx),
}

export const LISTING_CLOSE_TOOLS: AgentTool[] = [closeListing, reopenListing]
