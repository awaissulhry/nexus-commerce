/**
 * MCP full control I9 — take a channel id off a listing, or put one on (section 04 §3, §4.1: unlink-channel-id,
 * link-channel-id). Claude's tools wait for a person (alwaysAsk); the product sheet's Item ID cell (Item ID control,
 * docs/sheet-ids-sku-rows/A2-item-id-control.md, step I1) calls the same plans and runs as the signed-in person
 * (`channel-id.service.ts`). One rule, both paths: the plans here read, the runs write.
 *
 * The coordinate: the listing's family (its parent and variations) on the listing's channel, market, account and extra
 * listing — the rows that carry the same channel id (an eBay item, a Shopify product and an Etsy listing are shared by a
 * family's rows; an Amazon ASIN is one row's own).
 *
 * Unlink: a snapshot of each row first (ChannelListingSnapshot, reason 'unlink'), then in one transaction the id is
 * cleared and each row made an inert draft (DRAFT, unpublished, sync paused — draftListingFields' state), the shared eBay
 * variation rows of that item are ended, the account's held-id records are unlinked (the audit's #4 then shows the item),
 * and the snapshots are accepted. An accepted unlink is read like an accepted Delete (`listing-deletions.ts`): the rows
 * read Not listed and are never offered as a NEW listing, so a Publish cannot create a second item while the old one is
 * still live. Nothing is sent to the channel: the item stays live there and can oversell, which the preview says with
 * the quantity it last advertised.
 *
 * Link: eBay — the Item ID is proven on eBay as THIS business's account (GetItem through the gateway: listed by this
 * account's seller; its SKUs are this family's channel SKUs on this market and account, `channel-sku.ts`; no other family
 * holds it; Active or Ended), then written only on the rows the item carries, with the status eBay reports (an Ended item
 * reads ENDED, and Relist is offered). The rows stay paused: a person resumes their pushes. A snapshot of each row comes
 * first. A variation that holds ANOTHER item is moved to this one only when the same GetItem proof shows its own channel
 * SKU on this item (Owner, 2026-10-05, option A); one whose SKU is not on it is left alone ("kept"). Both are listed, in
 * plain words, before anything is written. Amazon — the ASIN is READ from Amazon by the listing's seller SKU (fillAmazonListingAsins), never typed. Shopify
 * and Etsy are linked in their own flows (colour products; Etsy later): refused here, saying so.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { announceListingValues } from '../listing-values-events.js'
import { nexusStatusForEbayItem } from '../ebay-itemid-relink.pure.js'
import { CHANNEL_SKU_LISTING_SELECT } from '../listings/channel-sku.js'
import { liveChannelSku, wantedChannelSku, type ChannelSkuListing } from '../listings/channel-sku.pure.js'
import { heldIdKey } from './channel-held.service.js'

/** Why a plan or a run refused: `not_found` (no such listing here), `conflict` (it changed meanwhile), `refused` (the rule). */
export type IdentityFixRefusalCode = 'refused' | 'conflict' | 'not_found'

export class IdentityFixRefusal extends Error {
  constructor(message: string, readonly code: IdentityFixRefusalCode = 'refused') {
    super(message)
    this.name = 'IdentityFixRefusal'
  }
}

const LISTING_NOT_FOUND = 'Listing not found'
/** A fenced run whose listing moved after it was read (the sheet's fence: the listing version it read). */
export const LISTING_CHANGED = 'This listing changed after it was read. Nothing changed: read it again, then try again.'
/** eBay: what a link and a Keep leave paused, in the words the sheet and Claude both show. */
export const PUSHES_STAY_PAUSED = 'Pushes stay paused: Nexus sends nothing to this item until you resume them (Sync).'

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
  version: number
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
  /** The listing asked about: its version (the sheet's fence) and whether it is the family's main row. */
  asked: { id: string; productId: string; version: number; isMain: boolean }
}

