/**
 * MCP full control I9 — take a channel id off a listing, or put one on (section 04 §3, §4.1: unlink-channel-id,
 * link-channel-id). Claude's tools wait for a person (alwaysAsk); the product sheet's channel id cells (Item ID control,
 * docs/sheet-ids-sku-rows/A2-item-id-control.md, steps I1–I4) call the same plans and run as the signed-in person
 * (`channel-id.service.ts`). One rule, both paths: the plans here read, the runs write.
 *
 * The coordinate: the listing's family (its parent and variations) on the listing's channel, market, account and extra
 * listing — the rows that carry the same channel id (an eBay item, a Shopify product and an Etsy listing are shared by a
 * family's rows; an Amazon ASIN is one row's own).
 *
 * Unlink: a snapshot of each row first (ChannelListingSnapshot, reason 'unlink'), then in one transaction the id is
 * cleared and each row made an inert draft (DRAFT, unpublished, sync paused — draftListingFields' state), the SKU the
 * channel held for it is forgotten (`liveChannelSku`; the SKU Nexus sends, `channelSku`, stays), the shared eBay
 * variation rows of that item are ended, the account's held-id records are unlinked (the audit's #4 then shows the item),
 * and the snapshots are accepted. An accepted unlink is read like an accepted Delete (`listing-deletions.ts`): the rows
 * read Not listed and are never offered as a NEW listing, so a Publish cannot create a second item while the old one is
 * still live. Nothing is sent to the channel: the item stays live there and can oversell, which the preview says with
 * the quantity it last advertised. A Shopify colour product is not unlinked here (colour products own its links).
 *
 * Link — proven on the channel as THIS business's own account, then written only on the rows the item carries (each
 * row's own channel SKU on the item, `channel-sku.ts`; the main row once the item proved the family's), with the status
 * the channel reports, a snapshot of each row first, pushes left paused, and the SKU the channel proved recorded as the
 * row's `liveChannelSku`. A row holding ANOTHER item moves to this one only when the same proof shows its own channel
 * SKU on it (Owner, 2026-10-05, option A); one whose SKU is not on it is left alone ("kept"). Both are listed, in plain
 * words, before anything is written. Per channel (`channel-id-proofs/`):
 *   eBay     GetItem: listed by this account's seller; Active or Ended (Relist is offered).
 *   Etsy     the listing's shop is this account's shop; active / inactive / expired (`etsy.ts`).
 *   Shopify  one product per family: a product of this store with no other Nexus identity; each row matched to a variant
 *            (product, variant and inventory item ids written). Colour products: Find + Confirm of the colour (`shopify.ts`).
 *   Amazon   no id typed: the ASIN is READ from Amazon by the listing's seller SKU (fillAmazonListingAsins). An ASIN typed
 *            on a row not on Amazon is proven in the catalog and becomes the ASIN it lists on at Publish
 *            (`merchant_suggested_asin`, `amazon.ts`); on a live offer it is refused with Amazon's reason and the way.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { announceListingValues } from '../listing-values-events.js'
import { nexusStatusForEbayItem } from '../ebay-itemid-relink.pure.js'
import { wantedChannelSku } from '../listings/channel-sku.pure.js'
import { clearLiveChannelSku, confirmLiveChannelSku } from '../listings/channel-sku.js'
import { heldIdKey } from './channel-held.service.js'
import {
  CHANNEL_WORDS, IdentityFixRefusal, carryRows, channelSkusOf, emptyProof, familyRowsOf, lower, object, ownSkuOn, skuSentence, where, wordsOf,
  type CarriedRow, type ChannelItemProof, type Coordinate, type CoordinateRow, type KeptRow, type LinkStatus, type MovedRow,
} from './channel-id-proofs/common.js'
import { etsyFoundSentences, proveEtsyListing, type EtsyReadDeps } from './channel-id-proofs/etsy.js'
import {
  COLOUR_CLEAR_REFUSED, confirmShopifyColour, holdsColourProduct, isColourFamily, proveShopifyColour, proveShopifyProduct, shopifyFoundSentences,
  type ShopifyLinkDeps,
} from './channel-id-proofs/shopify.js'
import { amazonClearFacts, proveAmazonAsin, suggestedAsinOf, writeSuggestedAsin, type AmazonAsinDeps } from './channel-id-proofs/amazon.js'

export { IdentityFixRefusal, movedSentence, keptSentence } from './channel-id-proofs/common.js'
export type { IdentityFixRefusalCode, Coordinate, CarriedRow, MovedRow, KeptRow, ChannelItemProof } from './channel-id-proofs/common.js'

const LISTING_NOT_FOUND = 'Listing not found'
/** A fenced run whose listing moved after it was read (the sheet's fence: the listing version it read). */
export const LISTING_CHANGED = 'This listing changed after it was read. Nothing changed: read it again, then try again.'
/** What a link and a Keep leave paused, in the words the sheet and Claude both show (`noun`: item, listing, product). */
export const pushesStayPaused = (noun = 'item') => `Pushes stay paused: Nexus sends nothing to this ${noun} until you resume them (Sync).`
/** eBay's sentence (I1). */
export const PUSHES_STAY_PAUSED = pushesStayPaused('item')

