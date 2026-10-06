/**
 * MCP full control L9, build shape v2 (Owner 2026-10-04) — Claude's close-listing / reopen-listing are Pause offer /
 * Resume offer of THE listing-action engine (listing-action.service.ts), the same rules, adapters and audit as the
 * product sheet's Status column. Reversible only (decision d5): nothing here ends or deletes a listing.
 *
 *   Amazon   Pause removes THIS market's offer (SCT.6; never quantity 0: Amazon EU keeps one quantity per SKU). FBA
 *            too, with the warning: the FBA quantity is never touched. Resume puts the saved offer back.
 *   eBay     quantity 0 held by Nexus, only with the out-of-stock control on (the item's, read when sending; an
 *            Inventory listing: the account's). Resume lifts the hold and sends the current stock.
 *   Shopify  quantity 0 held by Nexus, per variant (a variant that sells out of stock is not paused). Resume lifts it;
 *            a product that is a Draft in Shopify becomes Active.
 *   Etsy     Etsy's own inactive / active (never quantity 0). Etsy may charge a renewal when it becomes active.
 *
 * Plan (read-only, `planListingClose`): every listing must be this business's, live (not a draft) and on ONE coordinate
 * (channel, market, account, alias); per family the engine's plan decides. A main product's variations pause with it.
 * Run (`runListingClose`): per family, the engine's preview and run as the approver — the engine re-plans and sends
 * only what is still the same. The engine writes the hold (`offerClosedAt`) and the audit; nothing here writes the
 * presence column `endedAt` any more (the push lock reads it as Ended). A Resume clears an `endedAt` an older close
 * wrote. Rows closed before keep the same fields (an Amazon close, an Etsy INACTIVE) and Resume works for them; an eBay
 * listing an older close pinned at 0 reads Inactive (`oldClosePauses`) and its Resume lifts the pin (hold.ts).
 */
import prisma from '../../db.js'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import { channelLabel } from '@nexus/shared/channel-label'
import type { ListingModel } from '@nexus/shared/listing-actions'
import { ENDED_USE_RELIST, listingActionGate, ListingActionError, planListingAction, previewListingAction, readListingActionState, runListingAction } from './listing-action.service.js'
import { clearOldCloseMarks } from './listing-action-adapters/hold.js'

/** reopen-listing on an Ended listing: the engine says "use Relist"; Claude's Relist is relist-listing. */
export const ENDED_USE_RELIST_TOOL = 'Ended — use relist-listing (on eBay it gets a NEW item number).'

export type CloseAction = 'close' | 'reopen'
const ENGINE_ACTION = { close: 'pause', reopen: 'resume' } as const

/** How the channel is told: the engine's adapter for this listing model. */
export type CloseDoor = 'amazon-offer' | 'ebay-quantity' | 'shopify-quantity' | 'etsy-state'
const DOOR: Partial<Record<ListingModel, CloseDoor>> = {
  amazon: 'amazon-offer', 'ebay-trading': 'ebay-quantity', 'ebay-inventory': 'ebay-quantity', shopify: 'shopify-quantity', etsy: 'etsy-state',
}

export interface ListingCloseRow {
  listingId: string
  productId: string
  sku: string
  channel: string
  market: string
  accountId: string | null
  aliasKey: string
  /** What happens to it: paused / resumed through its channel's door, or 'skip' (a main product: its variations carry it). */
  does: CloseDoor | 'skip'
  closed: boolean
  /** The engine's sentence for this row (an FBA pause carries its warning here). */
  note?: string
}

export interface ListingClosePlan {
  action: CloseAction
  rows: ListingCloseRow[]
  refusals: string[]
  /** The engine's one-line consequence per family, and the check the channel answers only when sending. */
  consequences: string[]
  checkedAtSend: string | null
}

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, listingStatus: true, isPublished: true,
  externalListingId: true, product: { select: { sku: true, parentId: true } },
} as const

/**
 * What a pause or resume of these listings would do, read-only (the engine's plan, nothing saved). An eBay Inventory
 * pause asks eBay for the account's out-of-stock preference (through the gateway, bounded; unknown refuses).
 */