/** The coordinate of a listing in this business: its family's rows that carry the same channel id. */
export async function coordinateOf(listingId: string): Promise<Coordinate | null> {
  const listing = await prisma.channelListing.findFirst({
    where: { id: listingId, product: { deletedAt: null } },
    select: { id: true, version: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, externalListingId: true, product: { select: { id: true, parentId: true } } },
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
      platformAttributes: true, version: true, product: { select: { sku: true } },
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
    asked: { id: listing.id, productId: listing.product.id, version: listing.version, isMain: listing.product.id === root.id },
  }
}

/** The fence of a run from the product sheet: the asked listing's version must still be the one the sheet read. */
function fenceVersion(coordinate: Coordinate, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && coordinate.asked.version !== expectedVersion) throw new IdentityFixRefusal(LISTING_CHANGED, 'conflict')
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

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
  if (!coordinate) throw new IdentityFixRefusal(LISTING_NOT_FOUND, 'not_found')
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

/**
 * Run an unlink: refused when the coordinate's id moved since the plan (the fence), or — from the sheet — when the asked
 * listing's version is not the one the sheet read.
 */
export async function runUnlink(listingId: string, expectedExternalId: string, actor: string | null, options: { expectedVersion?: number } = {}): Promise<UnlinkRecord> {
  const plan = await planUnlink(listingId)
  if (plan.externalId !== expectedExternalId) throw new IdentityFixRefusal('The listing\'s channel id changed after this was approved. Ask again to see what it would do now.', 'conflict')
  const { coordinate } = plan
  fenceVersion(coordinate, options.expectedVersion)
  // A snapshot of every row first: what was there is kept even if a later step fails. It is the unlink's own record
  // (reason 'unlink'), accepted below in the same transaction as the unlink.
  const { captureSnapshot } = await import('../pim/listing-snapshot.service.js')
  const snapshots: Array<{ id: string; payload: unknown }> = []
  for (const row of coordinate.rows) {
    const snap = await captureSnapshot({ channelListingId: row.id, reason: 'unlink', label: `before unlink-channel-id (${plan.externalId})`, capturedBy: actor })
    snapshots.push({ id: snap.id, payload: snap.payload })
  }
  const record = await prisma.$transaction(async (tx) => {
    const record: UnlinkRecord = { listingId, channel: coordinate.channel, externalId: plan.externalId, rows: [], membershipIds: [], snapshotIds: snapshots.map((s) => s.id) }
    for (const row of coordinate.rows) {
      const pa = (row.platformAttributes && typeof row.platformAttributes === 'object' && !Array.isArray(row.platformAttributes) ? { ...(row.platformAttributes as Record<string, unknown>) } : {})
      const shopifyIds: Record<string, unknown> = {}
      if (coordinate.channel === 'SHOPIFY') for (const key of SHOPIFY_ID_KEYS) if (key in pa) { shopifyIds[key] = pa[key]; delete pa[key] }
      const updated = await tx.channelListing.updateMany({
        where: { id: row.id, externalListingId: row.externalListingId, version: row.version },
        data: {
          externalListingId: null, ...(coordinate.channel === 'AMAZON' ? { externalParentId: null } : {}),
          listingStatus: 'DRAFT', isPublished: false, syncPaused: true, version: { increment: 1 },
          ...(Object.keys(shopifyIds).length ? { platformAttributes: pa as never } : {}),
        },
      })
      if (updated.count !== 1) throw new IdentityFixRefusal('A listing of this item changed meanwhile. Nothing changed.', 'conflict')
      record.rows.push({ id: row.id, externalListingId: row.externalListingId, externalParentId: row.externalParentId, listingStatus: row.listingStatus, isPublished: row.isPublished, syncPaused: row.syncPaused, shopifyIds })
    }
    if (coordinate.channel === 'EBAY') {
      const memberships = await tx.sharedListingMembership.findMany({ where: { parentSku: coordinate.root.sku, marketplace: coordinate.market, itemId: plan.externalId, status: 'ACTIVE' }, select: { id: true } })
      if (memberships.length) await tx.sharedListingMembership.updateMany({ where: { id: { in: memberships.map((m) => m.id) } }, data: { status: 'ENDED' } })
      record.membershipIds = memberships.map((m) => m.id)
    }
    await tx.channelHeldId.updateMany({ where: { listingId: { in: coordinate.rows.map((r) => r.id) } }, data: { listingId: null, matchState: 'UNLINKED' } })
    // The unlink's record, accepted with it: from now on these rows read Not listed (`readListingDeletions`), never NEW.
    const acceptedAt = new Date()
    for (const snap of snapshots) {
      await tx.channelListingSnapshot.update({
        where: { id: snap.id },
        data: { outcome: 'ACCEPTED', acceptedAt, payload: { ...object(snap.payload), kind: 'channel-id-unlink', evidence: { oldExternalListingId: plan.externalId } } as never },
      })
    }
    return record
  }, { timeout: 30_000 })
  announceListingValues(record.rows.map((r) => r.id), ['externalListingId', 'syncState'], 'channel-id-unlink')
  return record
}

// ── Link ──────────────────────────────────────────────────────────────────────────────────────────────

/** A row an eBay item carries: the only rows a link writes. */
export interface CarriedRow {
  id: string
  productId: string
  /** The product's SKU (what a person reads in the sheet). */
  sku: string
  /** The SKU eBay holds for this row, when the item names it (a variation's or the item's own); null for the main row of a variation item. */
  channelSku: string | null
  externalListingId: string | null
  listingStatus: string
  isPublished: boolean
  version: number
}

/** A row that holds another item and that the link MOVES to this one: eBay shows its channel SKU on this item. */
export interface MovedRow {
  id: string
  sku: string
  channelSku: string
  /** The item it holds now. */
  fromItemId: string
  /** "M holds item 1234; eBay shows its SKU M-IT on item 5678; Link moves it to 5678." */
  sentence: string
}

/** A row that holds an item and that the link leaves alone: eBay does not show its SKU on this item. */
export interface KeptRow {
  id: string
  sku: string
  externalListingId: string
  sentence: string
}

export const movedSentence = (sku: string, from: string, channelSku: string, itemId: string) =>
  `${sku} holds item ${from}; eBay shows its SKU ${channelSku} on item ${itemId}; Link moves it to ${itemId}.`
export const keptSentence = (sku: string, held: string, itemId: string) =>
  `${sku} holds item ${held}; eBay does not show its SKU on item ${itemId}, so Link leaves it as it is.`

/** What eBay says of one item, and what a link of it would write here. Built once; the plan, the check and the run read it. */
export interface EbayItemProof {
  itemId: string
  verdict: 'verified' | 'unverifiable' | 'rejected' | 'invalid'
  /** The proof's own sentence(s) (`ebay-itemid-relink`). */
  reason: string
  ebayStatus: string | null
  /** What the rows read after a link: eBay's status in Nexus words; null when eBay said neither Active nor Ended. */
  status: 'ACTIVE' | 'ENDED' | null
  title: string | null
  seller: { item: string | null; account: string | null } | null
  liveSkus: string[]
  matchedSkus: string[]
  /** Every row a link writes: the rows the item carries, the moved rows included (they are also in `moved`). */
  rows: CarriedRow[]
  /** Rows that hold another item and that this one carries by their own SKU: the link moves them to this item. */
  moved: MovedRow[]
  /** Rows of the family here that hold an item and whose SKU is not on this one: the link leaves them as they are. */
  kept: KeptRow[]
  /** The id is the one the rows hold, and every row it carries already reads what eBay says: nothing to write. */
  unchanged: boolean
  /** Why a link cannot be written, or null. Unverifiable is a refusal unless the caller's person said yes explicitly. */
  refusal: string | null
}

async function ebayToken(connectionId: string): Promise<string> {
  const { EbayAuthService } = await import('../ebay-auth.service.js')
  return new EbayAuthService().getValidToken(connectionId)
}

type LinkDeps = { token?: (connectionId: string) => Promise<string> }

const where = (c: Coordinate) => `the ${c.channel} ${c.market} listing of ${c.root.sku}`
const lower = (s: string) => s.trim().toLowerCase()

type FamilyRow = ChannelSkuListing & { id: string; productId: string; version: number; listingStatus: string; isPublished: boolean; externalListingId: string | null; product: { sku: string } | null }

/** The SKUs one listing row stands for on its channel: the one the channel holds and the one Nexus sends (`channel-sku.ts`). */
function channelSkusOf(row: FamilyRow): string[] {
  const out = new Set<string>()
  const productSku = row.product?.sku ?? null
  const live = liveChannelSku(row, productSku)
  if (live?.sku) out.add(live.sku)
  const wanted = wantedChannelSku(row, productSku)
  if (wanted.sku) out.add(wanted.sku)
  // Two SKUs on record for one listing: either may be the one the item carries.
  for (const candidate of wanted.conflict?.candidates ?? []) out.add(candidate.sku)
  return [...out]
}

/** Plain sentence of an unverifiable proof, from its facts — the sheet has no "link it anyway". */
function unverifiableSentence(proof: Pick<EbayItemProof, 'seller' | 'liveSkus'>): string {
  if (!proof.seller?.account) return 'This eBay account has no eBay seller recorded in Nexus (it was connected before Nexus recorded one), so Nexus cannot prove the item is this account\'s. Reconnect the account in Nexus (Settings, Channels), then check again.'
  if (!proof.seller.item) return 'eBay did not say which seller lists this item, so Nexus cannot prove it is this account\'s.'
  if (!proof.liveSkus.length) return 'The item reports no SKUs on eBay, so Nexus cannot prove it is this listing\'s.'
  return 'Nexus cannot prove the item is this account\'s.'
}

/**
 * Prove one eBay item for a coordinate, as THIS business's own account (its token; its recorded seller). Never writes.
 * Refusals are returned (`refusal`), so the sheet can show what the proof found; `planLink` throws them.
 * `acknowledgeUnverifiable` is Claude's explicit yes (a person approves the link in Nexus); the sheet never sends it.
 */
async function proveEbayItem(coordinate: Coordinate, rawItemId: string, input: { acknowledgeUnverifiable?: boolean; mcp?: boolean }, deps: LinkDeps): Promise<EbayItemProof> {
  const itemId = String(rawItemId ?? '').trim()
  const empty: EbayItemProof = { itemId, verdict: 'invalid', reason: '', ebayStatus: null, status: null, title: null, seller: null, liveSkus: [], matchedSkus: [], rows: [], moved: [], kept: [], unchanged: false, refusal: null }
  if (!coordinate.accountId) return { ...empty, refusal: `${where(coordinate)} names no account: set its account first.` }
  // An account with no credentials (never connected, signed out, needs a new sign-in) is a refusal in plain words, not
  // an error: the Item ID cannot be checked, so nothing is linked and eBay is not asked.
  let token: string
  try {
    token = await (deps.token ?? ebayToken)(coordinate.accountId)
  } catch (error) {
    logger.warn('[identity-fix] link: no eBay token for the account', { error: error instanceof Error ? error.message : String(error) })
    return { ...empty, refusal: `${where(coordinate)}: its eBay account has no working sign-in in Nexus, so the Item ID cannot be checked on eBay. Reconnect the account in Nexus (Settings, Channels), then ask again.` }
  }

  // This family's rows on THIS coordinate, and the SKUs each stands for here (channel-sku.ts, never Product.sku alone).
  const family = await prisma.channelListing.findMany({
    where: {
      channel: 'EBAY', marketplace: coordinate.market, channelConnectionId: coordinate.accountId, aliasKey: coordinate.aliasKey,
      product: { deletedAt: null, OR: [{ id: coordinate.root.id }, { parentId: coordinate.root.id }] },
    },
    select: CHANNEL_SKU_LISTING_SELECT,
    orderBy: { id: 'asc' },
  }) as unknown as FamilyRow[]
  const products = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: coordinate.root.id }, { parentId: coordinate.root.id }] }, select: { id: true, sku: true } })
  const skusByRow = new Map(family.map((row) => [row.id, channelSkusOf(row)]))
  const familySkus = [...skusByRow.values()].flat()
  // A family product with no listing here: the SKU a new listing of it would send.
  for (const product of products) {
    if (family.some((row) => row.productId === product.id)) continue
    const wanted = wantedChannelSku({ channel: 'EBAY' }, product.sku)
    if (wanted.sku) familySkus.push(wanted.sku)
  }
  // Shell listings pool other products' SKUs through memberships (this account's, or recorded without one).
  const pooled = await prisma.sharedListingMembership.findMany({
    where: { parentSku: coordinate.root.sku, marketplace: coordinate.market, OR: [{ channelConnectionId: coordinate.accountId }, { channelConnectionId: null }] },
    select: { sku: true },
  })
  for (const p of pooled) if (p.sku) familySkus.push(p.sku)

  const { relinkEbayItemId } = await import('../ebay-itemid-relink.service.js')
  const check = await relinkEbayItemId(prisma as never, {
    parentSku: coordinate.root.sku, marketplace: coordinate.market, itemId, apply: false,
    acknowledgeUnverifiable: input.acknowledgeUnverifiable === true, familySkus, acceptEnded: true,
  }, { oauthToken: token, connectionId: coordinate.accountId })

  const proof: EbayItemProof = {
    ...empty, itemId: check.itemId, verdict: check.verdict, reason: check.reason, ebayStatus: check.liveStatus ?? null,
    status: nexusStatusForEbayItem(check.liveStatus), title: check.liveTitle?.trim() || null, seller: check.seller ?? null,
    liveSkus: check.liveSkus ?? [], matchedSkus: check.matchedSkus,
  }
  if (check.verdict === 'rejected' || check.verdict === 'invalid') return { ...proof, refusal: `${where(coordinate)}: ${check.reason}` }
  if (check.verdict === 'unverifiable' && input.acknowledgeUnverifiable !== true) {
    return { ...proof, refusal: input.mcp ? `${where(coordinate)}: ${check.reason} Ask again with acknowledgeUnverifiable to link it anyway.` : `${where(coordinate)}: ${unverifiableSentence(proof)}` }
  }
  if (!proof.status) {
    return { ...proof, refusal: `${where(coordinate)}: eBay reports item ${proof.itemId} as ${proof.ebayStatus ? `"${proof.ebayStatus}"` : 'nothing (no status)'}, neither Active nor Ended, so Nexus cannot record whether it sells. Nothing changed.` }
  }

  // The rows the item carries: a row whose channel SKU eBay names, and the family's main row (the item itself) once the
  // item proved this family's. A row holding ANOTHER item is moved only on its own proof (its channel SKU on this item);
  // the main row of a variation item names no SKU of its own, so it never moves off another item without one. A
  // SKU-less item a person linked anyway (Claude's explicit yes) carries the rows that hold no other item.
  const item = new Set(proof.liveSkus.map(lower))
  const matched = proof.matchedSkus.length > 0
  const other = (row: FamilyRow) => {
    const held = heldIdKey('EBAY', row.externalListingId)
    return held && held !== coordinate.externalId && held !== proof.itemId ? held : null
  }
  for (const row of family) {
    const own = (skusByRow.get(row.id) ?? []).find((sku) => item.has(lower(sku))) ?? null
    const isMain = row.productId === coordinate.root.id
    const sku = row.product?.sku ?? row.id
    const held = heldIdKey('EBAY', row.externalListingId)
    const elsewhere = other(row)
    const carried = item.size ? !!own || (isMain && matched) : true
    if (!carried || (elsewhere && !own)) {
      // Not on this item (or on it only as the main row, while it holds another item): left alone; said when it holds one.
      if (held && held !== proof.itemId) proof.kept.push({ id: row.id, sku, externalListingId: held, sentence: keptSentence(sku, held, proof.itemId) })
      continue
    }
    if (elsewhere && own) proof.moved.push({ id: row.id, sku, channelSku: own, fromItemId: elsewhere, sentence: movedSentence(sku, elsewhere, own, proof.itemId) })
    proof.rows.push({
      id: row.id, productId: row.productId, sku: row.product?.sku ?? '', channelSku: own,
      externalListingId: row.externalListingId, listingStatus: row.listingStatus, isPublished: row.isPublished, version: row.version,
    })
  }
  if (!proof.rows.length) {
    return { ...proof, refusal: `${where(coordinate)}: eBay item ${proof.itemId} carries none of this listing's rows here. Nothing changed.` }
  }
  proof.unchanged = proof.rows.every((row) => heldIdKey('EBAY', row.externalListingId) === proof.itemId && row.listingStatus === proof.status && row.isPublished)
  return proof
}