const SHOPIFY_ID_KEYS = ['shopifyProductId', 'variantId', 'inventoryItemId'] as const

/** The coordinate of a listing in this business: its family's rows that carry the same channel id. */
export async function coordinateOf(listingId: string): Promise<Coordinate | null> {
  const listing = await prisma.channelListing.findFirst({
    where: { id: listingId, product: { deletedAt: null } },
    select: { id: true, version: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, externalListingId: true, workspaceId: true, overrideData: true,
      product: { select: { id: true, parentId: true } } },
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
    channel: listing.channel, market: listing.marketplace, accountId: listing.channelConnectionId, aliasKey: listing.aliasKey, workspaceId: listing.workspaceId ?? null,
    root, externalId, rows: rows.map(({ product: _p, ...rest }) => rest as unknown as CoordinateRow),
    asked: { id: listing.id, productId: listing.product.id, version: listing.version, isMain: listing.product.id === root.id },
    ...(listing.channel === 'AMAZON' ? { suggestedId: suggestedAsinOf(listing.overrideData) } : {}),
  }
}

/** The fence of a run from the product sheet: the asked listing's version must still be the one the sheet read. */
function fenceVersion(coordinate: Coordinate, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && coordinate.asked.version !== expectedVersion) throw new IdentityFixRefusal(LISTING_CHANGED, 'conflict')
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
  /**
   * Amazon, a row not on Amazon: the id is the ASIN it lists on at Publish (`merchant_suggested_asin`), and the unlink
   * removes it — nothing else changes on the row, and nothing is sent to Amazon. `sellerSku`: the SKU Publish sends.
   */
  suggested?: { sellerSku: string }
}

