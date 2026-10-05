/**
 * Per-listing channel SKU, the database half (plan docs/sheet-ids-sku-rows/PLAN.md, step S2). The rules live in
 * `channel-sku.pure.ts`; this file reads and writes `ChannelListing.channelSku` / `liveChannelSku` with them.
 *
 *   - `productForChannelSku` matches a channel's SKU back to a product (orders, returns, stock reports), inside one
 *     connected account: confirmed `liveChannelSku` → `channelSku` → the old stores → `Product.sku`. Two products
 *     at the same step are reported as ambiguous, never picked.
 *   - `setChannelSku` is the one writer of a listing's own SKU (a SKU edit in a channel scope of the product sheet).
 *   - `confirmLiveChannelSku` / `clearLiveChannelSku` record what the channel holds (an accepted publish; a Delete).
 *
 * Every call takes the caller's client (`tx`). The writers belong in a transaction: `setChannelSku` holds a
 * transaction-scoped advisory lock while it checks and writes. Business scope: row-level security, plus an explicit
 * workspace and connection filter on every raw read. Nothing here calls a channel.
 */
import { Prisma } from '@prisma/client'
import { channelLabel } from '@nexus/shared/channel-label'
import { PRODUCT_SKU_MAX_LENGTH, PRODUCT_SKU_PATTERN } from '@nexus/shared/product-create'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { AMAZON_LISTING_SKU_KEYS } from '../channel-mapping/defaults.js'
import { listingSkuRefusal, productUsingSku, skusUsedByListings } from '../identity/identity-write-guards.js'
import {
  SHOPIFY_SKU_STORES, legacyChannelSkus, liveChannelSku, wantedChannelSku,
  type ChannelSkuListing, type ChannelSkuSource,
} from './channel-sku.pure.js'
import { liveChannelSkuMoveRefusal, type ChannelSkuMoveFacts } from './channel-sku-live-move.js'
import { usesEbayInventory } from '../pim/ebay-listing-model.js'
import { isStillDraftListing } from '@nexus/shared/push-lock'

type Db = Prisma.TransactionClient

/** The listing facts the channel-SKU rules read. Select this wherever a caller needs `wantedChannelSku` and friends. */
export const CHANNEL_SKU_LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true,
  channelSku: true, liveChannelSku: true, listingStatus: true, isPublished: true, externalListingId: true,
  platformAttributes: true, flatFileSnapshot: true, overrideData: true, version: true,
  // Oldest offer first, so the source a SKU is reported under (and a conflict's list) does not change between reads.
  offers: { select: { sku: true, isActive: true, fulfillmentMethod: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  alias: { select: { sku: true, productId: true } },
  product: { select: { sku: true, deletedAt: true } },
} satisfies Prisma.ChannelListingSelect

export type ChannelSkuListingRow = Prisma.ChannelListingGetPayload<{ select: typeof CHANNEL_SKU_LISTING_SELECT }>

/** A channel SKU matched to one product. `listingId` is null when several of its listings match (several markets). */
export interface ChannelSkuProductMatch {
  ambiguous?: false
  productId: string
  listingId: string | null
  via: ChannelSkuSource
}

/** Two or more products match at the same step: the caller must not pick one. */
export interface ChannelSkuAmbiguousMatch {
  ambiguous: true
  productIds: string[]
  via: ChannelSkuSource
}

export type ChannelSkuMatch = ChannelSkuProductMatch | ChannelSkuAmbiguousMatch

export type ChannelSkuErrorCode = 'LISTING_NOT_FOUND' | 'INVALID_SKU' | 'SKU_TAKEN' | 'VERSION_CONFLICT' | 'NO_ACCOUNT' | 'LIVE_SKU_HELD'

/** A refused channel-SKU write: a status for the route, a code, and one plain sentence. */
export class ChannelSkuError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code: ChannelSkuErrorCode, readonly currentVersion?: number) {
    super(message)
    this.name = 'ChannelSkuError'
  }
}