/** The plain sentences a person reads of a proof: what eBay said and what a link would write. */
export function proofSentences(proof: EbayItemProof): string[] {
  const out: string[] = []
  if (proof.title) out.push(`eBay item ${proof.itemId}: "${proof.title}".`)
  if (proof.ebayStatus) {
    out.push(proof.status === 'ENDED' ? `eBay reports it as ${proof.ebayStatus}: Nexus records it as Ended, and Relist is offered.`
      : proof.status === 'ACTIVE' ? 'eBay reports it as Active.' : `eBay reports it as ${proof.ebayStatus}.`)
  }
  if (proof.seller?.item) out.push(proof.seller.account && lower(proof.seller.item) === lower(proof.seller.account)
    ? `Listed by eBay seller "${proof.seller.item}", the seller of this account.` : `Listed by eBay seller "${proof.seller.item}".`)
  if (proof.liveSkus.length) {
    const shown = proof.liveSkus.slice(0, 8).join(', ')
    out.push(`It carries ${proof.liveSkus.length} SKU${proof.liveSkus.length === 1 ? '' : 's'} (${shown}${proof.liveSkus.length > 8 ? ', …' : ''}); ${proof.matchedSkus.length} ${proof.matchedSkus.length === 1 ? 'is' : 'are'} this listing's.`)
  }
  if (proof.rows.length && !proof.refusal) {
    out.push(proof.unchanged ? `Nexus already holds it on ${proof.rows.length} row${proof.rows.length === 1 ? '' : 's'}: nothing to change.`
      : `Linking writes it on ${proof.rows.length} row${proof.rows.length === 1 ? '' : 's'} (${proof.rows.slice(0, 8).map((r) => r.sku).join(', ')}${proof.rows.length > 8 ? ', …' : ''}).`)
  }
  // The moved rows are said apart (`moved`), so the sheet and Claude's preview list them before Link.
  for (const kept of proof.kept.slice(0, 8)) out.push(kept.sentence)
  if (proof.kept.length > 8) out.push(`${proof.kept.length - 8} more rows hold another item and are left as they are.`)
  return out
}