export async function planUnlink(listingId: string): Promise<UnlinkPlan> {
  const coordinate = await coordinateOf(listingId)
  if (!coordinate) throw new IdentityFixRefusal(LISTING_NOT_FOUND, 'not_found')
  if (coordinate.channel === 'AMAZON') {
    // One rule with the sheet's Clear (I4): a row on Amazon keeps its ASIN — Amazon ties its seller SKU to it — and the
    // refusal is Amazon's reason and the way, in the sheet's words. A row not on Amazon may lose the ASIN it lists on at Publish.
    const facts = await amazonClearFacts(listingId)
    if (facts?.refusal && (coordinate.externalId || coordinate.suggestedId)) throw new IdentityFixRefusal(facts.refusal)
    if (!coordinate.externalId && coordinate.suggestedId && facts) {
      const row = coordinate.rows[0]
      return { coordinate, externalId: coordinate.suggestedId, rows: row ? [{ id: row.id, sku: row.sku, status: row.listingStatus, quantity: row.quantity }] : [],
        liveQuantity: 0, live: false, sharedVariations: 0, suggested: { sellerSku: facts.sellerSku } }
    }
  }
  if (!coordinate.externalId) throw new IdentityFixRefusal(`${where(coordinate)} carries no channel id: nothing to unlink.`)
  if (coordinate.channel === 'SHOPIFY' && holdsColourProduct(coordinate.rows)) throw new IdentityFixRefusal(COLOUR_CLEAR_REFUSED)
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
  /** Amazon: the ASIN removed was the one the row listed on at Publish (the row's own facts did not change). */
  suggested?: true
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
  if (plan.suggested) {
    const before = coordinate.rows[0]
    await writeSuggestedAsin(listingId, { asin: null, expectedAsin: plan.externalId, expectedVersion: options.expectedVersion ?? coordinate.asked.version })
    return { listingId, channel: 'AMAZON', externalId: plan.externalId, membershipIds: [], snapshotIds: [], suggested: true,
      rows: before ? [{ id: before.id, externalListingId: before.externalListingId, externalParentId: before.externalParentId, listingStatus: before.listingStatus, isPublished: before.isPublished, syncPaused: before.syncPaused, shopifyIds: {} }] : [] }
  }
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
      // The channel no longer holds this row for Nexus: the SKU it held is forgotten; the SKU Nexus sends stays.
      await clearLiveChannelSku(tx, row.id)
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

/** eBay's proof (I1): the shared proof with eBay's own fields (`ebayStatus`, its seller). */
export type EbayItemProof = ChannelItemProof & { ebayStatus: string | null }

async function ebayToken(connectionId: string): Promise<string> {
  const { EbayAuthService } = await import('../ebay-auth.service.js')
  return new EbayAuthService().getValidToken(connectionId)
}

/** The channels' doors, stood in by the tests: eBay's token, Etsy's reader, Shopify's reader and colour services, Amazon's catalog. */
export type LinkDeps = { token?: (connectionId: string) => Promise<string>; etsy?: EtsyReadDeps; shopify?: ShopifyLinkDeps; amazon?: AmazonAsinDeps }

/** Plain sentence of an unverifiable proof, from its facts — the sheet has no "link it anyway". */
function unverifiableSentence(proof: Pick<ChannelItemProof, 'seller' | 'liveSkus'>): string {
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
  const empty: EbayItemProof = { ...emptyProof('EBAY', itemId), ebayStatus: null }
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
  const family = await familyRowsOf(coordinate)
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
    ...empty, itemId: check.itemId, verdict: check.verdict, reason: check.reason, ebayStatus: check.liveStatus ?? null, channelStatus: check.liveStatus ?? null,
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
  // The rows the item carries (the one rule, `carryRows`): a row whose channel SKU eBay names, and the family's main row.
  carryRows(coordinate, family, proof, (row) => ownSkuOn(row, skusByRow, proof.liveSkus))
  if (!proof.rows.length) {
    return { ...proof, refusal: `${where(coordinate)}: eBay item ${proof.itemId} carries none of this listing's rows here. Nothing changed.` }
  }
  proof.unchanged = proof.rows.every((row) => heldIdKey('EBAY', row.externalListingId) === proof.itemId && row.listingStatus === proof.status && row.isPublished)
  return proof
}

/** The plain sentences a person reads of a proof: what the channel said and what a link would write. */
export function proofSentences(proof: ChannelItemProof): string[] {
  const words = wordsOf(proof.channel)
  const out: string[] = []
  if (proof.channel === 'ETSY') out.push(...etsyFoundSentences(proof))
  else if (proof.channel === 'SHOPIFY') out.push(...shopifyFoundSentences(proof))
  else {
    if (proof.title) out.push(`eBay item ${proof.itemId}: "${proof.title}".`)
    if (proof.channelStatus) {
      out.push(proof.status === 'ENDED' ? `eBay reports it as ${proof.channelStatus}: Nexus records it as Ended, and Relist is offered.`
        : proof.status === 'ACTIVE' ? 'eBay reports it as Active.' : `eBay reports it as ${proof.channelStatus}.`)
    }
    if (proof.seller?.item) out.push(proof.seller.account && lower(proof.seller.item) === lower(proof.seller.account)
      ? `Listed by eBay seller "${proof.seller.item}", the seller of this account.` : `Listed by eBay seller "${proof.seller.item}".`)
  }
  const skus = proof.colour ? null : skuSentence(proof)
  if (skus) out.push(skus)
  if (proof.rows.length && !proof.refusal) {
    out.push(proof.unchanged ? `Nexus already holds it on ${proof.rows.length} row${proof.rows.length === 1 ? '' : 's'}: nothing to change.`
      : `Linking writes it on ${proof.rows.length} row${proof.rows.length === 1 ? '' : 's'} (${proof.rows.slice(0, 8).map((r) => r.sku).join(', ')}${proof.rows.length > 8 ? ', …' : ''}).`)
  }
  // The moved rows are said apart (`moved`), so the sheet and Claude's preview list them before Link.
  for (const kept of proof.kept.slice(0, 8)) out.push(kept.sentence)
  if (proof.kept.length > 8) out.push(`${proof.kept.length - 8} more rows hold another ${words.noun} and are left as they are.`)
  return out
}

export interface LinkPlan {
  coordinate: Coordinate
  channel: 'EBAY' | 'AMAZON' | 'ETSY' | 'SHOPIFY'
  externalId: string
  verdict: 'verified' | 'unverifiable'
  reason: string
  matchedSkus: string[]
  seller?: { item: string | null; account: string | null }
  liveStatus?: string | null
  /** eBay, Etsy, Shopify: the whole proof (what the channel said, the rows the item carries, the status they take). */
  proof?: ChannelItemProof
  /** Amazon, an ASIN typed on a row not on Amazon: it becomes the ASIN the row lists on at Publish (nothing is sent now). */
  suggestedAsin?: { sellerSku: string; current: string | null; unchanged: boolean; found: string[] }
}

/** The channel-level refusals before any proof: the channels this link is not for, and a listing with no account. */
function linkChannelRefusal(coordinate: Coordinate): string | null {
  if (!['EBAY', 'AMAZON', 'ETSY', 'SHOPIFY'].includes(coordinate.channel)) return `${where(coordinate)}: linking a ${coordinate.channel} listing is not built yet.`
  if (!coordinate.accountId) return `${where(coordinate)} names no account: set its account first.`
  return null
}

/** Verify a link on the channel (a read, never a write). Claude's link-channel-id preview; throws its refusals. */
export async function planLink(listingId: string, input: { externalId?: string | null; acknowledgeUnverifiable?: boolean }, deps: LinkDeps = {}): Promise<LinkPlan> {
  const coordinate = await coordinateOf(listingId)
  if (!coordinate) throw new IdentityFixRefusal(LISTING_NOT_FOUND, 'not_found')
  return planFor(coordinate, listingId, input, deps)
}

/** Prove a typed id for a shared-id channel (eBay, Etsy, Shopify). Never writes (a colour store's Find stores its proposal). */
async function proveShared(coordinate: Coordinate, id: string, input: { acknowledgeUnverifiable?: boolean; mcp?: boolean }, deps: LinkDeps): Promise<ChannelItemProof> {
  if (coordinate.channel === 'ETSY') return proveEtsyListing(coordinate, id, input, deps.etsy)
  if (coordinate.channel === 'SHOPIFY') {
    return (await isColourFamily(coordinate, deps.shopify)) ? proveShopifyColour(coordinate, id, deps.shopify) : proveShopifyProduct(coordinate, id, input, deps.shopify)
  }
  return proveEbayItem(coordinate, id, input, deps)
}

/**
 * `sheet`: the product sheet's Link / Keep — an item the channel confirms and Nexus already holds is an answer, not a
 * refusal; an item Nexus cannot prove is this account's is refused in the sheet's words (it has no "link it anyway").
 */
async function planFor(coordinate: Coordinate, listingId: string, input: { externalId?: string | null; acknowledgeUnverifiable?: boolean },
  deps: LinkDeps, options: { sheet?: boolean } = {}): Promise<LinkPlan> {
  const refusal = linkChannelRefusal(coordinate)
  if (refusal) throw new IdentityFixRefusal(refusal)

  if (coordinate.channel === 'AMAZON') {
    if (input.externalId) {
      // An ASIN typed: the ASIN a row not on Amazon lists on at Publish; refused on a live offer (Amazon's reason).
      const proof = await proveAmazonAsin(listingId, input.externalId, deps.amazon)
      if (proof.refusal) throw new IdentityFixRefusal(`${where(coordinate)}: ${proof.refusal}`)
      if (proof.unchanged && !options.sheet) throw new IdentityFixRefusal(`${where(coordinate)} already lists on ASIN ${proof.asin} at Publish: nothing to change.`)
      return { coordinate, channel: 'AMAZON', externalId: proof.asin, verdict: 'verified', reason: proof.found.join(' '), matchedSkus: [proof.sellerSku],
        suggestedAsin: { sellerSku: proof.sellerSku, current: proof.current, unchanged: proof.unchanged, found: proof.found } }
    }
    if (coordinate.externalId) throw new IdentityFixRefusal(`${where(coordinate)} already carries ASIN ${coordinate.externalId}.`)
    const { fillAmazonListingAsins } = await import('../amazon/listing-asin-fill.service.js')
    const report = await fillAmazonListingAsins([listingId], { dryRun: true })
    const row = report.rows[0]
    if (row?.outcome !== 'filled' || !row.asin) throw new IdentityFixRefusal(`${where(coordinate)}: Amazon gave no ASIN (${row?.reason ?? row?.outcome ?? 'no answer'}).`)
    return { coordinate, channel: 'AMAZON', externalId: row.asin, verdict: 'verified', reason: `Amazon holds seller SKU ${row.sku} as ${row.asin}.`, matchedSkus: row.sku ? [row.sku] : [] }
  }

  const words = wordsOf(coordinate.channel)
  const id = String(input.externalId ?? '').trim()
  if (!id) throw new IdentityFixRefusal(`${where(coordinate)}: name the ${words.name} ${words.idLabel} to link (externalId).`)
  const proof = await proveShared(coordinate, id, options.sheet ? {} : { acknowledgeUnverifiable: input.acknowledgeUnverifiable, mcp: true }, deps)
  if (proof.refusal) throw new IdentityFixRefusal(proof.refusal)
  if (proof.unchanged && !options.sheet) throw new IdentityFixRefusal(`${where(coordinate)} already carries ${words.name} ${words.idLabel} ${proof.itemId}, and ${words.name} confirms it: nothing to change.`)
  return {
    coordinate, channel: coordinate.channel as LinkPlan['channel'], externalId: proof.itemId, verdict: proof.verdict as 'verified' | 'unverifiable', reason: proof.reason,
    matchedSkus: proof.matchedSkus, seller: proof.seller ?? undefined, liveStatus: proof.channelStatus, proof,
  }
}

/** What the sheet's Check shows: the proof in plain words, never thrown (a refusal is a finding). */
export interface ChannelIdCheck {
  listingId: string
  channel: string
  market: string
  /** The family's main SKU (Amazon: the row's). */
  sku: string
  /** The id Nexus holds now (Amazon: the row's ASIN, or the ASIN it lists on at Publish), and the listing version the check read (the sheet's fence for Link and Clear). */
  currentId: string | null
  version: number
  itemId: string
  /** A link of `itemId` can be written (or, `unchanged`, the channel confirms what Nexus holds). */
  ok: boolean
  unchanged: boolean
  refusal: string | null
  verdict: ChannelItemProof['verdict'] | null
  /** eBay's own word for the item's state (I1); `channelStatus` is every channel's. */
  ebayStatus: string | null
  channelStatus: string | null
  status: LinkStatus | null
  /** What the proof found, in plain sentences. */
  found: string[]
  /** The rows a link writes. */
  rows: Array<{ listingId: string; sku: string; from: string | null }>
  /** Rows the link moves from another item to this one (the channel shows their SKU on it), each with its sentence. */
  moved: Array<{ listingId: string; sku: string; channelSku: string; from: string; sentence: string }>
  kept: KeptRow[]
  /** What happens after Link: pushes stay paused (eBay, Etsy, Shopify), or nothing is sent until Publish (Amazon). */
  pushes: string
}

/** What Link leaves for Publish on an Amazon row (nothing is sent to Amazon now). */
export const AMAZON_AT_PUBLISH = 'Nothing is sent to Amazon now: Publish lists this row on the ASIN.'

/**
 * Verify mode (the sheet's Check): prove a typed id, or with none the one the listing holds now ("Not confirmed" →
 * Check → Keep / Clear). Reads the channel as this business's account; writes nothing (a Shopify colour store's Find
 * stores the proposal Link confirms).
 */
export async function checkChannelId(listingId: string, input: { externalId?: string | null } = {}, deps: LinkDeps = {}): Promise<ChannelIdCheck> {
  const coordinate = await coordinateOf(listingId)
  if (!coordinate) throw new IdentityFixRefusal(LISTING_NOT_FOUND, 'not_found')
  const words = wordsOf(coordinate.channel)
  const typed = String(input.externalId ?? '').trim()
  const amazon = coordinate.channel === 'AMAZON'
  const current = amazon ? coordinate.externalId ?? coordinate.suggestedId ?? null : coordinate.externalId
  const itemId = typed || current || ''
  const base: ChannelIdCheck = {
    listingId, channel: coordinate.channel, market: coordinate.market, sku: amazon ? coordinate.rows[0]?.sku ?? coordinate.root.sku : coordinate.root.sku, currentId: current,
    version: coordinate.asked.version, itemId, ok: false, unchanged: false, refusal: null, verdict: null, ebayStatus: null, channelStatus: null, status: null,
    found: [], rows: [], moved: [], kept: [], pushes: amazon ? AMAZON_AT_PUBLISH : pushesStayPaused(words.noun),
  }
  const refusal = linkChannelRefusal(coordinate)
  if (refusal) return { ...base, refusal }
  if (!itemId) return { ...base, refusal: `Type the ${words.name} ${words.idLabel} to check.` }
  if (amazon) {
    const proof = await proveAmazonAsin(listingId, itemId, deps.amazon)
    return { ...base, itemId: proof.asin || itemId, ok: !proof.refusal, unchanged: !proof.refusal && proof.unchanged, refusal: proof.refusal, verdict: proof.refusal ? 'rejected' : 'verified',
      found: proof.found, rows: proof.refusal ? [] : [{ listingId, sku: base.sku, from: proof.current }] }
  }
  const proof = await proveShared(coordinate, itemId, {}, deps)
  return {
    ...base, itemId: proof.itemId || itemId, ok: !proof.refusal, unchanged: !proof.refusal && proof.unchanged, refusal: proof.refusal,
    verdict: proof.verdict, ebayStatus: proof.channel === 'EBAY' ? proof.channelStatus : null, channelStatus: proof.channelStatus, status: proof.status, found: proofSentences(proof),
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
  /** The status the rows took (the channel's, in Nexus words). */
  status?: LinkStatus
  snapshotIds?: string[]
  /** Rows moved from another item to this one (their SKU is on it), and rows that hold another item and were left alone. */
  moved?: MovedRow[]
  kept?: KeptRow[]
  /** Rows whose `liveChannelSku` the link recorded (the SKU the channel proved for each). */
  liveSkus?: Array<{ id: string; sku: string }>
  /** Amazon: the ASIN set (or kept) as the one the row lists on at Publish. */
  suggestedAsin?: { previous: string | null; changed: boolean }
  /** Shopify colour store: the colour Confirm linked. */
  colour?: ChannelItemProof['colour']
}

/** What one linked row becomes, per channel: the id, the channel's status, published, paused (and the channel's own facts). */
function linkData(channel: string, proof: ChannelItemProof, row: CarriedRow, now: Date): Record<string, unknown> {
  const status = proof.status!
  if (channel === 'SHOPIFY') {
    return { externalListingId: proof.itemId, platformProductId: proof.itemId, listingStatus: status, isPublished: status === 'ACTIVE', syncPaused: true,
      ...(row.platformAttributes ? { platformAttributes: row.platformAttributes } : {}), version: { increment: 1 } }
  }
  // Etsy: the link is a read of the listing, as the 4-hourly refresh's: the same three stamps (status, time, SUCCESS).
  if (channel === 'ETSY') return { externalListingId: proof.itemId, listingStatus: status, isPublished: true, syncPaused: true, lastSyncedAt: now, lastSyncStatus: 'SUCCESS', version: { increment: 1 } }
  return { externalListingId: proof.itemId, listingStatus: status, isPublished: true, syncPaused: true, version: { increment: 1 } }
}

/**
 * Run a link: verified again on the channel first, then written fenced on the ids and versions the rows carried. Only
 * the rows the item carries, with the channel's status; they stay paused; each records the SKU the channel proved for it
 * (`liveChannelSku`). `actor` = the signed-in person (the sheet) or the approver (Claude). `expectedVersion` = the
 * sheet's fence on the asked listing; `acknowledgeUnverifiable` is Claude's only (an approval in Nexus is the explicit
 * yes): `sheet` runs ignore it.
 */
export async function runLink(listingId: string, input: { externalId?: string | null; acknowledgeUnverifiable?: boolean; expectedExternalId: string; expectedVersion?: number; actor?: string | null; sheet?: boolean }, deps: LinkDeps = {}): Promise<LinkRecord> {
  const asked = await coordinateOf(listingId)
  if (!asked) throw new IdentityFixRefusal(LISTING_NOT_FOUND, 'not_found')
  // The sheet's fence first: a listing that moved since the sheet read it is not asked about on the channel at all.
  fenceVersion(asked, input.expectedVersion)
  const plan = await planFor(asked, listingId, input, deps, { sheet: input.sheet })
  if (plan.externalId !== input.expectedExternalId) throw new IdentityFixRefusal('The channel now answers with another id than the one approved. Nothing changed.', 'conflict')
  const { coordinate } = plan
  if (plan.suggestedAsin) {
    const before = coordinate.rows[0]
    const written = await writeSuggestedAsin(listingId, { asin: plan.externalId, expectedAsin: plan.suggestedAsin.current, expectedVersion: input.expectedVersion ?? asked.asked.version })
    return { listingId, channel: 'AMAZON', externalId: plan.externalId, rows: written.changed ? [{ id: before.id, externalListingId: before.externalListingId, listingStatus: before.listingStatus, isPublished: before.isPublished }] : [],
      membershipsReactivated: [], suggestedAsin: { previous: written.previous, changed: written.changed } }
  }
  // The sheet's Keep on rows that already read what the channel says: nothing to write, and that is the answer.
  if (plan.proof?.unchanged) return { listingId, channel: coordinate.channel, externalId: plan.externalId, rows: [], membershipsReactivated: [], status: plan.proof.status ?? undefined, snapshotIds: [], moved: [], kept: plan.proof.kept, liveSkus: [] }
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
  if (proof.colour) return linkColour(listingId, coordinate, plan, proof, snapshotIds, deps)
  const now = new Date()
  const record = await prisma.$transaction(async (tx) => {
    const record: LinkRecord = { listingId, channel: coordinate.channel, externalId: plan.externalId, rows: [], membershipsReactivated: [], status, snapshotIds, moved: proof.moved, kept: proof.kept, liveSkus: [] }
    for (const row of proof.rows) {
      const updated = await tx.channelListing.updateMany({
        where: { id: row.id, externalListingId: row.externalListingId, version: row.version },
        // The status the channel reports; pushes stay paused until a person resumes them.
        data: linkData(coordinate.channel, proof, row, now) as never,
      })
      if (updated.count !== 1) throw new IdentityFixRefusal('A listing of this family changed meanwhile. Nothing changed.', 'conflict')
      // The SKU the channel proved for this row is the one it holds now (a main row of a variation item names none).
      if (row.channelSku?.trim()) {
        await confirmLiveChannelSku(tx, row.id, row.channelSku)
        record.liveSkus!.push({ id: row.id, sku: row.channelSku.trim() })
      }
      record.rows.push({ id: row.id, externalListingId: row.externalListingId, listingStatus: row.listingStatus, isPublished: row.isPublished })
    }
    if (coordinate.channel === 'EBAY') {
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
    }
    return record
  }, { timeout: 30_000 }).catch((error) => {
    logger.warn('[identity-fix] link failed', { listingId, error: error instanceof Error ? error.message : String(error) })
    throw error
  })
  announceListingValues(record.rows.map((r) => r.id), ['externalListingId', 'syncState'], 'channel-id-link')
  return record
}

/** Shopify colour store: Confirm the colour (it re-reads Shopify and writes the size listings), then record each size's SKU. */
async function linkColour(listingId: string, coordinate: Coordinate, plan: LinkPlan, proof: ChannelItemProof, snapshotIds: string[], deps: LinkDeps): Promise<LinkRecord> {
  try {
    await confirmShopifyColour(coordinate, proof, deps.shopify)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new IdentityFixRefusal(`${where(coordinate)}: ${message}`, /changed|again/i.test(message) ? 'conflict' : 'refused')
  }
  const sizes = new Map((proof.colour?.sizes ?? []).map((s) => [s.productId, s.sku]))
  const linked = await prisma.channelListing.findMany({
    where: { channel: 'SHOPIFY', marketplace: coordinate.market, channelConnectionId: coordinate.accountId, aliasKey: coordinate.aliasKey, productId: { in: [...sizes.keys()] } },
    select: { id: true, productId: true, externalListingId: true, listingStatus: true, isPublished: true },
  })
  const liveSkus: Array<{ id: string; sku: string }> = []
  await prisma.$transaction(async (tx) => {
    for (const row of linked) {
      const sku = sizes.get(row.productId)?.trim()
      if (sku) { await confirmLiveChannelSku(tx, row.id, sku); liveSkus.push({ id: row.id, sku }) }
    }
  })
  announceListingValues(linked.map((r) => r.id), ['externalListingId', 'syncState'], 'channel-id-link')
  return { listingId, channel: 'SHOPIFY', externalId: plan.externalId, rows: linked.map((r) => ({ id: r.id, externalListingId: r.externalListingId, listingStatus: r.listingStatus, isPublished: r.isPublished })),
    membershipsReactivated: [], status: proof.status ?? undefined, snapshotIds, moved: [], kept: [], liveSkus, colour: proof.colour }
}

export { CHANNEL_WORDS }
