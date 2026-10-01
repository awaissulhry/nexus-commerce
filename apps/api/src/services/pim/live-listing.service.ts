/**
 * The ONE place a listing the channel already has is recorded (step 7, part 1). Its twin for listings that are NOT on
 * the channel is `ensureDraftListings` (draft-listing.service.ts); between them they decide every rule-owned field of
 * a ChannelListing a creator writes.
 *
 * A recorded listing is LIVE:
 *   - `isPublished: true` and the status the channel reported (the caller passes it: ACTIVE, BUYABLE, …);
 *   - the channel's id when the caller has one;
 *   - a still-draft (`isStillDraftListing`: DRAFT, never published, no channel id) loses the `syncPaused` that kept it
 *     inert — it is live now, and a paused live listing sends no stock. Any other row keeps its own `syncPaused`: an
 *     operator's pause on a live listing is never undone here.
 *
 * Rules:
 *   - Account: REQUIRED, and an ACTIVE connection of the channel. A publisher knows which account it sent through;
 *     nothing here guesses one.
 *   - Market: an active `Marketplace` row of the channel, spelled as its code (eBay UK is 'UK', `EBAY_UK`). `region`
 *     follows `listingRegion`, because eBay's own readers key their listings by region and eBay UK's is GB.
 *   - Address: the coordinate (channel + market + account + alias, `whereCoordinate`). A row there is updated, a missing
 *     one created. Before creating, a LEGACY row of the same listing is adopted onto the coordinate: a row with no
 *     account (only when this account is the one the resolver gives an unattributed row), or a row under an older
 *     spelling of the market (eBay UK written as GB). Two such rows for one product are refused: which one is the
 *     listing is not a guess to make here.
 *   - Channel id: written when the row has none or the same one. A DIFFERENT stored id is KEPT, and reported in
 *     `keptExternalListingId`: changing an established link is the dangerous case (it points the next push at another
 *     listing), so it goes through a verified re-link, never through a write-back. The caller decides how loudly to
 *     report it. The same holds for `externalParentId`.
 *   - Alias: `aliasKey` '' is the primary listing; an alias listing must be one of the family's aliases on this
 *     account and market (`validateAliasWriteTargets`), and is created with its `aliasId`.
 *   - The caller's own fields (title, price, attributes, …) are written as given, after the rule's own checks: they
 *     may not name a rule-owned field.
 *
 * It runs on the caller's transaction client and opens none of its own, calls no channel and publishes no event.
 *
 * Concurrency: rows are inserted with ON CONFLICT DO NOTHING against the coordinate's unique key, in product-id order.
 * A row another transaction inserted first is read back and then updated like any existing row. An update names the
 * facts it decided on (a still-draft, the channel id it may fill, the caller's version), so a row that changed after
 * it was read is read again and decided again, once.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { channelLabel } from '@nexus/shared/channel-label'
import { STILL_DRAFT_LISTING, isStillDraftListing } from '@nexus/shared/push-lock'
import { listingRegion, whereCoordinate } from '../../lib/listing-coordinate.js'
import { chooseConnection, listActiveConnections } from '../connection-resolver.service.js'
import { ChannelListingVersionConflict } from '../channel-listing-cas.js'
import { validateAliasWriteTargets } from './listing-alias.service.js'

/** Channel fields a caller writes beside the rule's own (title, price, platformAttributes, offerActive, …). */
export type LiveListingFields = Record<string, unknown>

export interface LiveListingRow {
  productId: string
  /** The status the channel reported: ACTIVE, or the channel's own word (Amazon's BUYABLE / DISCOVERABLE). */
  listingStatus: string
  /** The channel's id for this listing. Omitted or null: the stored id stays as it is. */
  externalListingId?: string | null
  /** The channel's parent id (Amazon's parent ASIN). Omitted or null: the stored one stays. */
  externalParentId?: string | null
  /** Written on create and on update. */
  fields?: LiveListingFields
  /** Written only when this call creates the row (a first observed quantity, the price just sent). */
  createFields?: LiveListingFields
  /** The version the caller read: an existing row that moved on is refused with `ChannelListingVersionConflict`. */
  expectedVersion?: number | null
  /** Extra facts an existing row must still have when it is written (the caller's own guard). */
  guard?: Prisma.ChannelListingWhereInput
}