export interface LinkPlan {
  coordinate: Coordinate
  channel: 'EBAY' | 'AMAZON'
  externalId: string
  verdict: 'verified' | 'unverifiable'
  reason: string
  matchedSkus: string[]
  seller?: { item: string | null; account: string | null }
  liveStatus?: string | null
  /** eBay: the whole proof (what eBay said, the rows the item carries, the status they take). */
  proof?: EbayItemProof
}

/** The channel-level refusals before any proof: the channels this link is not for, and a listing with no account. */
function linkChannelRefusal(coordinate: Coordinate): string | null {
  if (coordinate.channel === 'SHOPIFY') return `${where(coordinate)}: a Shopify product is linked through colour products (Find, then Confirm) in Nexus, not here.`
  if (coordinate.channel !== 'EBAY' && coordinate.channel !== 'AMAZON') return `${where(coordinate)}: linking a ${coordinate.channel} listing is not built yet.`
  if (!coordinate.accountId) return `${where(coordinate)} names no account: set its account first.`
  return null
}

/** Verify a link on the channel (a read, never a write). Claude's link-channel-id preview; throws its refusals. */
export async function planLink(listingId: string, input: { externalId?: string | null; acknowledgeUnverifiable?: boolean }, deps: LinkDeps = {}): Promise<LinkPlan> {
  const coordinate = await coordinateOf(listingId)
  if (!coordinate) throw new IdentityFixRefusal(LISTING_NOT_FOUND, 'not_found')
  return planFor(coordinate, listingId, input, deps)
}

