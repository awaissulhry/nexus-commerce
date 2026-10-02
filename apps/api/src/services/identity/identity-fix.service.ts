/**
 * MCP full control I9 — take a channel id off a listing, or put one on (section 04 §3, §4.1: unlink-channel-id,
 * link-channel-id). Only ever after a person approves (the tools are alwaysAsk); the plans here read, the runs write.
 *
 * The coordinate: the listing's family (its parent and variations) on the listing's channel, market, account and extra
 * listing — the rows that carry the same channel id (an eBay item, a Shopify product and an Etsy listing are shared by a
 * family's rows; an Amazon ASIN is one row's own).
 *
 * Unlink: a snapshot of each row first (ChannelListingSnapshot, reason manual), then in one transaction the id is
 * cleared and each row made an inert draft (DRAFT, unpublished, sync paused — draftListingFields' state), the shared eBay
 * variation rows of that item are ended, and the account's held-id records are unlinked (the audit's #4 then shows the
 * item). Nothing is sent to the channel: the item stays live there and can oversell, which the preview says with the
 * quantity it last advertised.
 *
 * Link: eBay — the Item ID is verified on eBay (GetItem through the gateway: listed by this account's seller, Active, the
 * family's SKUs; ebay-itemid-relink), then written on the coordinate's rows, which become live again but stay paused
 * (a person resumes pushes). Amazon — the ASIN is READ from Amazon by the listing's seller SKU (fillAmazonListingAsins),
 * never typed. Shopify and Etsy are linked in their own flows (colour products; Etsy later): refused here, saying so.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { heldIdKey } from './channel-held.service.js'

export class IdentityFixRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityFixRefusal'
  }
}

const SHOPIFY_ID_KEYS = ['shopifyProductId', 'variantId', 'inventoryItemId'] as const

interface CoordinateRow {
  id: string
  productId: string
  sku: string
  listingStatus: string
  isPublished: boolean
  syncPaused: boolean
  quantity: number | null
  externalListingId: string | null
  externalParentId: string | null
  platformAttributes: unknown
}

export interface Coordinate {
  channel: string
  market: string
  accountId: string | null
  aliasKey: string
  root: { id: string; sku: string }
  /** The id the coordinate carries now (the asked listing's), or null. */
  externalId: string | null
  rows: CoordinateRow[]
}

/** The coordinate of a listing in this business: its family's rows that carry the same channel id. */
export async function coordinateOf(listingId: string): Promise<Coordinate | null> {
  const listing = await prisma.channelListing.findFirst({
    where: { id: listingId, product: { deletedAt: null } },
    select: { id: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, externalListingId: true, product: { select: { id: true, parentId: true } } },
  })
  if (!listing) return null
  const rootId = listing.product.parentId && listing.product.parentId !== listing.product.id ? listing.product.parentId : listing.product.id
  const root = await prisma.product.findFirst({ where: { id: rootId, deletedAt: null }, select: { id: true, sku: true } })
    ?? await prisma.product.findFirstOrThrow({ where: { id: listing.product.id }, select: { id: true, sku: true } })
  const externalId = heldIdKey(listing.channel, listing.externalListingId)
  const family = await prisma.channelListing.findMany({
    where: {
      channel: listing.channel, marketplace: listing.marketplace, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey,
      product: { deletedAt: null, OR: [{ id: root.id }, { parentId: root.id }] },
    },
    select: {
      id: true, productId: true, listingStatus: true, isPublished: true, syncPaused: true, quantity: true, externalListingId: true, externalParentId: true,
      platformAttributes: true, product: { select: { sku: true } },
    },
    orderBy: { id: 'asc' },
  })
  // Amazon: an ASIN is one row's own. Elsewhere the family shares the item: every row carrying the same id.
  const rows = family
    .filter((r) => (listing.channel === 'AMAZON' || !externalId ? r.id === listing.id : heldIdKey(listing.channel, r.externalListingId) === externalId))
    .map((r) => ({ ...r, sku: r.product.sku }))
  return {
    channel: listing.channel, market: listing.marketplace, accountId: listing.channelConnectionId, aliasKey: listing.aliasKey,
    root, externalId, rows: rows.map(({ product: _p, ...rest }) => rest as unknown as CoordinateRow),
  }
}

// ── Unlink ────────────────────────────────────────────────────────────────────────────────────────────