const LEVELS = ['live', 'channel', 'legacy'] as const
type Level = typeof LEVELS[number]

/** The step at which `listing` holds the SKU `equal` accepts, and the store it came from; null when it does not. */
function matchAt(listing: ChannelSkuListing, level: Level, equal: (value: unknown) => boolean): ChannelSkuSource | null {
  if (level === 'live') return equal(listing.liveChannelSku) ? 'live' : null
  if (level === 'channel') return equal(listing.channelSku) ? 'channel' : null
  // Every offer, active or not: an order or a report may still name an offer that is no longer active.
  return legacyChannelSkus(listing, { offers: 'all' }).find(found => equal(found.sku))?.source ?? null
}

const equalTo = (sku: string, ignoreCase: boolean) => {
  const want = ignoreCase ? sku.trim().toLowerCase() : sku.trim()
  return (value: unknown) => typeof value === 'string' && (ignoreCase ? value.trim().toLowerCase() : value.trim()) === want
}

/**
 * S9 — does this listing hold `sku` as a channel SKU, in any store (confirmed, wanted, or an old store; case and
 * surrounding spaces ignored)? The test `setChannelSku` runs against other products' listings, for a product SKU rename.
 */
export function listingHoldsChannelSku(listing: ChannelSkuListing, sku: string): boolean {
  const equal = equalTo(sku, true)
  return LEVELS.some(level => matchAt(listing, level, equal) !== null)
}

/** One listing that may hold one of the asked SKUs (`listingsThatMayHoldSkus`). */
export interface ChannelSkuHolder {
  /** The asked SKU this listing may hold: trimmed as asked (lower-cased when `ignoreCase`). */
  sku: string
  listingId: string
  productId: string
  channelConnectionId: string | null
  marketplace: string
}

/**
 * The listings that MAY hold one of `skus` in any store (the two columns, offers — inactive too —, the Amazon and
 * Shopify attribute keys, the flat-file snapshot, an alias's SKU): a wide database prefilter, ONE statement that filters
 * in SQL and returns only ids. The pure rules then decide what each row really holds, so there is one rule, not a SQL
 * copy of it. One connected account when `connectionId` is given, else every account of this business (S8: a SKU that
 * arrives without its account, e.g. a feed report). Products in the trash are left out; at most `limit` (SKU, listing)
 * pairs, by listing id.
 *
 * Not for a per-write hot path: the JSON stores cannot use an index. The write guards match the indexed columns only.
 */