/**
 * `sheet`: the product sheet's Link / Keep — an item eBay confirms and Nexus already holds is an answer, not a refusal;
 * an item Nexus cannot prove is this account's is refused in the sheet's words (it has no "link it anyway").
 */
async function planFor(coordinate: Coordinate, listingId: string, input: { externalId?: string | null; acknowledgeUnverifiable?: boolean },
  deps: LinkDeps, options: { sheet?: boolean } = {}): Promise<LinkPlan> {
  const refusal = linkChannelRefusal(coordinate)
  if (refusal) throw new IdentityFixRefusal(refusal)

  if (coordinate.channel === 'AMAZON') {
    if (input.externalId) throw new IdentityFixRefusal(`${where(coordinate)}: an ASIN is never typed — leave externalId out, and Nexus reads it from Amazon by the listing's seller SKU.`)
    if (coordinate.externalId) throw new IdentityFixRefusal(`${where(coordinate)} already carries ASIN ${coordinate.externalId}.`)
    const { fillAmazonListingAsins } = await import('../amazon/listing-asin-fill.service.js')
    const report = await fillAmazonListingAsins([listingId], { dryRun: true })
    const row = report.rows[0]
    if (row?.outcome !== 'filled' || !row.asin) throw new IdentityFixRefusal(`${where(coordinate)}: Amazon gave no ASIN (${row?.reason ?? row?.outcome ?? 'no answer'}).`)
    return { coordinate, channel: 'AMAZON', externalId: row.asin, verdict: 'verified', reason: `Amazon holds seller SKU ${row.sku} as ${row.asin}.`, matchedSkus: row.sku ? [row.sku] : [] }
  }

  const itemId = String(input.externalId ?? '').trim()
  if (!itemId) throw new IdentityFixRefusal(`${where(coordinate)}: name the eBay Item ID to link (externalId).`)
  const proof = await proveEbayItem(coordinate, itemId, options.sheet ? {} : { acknowledgeUnverifiable: input.acknowledgeUnverifiable, mcp: true }, deps)
  if (proof.refusal) throw new IdentityFixRefusal(proof.refusal)
  if (proof.unchanged && !options.sheet) throw new IdentityFixRefusal(`${where(coordinate)} already carries Item ID ${proof.itemId}, and eBay confirms it: nothing to change.`)
  return {
    coordinate, channel: 'EBAY', externalId: proof.itemId, verdict: proof.verdict as 'verified' | 'unverifiable', reason: proof.reason,
    matchedSkus: proof.matchedSkus, seller: proof.seller ?? undefined, liveStatus: proof.ebayStatus, proof,
  }
}