export interface UnlinkPlan {
  coordinate: Coordinate
  externalId: string
  /** The rows that carry it: SKU, status, the quantity each last advertised. */
  rows: Array<{ id: string; sku: string; status: string; quantity: number | null }>
  liveQuantity: number
  live: boolean
  sharedVariations: number
}

export async function planUnlink(listingId: string): Promise<UnlinkPlan> {
  const coordinate = await coordinateOf(listingId)
  if (!coordinate) throw new IdentityFixRefusal('Listing not found')
  if (!coordinate.externalId) throw new IdentityFixRefusal(`The ${coordinate.channel} ${coordinate.market} listing of ${coordinate.root.sku} carries no channel id: nothing to unlink.`)
  const sharedVariations = coordinate.channel === 'EBAY'
    ? await prisma.sharedListingMembership.count({ where: { parentSku: coordinate.root.sku, marketplace: coordinate.market, itemId: coordinate.externalId, status: 'ACTIVE' } })
    : 0
  const rows = coordinate.rows.map((r) => ({ id: r.id, sku: r.sku, status: r.listingStatus, quantity: r.quantity }))
  return {
    coordinate, externalId: coordinate.externalId, rows,
    liveQuantity: coordinate.rows.filter((r) => r.listingStatus === 'ACTIVE').reduce((n, r) => n + (r.quantity ?? 0), 0),
    live: coordinate.rows.some((r) => r.listingStatus === 'ACTIVE' && r.isPublished),
    sharedVariations,
  }
}

export interface UnlinkRecord {
  listingId: string
  channel: string
  externalId: string
  rows: Array<{ id: string; externalListingId: string | null; externalParentId: string | null; listingStatus: string; isPublished: boolean; syncPaused: boolean; shopifyIds: Record<string, unknown> }>
  membershipIds: string[]
  snapshotIds: string[]
}

/** Run an unlink: refused when the coordinate's id moved since the plan (the fence). */
export async function runUnlink(listingId: string, expectedExternalId: string, actor: string | null): Promise<UnlinkRecord> {
  const plan = await planUnlink(listingId)
  if (plan.externalId !== expectedExternalId) throw new IdentityFixRefusal('The listing\'s channel id changed after this was approved. Ask again to see what it would do now.')
  const { coordinate } = plan
  // A snapshot of every row first: what was there is kept even if a later step fails.
  const { captureSnapshot } = await import('../pim/listing-snapshot.service.js')
  const snapshotIds: string[] = []
  for (const row of coordinate.rows) {
    const snap = await captureSnapshot({ channelListingId: row.id, reason: 'manual', label: `before unlink-channel-id (${plan.externalId})`, capturedBy: actor })
    snapshotIds.push(snap.id)
  }
  return prisma.$transaction(async (tx) => {
    const record: UnlinkRecord = { listingId, channel: coordinate.channel, externalId: plan.externalId, rows: [], membershipIds: [], snapshotIds }
    for (const row of coordinate.rows) {
      const pa = (row.platformAttributes && typeof row.platformAttributes === 'object' && !Array.isArray(row.platformAttributes) ? { ...(row.platformAttributes as Record<string, unknown>) } : {})
      const shopifyIds: Record<string, unknown> = {}
      if (coordinate.channel === 'SHOPIFY') for (const key of SHOPIFY_ID_KEYS) if (key in pa) { shopifyIds[key] = pa[key]; delete pa[key] }
      const updated = await tx.channelListing.updateMany({
        where: { id: row.id, externalListingId: row.externalListingId },
        data: {
          externalListingId: null, ...(coordinate.channel === 'AMAZON' ? { externalParentId: null } : {}),
          listingStatus: 'DRAFT', isPublished: false, syncPaused: true, version: { increment: 1 },
          ...(Object.keys(shopifyIds).length ? { platformAttributes: pa as never } : {}),
        },
      })
      if (updated.count !== 1) throw new IdentityFixRefusal('A listing of this item changed meanwhile. Nothing changed.')
      record.rows.push({ id: row.id, externalListingId: row.externalListingId, externalParentId: row.externalParentId, listingStatus: row.listingStatus, isPublished: row.isPublished, syncPaused: row.syncPaused, shopifyIds })
    }
    if (coordinate.channel === 'EBAY') {
      const memberships = await tx.sharedListingMembership.findMany({ where: { parentSku: coordinate.root.sku, marketplace: coordinate.market, itemId: plan.externalId, status: 'ACTIVE' }, select: { id: true } })
      if (memberships.length) await tx.sharedListingMembership.updateMany({ where: { id: { in: memberships.map((m) => m.id) } }, data: { status: 'ENDED' } })
      record.membershipIds = memberships.map((m) => m.id)
    }
    await tx.channelHeldId.updateMany({ where: { listingId: { in: coordinate.rows.map((r) => r.id) } }, data: { listingId: null, matchState: 'UNLINKED' } })
    return record
  }, { timeout: 30_000 })
}