export async function listingsThatMayHoldSkus(tx: Db, args: {
  skus: ReadonlyArray<string | null | undefined>
  ignoreCase?: boolean
  connectionId?: string | null
  channel?: string | null
  marketplace?: string | null
  exceptProductId?: string | null
  limit?: number
  /** False on a database without `ProductListingAlias.sku` (`availableRequirements`): the alias store is not read. */
  aliasSku?: boolean
}): Promise<ChannelSkuHolder[]> {
  const keys = [...new Set(args.skus
    .filter((s): s is string => typeof s === 'string' && !!s.trim())
    .map(s => args.ignoreCase ? s.trim().toLowerCase() : s.trim()))]
  if (!keys.length) return []
  // The two new columns are written trimmed, so the exact match can use their (connection, SKU) indexes.
  const column = (name: 'channelSku' | 'liveChannelSku') => args.ignoreCase
    ? Prisma.sql`lower(btrim(cl.${Prisma.raw(`"${name}"`)})) = s.key` : Prisma.sql`cl.${Prisma.raw(`"${name}"`)} = s.key`
  const same = (expr: Prisma.Sql) => args.ignoreCase ? Prisma.sql`lower(btrim(${expr})) = s.key` : Prisma.sql`btrim(${expr}) = s.key`
  const holds = [
    column('liveChannelSku'),
    column('channelSku'),
    Prisma.sql`EXISTS (SELECT 1 FROM "Offer" o WHERE o."channelListingId" = cl.id AND ${same(Prisma.sql`o.sku`)})`,
    ...AMAZON_LISTING_SKU_KEYS.platformAttributes.map(k => same(Prisma.sql`cl."platformAttributes" ->> ${k}::text`)),
    ...AMAZON_LISTING_SKU_KEYS.flatFileSnapshot.map(k => same(Prisma.sql`cl."flatFileSnapshot" ->> ${k}::text`)),
    ...SHOPIFY_SKU_STORES.attributePaths.map(path => same(Prisma.sql`cl."platformAttributes" #>> ${path}::text[]`)),
    ...SHOPIFY_SKU_STORES.overrideKeys.map(k => same(Prisma.sql`cl."overrideData" ->> ${k}::text`)),
    ...(args.aliasSku === false ? [] : [same(Prisma.sql`a.sku`)]),
  ]
  const rows = await tx.$queryRaw<Array<{ sku: string; listing_id: string; product_id: string; connection_id: string | null; marketplace: string }>>`
    SELECT DISTINCT s.key AS sku, cl.id AS listing_id, cl."productId" AS product_id, cl."channelConnectionId" AS connection_id, cl.marketplace
    FROM unnest(${keys}::text[]) AS s(key)
    JOIN "ChannelListing" cl ON cl."workspaceId" = ${workspaceIdForQuery()}
      ${args.connectionId ? Prisma.sql`AND cl."channelConnectionId" = ${args.connectionId}` : Prisma.empty}
      ${args.channel ? Prisma.sql`AND cl.channel = ${args.channel}` : Prisma.empty}
      ${args.marketplace ? Prisma.sql`AND cl.marketplace = ${args.marketplace}` : Prisma.empty}
      ${args.exceptProductId ? Prisma.sql`AND cl."productId" <> ${args.exceptProductId}` : Prisma.empty}
    JOIN "Product" p ON p.id = cl."productId" AND p."deletedAt" IS NULL
    ${args.aliasSku === false ? Prisma.empty : Prisma.sql`LEFT JOIN "ProductListingAlias" a ON a.id = cl."aliasId"`}
    WHERE (${Prisma.join(holds, ' OR ')})
    ORDER BY listing_id, sku
    LIMIT ${args.limit ?? 500}`
  return rows.map(r => ({ sku: r.sku, listingId: r.listing_id, productId: r.product_id, channelConnectionId: r.connection_id, marketplace: r.marketplace }))
}

/** The listings on ONE connected account that may hold `sku` (`listingsThatMayHoldSkus`), loaded for the pure rules. */
async function listingsThatMayHold(tx: Db, args: {
  connectionId: string; sku: string; ignoreCase: boolean
  channel?: string | null; marketplace?: string | null; exceptProductId?: string | null
}): Promise<ChannelSkuListingRow[]> {
  if (!args.connectionId) return []
  const held = await listingsThatMayHoldSkus(tx, { ...args, skus: [args.sku] })
  if (!held.length) return []
  return tx.channelListing.findMany({ where: { id: { in: held.map(r => r.listingId) } }, select: CHANNEL_SKU_LISTING_SELECT, orderBy: { id: 'asc' } })
}

/**
 * Which product a channel's SKU names, inside ONE connected account (and one market, when given). In order:
 * the SKU the channel confirmed (`liveChannelSku`), the SKU Nexus sends (`channelSku`), the old stores (Amazon offers,
 * mirror keys and flat-file snapshot; Shopify's native SKU; an alias's SKU), then a product whose own SKU it is.
 * The first step that matches decides: one product → that product (and its listing, when exactly one matched); two or
 * more products → `{ ambiguous: true }`. The SKU is compared exactly (surrounding spaces ignored), as a channel sends it.
 * Another business's rows are never read (row-level security and an explicit workspace filter); another account's
 * listings are never matched.
 */