/** What the sheet's Check shows: the proof in plain words, never thrown (a refusal is a finding). */
export interface ChannelIdCheck {
  listingId: string
  channel: string
  market: string
  /** The family's main SKU. */
  sku: string
  /** The Item ID Nexus holds now, and the listing version the check read (the sheet's fence for Link and Clear). */
  currentId: string | null
  version: number
  itemId: string
  /** A link of `itemId` can be written (or, `unchanged`, eBay confirms what Nexus holds). */
  ok: boolean
  unchanged: boolean
  refusal: string | null
  verdict: EbayItemProof['verdict'] | null
  ebayStatus: string | null
  status: 'ACTIVE' | 'ENDED' | null
  /** What the proof found, in plain sentences. */
  found: string[]
  /** The rows a link writes. */
  rows: Array<{ listingId: string; sku: string; from: string | null }>
  /** Rows the link moves from another item to this one (eBay shows their SKU on it), each with its sentence. */
  moved: Array<{ listingId: string; sku: string; channelSku: string; from: string; sentence: string }>
  kept: EbayItemProof['kept']
  pushes: string
}

/**
 * Verify mode (the sheet's Check): prove a typed Item ID, or with none the one the listing holds now ("Not confirmed" →
 * Check → Keep / Clear). eBay only in this step. Reads eBay as this business's account; writes nothing.
 */
