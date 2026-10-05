/**
 * MCP full control L9, build shape v2 (Owner 2026-10-04) — close-listing / reopen-listing are Pause offer / Resume
 * offer of THE listing-action engine (`services/listings/listing-close.service.ts` → listing-action.service.ts), the
 * same rules as the product sheet's Status column: Amazon removes this market's offer (FBA too, with the warning; the
 * FBA quantity is never touched), eBay and Shopify show quantity 0 held by Nexus (eBay only with the out-of-stock
 * control on; a Shopify variant that sells out of stock is not paused), Etsy goes inactive. Reversible only (d5): End,
 * Relist and Delete are their own tools (listing-lifecycle.tools.ts; reopen-listing on an Ended listing points to
 * relist-listing). The listing stays in Nexus. Each is the other's undo. The tool
 * names are kept; the plan → approval → run flow and the 250-listing cap are unchanged.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const closeService = () => import('../../listings/listing-close.service.js')

const listingIdsInput = z.array(z.string().trim().min(1).max(64)).min(1).max(250)
  .describe('Nexus listing ids from listing-coordinates, all on one channel, market and account (a family\'s variations)')

type Action = 'close' | 'reopen'

const HOW: Record<Action, Record<string, string>> = {
  close: {
    'amazon-offer': 'Amazon: this market\'s offer is removed (a copy is kept to put it back); other markets keep selling. FBA offers too: the units stay in Amazon\'s warehouse and Amazon keeps their quantity.',
    'ebay-quantity': 'eBay: quantity 0 held by Nexus — only while the out-of-stock control is on (checked when sending), else nothing is sent; the listing and its item number stay.',
    'shopify-quantity': 'Shopify: quantity 0 per variant held by Nexus (the page shows "sold out"); a variant that sells when out of stock is not paused.',
    'etsy-state': 'Etsy: the listing is set inactive (never quantity 0).',
  },
  reopen: {
    'amazon-offer': 'Amazon: the saved offer is put back and Nexus sends the current stock (FBA: Amazon keeps its own quantity; Nexus sends none).',
    'ebay-quantity': 'eBay: Nexus lifts the hold and sends the current stock (a pinned quantity comes back).',
    'shopify-quantity': 'Shopify: Nexus lifts the hold and sends the current stock; a product that is a Draft in Shopify becomes Active.',
    'etsy-state': 'Etsy: the listing is set active again — Etsy may set its quantity to 1 and charge a renewal; Nexus then sends the current stock.',
  },
}

async function previewFor(action: Action, args: Record<string, unknown>): Promise<ToolResult> {
  if (action === 'reopen' && args.quantity !== undefined) return { ok: false, error: 'reopen-listing sends the current stock (a pinned quantity comes back by itself); it takes no quantity. To set a quantity, use set-listing-stock. Nothing was queued.' }
  const ids = [...new Set(args.listingIds as string[])]
  const { planListingClose } = await closeService()
  const plan = await planListingClose(ids, action)
  if (plan.refusals.length) return { ok: false, error: `${plan.refusals.slice(0, 10).join(' ')} Nothing was queued.` }
  const doing = plan.rows.find((r) => r.does !== 'skip')!
  return {
    ok: true,
    preview: {
      action: `${action}-listing`,
      how: HOW[action][doing.does],
      listings: plan.rows.map((r) => ({ listingId: r.listingId, sku: r.sku, channel: r.channel, market: r.market, does: r.does, ...(r.note ? { note: r.note } : {}) })),
      consequence: plan.consequences.join(' '),
      ...(plan.checkedAtSend ? { checkedWhenSending: plan.checkedAtSend } : {}),
      ...(action === 'close' && args.reason ? { reason: args.reason } : {}),
      note: 'The listing stays in Nexus and on the channel. Nothing is ended or deleted.',
    },
  }
}

async function runFor(action: Action, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (action === 'reopen' && args.quantity !== undefined) return { ok: false, error: 'reopen-listing takes no quantity (use set-listing-stock). Nothing changed.' }
  const ids = [...new Set(args.listingIds as string[])]
  const approved = ctx.approvedPreview as { listings?: Array<{ listingId?: unknown; does?: unknown }> } | undefined
  if (!Array.isArray(approved?.listings)) return { ok: false, error: `A ${action === 'close' ? 'pause' : 'resume'} runs only after a person approved its preview. Nothing changed.` }
  const { planListingClose, runListingClose } = await closeService()
  // The plan must still be the one the person approved (each listing, and how it is paused or resumed).
  const fresh = await planListingClose(ids, action)
  const same = !fresh.refusals.length && JSON.stringify(fresh.rows.map((r) => [r.listingId, r.does])) === JSON.stringify(approved.listings.map((l) => [l.listingId, l.does]))
  if (!same) return { ok: false, error: `${fresh.refusals.slice(0, 5).join(' ') || 'These listings changed since it was approved.'} Nothing changed; ask Claude again.` }
  const { outcomes } = await runListingClose({ listingIds: ids, action, actor: ctx.userId ?? 'claude', reason: (args.reason as string | undefined) ?? null })
  const done = outcomes.filter((o) => o.done)
  if (!done.length) return { ok: false, error: `Nothing ${action === 'close' ? 'paused' : 'resumed'}: ${outcomes.slice(0, 10).map((o) => `${o.sku}: ${o.detail ?? 'not done'}`).join(' · ')}` }
  const doneIds = done.map((o) => o.listingId)
  return {
    ok: true,
    data: { [action === 'close' ? 'paused' : 'resumed']: done.map((o) => o.sku), notDone: outcomes.filter((o) => !o.done).map((o) => ({ sku: o.sku, detail: o.detail })) },
    change: { before: { listingIds: doneIds, closed: action !== 'close' }, after: { listingIds: doneIds, closed: action === 'close' } },
  }
}

/** C2 — each listing's state now, in the change's shape: all inactive (after a pause), or all selling (after a resume). */
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
  title: 'Pause offer',
  input: z.object({
    listingIds: listingIdsInput,
    reason: z.string().trim().min(1).max(300).optional().describe('why, kept on the change\'s audit record'),
  }),
  requires: [F.listingsPublish, F.inventoryAdjust],
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — partly: reopen-listing resumes it, but buyers could not buy meanwhile (and an Etsy resume costs a renewal).
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: undoOf('reopen-listing'),
  description:
    'Pause offer — stop selling live listings on one channel, market and account, reversibly (the product sheet\'s '
    + 'Status → Inactive): Amazon removes this market\'s offer (FBA too: the units stay in Amazon\'s warehouse and their '
    + 'quantity is never touched), eBay shows quantity 0 held by Nexus (only while the out-of-stock control is on, else '
    + 'eBay would end it and nothing is sent), Shopify shows quantity 0 per variant held by Nexus (a variant that sells '
    + 'when out of stock is not paused), Etsy goes inactive. Naming a main product pauses its variations. Nothing is ended '
    + 'or deleted: reopen-listing resumes it, and the listing stays in Nexus. Waits for a person to approve it in Nexus.',
  handler: (args) => previewFor('close', args),
  execute: (args, ctx) => runFor('close', args, ctx),
}

const reopenListing: AgentTool = {
  name: 'reopen-listing',
  title: 'Resume offer',
  input: z.object({
    listingIds: listingIdsInput,
    // Kept only to refuse it plainly: a resume sends the current stock; set-listing-stock sets a quantity.
    quantity: z.coerce.number().int().min(1).max(1_000_000).optional().describe('not accepted: a resume sends the current stock; use set-listing-stock to set a quantity'),
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
    'Resume offer — sell Inactive listings again on one channel, market and account (the product sheet\'s '
    + 'Status → Active): Amazon puts the saved offer back (Amazon EU keeps one quantity for every EU market: a conflict '
    + 'refuses it; FBA: Amazon keeps its own quantity), eBay and Shopify lift the Nexus hold and get the current stock (a '
    + 'pinned quantity comes back; a Shopify product that is a Draft becomes Active), Etsy goes active (Etsy may set the '
    + 'quantity to 1 and charge a renewal). Waits for a person to approve it in Nexus.',
  handler: (args) => previewFor('reopen', args),
  execute: (args, ctx) => runFor('reopen', args, ctx),
}

export const LISTING_CLOSE_TOOLS: AgentTool[] = [closeListing, reopenListing]