export async function productForChannelSku(tx: Db, input: {
  channel: string
  channelConnectionId: string
  marketplace?: string | null
  sku: string
}): Promise<ChannelSkuMatch | null> {
  const sku = String(input.sku ?? '').trim()
  if (!sku || !input.channelConnectionId) return null
  const channel = String(input.channel ?? '').trim().toUpperCase() || null
  const marketplace = input.marketplace?.trim() || null
  const equal = equalTo(sku, false)
  const candidates = await listingsThatMayHold(tx, { connectionId: input.channelConnectionId, sku, ignoreCase: false, channel, marketplace })
  for (const level of LEVELS) {
    const hits = candidates.flatMap(listing => {
      const via = matchAt(listing, level, equal)
      return via ? [{ listing, via }] : []
    })
    if (!hits.length) continue
    const productIds = [...new Set(hits.map(hit => hit.listing.productId))].sort()
    if (productIds.length > 1) return { ambiguous: true, productIds, via: hits[0].via }
    return { productId: productIds[0], listingId: hits.length === 1 ? hits[0].listing.id : null, via: hits[0].via }
  }
  const product = await tx.product.findFirst({ where: { sku, deletedAt: null }, select: { id: true, sku: true } })
  if (!product) return null
  // Its listing here, when exactly one of them holds (or, still a draft, would send) this SKU.
  const listings = await tx.channelListing.findMany({
    where: { productId: product.id, channelConnectionId: input.channelConnectionId, ...(channel ? { channel } : {}), ...(marketplace ? { marketplace } : {}) },
    select: CHANNEL_SKU_LISTING_SELECT,
  })
  const holding = listings.filter(listing => (liveChannelSku(listing, product.sku) ?? wantedChannelSku(listing, product.sku)).sku === sku)
  return { productId: product.id, listingId: holding.length === 1 ? holding[0].id : null, via: 'product' }
}

/** Why a typed channel SKU cannot be stored, or null: the product-SKU rule (`@nexus/shared/product-create`). */
export function channelSkuProblem(sku: string): string | null {
  if (sku.length > PRODUCT_SKU_MAX_LENGTH) return `A SKU can have up to ${PRODUCT_SKU_MAX_LENGTH} characters. This one has ${sku.length}.`
  if (!PRODUCT_SKU_PATTERN.test(sku)) return 'Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.'
  return null
}

const VERSION_CONFLICT = 'Version conflict — another tab edited this listing. Refresh and retry.'

/**
 * S10 — what decides whether Publish can move this held listing to another SKU (`channelSkuMoveRefusal`): on Amazon,
 * whether it is a family's main row (a parent, or a product with variations: S10 refuses to move it); on eBay, whether
 * its item is on eBay's Inventory API — `usesEbayInventory` over the item's rows (this market, account and listing), the
 * test the eBay publisher itself makes. Other channels need no facts. Read only for a listing about to move.
 */
export async function channelSkuMoveFacts(tx: Db, listing: {
  productId: string; channel: string; marketplace: string; channelConnectionId: string | null; aliasKey?: string | null
}): Promise<ChannelSkuMoveFacts> {
  const channel = String(listing.channel ?? '').toUpperCase()
  if (channel !== 'AMAZON' && channel !== 'EBAY') return {}
  const product = await tx.product.findUnique({ where: { id: listing.productId },
    select: { isParent: true, parentId: true, _count: { select: { children: { where: { deletedAt: null } } } } } })
  if (channel === 'AMAZON') return { mainRow: !!product && !product.parentId && (product.isParent || product._count.children > 0) }
  const root = product?.parentId ?? listing.productId
  const rows = await tx.channelListing.findMany({ where: { channel: 'EBAY', marketplace: listing.marketplace, channelConnectionId: listing.channelConnectionId,
    aliasKey: listing.aliasKey ?? '', OR: [{ productId: root }, { product: { parentId: root } }] }, select: { platformAttributes: true } })
  return { ebayInventory: usesEbayInventory({ listings: rows }) }
}