export async function checkChannelId(listingId: string, input: { externalId?: string | null } = {}, deps: LinkDeps = {}): Promise<ChannelIdCheck> {
  const coordinate = await coordinateOf(listingId)
  if (!coordinate) throw new IdentityFixRefusal(LISTING_NOT_FOUND, 'not_found')
  const typed = String(input.externalId ?? '').trim()
  const itemId = typed || coordinate.externalId || ''
  const base: ChannelIdCheck = {
    listingId, channel: coordinate.channel, market: coordinate.market, sku: coordinate.root.sku, currentId: coordinate.externalId,
    version: coordinate.asked.version, itemId, ok: false, unchanged: false, refusal: null, verdict: null, ebayStatus: null, status: null,
    found: [], rows: [], moved: [], kept: [], pushes: PUSHES_STAY_PAUSED,
  }
  const refusal = coordinate.channel !== 'EBAY' ? `${where(coordinate)}: only an eBay Item ID is checked here yet.` : linkChannelRefusal(coordinate)
  if (refusal) return { ...base, refusal }
  if (!itemId) return { ...base, refusal: 'Type the eBay Item ID to check.' }
  const proof = await proveEbayItem(coordinate, itemId, {}, deps)
  return {
    ...base, itemId: proof.itemId || itemId, ok: !proof.refusal, unchanged: !proof.refusal && proof.unchanged, refusal: proof.refusal,
    verdict: proof.verdict, ebayStatus: proof.ebayStatus, status: proof.status, found: proofSentences(proof),
    rows: proof.rows.map((r) => ({ listingId: r.id, sku: r.sku, from: r.externalListingId })),
    moved: proof.moved.map((m) => ({ listingId: m.id, sku: m.sku, channelSku: m.channelSku, from: m.fromItemId, sentence: m.sentence })), kept: proof.kept,
  }
}

export interface LinkRecord {
  listingId: string
  channel: string
  externalId: string
  rows: Array<{ id: string; externalListingId: string | null; listingStatus: string; isPublished: boolean }>
  membershipsReactivated: string[]
  /** eBay: the status the rows took (eBay's). */
  status?: 'ACTIVE' | 'ENDED'
  snapshotIds?: string[]
  /** eBay: rows moved from another item to this one (their SKU is on it), and rows that hold another item and were left alone. */
  moved?: EbayItemProof['moved']
  kept?: EbayItemProof['kept']
}

/**
 * Run a link: verified again on the channel first, then written fenced on the ids and versions the rows carried.
 * eBay: only the rows the item carries, with eBay's status; they stay paused. `actor` = the signed-in person (the sheet)
 * or the approver (Claude). `expectedVersion` = the sheet's fence on the asked listing; `acknowledgeUnverifiable` is
 * Claude's only (an approval in Nexus is the explicit yes): `sheet` runs ignore it.
 */