// ── Link ──────────────────────────────────────────────────────────────────────────────────────────────

export interface LinkPlan {
  coordinate: Coordinate
  channel: 'EBAY' | 'AMAZON'
  externalId: string
  verdict: 'verified' | 'unverifiable'
  reason: string
  matchedSkus: string[]
  seller?: { item: string | null; account: string | null }
  liveStatus?: string | null
}

async function ebayToken(connectionId: string): Promise<string> {
  const { EbayAuthService } = await import('../ebay-auth.service.js')
  return new EbayAuthService().getValidToken(connectionId)
}

/** Verify a link on the channel (a read, never a write). */
export async function planLink(listingId: string, input: { externalId?: string | null; acknowledgeUnverifiable?: boolean }, deps: { token?: (connectionId: string) => Promise<string> } = {}): Promise<LinkPlan> {
  const coordinate = await coordinateOf(listingId)
  if (!coordinate) throw new IdentityFixRefusal('Listing not found')
  const where = `the ${coordinate.channel} ${coordinate.market} listing of ${coordinate.root.sku}`
  if (coordinate.channel === 'SHOPIFY') throw new IdentityFixRefusal(`${where}: a Shopify product is linked through colour products (Find, then Confirm) in Nexus, not here.`)
  if (coordinate.channel !== 'EBAY' && coordinate.channel !== 'AMAZON') throw new IdentityFixRefusal(`${where}: linking a ${coordinate.channel} listing is not built yet.`)
  if (!coordinate.accountId) throw new IdentityFixRefusal(`${where} names no account: set its account first.`)

  if (coordinate.channel === 'AMAZON') {
    if (input.externalId) throw new IdentityFixRefusal(`${where}: an ASIN is never typed — leave externalId out, and Nexus reads it from Amazon by the listing's seller SKU.`)
    if (coordinate.externalId) throw new IdentityFixRefusal(`${where} already carries ASIN ${coordinate.externalId}.`)
    const { fillAmazonListingAsins } = await import('../amazon/listing-asin-fill.service.js')
    const report = await fillAmazonListingAsins([listingId], { dryRun: true })
    const row = report.rows[0]
    if (row?.outcome !== 'filled' || !row.asin) throw new IdentityFixRefusal(`${where}: Amazon gave no ASIN (${row?.reason ?? row?.outcome ?? 'no answer'}).`)
    return { coordinate, channel: 'AMAZON', externalId: row.asin, verdict: 'verified', reason: `Amazon holds seller SKU ${row.sku} as ${row.asin}.`, matchedSkus: row.sku ? [row.sku] : [] }
  }

  const itemId = String(input.externalId ?? '').trim()
  if (!itemId) throw new IdentityFixRefusal(`${where}: name the eBay Item ID to link (externalId).`)
  if (coordinate.externalId === itemId) throw new IdentityFixRefusal(`${where} already carries Item ID ${itemId}.`)
  const { relinkEbayItemId } = await import('../ebay-itemid-relink.service.js')
  // An account with no credentials (never connected, signed out, needs a new sign-in) is a refusal in plain words, not
  // an error: the Item ID cannot be checked, so nothing is linked and eBay is not asked.
  let token: string
  try {
    token = await (deps.token ?? ebayToken)(coordinate.accountId)
  } catch (error) {
    logger.warn('[identity-fix] link: no eBay token for the account', { listingId, error: error instanceof Error ? error.message : String(error) })
    throw new IdentityFixRefusal(`${where}: its eBay account has no working sign-in in Nexus, so the Item ID cannot be checked on eBay. Reconnect the account in Nexus (Settings, Channels), then ask again.`)
  }
  const check = await relinkEbayItemId(prisma as never, { parentSku: coordinate.root.sku, marketplace: coordinate.market, itemId, apply: false, acknowledgeUnverifiable: input.acknowledgeUnverifiable === true }, { oauthToken: token, connectionId: coordinate.accountId })
  if (check.verdict === 'rejected' || check.verdict === 'invalid') throw new IdentityFixRefusal(`${where}: ${check.reason}`)
  if (check.verdict === 'unverifiable' && input.acknowledgeUnverifiable !== true) {
    throw new IdentityFixRefusal(`${where}: ${check.reason} Ask again with acknowledgeUnverifiable to link it anyway.`)
  }
  return { coordinate, channel: 'EBAY', externalId: check.itemId, verdict: check.verdict, reason: check.reason, matchedSkus: check.matchedSkus, seller: check.seller, liveStatus: check.liveStatus }
}

