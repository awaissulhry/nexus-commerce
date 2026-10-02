/**
 * MCP full control L9 — closing a live listing and opening it again, one coordinate at a time, through the doors that
 * already do it per channel. Reversible ends only (decision d5): nothing here ends an eBay item or deletes an Amazon
 * listing — a permanent end stays a click in Nexus. The local record always stays.
 *
 *   Amazon   the market's offer is closed (SCT.6 `closeMarketOffers`: a live snapshot, then the offer of THAT market
 *            deleted) and reopened from that snapshot (`reopenMarketOffers`, with the EU quantity guard). FBA is never
 *            closed: Amazon manages it.
 *   eBay     the item is hidden by pinning its quantity to 0 through the Matrix door — only while the account's
 *            out-of-stock option is ON (else eBay would END the item; the door refuses it). Reopened by following the
 *            stock again (or pinning a quantity).
 *   Etsy     the listing is set inactive / active (`setEtsyListingState`), only while Etsy publishing is live; making it
 *            active can set its quantity to 1 and charge a renewal, which the reopen states.
 *   Shopify  refused: not available yet.
 *
 * A family parent has no offer of its own: it is skipped, its variations are what close. A draft was never live: it is
 * removed (remove-draft-listings), not closed. Each close/reopen records who and why on the listing's presence columns
 * (`endedAt`, `endedBy`, `endedReason`; migration 20260913180000_pr_presence) where the database has them.
 */
import prisma from '../../db.js'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import { channelLabel } from '@nexus/shared/channel-label'
import { isFbaCoordinate } from '../../lib/amazon-fulfillment.js'

export type CloseAction = 'close' | 'reopen'

export interface ListingCloseRow {
  listingId: string
  productId: string
  sku: string
  channel: string
  market: string
  accountId: string | null
  aliasKey: string
  /** What happens to it: 'close' / 'reopen' through its channel's door, or 'skip' (a parent: its variations close). */
  does: 'amazon-offer' | 'ebay-quantity' | 'etsy-state' | 'skip'
  closed: boolean
  note?: string
}

export interface ListingClosePlan {
  action: CloseAction
  rows: ListingCloseRow[]
  refusals: string[]
}

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, listingStatus: true, isPublished: true,
  externalListingId: true, offerClosedAt: true, fulfillmentMethod: true, platformAttributes: true, followMasterQuantity: true, quantity: true,
  quantityOverride: true, product: { select: { sku: true, fulfillmentMethod: true, parentId: true, _count: { select: { children: true } } } },
} as const

/** eBay: hidden = pinned at 0. */
const ebayHidden = (row: { followMasterQuantity: boolean; quantityOverride: number | null; quantity: number | null }) =>
  row.followMasterQuantity === false && (row.quantityOverride ?? row.quantity) === 0

/**
 * What a close or reopen of these listings would do, read-only. Every listing must be this business's, live (not a draft)
 * and on ONE coordinate (channel, market, account, alias). An eBay close asks eBay for the out-of-stock option
 * (`readOption`, through the gateway) — refused unless ON.
 */