export interface RecordLiveListingsInput {
  channel: string
  market: string
  accountId: string
  /** '' (the default) is the primary listing. */
  aliasKey?: string
  rows: LiveListingRow[]
}

export interface RecordedLiveListing {
  id: string
  productId: string
  version: number
  /** True only for a row THIS call inserted. */
  created: boolean
  /** A legacy row of this listing (no account, or an older market spelling) that this call moved onto the coordinate. */
  adopted: boolean
  /** A still-draft this call made live, which lost the pause that kept it inert. */
  unpaused: boolean
  /** The channel offered another id than the one stored: the stored id was kept. */
  keptExternalListingId?: { stored: string; offered: string }
  keptExternalParentId?: { stored: string; offered: string }
}

export type LiveListingErrorCode =
  | 'INVALID_REQUEST'
  | 'NO_ACCOUNT'
  | 'ACCOUNT_UNAVAILABLE'
  | 'MARKET_UNAVAILABLE'
  | 'LISTING_AMBIGUOUS'
  | 'LISTING_CHANGED'
  | 'COORDINATE_TAKEN'

export class LiveListingError extends Error {
  constructor(readonly code: LiveListingErrorCode, message: string, readonly statusCode = 409) {
    super(message)
    this.name = 'LiveListingError'
  }
}

type Tx = Prisma.TransactionClient

/** "an Amazon", "an eBay"; "a Shopify". */
const withArticle = (label: string) => `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`

/** Fields only this rule writes: a caller naming one would overrule it. */
const RULE_OWNED = ['id', 'workspaceId', 'productId', 'channel', 'marketplace', 'channelMarket', 'region', 'channelConnectionId',
  'aliasKey', 'aliasId', 'listingStatus', 'isPublished', 'syncPaused', 'externalListingId', 'externalParentId', 'version'] as const

/** Older spellings a listing of this market may still be stored under (`${channel}_${code}` → spellings). */
const LEGACY_MARKET_SPELLINGS: Record<string, string[]> = { EBAY_UK: ['GB'] }

const FACTS = { id: true, productId: true, version: true, marketplace: true, channelConnectionId: true, listingStatus: true,
  isPublished: true, externalListingId: true, externalParentId: true, syncPaused: true } as const
type Facts = Prisma.ChannelListingGetPayload<{ select: typeof FACTS }>

/**
 * Record, on one coordinate, the listings the channel already has for these products: create the missing rows and
 * make the existing ones live. Returns one entry per requested row, in the request's order.
 */