export interface LinkRecord {
  listingId: string
  channel: string
  externalId: string
  rows: Array<{ id: string; externalListingId: string | null; listingStatus: string; isPublished: boolean }>
  membershipsReactivated: string[]
}

/** Run a link: verified again on the channel first, then written fenced on the ids the rows carried. */
export async function runLink(listingId: string, input: { externalId?: string | null; acknowledgeUnverifiable?: boolean; expectedExternalId: string }, deps: { token?: (connectionId: string) => Promise<string> } = {}): Promise<LinkRecord> {
  const plan = await planLink(listingId, input, deps)
  if (plan.externalId !== input.expectedExternalId) throw new IdentityFixRefusal('The channel now answers with another id than the one approved. Nothing changed.')
  const { coordinate } = plan
  if (plan.channel === 'AMAZON') {
    const { fillAmazonListingAsins } = await import('../amazon/listing-asin-fill.service.js')
    const report = await fillAmazonListingAsins([listingId])
    const row = report.rows[0]
    if (row?.outcome !== 'filled' || row.asin !== plan.externalId) throw new IdentityFixRefusal(`Amazon's answer changed (${row?.reason ?? row?.outcome ?? 'no answer'}). Nothing changed.`)
    const before = coordinate.rows[0]
    return { listingId, channel: 'AMAZON', externalId: plan.externalId, rows: [{ id: before.id, externalListingId: before.externalListingId, listingStatus: before.listingStatus, isPublished: before.isPublished }], membershipsReactivated: [] }
  }
  // eBay: every row of the family on this coordinate that carries nothing, or the id the plan read, takes the item.
  const family = await prisma.channelListing.findMany({
    where: {
      channel: 'EBAY', marketplace: coordinate.market, channelConnectionId: coordinate.accountId, aliasKey: coordinate.aliasKey,
      product: { deletedAt: null, OR: [{ id: coordinate.root.id }, { parentId: coordinate.root.id }] },
      OR: [{ externalListingId: null }, { externalListingId: '' }, ...(coordinate.externalId ? [{ externalListingId: coordinate.externalId }] : [])],
    },
    select: { id: true, externalListingId: true, listingStatus: true, isPublished: true },
  })
  return prisma.$transaction(async (tx) => {
    const record: LinkRecord = { listingId, channel: 'EBAY', externalId: plan.externalId, rows: [], membershipsReactivated: [] }
    for (const row of family) {
      const updated = await tx.channelListing.updateMany({
        where: { id: row.id, externalListingId: row.externalListingId },
        data: { externalListingId: plan.externalId, listingStatus: 'ACTIVE', isPublished: true, version: { increment: 1 } },
      })
      if (updated.count !== 1) throw new IdentityFixRefusal('A listing of this family changed meanwhile. Nothing changed.')
      record.rows.push(row)
    }
    await tx.sharedListingMembership.updateMany({ where: { parentSku: coordinate.root.sku, marketplace: coordinate.market, itemId: { not: plan.externalId } }, data: { itemId: plan.externalId } })
    // The shared variations eBay confirms on this item are live again (an unlink ended them).
    const matched = new Set(plan.matchedSkus.map((s) => s.trim().toLowerCase()))
    const ended = await tx.sharedListingMembership.findMany({ where: { parentSku: coordinate.root.sku, marketplace: coordinate.market, itemId: plan.externalId, status: 'ENDED' }, select: { id: true, sku: true } })
    const revive = ended.filter((m) => matched.has(m.sku.trim().toLowerCase())).map((m) => m.id)
    if (revive.length) await tx.sharedListingMembership.updateMany({ where: { id: { in: revive } }, data: { status: 'ACTIVE' } })
    record.membershipsReactivated = revive
    return record
  }, { timeout: 30_000 }).catch((error) => {
    logger.warn('[identity-fix] link failed', { listingId, error: error instanceof Error ? error.message : String(error) })
    throw error
  })
}