export async function planListingClose(listingIds: readonly string[], action: CloseAction, readOption?: (accountId: string, market: string) => Promise<'ON' | 'OFF' | 'UNKNOWN'>): Promise<ListingClosePlan> {
  const found = await prisma.channelListing.findMany({ where: { id: { in: [...listingIds] } }, select: LISTING_SELECT })
  const refusals: string[] = []
  const rows: ListingCloseRow[] = []
  for (const id of listingIds) {
    const l = found.find((r) => r.id === id)
    if (!l) { refusals.push(`Listing ${id} not found in this business.`); continue }
    const where = `${l.product.sku} ${channelLabel(l.channel)} ${l.marketplace}`
    const base = { listingId: l.id, productId: l.productId, sku: l.product.sku, channel: l.channel, market: l.marketplace, accountId: l.channelConnectionId, aliasKey: l.aliasKey }
    if (isStillDraftListing(l)) { refusals.push(`${where}: a draft was never live — remove it (remove-draft-listings) instead.`); continue }
    const parent = l.product._count.children > 0
    if (l.channel === 'AMAZON') {
      if (isFbaCoordinate(l)) { refusals.push(`${where}: fulfilled by Amazon (FBA) — Amazon manages it; it is never closed from Nexus.`); continue }
      const closed = !!l.offerClosedAt
      if (parent) { rows.push({ ...base, does: 'skip', closed, note: 'A family parent has no offer of its own: its variations close.' }); continue }
      if (action === 'close' && closed) { refusals.push(`${where}: its offer is already closed.`); continue }
      if (action === 'reopen' && !closed) { refusals.push(`${where}: its offer is not closed.`); continue }
      rows.push({ ...base, does: 'amazon-offer', closed })
    } else if (l.channel === 'EBAY') {
      const closed = ebayHidden(l)
      if (parent) { rows.push({ ...base, does: 'skip', closed, note: 'A family parent has no quantity of its own: its variations are hidden.' }); continue }
      if (action === 'close' && closed) { refusals.push(`${where}: it is already hidden (pinned at 0).`); continue }
      if (action === 'reopen' && !closed) { refusals.push(`${where}: it is not hidden (not pinned at 0).`); continue }
      rows.push({ ...base, does: 'ebay-quantity', closed })
    } else if (l.channel === 'ETSY') {
      const { etsyWriteRefusal } = await import('../etsy-publish-gate.service.js')
      const gate = etsyWriteRefusal()
      if (gate) { refusals.push(`${where}: ${gate}`); continue }
      if (!l.externalListingId) { refusals.push(`${where}: it has no Etsy listing to change.`); continue }
      const closed = l.listingStatus === 'INACTIVE'
      if (action === 'close' && closed) { refusals.push(`${where}: it is already inactive.`); continue }
      if (action === 'reopen' && !closed) { refusals.push(`${where}: it is not inactive.`); continue }
      rows.push({ ...base, does: 'etsy-state', closed, ...(action === 'reopen' ? { note: 'Etsy may set its quantity to 1 and charge a renewal when it becomes active.' } : {}) })
    } else {
      refusals.push(`${where}: closing a ${channelLabel(l.channel)} listing from Nexus is not available yet.`)
    }
  }
  const coordinates = new Set(rows.map((r) => JSON.stringify([r.channel, r.market, r.accountId, r.aliasKey])))
  if (coordinates.size > 1) refusals.push('These listings are on more than one channel, market, account or alias: close each one separately.')
  if (!rows.some((r) => r.does !== 'skip') && !refusals.length) refusals.push('Only family parents were named: name their variations.')
  // eBay: hidden at 0 only while the account's out-of-stock option is ON — else eBay would end the item.
  const ebay = rows.find((r) => r.does === 'ebay-quantity')
  if (action === 'close' && ebay && !refusals.length) {
    const option = ebay.accountId && readOption ? await readOption(ebay.accountId, ebay.market) : 'UNKNOWN'
    if (option !== 'ON') refusals.push(`${ebay.sku} eBay ${ebay.market}: the account's out-of-stock option is ${option === 'OFF' ? 'OFF' : 'not readable'}, so eBay would END the item at 0. Turn it on in eBay first.`)
  }
  return { action, rows, refusals }
}

export interface ListingCloseOutcome { listingId: string; sku: string; done: boolean; detail?: string }

/** Who closed it and why, on the presence columns — where the database has them (a raw-SQL migration adds them). */
async function recordPresence(listingIds: string[], action: CloseAction, actor: string, reason: string | null) {
  if (!listingIds.length) return
  const has = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ChannelListing' AND column_name IN ('endedAt', 'endedBy', 'endedReason')`)
  if ((has[0]?.n ?? 0) !== 3) return
  if (action === 'close') {
    await prisma.$executeRawUnsafe(`UPDATE "ChannelListing" SET "endedAt" = now(), "endedBy" = $2, "endedReason" = $3 WHERE id = ANY($1::text[])`, listingIds, actor, reason)
  } else {
    await prisma.$executeRawUnsafe(`UPDATE "ChannelListing" SET "endedAt" = NULL, "endedBy" = NULL, "endedReason" = NULL WHERE id = ANY($1::text[])`, listingIds)
  }
}

/**
 * Close or reopen the planned listings through their channel's door, as `actor`. Re-plans first (the plan must still
 * hold); per listing, what happened. `can` is the actor's permission check (the Matrix door enforces it). eBay `quantity`:
 * a reopen that pins this quantity instead of following the stock.
 */