export async function recordLiveListings(tx: Tx, input: RecordLiveListingsInput): Promise<RecordedLiveListing[]> {
  const channel = String(input.channel ?? '').trim().toUpperCase()
  const market = String(input.market ?? '').trim().toUpperCase()
  const aliasKey = input.aliasKey ?? ''
  if (!channel || !market) throw new LiveListingError('INVALID_REQUEST', 'Choose a channel and a market.', 400)
  if (typeof aliasKey !== 'string') throw new LiveListingError('INVALID_REQUEST', 'A listing alias must be text.', 400)
  const label = channelLabel(channel)
  if (typeof input.accountId !== 'string' || !input.accountId.trim()) {
    throw new LiveListingError('NO_ACCOUNT', `Name the ${label} account this listing is live on.`, 400)
  }
  const rows = Array.isArray(input.rows) ? input.rows : []
  if (rows.some(row => typeof row?.productId !== 'string' || !row.productId.trim())) throw new LiveListingError('INVALID_REQUEST', 'Every listing needs a product.', 400)
  if (new Set(rows.map(row => row.productId)).size !== rows.length) throw new LiveListingError('INVALID_REQUEST', 'A product is listed twice in one record.', 400)
  for (const row of rows) {
    if (typeof row.listingStatus !== 'string' || !row.listingStatus.trim()) throw new LiveListingError('INVALID_REQUEST', 'Every live listing needs the status the channel reported.', 400)
    const named = RULE_OWNED.filter(key => (row.fields && key in row.fields) || (row.createFields && key in row.createFields))
    if (named.length > 0) throw new LiveListingError('INVALID_REQUEST', `A caller may not write ${named.join(', ')} beside the live-listing rule.`, 400)
  }
  if (rows.length === 0) return []

  const marketplace = await tx.marketplace.findFirst({ where: { channel, code: market, isActive: true }, select: { id: true } })
  if (!marketplace) throw new LiveListingError('MARKET_UNAVAILABLE', `${label} · ${market} is not an active market in this business.`, 400)
  const active = await listActiveConnections(channel, tx)
  const account = active.find(connection => connection.id === input.accountId)
  if (!account) throw new LiveListingError('ACCOUNT_UNAVAILABLE', `The ${label} account for ${market} is not connected. Reconnect it before recording this listing.`)
  const accountId = account.id
  const coordinate = { channel, market, accountId, aliasKey }
  const productIds = rows.map(row => row.productId)
  if (aliasKey !== '') {
    // A pasted alias id is no authority over another family's or account's listing (throws AliasScopeMismatchError).
    await validateAliasWriteTargets(productIds.map(productId => ({ productId, channel, marketplace: market, connectionId: accountId, aliasKey })), tx)
  }

  const existing = new Map((await tx.channelListing.findMany({ where: coordinateWhere(productIds, coordinate), select: FACTS })).map(row => [row.productId, row]))
  const adopted = await adoptLegacyRows(tx, productIds.filter(id => !existing.has(id)), coordinate, active, label)
  for (const row of adopted) existing.set(row.productId, row)

  // One insert order for every caller (by product id), as `ensureDraftListings` does, so two calls queue on the key.
  const missing = rows.filter(row => !existing.has(row.productId)).sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
  const inserted = missing.length === 0 ? [] : await tx.channelListing.createManyAndReturn({
    data: missing.map(row => liveListingData(row, coordinate)),
    skipDuplicates: true,
    select: { id: true, productId: true, version: true },
  })
  const created = new Set(inserted.map(row => row.productId))
  const skipped = missing.filter(row => !created.has(row.productId)).map(row => row.productId)
  if (skipped.length > 0) {
    // Another transaction committed these first (READ COMMITTED): update what is there now.
    for (const row of await tx.channelListing.findMany({ where: coordinateWhere(skipped, coordinate), select: FACTS })) existing.set(row.productId, row)
    const absent = skipped.filter(id => !existing.has(id))
    if (absent.length > 0) {
      // ON CONFLICT DO NOTHING also yields to the legacy `channelMarket` key: a row with the same `${channel}_${market}`
      // under another `marketplace` spelling. Refuse rather than report a row that is not there.
      throw new LiveListingError('COORDINATE_TAKEN', `${await skusOf(tx, absent)} already has ${withArticle(label)} ${market} listing recorded under another market name. Fix that listing before recording this one.`)
    }
  }

  const adoptedIds = new Set(adopted.map(row => row.id))
  const outcomes = new Map<string, Omit<RecordedLiveListing, 'version'>>()
  for (const row of inserted) outcomes.set(row.productId, { id: row.id, productId: row.productId, created: true, adopted: false, unpaused: false })
  for (const row of rows) {
    if (created.has(row.productId)) continue
    const facts = existing.get(row.productId)!
    outcomes.set(row.productId, { ...await makeLive(tx, facts, row), adopted: adoptedIds.has(facts.id) })
  }
  const versions = new Map((await tx.channelListing.findMany({ where: { id: { in: [...outcomes.values()].map(o => o.id) } }, select: { id: true, version: true } })).map(row => [row.id, row.version]))
  return rows.map(row => {
    const outcome = outcomes.get(row.productId)!
    return { ...outcome, version: versions.get(outcome.id) ?? 0 }
  })
}

/**
 * For a caller that holds no transaction (a route): the same rule, in a transaction of its own — and, once it has
 * committed, the go-live's held prices are sent (`sendHeldPricesAfterGoLive`).
 */