export interface SetChannelSkuResult {
  listingId: string
  /** What is stored now; null = the listing follows the product SKU. */
  channelSku: string | null
  previous: string | null
  version: number
  changed: boolean
}

/**
 * The one writer of a listing's own SKU (this channel, this market). `sku` is trimmed; null or empty = follow the
 * product SKU again. A SKU is stored as typed, even when it equals the product SKU; on a listing the channel holds it
 * then stays put if the product SKU is renamed later. S9: on a still-draft, a stored SKU equal to the product SKU
 * follows a rename like no SKU at all (`channel-sku-rename.ts`), and "follow" really follows: when an old store still
 * names another SKU for the draft (a flat-file or offer copy left by a Delete), the product SKU itself is stored, so
 * Publish lists the product SKU and not the old copy.
 *
 * Refused, each with one plain sentence: more than 100 characters, or a character the product-SKU rule does not allow;
 * a listing the channel holds that would then MOVE to another SKU where Publish cannot move it (`liveChannelSkuMoveRefusal`,
 * per channel: an Amazon family's main row, an eBay Inventory item, Etsy — the sentence Publish's review gives; Amazon,
 * eBay Trading and Shopify moves are allowed, Publish carries them. `liveMove: 'allow'` only for a caller that removed the
 * listing from the channel itself, as listing recovery does); another product's SKU in this business (G4, the other direction); another product's
 * extra-listing SKU (G4); a SKU another product holds on the same connected account (channel, confirmed or old stores).
 * The same product may reuse its SKU across its markets and aliases. The checks and the write run under a
 * transaction-scoped advisory lock on (business, account, SKU), so two writers cannot both pass. The write bumps the
 * listing's `version` (a stale `expectedVersion` is refused) and leaves a `ChannelListingOverride` history row.
 * `dryRun`: every check, no write (a preview); the answer is what the write would store.
 */