export async function runLink(listingId: string, input: { externalId?: string | null; acknowledgeUnverifiable?: boolean; expectedExternalId: string; expectedVersion?: number; actor?: string | null; sheet?: boolean }, deps: LinkDeps = {}): Promise<LinkRecord> {
  const asked = await coordinateOf(listingId)
  if (!asked) throw new IdentityFixRefusal(LISTING_NOT_FOUND, 'not_found')
  // The sheet's fence first: a listing that moved since the sheet read it is not asked about on the channel at all.
  fenceVersion(asked, input.expectedVersion)
  const plan = await planFor(asked, listingId, input, deps, { sheet: input.sheet })
  if (plan.externalId !== input.expectedExternalId) throw new IdentityFixRefusal('The channel now answers with another id than the one approved. Nothing changed.', 'conflict')
  const { coordinate } = plan
  // The sheet's Keep on rows that already read what eBay says: nothing to write, and that is the answer.
  if (plan.proof?.unchanged) return { listingId, channel: 'EBAY', externalId: plan.externalId, rows: [], membershipsReactivated: [], status: plan.proof.status ?? undefined, snapshotIds: [], moved: [], kept: plan.proof.kept }
  if (plan.channel === 'AMAZON') {
    const { fillAmazonListingAsins } = await import('../amazon/listing-asin-fill.service.js')
    const report = await fillAmazonListingAsins([listingId])
    const row = report.rows[0]
    if (row?.outcome !== 'filled' || row.asin !== plan.externalId) throw new IdentityFixRefusal(`Amazon's answer changed (${row?.reason ?? row?.outcome ?? 'no answer'}). Nothing changed.`)
    const before = coordinate.rows[0]
    announceListingValues([before.id], ['externalListingId'], 'channel-id-link')
    return { listingId, channel: 'AMAZON', externalId: plan.externalId, rows: [{ id: before.id, externalListingId: before.externalListingId, listingStatus: before.listingStatus, isPublished: before.isPublished }], membershipsReactivated: [] }
  }
  const proof = plan.proof!
  const status = proof.status!
  // A snapshot of every row it writes first, so the link can be looked back at (and undone) from what was there.
  const { captureSnapshot } = await import('../pim/listing-snapshot.service.js')
  const snapshotIds: string[] = []
  for (const row of proof.rows) {
    snapshotIds.push((await captureSnapshot({ channelListingId: row.id, reason: 'manual', label: `before link-channel-id (${plan.externalId})`, capturedBy: input.actor ?? null })).id)
  }
  const record = await prisma.$transaction(async (tx) => {
    const record: LinkRecord = { listingId, channel: 'EBAY', externalId: plan.externalId, rows: [], membershipsReactivated: [], status, snapshotIds, moved: proof.moved, kept: proof.kept }
    for (const row of proof.rows) {
      const updated = await tx.channelListing.updateMany({
        where: { id: row.id, externalListingId: row.externalListingId, version: row.version },
        // The status eBay reports; pushes stay paused until a person resumes them.
        data: { externalListingId: plan.externalId, listingStatus: status, isPublished: true, syncPaused: true, version: { increment: 1 } },
      })
      if (updated.count !== 1) throw new IdentityFixRefusal('A listing of this family changed meanwhile. Nothing changed.', 'conflict')
      record.rows.push({ id: row.id, externalListingId: row.externalListingId, listingStatus: row.listingStatus, isPublished: row.isPublished })
    }
    const account = { OR: [{ channelConnectionId: coordinate.accountId }, { channelConnectionId: null }] }
    await tx.sharedListingMembership.updateMany({ where: { parentSku: coordinate.root.sku, marketplace: coordinate.market, itemId: { not: plan.externalId }, ...account }, data: { itemId: plan.externalId } })
    // The shared variations eBay confirms on a live item are live again (an unlink ended them). An ended item revives none.
    if (status === 'ACTIVE') {
      const matched = new Set(plan.matchedSkus.map(lower))
      const ended = await tx.sharedListingMembership.findMany({ where: { parentSku: coordinate.root.sku, marketplace: coordinate.market, itemId: plan.externalId, status: 'ENDED', ...account }, select: { id: true, sku: true } })
      const revive = ended.filter((m) => matched.has(lower(m.sku))).map((m) => m.id)
      if (revive.length) await tx.sharedListingMembership.updateMany({ where: { id: { in: revive } }, data: { status: 'ACTIVE' } })
      record.membershipsReactivated = revive
    }
    return record
  }, { timeout: 30_000 }).catch((error) => {
    logger.warn('[identity-fix] link failed', { listingId, error: error instanceof Error ? error.message : String(error) })
    throw error
  })
  announceListingValues(record.rows.map((r) => r.id), ['externalListingId', 'syncState'], 'channel-id-link')
  return record
}