export async function planListingClose(listingIds: readonly string[], action: CloseAction): Promise<ListingClosePlan> {
  const found = await prisma.channelListing.findMany({ where: { id: { in: [...listingIds] } }, select: LISTING_SELECT })
  const refusals: string[] = []
  const named: typeof found = []
  for (const id of listingIds) {
    const l = found.find((r) => r.id === id)
    if (!l) { refusals.push(`Listing ${id} not found in this business.`); continue }
    const where = `${l.product.sku} ${channelLabel(l.channel)} ${l.marketplace}`
    if (isStillDraftListing(l)) { refusals.push(`${where}: a draft was never live — remove it (remove-draft-listings) instead.`); continue }
    if (!l.channelConnectionId) { refusals.push(`${where}: this listing has no account. Link it to its account first.`); continue }
    named.push(l)
  }
  const coordinates = new Set(named.map((l) => JSON.stringify([l.channel, l.marketplace, l.channelConnectionId, l.aliasKey])))
  if (coordinates.size > 1) refusals.push('These listings are on more than one channel, market, account or alias: pause each one separately.')
  const empty = { action, rows: [], refusals, consequences: [], checkedAtSend: null }
  if (refusals.length || !named.length) return refusals.length ? empty : { ...empty, refusals: ['Name at least one listing.'] }

  const first = named[0]
  // The channel's publish mode must be live, as the run requires: say so now rather than after the approval.
  const gate = listingActionGate(first.channel)
  if (gate) return { ...empty, refusals: [`${first.product.sku} ${channelLabel(first.channel)} ${first.marketplace}: ${gate}`] }
  const scope = { channel: first.channel, marketplace: first.marketplace, accountId: first.channelConnectionId, aliasKey: first.aliasKey }
  const families = new Map<string, typeof named>()
  for (const l of named) {
    const familyId = l.product.parentId ?? l.productId
    families.set(familyId, [...(families.get(familyId) ?? []), l])
  }
  const rows: ListingCloseRow[] = []
  const consequences: string[] = []
  let checkedAtSend: string | null = null
  for (const [familyId, members] of families) {
    let plan: Awaited<ReturnType<typeof planListingAction>>
    try {
      plan = await planListingAction(familyId, ENGINE_ACTION[action], { scope, productIds: [...new Set(members.map((l) => l.productId))], wholeListing: true })
    } catch (err) {
      refusals.push(`${members[0].product.sku}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const door = DOOR[plan.model]
    if (!door) { refusals.push(`${members[0].product.sku} ${channelLabel(first.channel)} ${first.marketplace}: ${action === 'close' ? 'pausing' : 'resuming'} a ${channelLabel(first.channel)} listing from Nexus is not available yet.`); continue }
    const namedProducts = new Set(members.map((l) => l.productId))
    for (const row of plan.rows) {
      const where = `${row.sku} ${channelLabel(first.channel)} ${first.marketplace}`
      const base = { productId: row.productId, sku: row.sku, channel: first.channel, market: first.marketplace, accountId: first.channelConnectionId, aliasKey: first.aliasKey }
      if (row.plan === 'send' && row.listingId) { rows.push({ ...base, listingId: row.listingId, does: door, closed: action === 'reopen', note: row.sentence }); continue }
      if (!namedProducts.has(row.productId) || !row.listingId) continue
      // A main product follows its variations: listed, not refused.
      if (row.plan === 'skip' && /follows its variations/.test(row.sentence)) { rows.push({ ...base, listingId: row.listingId, does: 'skip', closed: action === 'reopen', note: row.sentence }); continue }
      // An Ended listing is relisted, not resumed: Claude's door for that is relist-listing.
      refusals.push(`${where}: ${action === 'reopen' && row.sentence === ENDED_USE_RELIST ? ENDED_USE_RELIST_TOOL : row.sentence}`)
    }
    consequences.push(plan.consequence)
    checkedAtSend = checkedAtSend ?? plan.checkedAtSend
  }
  if (!refusals.length && !rows.some((r) => r.does !== 'skip')) refusals.push('Nothing to change: no named listing can be ' + (action === 'close' ? 'paused.' : 'resumed.'))
  return { action, rows, refusals, consequences, checkedAtSend }
}

export interface ListingCloseOutcome { listingId: string; sku: string; done: boolean; detail?: string }

/**
 * Pause or resume the planned listings through the engine, as `actor`. Re-plans first (the plan must still hold);
 * per family one engine preview + run (the publish mode must be live); per listing, what happened. `reason` travels to
 * the engine's audit record.
 */
export async function runListingClose(input: { listingIds: string[]; action: CloseAction; actor: string; reason?: string | null }): Promise<{ plan: ListingClosePlan; outcomes: ListingCloseOutcome[] }> {
  const plan = await planListingClose(input.listingIds, input.action)
  if (plan.refusals.length) return { plan, outcomes: [] }
  const sending = plan.rows.filter((r) => r.does !== 'skip')
  const scope = { channel: sending[0].channel, marketplace: sending[0].market, accountId: sending[0].accountId, aliasKey: sending[0].aliasKey }
  const families = new Map<string, ListingCloseRow[]>()
  const parents = await prisma.product.findMany({ where: { id: { in: sending.map((r) => r.productId) } }, select: { id: true, parentId: true } })
  for (const r of sending) {
    const familyId = parents.find((p) => p.id === r.productId)?.parentId ?? r.productId
    families.set(familyId, [...(families.get(familyId) ?? []), r])
  }
  const outcomes: ListingCloseOutcome[] = []
  for (const [familyId, rows] of families) {
    try {
      const preview = await previewListingAction(familyId, ENGINE_ACTION[input.action], { scope, productIds: rows.map((r) => r.productId), wholeListing: true, ...(input.reason ? { reason: input.reason } : {}) }, input.actor)
      const result = await runListingAction(familyId, ENGINE_ACTION[input.action], { previewId: preview.previewId }, input.actor)
      for (const r of rows) {
        const answer = result.rows.find((x) => x.listingId === r.listingId)
        const done = answer?.outcome === 'DONE'
        outcomes.push({ listingId: r.listingId, sku: r.sku, done, ...(done ? {} : { detail: answer ? `${answer.outcome}: ${answer.message}` : 'Not sent: it changed since it was approved.' }) })
      }
    } catch (err) {
      const detail = err instanceof ListingActionError || err instanceof Error ? err.message : String(err)
      for (const r of rows) outcomes.push({ listingId: r.listingId, sku: r.sku, done: false, detail })
    }
  }
  if (input.action === 'reopen') await clearOldCloseMarks(outcomes.filter((o) => o.done).map((o) => o.listingId))
  return { plan, outcomes }
}

/** C2 — whether each listing is inactive now (the engine's selling state: Inactive), in the order given. */
export async function closedState(listingIds: readonly string[]): Promise<Array<{ listingId: string; closed: boolean }>> {
  const found = await prisma.channelListing.findMany({ where: { id: { in: [...listingIds] } }, select: LISTING_SELECT })
  const state = new Map<string, boolean>()
  const groups = new Map<string, typeof found>()
  for (const l of found) {
    if (!l.channelConnectionId) continue
    const key = JSON.stringify([l.product.parentId ?? l.productId, l.channel, l.marketplace, l.channelConnectionId, l.aliasKey])
    groups.set(key, [...(groups.get(key) ?? []), l])
  }
  for (const [key, members] of groups) {
    const [familyId, channel, market, accountId, aliasKey] = JSON.parse(key) as string[]
    try {
      const read = await readListingActionState(familyId, { channel, market, accountId, aliasKey })
      for (const l of members) state.set(l.id, read.rows.find((r) => r.listingId === l.id)?.state === 'paused')
    } catch { /* unreadable: not closed */ }
  }
  return listingIds.map((id) => ({ listingId: id, closed: state.get(id) ?? false }))
}