export async function setChannelSku(tx: Db, input: {
  listingId: string
  sku: string | null
  actorId: string | null
  expectedVersion?: number
  reason?: string
  liveMove?: 'refuse' | 'allow'
  dryRun?: boolean
}): Promise<SetChannelSkuResult> {
  const typed = typeof input.sku === 'string' && input.sku.trim() ? input.sku.trim() : null
  const listing = await tx.channelListing.findUnique({ where: { id: input.listingId }, select: CHANNEL_SKU_LISTING_SELECT })
  if (!listing || listing.product?.deletedAt) throw new ChannelSkuError(404, 'Listing not found.', 'LISTING_NOT_FOUND')
  if (input.expectedVersion != null && input.expectedVersion !== listing.version) {
    throw new ChannelSkuError(409, VERSION_CONFLICT, 'VERSION_CONFLICT', listing.version)
  }
  const productSku = listing.product?.sku?.trim() || null
  const draft = isStillDraftListing(listing)
  const held = draft ? null : liveChannelSku(listing, productSku)
  const follows = wantedChannelSku({ ...listing, channelSku: null }, productSku).sku
  // "Follow" (null). On a draft an old store still names another SKU for: store the product SKU itself. On a listing the
  // channel holds under another SKU than the one it would then send: that is a MOVE, stored explicitly — Publish moves a
  // held listing only to a SKU of its own (S10), so a bare "follow" would send the new SKU without moving the old one.
  const value = typed ?? (draft ? (productSku && follows !== productSku ? productSku : null)
    : held?.sku && follows && follows !== held.sku ? follows : null)
  const previous = listing.channelSku?.trim() || null
  if (value === previous) return { listingId: listing.id, channelSku: previous, previous, version: listing.version, changed: false }
  if (value) {
    const problem = channelSkuProblem(value)
    if (problem) throw new ChannelSkuError(400, problem, 'INVALID_SKU')
  }
  if (input.liveMove !== 'allow' && held) {
    const moving = held.sku === null || wantedChannelSku({ ...listing, channelSku: value }, productSku).sku !== held.sku
    const refusal = moving ? liveChannelSkuMoveRefusal(listing, productSku, value, await channelSkuMoveFacts(tx, listing)) : null
    if (refusal) throw new ChannelSkuError(409, refusal, 'LIVE_SKU_HELD')
  }
  // Following the product SKU (stored only because an old store says otherwise) needs no check: it is this product's.
  if (value && (typed || value !== productSku)) {
    if (!listing.channelConnectionId) {
      throw new ChannelSkuError(409, 'This listing is not linked to a channel account, so its own SKU cannot be checked. Link the listing to its account first.', 'NO_ACCOUNT')
    }
    const workspaceId = workspaceIdForQuery()
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['nexus-channel-sku', workspaceId, listing.channelConnectionId, value.toLowerCase()])}, 0))`
    const otherProduct = await productUsingSku(value, listing.productId, tx)
    if (otherProduct) {
      throw new ChannelSkuError(409, `${value} is the SKU of another product (${otherProduct.sku}) in this business. One SKU names one product: choose another SKU for this listing.`, 'SKU_TAKEN')
    }
    // An extra listing's SKU belongs to its family root; the root's own listings may reuse it (a SKU is unique per business).
    const aliasUse = (await skusUsedByListings([value], tx)).find(use => use.productSku !== listing.product?.sku)
    if (aliasUse) throw new ChannelSkuError(409, listingSkuRefusal(aliasUse), 'SKU_TAKEN')
    const equal = equalTo(value, true)
    const holders = await listingsThatMayHold(tx, { connectionId: listing.channelConnectionId, sku: value, ignoreCase: true, exceptProductId: listing.productId })
    const holder = holders.find(other => LEVELS.some(level => matchAt(other, level, equal)))
    if (holder) {
      const where = channelLabel(holder.channel)
      throw new ChannelSkuError(409, `${value} is already the SKU of ${holder.product?.sku ?? 'another product'} on this ${where} account (${where} ${holder.marketplace}). `
        + 'Within one channel account a SKU names one product: choose another SKU.', 'SKU_TAKEN')
    }
  }
  if (input.dryRun) return { listingId: listing.id, channelSku: value, previous, version: listing.version, changed: true }
  const written = await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version }, data: { channelSku: value, version: { increment: 1 } } })
  if (written.count !== 1) throw new ChannelSkuError(409, VERSION_CONFLICT, 'VERSION_CONFLICT')
  await tx.channelListingOverride.create({ data: { channelListingId: listing.id, fieldName: 'channelSku', previousValue: previous, newValue: value,
    changedBy: input.actorId, reason: input.reason ?? (typed ? 'Own SKU for this listing' : 'Follows the product SKU again') } })
  return { listingId: listing.id, channelSku: value, previous, version: listing.version + 1, changed: true }
}

/**
 * The channel confirmed it holds `sku` for this listing (an accepted publish, a pull, an import). A system record, so
 * no version bump (as the publish settle step writes a listing). Returns whether anything changed.
 */
export async function confirmLiveChannelSku(tx: Db, listingId: string, sku: string): Promise<boolean> {
  const value = typeof sku === 'string' ? sku.trim() : ''
  if (!value) throw new ChannelSkuError(400, 'A channel SKU cannot be empty; nothing was recorded.', 'INVALID_SKU')
  const written = await tx.channelListing.updateMany({
    where: { id: listingId, OR: [{ liveChannelSku: null }, { liveChannelSku: { not: value } }] },
    data: { liveChannelSku: value },
  })
  return written.count === 1
}

/** The channel no longer holds this listing (a Delete returned it to draft): nothing known. Returns whether anything changed. */
export async function clearLiveChannelSku(tx: Db, listingId: string): Promise<boolean> {
  const written = await tx.channelListing.updateMany({ where: { id: listingId, liveChannelSku: { not: null } }, data: { liveChannelSku: null } })
  return written.count === 1
}