export async function recordLiveListingsInTransaction(input: RecordLiveListingsInput, actor = 'live-listing'): Promise<RecordedLiveListing[]> {
  const recorded = await prisma.$transaction(tx => recordLiveListings(tx, input))
  await sendHeldPricesAfterGoLive(recorded, actor)
  return recorded
}

/**
 * Round 6 (2026-10-01) — a still-draft this recorder made live (`unpaused`): a price change it held while it was a draft
 * and its publication does not carry (`PRICE_HELD_DRAFT`: an Amazon sale) is sent ONCE now, through the price door
 * (`sendHeldPrices`; nothing held → nothing sent). The same hook Publish's acceptance runs. Call it AFTER the
 * transaction that recorded the listings has COMMITTED: the hook reads the listing as live. Never throws.
 */
export async function sendHeldPricesAfterGoLive(recorded: ReadonlyArray<Pick<RecordedLiveListing, 'id' | 'unpaused'>>, actor: string): Promise<void> {
  const listingIds = recorded.filter(row => row.unpaused).map(row => row.id)
  if (!listingIds.length) return
  try {
    // Loaded here: the price door's module loads the outbound queue, which a recorder's other callers do not need.
    const { sendHeldPrices } = await import('./channel-price-write.service.js')
    await sendHeldPrices({ listingIds, actor, cause: 'publish' })
  } catch (error) {
    const { logger } = await import('../../utils/logger.js')
    logger.warn('live listing: held prices not sent after go-live; the next resume or price change sends them', { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Every rule-owned field of a created live listing is decided here, and only here. */
function liveListingData(row: LiveListingRow, c: Coordinate): Prisma.ChannelListingCreateManyInput {
  return {
    ...row.createFields,
    ...row.fields,
    productId: row.productId,
    channel: c.channel,
    marketplace: c.market,
    channelMarket: `${c.channel}_${c.market}`,
    region: listingRegion(c.channel, c.market),
    channelConnectionId: c.accountId,
    aliasKey: c.aliasKey,
    aliasId: c.aliasKey === '' ? null : c.aliasKey,
    listingStatus: row.listingStatus,
    isPublished: true,
    syncPaused: false,
    externalListingId: row.externalListingId ?? null,
    externalParentId: row.externalParentId ?? null,
  } as Prisma.ChannelListingCreateManyInput
}

/** One existing row made live: decided on the facts read, and decided again once if the row changed meanwhile. */
async function makeLive(tx: Tx, first: Facts, row: LiveListingRow): Promise<Omit<RecordedLiveListing, 'version' | 'adopted'>> {
  let facts: Facts | null = first
  for (let attempt = 0; attempt < 2 && facts; attempt++) {
    if (row.expectedVersion != null && facts.version !== row.expectedVersion) throw new ChannelListingVersionConflict(facts.id, row.expectedVersion, facts.version)
    const stillDraft = isStillDraftListing(facts)
    const listingId = identity(facts.externalListingId, row.externalListingId)
    const parentId = identity(facts.externalParentId, row.externalParentId)
    const where: Prisma.ChannelListingWhereInput = {
      id: facts.id,
      ...(row.expectedVersion != null ? { version: row.expectedVersion } : {}),
      // A still-draft is lifted only while it IS one; otherwise the stored id must still be the one decided on.
      ...(stillDraft ? STILL_DRAFT_LISTING : listingId.write ? { externalListingId: facts.externalListingId } : {}),
      ...(parentId.write ? { externalParentId: facts.externalParentId } : {}),
      ...(row.guard ? { AND: [row.guard] } : {}),
    }
    const data = {
      ...row.fields,
      listingStatus: row.listingStatus,
      isPublished: true,
      ...(listingId.write ? { externalListingId: row.externalListingId } : {}),
      ...(parentId.write ? { externalParentId: row.externalParentId } : {}),
      ...(stillDraft ? { syncPaused: false } : {}),
      version: { increment: 1 },
    } as Prisma.ChannelListingUpdateManyMutationInput
    const { count } = await tx.channelListing.updateMany({ where, data })
    if (count === 1) {
      return { id: facts.id, productId: facts.productId, created: false, unpaused: stillDraft,
        ...(listingId.kept ? { keptExternalListingId: listingId.kept } : {}), ...(parentId.kept ? { keptExternalParentId: parentId.kept } : {}) }
    }
    facts = await tx.channelListing.findUnique({ where: { id: facts.id }, select: FACTS })
  }
  throw new LiveListingError('LISTING_CHANGED', 'This listing changed while it was being recorded. Reload it and try again.')
}

/** Write the offered id when none is stored or it is the same; keep a different stored id and say so. */
function identity(stored: string | null, offered: string | null | undefined): { write: boolean; kept?: { stored: string; offered: string } } {
  if (offered == null || offered === '') return { write: false }
  if (stored != null && stored !== '' && stored !== offered) return { write: false, kept: { stored, offered } }
  return { write: stored !== offered }
}

/**
 * The legacy rows of these listings, moved onto the coordinate: a row with no account (only when `accountId` is the
 * account the resolver answers for an unattributed row — the one it already belonged to), or a row of this account or
 * of none under an older spelling of the market. Two candidates for one product are refused.
 */
async function adoptLegacyRows(tx: Tx, productIds: string[], c: Coordinate, active: Awaited<ReturnType<typeof listActiveConnections>>, label: string): Promise<Facts[]> {
  if (productIds.length === 0) return []
  const spellings = LEGACY_MARKET_SPELLINGS[`${c.channel}_${c.market}`] ?? []
  let ownsUnattributed = false
  try { ownsUnattributed = chooseConnection(active, { channel: c.channel, wantPrimary: true }).id === c.accountId } catch { /* ambiguous: no unattributed row is this account's */ }
  const accounts = ownsUnattributed ? [c.accountId, null] : [c.accountId]
  const or: Prisma.ChannelListingWhereInput[] = []
  if (ownsUnattributed) or.push({ marketplace: c.market, channelConnectionId: null })
  if (spellings.length > 0) or.push({ marketplace: { in: spellings }, OR: accounts.map(channelConnectionId => ({ channelConnectionId })) })
  if (or.length === 0) return []
  const candidates = await tx.channelListing.findMany({ where: { productId: { in: productIds }, channel: c.channel, aliasKey: c.aliasKey, OR: or }, select: FACTS, orderBy: { id: 'asc' } })
  const byProduct = new Map<string, Facts[]>()
  for (const row of candidates) byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), row])
  const ambiguous = [...byProduct].filter(([, list]) => list.length > 1).map(([productId]) => productId)
  if (ambiguous.length > 0) {
    throw new LiveListingError('LISTING_AMBIGUOUS', `${await skusOf(tx, ambiguous)} has several older ${label} ${c.market} listings. Remove the duplicate before recording this one.`)
  }
  const adopted: Facts[] = []
  for (const [, [row]] of byProduct) {
    const { count } = await tx.channelListing.updateMany({
      where: { id: row.id, marketplace: row.marketplace, channelConnectionId: row.channelConnectionId, aliasKey: c.aliasKey },
      data: { marketplace: c.market, channelConnectionId: c.accountId },
    })
    if (count !== 1) throw new LiveListingError('LISTING_CHANGED', 'This listing changed while it was being recorded. Reload it and try again.')
    adopted.push({ ...row, marketplace: c.market, channelConnectionId: c.accountId })
  }
  return adopted
}

type Coordinate = { channel: string; market: string; accountId: string; aliasKey: string }

/** The same predicate for every product, validated level by level (`whereCoordinate`). */
function coordinateWhere(productIds: string[], c: Coordinate): Prisma.ChannelListingWhereInput {
  if (productIds.length === 0) throw new Error('coordinateWhere needs at least one product.')
  const levels = productIds.map(productId => whereCoordinate({ productId, channel: c.channel, marketplace: c.market, channelConnectionId: c.accountId, aliasKey: c.aliasKey }))
  return { ...levels[0], productId: { in: productIds } }
}

async function skusOf(tx: Tx, productIds: string[]): Promise<string> {
  const products = await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } })
  const sku = new Map(products.map(p => [p.id, p.sku]))
  return productIds.map(id => sku.get(id) ?? id).join(', ')
}