export async function runListingClose(input: { listingIds: string[]; action: CloseAction; actor: string; reason?: string | null; quantity?: number
  can: (permission: string) => boolean; readOption?: (accountId: string, market: string) => Promise<'ON' | 'OFF' | 'UNKNOWN'> }): Promise<{ plan: ListingClosePlan; outcomes: ListingCloseOutcome[] }> {
  const plan = await planListingClose(input.listingIds, input.action, input.readOption)
  if (plan.refusals.length) return { plan, outcomes: [] }
  const rows = plan.rows.filter((r) => r.does !== 'skip')
  const outcomes: ListingCloseOutcome[] = []
  const reason = input.reason ?? null
  const does = rows[0].does
  if (does === 'amazon-offer') {
    const { closeMarketOffers, reopenMarketOffers } = await import('../amazon-market-offer.service.js')
    const targets = rows.map((r) => ({ productId: r.productId, marketplace: r.market, channelConnectionId: r.accountId, aliasKey: r.aliasKey }))
    const result = input.action === 'close'
      ? await closeMarketOffers({ targets, actor: input.actor, ...(reason ? { reason } : {}) })
      : await reopenMarketOffers({ targets, actor: input.actor })
    for (const r of rows) {
      const answer = result.results.find((x) => x.productId === r.productId)
      const done = answer?.action === 'CLOSED' || answer?.action === 'REOPENED'
      outcomes.push({ listingId: r.listingId, sku: r.sku, done, ...(done ? {} : { detail: answer ? `${answer.action}${answer.detail ? `: ${answer.detail}` : ''}` : (result.error ?? 'not attempted') }) })
    }
  } else if (does === 'ebay-quantity') {
    const { runMatrixVerb } = await import('../pim/matrix-write.service.js')
    const first = rows[0]
    const product = await prisma.product.findFirst({ where: { id: first.productId }, select: { parentId: true } })
    const root = product?.parentId ?? first.productId
    const key = `EBAY:${first.market}${first.aliasKey ? `#${first.aliasKey}` : ''}`
    const params = input.action === 'close' ? { verb: 'pin-quantity' as const, value: 0 }
      : typeof input.quantity === 'number' ? { verb: 'pin-quantity' as const, value: input.quantity } : { verb: 'set-follow' as const }
    const out = await runMatrixVerb({ productId: root, actor: input.actor, can: input.can }, { params, targets: rows.map((r) => ({ rowId: r.productId, coordinateKey: key })), commit: true }) as
      { results: Array<{ rowId: string; outcome: string; reason?: string }> }
    for (const r of rows) {
      const answer = out.results.find((x) => x.rowId === r.productId)
      // No change for the row: it already was as asked (a follow that already follows).
      const done = !answer || answer.outcome === 'applied' || answer.outcome === 'noop'
      outcomes.push({ listingId: r.listingId, sku: r.sku, done, ...(done ? {} : { detail: answer?.reason ?? answer?.outcome }) })
    }
  } else {
    const { setEtsyListingState } = await import('../etsy/listing-write.service.js')
    for (const r of rows) {
      try {
        const listing = await prisma.channelListing.findFirst({ where: { id: r.listingId }, select: { externalListingId: true } })
        await setEtsyListingState({ accountId: r.accountId!, listingId: listing!.externalListingId!,
          change: input.action === 'close' ? { state: 'inactive' } : { state: 'active', acceptRenewalAndQuantityReset: true } })
        await prisma.channelListing.update({ where: { id: r.listingId }, data: { listingStatus: input.action === 'close' ? 'INACTIVE' : 'ACTIVE', version: { increment: 1 } } })
        outcomes.push({ listingId: r.listingId, sku: r.sku, done: true })
      } catch (error) {
        outcomes.push({ listingId: r.listingId, sku: r.sku, done: false, detail: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  await recordPresence(outcomes.filter((o) => o.done).map((o) => o.listingId), input.action, input.actor, reason)
  return { plan, outcomes }
}

/** C2 — whether each listing is closed now (Amazon offer closed, eBay pinned at 0, Etsy inactive), in the order given. */
export async function closedState(listingIds: readonly string[]): Promise<Array<{ listingId: string; closed: boolean }>> {
  const found = await prisma.channelListing.findMany({ where: { id: { in: [...listingIds] } }, select: LISTING_SELECT })
  return listingIds.map((id) => {
    const l = found.find((r) => r.id === id)
    if (!l) return { listingId: id, closed: false }
    return { listingId: id, closed: l.channel === 'AMAZON' ? !!l.offerClosedAt : l.channel === 'EBAY' ? ebayHidden(l) : l.channel === 'ETSY' ? l.listingStatus === 'INACTIVE' : false }
  })
}
