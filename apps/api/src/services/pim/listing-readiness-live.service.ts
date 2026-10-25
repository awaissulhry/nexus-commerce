/**
 * Listings live layer, step 3 (docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md) — the API half: what the channel
 * shows for the Listings page's rows, as far as Nexus knows. Nexus's own tables only, never a channel call: the
 * `ChannelListing` row (what Nexus last sent or read), its open `ListingIssue`s and `AmazonSuppression`s, its
 * `ChannelDrift`, the delete records (`readListingDeletions`) and the older close marks (`oldClosePauses`).
 *
 *   liveDestinationKey   → a listing's readiness coordinate key (the join rule)
 *   readLive             → ONE batched read for a page's products (a fixed number of queries, whatever the page size)
 *   summarizeLive        → a row's listings on one destination: the chip's mark and the "On the channel" words
 *   attachLive           → the post-step of the families and members pages (chips' `live` / `listing`, extra chips,
 *                          the live tiles, the pasted-list search summary)
 *   readChannelSection   → the Listing window's "On the channel" tab (`readinessDetail().channel`)
 *   resolveSearchTokens  → many SKUs, ASINs, Item IDs pasted at once
 *   liveJoinsSql / liveStateSql / liveFlagsSql → the same state and flags in SQL (the live tiles now; the step-2 SQL
 *                          summary's tiles and filters next). Parity: live-state-sql.db.vitest.test.ts.
 *
 * The join rule: a listing L belongs to product P on readiness destination D = (channel, market, account, alias) when
 * L.productId = P, L.channel = D.channel, the markets agree once GB reads UK, L.channelConnectionId = D.accountId and
 * L.aliasKey = D.aliasId ('' = the primary listing = a null alias). One listing per (P, D), except GB and UK twins:
 * those are reported (`duplicates`), never picked. Shared has no live layer. A listing that matches no readiness
 * destination (no account recorded, an account or market outside the footprint, an archived listing customization,
 * no market recorded) shows as an extra chip of its own with a note.
 */
import { Prisma } from '@prisma/client'
import { familySellingState, type ListingDeletion, type SellingState, type SellingStateRead } from '@nexus/shared/listing-actions'
import type {
  ReadinessChannelListing, ReadinessChannelMessage, ReadinessChannelSection, ReadinessChip, ReadinessDestination, ReadinessDiffer,
  ReadinessFamiliesPage, ReadinessLive, ReadinessLiveCounts, ReadinessLiveFlag, ReadinessLiveState, ReadinessLiveSummary, ReadinessMembersPage,
  ReadinessOutOfSync, ReadinessScopeState, ReadinessSuppression, ReadinessSyncAttempt,
} from '@nexus/shared/listing-readiness'
import { listingUrlFor } from '@nexus/shared/listing-url'
import prisma from '../../db.js'
import { isFbaCoordinate } from '../../lib/amazon-fulfillment.js'
// Types only: the listing-action engine (and the queues it imports) loads when a live read runs (`sellingReader`).
import type { destinationSellingStates as DestinationSellingStates, SellingStateListing } from '../listings/listing-action.service.js'
import { readListingDeletions } from '../listings/listing-deletions.js'

/* ── the join rule ────────────────────────────────────────────────────────────────────────── */

/** The readiness index says UK where a listing may say GB (as `readinessDestinationAllowed` reads markets). */
export const liveMarketCode = (code: string | null | undefined) => {
  const upper = (code ?? '').trim().toUpperCase()
  return upper === 'GB' ? 'UK' : upper
}

export interface LiveListingCoordinate { channel: string; marketplace: string; channelConnectionId: string | null; aliasKey: string | null }

/** The readiness coordinate key a listing belongs to (`readinessCoordinateKey`'s shape: channel, market, account, alias). */
export function liveDestinationKey(listing: LiveListingCoordinate): string {
  return JSON.stringify([listing.channel.trim().toUpperCase(), liveMarketCode(listing.marketplace), listing.channelConnectionId || null, listing.aliasKey || null])
}

/** A readiness destination key read the same way (GB = UK), so a listing and a destination compare as equals. Shared and anything unreadable stay themselves. */
export function canonicalDestinationKey(key: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(key) } catch { return key }
  if (!Array.isArray(parsed) || parsed.length !== 4 || typeof parsed[0] !== 'string' || !parsed[0]) return key
  const [channel, market, accountId, aliasId] = parsed as Array<string | null>
  return JSON.stringify([channel!.trim().toUpperCase(), liveMarketCode(market), accountId || null, aliasId || null])
}

/** A destination key's parts; Shared is all null. */
export function coordinateOfKey(key: string): { channel: string | null; market: string | null; accountId: string | null; aliasId: string | null } {
  try {
    const parsed = JSON.parse(key)
    if (Array.isArray(parsed) && parsed.length === 4) return { channel: parsed[0] ?? null, market: parsed[1] ?? null, accountId: parsed[2] ?? null, aliasId: parsed[3] ?? null }
  } catch { /* fall through */ }
  return { channel: null, market: null, accountId: null, aliasId: null }
}
const isSharedKey = (key: string) => !coordinateOfKey(key).channel

/** The page's filters, as they narrow listings (the readiness filters of the same names). */
export interface LiveScope { channel?: string; marketplace?: string; accountId?: string; listingIds?: readonly string[] }

export function inLiveScope(row: Pick<LiveListingRow, 'id' | 'channel' | 'marketplace' | 'channelConnectionId'>, scope: LiveScope): boolean {
  if (scope.channel && (scope.channel === 'SHARED' || row.channel.trim().toUpperCase() !== scope.channel)) return false
  if (scope.marketplace && liveMarketCode(row.marketplace) !== liveMarketCode(scope.marketplace)) return false
  if (scope.accountId && row.channelConnectionId !== scope.accountId) return false
  if (scope.listingIds && !scope.listingIds.includes(row.id)) return false
  return true
}

/* ── one listing ──────────────────────────────────────────────────────────────────────────── */

export interface LiveProduct { id: string; sku: string; parentId: string | null; isParent: boolean; lowStockThreshold: number; fulfillmentMethod: string | null }

/** One listing row as the live layer reads it; `platformAttributes` is cut to what the state and the fulfilment read. */
export interface LiveListingRow extends SellingStateListing {
  channel: string
  marketplace: string
  channelConnectionId: string | null
  aliasKey: string
  externalParentId: string | null
  price: number | null
  salePrice: number | null
  quantity: number | null
  followMasterQuantity: boolean
  quantityOverride: number | null
  syncStatus: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
  lastSyncedAt: Date | null
  syncPaused: boolean
  syncLocked: boolean
  publishAction: string | null
  publishActionAt: Date | null
  /** Open `ListingIssue`s by severity. */
  errors: number
  warnings: number
  /** An open `AmazonSuppression`. */
  suppressionOpen: boolean
  /** `ChannelDrift.driftCount` (0 = checked and clean, or never checked). */
  driftCount: number
}

const upper = (value: string | null | undefined) => String(value ?? '').trim().toUpperCase()
const isFailed = (status: string | null | undefined) => upper(status) === 'FAILED'
const iso = (date: Date | string | null | undefined) => date ? new Date(date).toISOString() : null
const num = (value: unknown) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)

/** THE selling-state reader of the listing-action engine (`destinationSellingStates`), carried by a live read. */
export type SellingReader = typeof DestinationSellingStates

/**
 * The listing-action engine's reader and its older-close check, loaded on the first live read: importing the engine
 * at module load would pull its channel adapters and queues into every readiness reader (and their tests).
 */
export async function sellingReader(): Promise<{ destinationSellingStates: SellingReader; oldClosePauses: typeof import('../listings/listing-action.service.js').oldClosePauses }> {
  const engine = await import('../listings/listing-action.service.js')
  return { destinationSellingStates: engine.destinationSellingStates, oldClosePauses: engine.oldClosePauses }
}

/**
 * One listing's selling state, exactly as the product sheet reads it: `destinationSellingStates` (the listing-action
 * engine's one reader) over this listing alone, with its Shopify owner (the family root's listing on the same
 * coordinate, whose status the product's variants share), the older close marks and Nexus's deletes.
 */
export function listingStateOf(row: LiveListingRow, rootId: string, owner: LiveListingRow | undefined,
  facts: { oldPauses: ReadonlySet<string>; deletions: ReadonlyMap<string, ListingDeletion>; sellingStates: SellingReader }): SellingStateRead {
  const listings = owner && owner.id !== row.id ? [row, owner] : [row]
  return facts.sellingStates({ familyId: rootId, channel: row.channel, products: [{ id: row.productId, sku: '', isParent: false }], listings,
    oldClosePauses: facts.oldPauses, deletions: facts.deletions }).states.get(row.productId)!
}

/** The listing on its channel, in the page's words. */
export function liveOf(row: LiveListingRow, read: SellingStateRead, product: Pick<LiveProduct, 'fulfillmentMethod'> | undefined, currency: string | null): ReadinessLive {
  const failed = isFailed(row.syncStatus) || isFailed(row.lastSyncStatus)
  const outOfSync: ReadinessOutOfSync[] = [...(row.driftCount > 0 ? ['channel-differs' as const] : []), ...(failed ? ['push-failed' as const] : [])]
  const fba = row.channel === 'AMAZON'
    ? isFbaCoordinate({ fulfillmentMethod: row.fulfillmentMethod, platformAttributes: row.platformAttributes, product: { fulfillmentMethod: product?.fulfillmentMethod ?? null } })
    : null
  return {
    listingId: row.id, state: read.state, reason: read.reason ?? null,
    externalId: row.externalListingId || null, externalParentId: row.externalParentId || null,
    url: listingUrlFor(row.channel, row.marketplace, row.externalListingId || null),
    price: num(row.price), salePrice: num(row.salePrice), currency, quantity: row.quantity ?? null,
    fulfillment: fba === null ? null : fba ? 'FBA' : 'FBM',
    syncStatus: failed ? 'FAILED' : row.lastSyncStatus || (row.syncStatus && upper(row.syncStatus) !== 'IDLE' ? row.syncStatus : null),
    lastSyncedAt: iso(row.lastSyncedAt), lastSyncError: row.lastSyncError ?? null,
    channelErrorCount: row.errors, channelWarningCount: row.warnings,
    suppressed: row.suppressionOpen || upper(row.listingStatus) === 'SUPPRESSED',
    outOfSync, held: !!(row.syncPaused || row.syncLocked || row.offerClosedAt),
  }
}

/**
 * The four flags of one listing (`ReadinessLiveFlag`): an open channel error, a failed last push or a listing in error;
 * suppressed; out of sync (the channel differs, or the last push failed); low stock (active, quantity at or under the
 * product's threshold). `liveFlagsSql` says the same in SQL.
 */
export function liveFlagsOf(live: Pick<ReadinessLive, 'state' | 'quantity' | 'channelErrorCount' | 'suppressed' | 'outOfSync'>,
  facts: { listingStatus: string | null; lowStockThreshold: number | null }): ReadinessLiveFlag[] {
  const flags: ReadinessLiveFlag[] = []
  if (live.channelErrorCount > 0 || live.outOfSync.includes('push-failed') || upper(facts.listingStatus) === 'ERROR') flags.push('error')
  if (live.suppressed) flags.push('suppressed')
  if (live.outOfSync.length) flags.push('outOfSync')
  if (live.state === 'active' && live.quantity !== null && facts.lowStockThreshold !== null && live.quantity <= facts.lowStockThreshold) flags.push('lowStock')
  return flags
}

/* ── the batched read ─────────────────────────────────────────────────────────────────────── */

export interface LiveFacts {
  products: Map<string, LiveProduct>
  /** Every row read (in scope or not: a family root's row is a variant's Shopify owner). */
  rows: Map<string, LiveListingRow>
  oldPauses: ReadonlySet<string>
  deletions: ReadonlyMap<string, ListingDeletion>
  /** `${channel}\0${market}` → currency (both GB and UK spellings). */
  currencies: ReadonlyMap<string, string>
  readAt: Date
  /** The listing-action engine's state reader (`sellingReader`). */
  sellingStates: SellingReader
}
/** productId → destination key (canonical, `liveDestinationKey`) → its listings in scope (more than one: GB/UK twins). */
export type LiveRead = Map<string, Map<string, ReadinessLive[]>> & { readonly facts: LiveFacts }

const exactKey = (productId: string, row: Pick<LiveListingRow, 'channel' | 'marketplace' | 'channelConnectionId' | 'aliasKey'>) =>
  `${productId}\u0000${row.channel}\u0000${row.marketplace}\u0000${row.channelConnectionId ?? ''}\u0000${row.aliasKey}`

export function currencyOf(currencies: ReadonlyMap<string, string>, channel: string, market: string): string | null {
  return currencies.get(`${channel}\u0000${upper(market)}`) ?? currencies.get(`${channel}\u0000${liveMarketCode(market)}`) ?? null
}

export function currencyMap(markets: ReadonlyArray<{ channel: string; code: string; currency: string }>): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of markets) {
    out.set(`${m.channel}\u0000${upper(m.code)}`, m.currency)
    if (!out.has(`${m.channel}\u0000${liveMarketCode(m.code)}`)) out.set(`${m.channel}\u0000${liveMarketCode(m.code)}`, m.currency)
  }
  return out
}

/** The pure half of `readLive`: states, words and grouping from rows already read. */
export function buildLive(products: ReadonlyArray<LiveProduct>, rows: ReadonlyArray<LiveListingRow>,
  facts: Omit<LiveFacts, 'products' | 'rows'>, scope: LiveScope = {}): LiveRead {
  const productOf = new Map(products.map(p => [p.id, p]))
  const rowOf = new Map(rows.map(r => [r.id, r]))
  const byCoordinate = new Map<string, LiveListingRow>()
  for (const row of rows) if (!byCoordinate.has(exactKey(row.productId, row))) byCoordinate.set(exactKey(row.productId, row), row)
  const out = new Map<string, Map<string, ReadinessLive[]>>()
  const ordered = [...rows].sort((a, b) => cmp(a.productId, b.productId) || cmp(a.channel, b.channel) || cmp(a.marketplace, b.marketplace) || cmp(a.id, b.id))
  for (const row of ordered) {
    if (!inLiveScope(row, scope)) continue
    const product = productOf.get(row.productId)
    const rootId = product?.parentId ?? row.productId
    const owner = row.channel === 'SHOPIFY' ? byCoordinate.get(exactKey(rootId, row)) : undefined
    const live = liveOf(row, listingStateOf(row, rootId, owner, facts), product, currencyOf(facts.currencies, row.channel, row.marketplace))
    let byKey = out.get(row.productId)
    if (!byKey) out.set(row.productId, byKey = new Map())
    const key = liveDestinationKey(row)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(live)
  }
  return Object.assign(out, { facts: { ...facts, products: productOf, rows: rowOf } })
}
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

const LISTING_COLUMNS = Prisma.sql`
  l.id, l."productId", l.channel, l.marketplace, l."channelConnectionId", l."aliasKey",
  l."externalListingId", l."externalParentId", l."listingStatus", l."isPublished", l."offerClosedAt", l."offerCloseReason", l."offerActive",
  l."fulfillmentMethod"::text AS "fulfillmentMethod",
  jsonb_strip_nulls(jsonb_build_object(
    'status', l."platformAttributes"->'status',
    'fulfillment_availability', l."platformAttributes"->'fulfillment_availability',
    'attributes', CASE WHEN jsonb_typeof(l."platformAttributes"->'attributes') = 'object'
      THEN jsonb_strip_nulls(jsonb_build_object('fulfillment_availability', l."platformAttributes"->'attributes'->'fulfillment_availability')) END
  )) AS "platformAttributes",
  l.price::float8 AS price, l."salePrice"::float8 AS "salePrice", l.quantity, l."followMasterQuantity", l."quantityOverride",
  l."syncStatus", l."lastSyncStatus", l."lastSyncError", l."lastSyncedAt", l."syncPaused", l."syncLocked", l."publishAction", l."publishActionAt",
  (SELECT count(*) FROM "ListingIssue" i WHERE i."listingId" = l.id AND i."resolvedAt" IS NULL AND upper(i.severity) = 'ERROR')::int AS errors,
  (SELECT count(*) FROM "ListingIssue" i WHERE i."listingId" = l.id AND i."resolvedAt" IS NULL AND upper(i.severity) = 'WARNING')::int AS warnings,
  EXISTS (SELECT 1 FROM "AmazonSuppression" s WHERE s."listingId" = l.id AND s."resolvedAt" IS NULL) AS "suppressionOpen",
  COALESCE((SELECT max(d."driftCount") FROM "ChannelDrift" d WHERE d."channelListingId" = l.id), 0)::int AS "driftCount"`

/**
 * ONE read for a page's products (their family roots come along: a root's Shopify listing is its variants' status).
 * Queries, whatever the page size: products 1, listings with their issue/suppression/drift facts 1, markets 1, Nexus's
 * deletes 0–2 (`readListingDeletions`), older close marks 0–2 (`oldClosePauses`, eBay rows pinned at 0 only).
 * Shopify colour products are not read: they change which actions a family offers, never its state.
 */
export async function readLive(productIds: Iterable<string>, scope: LiveScope = {}): Promise<LiveRead> {
  const ids = [...new Set(productIds)].filter(Boolean)
  const readAt = new Date()
  const engine = await sellingReader()
  if (!ids.length) return buildLive([], [], { oldPauses: new Set(), deletions: new Map(), currencies: new Map(), readAt, sellingStates: engine.destinationSellingStates })
  const products = await prisma.$queryRaw<LiveProduct[]>(Prisma.sql`
    SELECT p.id, p.sku, p."parentId", p."isParent", p."lowStockThreshold", p."fulfillmentMethod"::text AS "fulfillmentMethod"
      FROM "Product" p
     WHERE p.id = ANY(${ids}::text[])
        OR p.id IN (SELECT q."parentId" FROM "Product" q WHERE q.id = ANY(${ids}::text[]) AND q."parentId" IS NOT NULL)`)
  const rows = await prisma.$queryRaw<LiveListingRow[]>(Prisma.sql`
    SELECT ${LISTING_COLUMNS} FROM "ChannelListing" l WHERE l."productId" = ANY(${products.map(p => p.id)}::text[])`)
  const markets = rows.length ? await prisma.marketplace.findMany({ select: { channel: true, code: true, currency: true } }) : []
  const deletions = await readListingDeletions(rows)
  const eBay = rows.filter(row => row.channel === 'EBAY')
  const oldPauses = eBay.length ? await engine.oldClosePauses(eBay) : new Set<string>()
  return buildLive(products, rows, { oldPauses, deletions, currencies: currencyMap(markets), readAt, sellingStates: engine.destinationSellingStates }, scope)
}

/* ── a row on one destination ─────────────────────────────────────────────────────────────── */

/** A set of products' states as one: the same state, or Mixed. Draft and Not listed read alike ("Not listed"). */
export function foldStates(states: readonly SellingState[]): SellingState {
  if (!states.length) return 'not_listed'
  const listed = states.filter(s => s !== 'not_listed' && s !== 'draft')
  if (!listed.length) return states.includes('draft') ? 'draft' : 'not_listed'
  return new Set(states.map(s => s === 'draft' ? 'not_listed' : s)).size === 1 ? listed[0] : 'mixed'
}

const common = (values: ReadonlyArray<string | null>) => {
  const known = [...new Set(values.filter((v): v is string => !!v))]
  return known.length === 1 ? known[0] : null
}

/**
 * A row's listings on one destination, summed (`ReadinessLiveSummary`). A family row counts its variations (they are
 * what sells; a parent or a single product counts only when no variation is in the row). A member row is one product:
 * its one listing, or `not_listed` with `listed` 0 and `notListed` 1.
 *  - `state`: the product sheet's (`destinationSellingStates`: a parent reads its variations; the parent's own Ended,
 *    and on Shopify the product's own status, win), and Mixed whenever the counted products differ — "18 Active ·
 *    2 Not listed" is Mixed.
 *  - `byState` counts LISTINGS (a GB/UK twin is two); a product with no listing here is in `notListed` only.
 *  - The problem counts overlap as they come, on purpose: `channelErrorCount` counts open ERROR `ListingIssue`s, which
 *    include the suppressions the issue recorder mirrors there (so a suppressed listing adds to it AND to
 *    `suppressedCount`); `outOfSyncCount` counts listings that differ OR whose last push failed (so a failed push adds
 *    to it AND to `syncFailedCount`). They are counted over every listing of the row here, the parent's own included.
 *  - Price and quantity come from this destination only, so an alias or another market is never added; a product
 *    with GB and UK twins is counted in `duplicates` and its quantity is not added up (null: Nexus does not pick one).
 */
export function summarizeLive(rowProductIds: readonly string[], destinationKey: string, live: LiveRead,
  products: ReadonlyMap<string, Pick<LiveProduct, 'id' | 'parentId'>> = live.facts.products): ReadinessLiveSummary {
  const key = canonicalDestinationKey(destinationKey)
  const { channel, market } = coordinateOfKey(key)
  const ids = [...new Set(rowProductIds)]
  const entries = (id: string) => live.get(id)?.get(key) ?? []
  const children = ids.filter(id => products.get(id)?.parentId)
  const counted = children.length ? children : ids
  const rootId = children.length ? products.get(children[0])!.parentId! : ids[0]
  const rowOf = (entry: ReadinessLive) => live.facts.rows.get(entry.listingId)

  // The sheet's reader over the family here: its products' single listings (twins are left out: none is picked).
  const single = (id: string) => entries(id).length === 1 ? rowOf(entries(id)[0]) : undefined
  const callProducts = children.length
    ? [{ id: rootId, sku: '', isParent: true }, ...children.map(id => ({ id, sku: '', isParent: false }))]
    : [{ id: ids[0], sku: '', isParent: false }]
  const callListings = [...new Set([...(children.length ? [rootId] : []), ...counted])].map(single).filter((row): row is LiveListingRow => !!row)
  const read = channel ? live.facts.sellingStates({ familyId: rootId, channel, products: callProducts, listings: callListings,
    oldClosePauses: live.facts.oldPauses, deletions: live.facts.deletions }) : null

  const stateOf = new Map<string, SellingState>()
  for (const id of counted) {
    const list = entries(id)
    stateOf.set(id, !list.length ? 'not_listed' : list.length > 1 ? foldStates(list.map(l => l.state)) : children.length && read ? read.states.get(id)!.state : list[0].state)
  }
  let state = foldStates([...stateOf.values()])
  if (children.length && read) {
    // The parent's own listing decides (Ended; on Shopify the product's own status): its state is not its variations'.
    const rootState = read.states.get(rootId)!.state
    if (rootState !== familySellingState(children.map(id => read.states.get(id)!.state)).state) state = rootState
  }

  const countedEntries = counted.flatMap(entries)
  const byState: Partial<Record<SellingState, number>> = {}
  for (const entry of countedEntries) byState[entry.state] = (byState[entry.state] ?? 0) + 1
  const allEntries = ids.flatMap(entries)
  const rootEntries = entries(rootId)
  const externalId = rootEntries.length === 1 && rootEntries[0].externalId ? rootEntries[0].externalId
    : common(countedEntries.map(e => e.externalParentId)) ?? common(countedEntries.map(e => e.externalId))
  const prices = countedEntries.map(e => e.price).filter((p): p is number => p !== null)
  const duplicates = ids.filter(id => entries(id).length > 1).length
  const quantities = counted.filter(id => entries(id).length === 1).map(id => entries(id)[0].quantity).filter((q): q is number => q !== null)
  const fulfilments = new Set(countedEntries.map(e => e.fulfillment).filter(Boolean))
  const synced = allEntries.map(e => e.lastSyncedAt).filter((at): at is string => !!at).sort()
  return {
    state, listed: counted.filter(id => entries(id).length > 0).length, notListed: counted.filter(id => !entries(id).length).length, byState,
    externalId, url: channel && externalId ? listingUrlFor(channel, market ?? '', externalId) : null,
    priceMin: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null,
    currency: (channel && currencyOf(live.facts.currencies, channel, market ?? '')) ?? common(allEntries.map(e => e.currency)),
    quantity: duplicates || !quantities.length ? null : quantities.reduce((a, b) => a + b, 0),
    fulfillment: fulfilments.size > 1 ? 'mixed' : fulfilments.size ? [...fulfilments][0] as 'FBA' | 'FBM' : null,
    channelErrorCount: allEntries.reduce((n, e) => n + e.channelErrorCount, 0),
    suppressedCount: allEntries.filter(e => e.suppressed).length,
    outOfSyncCount: allEntries.filter(e => e.outOfSync.length > 0).length,
    syncFailedCount: allEntries.filter(e => e.outOfSync.includes('push-failed')).length,
    lastSyncedAt: synced[0] ?? null,
    duplicates,
  }
}

/* ── the page post-step ───────────────────────────────────────────────────────────────────── */

export interface LiveOptions { /** The caller may see listings (`listings.view`). Without it every live field is null. */ live?: boolean }

/** The parts of `familiesQuery()` the live layer reads. */
export interface LiveQuery { channel?: string; marketplace?: string; accountId?: string; listingIds?: string[]; language?: string; q?: string }

export const liveScopeOf = (query: LiveQuery): LiveScope => ({
  ...(query.channel ? { channel: query.channel } : {}), ...(query.marketplace ? { marketplace: query.marketplace } : {}),
  ...(query.accountId ? { accountId: query.accountId } : {}), ...(query.listingIds ? { listingIds: query.listingIds } : {}),
})

/** The live tiles of a families page, computed in the page's SQL (`liveTileCtes`). */
export interface LiveTiles { counts: ReadinessLiveCounts; unmatched: number }

export interface AttachLiveInput {
  query: LiveQuery
  live: boolean
  /** The page's rows → their products (a family row: its members in the result; a member row: itself). */
  rowProducts: ReadonlyMap<string, readonly string[]>
  /** Families page: the live tiles over the whole result (null without `listings.view`). */
  tiles?: LiveTiles | null
}

/* ── the live layer inside the page's SQL (step 2's summary) ──────────────────────────────── */

/** What the page's SQL needs of the live layer. Null for a caller without `listings.view`: live filters are ignored. */
export interface LiveSqlView {
  /** The raw-SQL presence columns exist (`livePresenceColumns`). */
  presence: boolean
  /** `live`: channel states, ANY of them. `not_listed` = no listing on the destination (or only one Nexus removed). */
  states: readonly ReadinessLiveState[]
  /** `flags`: live flags, ALL of them on the same listing. */
  flags: readonly ReadinessLiveFlag[]
  /** The page's channel / market / account / listing selection, as it narrows listings. */
  scope: LiveScope
}

/** The view for a caller with `listings.view` (one query: the presence columns), else null. */
export async function liveSqlView(query: LiveQuery & { liveStates?: readonly ReadinessLiveState[]; liveFlags?: readonly ReadinessLiveFlag[] }, live: boolean): Promise<LiveSqlView | null> {
  if (!live) return null
  return { presence: await livePresenceColumns(), states: query.liveStates ?? [], flags: query.liveFlags ?? [], scope: liveScopeOf(query) }
}
export const liveFiltering = (view: LiveSqlView | null): view is LiveSqlView => !!view && (view.states.length > 0 || view.flags.length > 0)

/** A market code as the join rule reads it (GB = UK), in SQL. */
const canonMarket = (column: string) => `CASE upper(btrim(COALESCE(${column}, ''))) WHEN 'GB' THEN 'UK' ELSE upper(btrim(COALESCE(${column}, ''))) END`
/** The join rule in SQL: listing `c` (a `*cl` row) belongs to pair `x` (a `*pair` row). */
const PAIR_MATCH = 'c.pid = x.pid AND c.channel = x.channel AND c.cmarket = x.cmarket AND c.account = x.account AND c.alias IS NOT DISTINCT FROM x.alias'
const FLAG_COLUMN: Record<ReadinessLiveFlag, string> = { error: 'c.error', suppressed: 'c.suppressed', outOfSync: 'c."outOfSync"', lowStock: 'c."lowStock"' }

/**
 * Live CTEs over a source CTE `src` of readiness rows (columns `root, pid, channel, market, account, alias`), named
 * with `prefix`:
 *   <prefix>mem  — the products of each family;
 *   <prefix>pair — product × channel destination of its family, the "not computed" fill included (`fill`), as the
 *                  readiness model counts them (Shared has no live layer);
 *   <prefix>cl   — those products' listings in the page's scope, with the join-rule coordinate, `liveStateSql` and
 *                  `liveFlagsSql`.
 */
export function liveCtes(src: string, prefix: string, fill: boolean, view: LiveSqlView): Prisma.Sql {
  const flags = liveFlagsSql()
  const scope: Prisma.Sql[] = []
  if (view.scope.channel) scope.push(view.scope.channel === 'SHARED' ? Prisma.sql`FALSE` : Prisma.sql`upper(btrim(l.channel)) = ${view.scope.channel}`)
  if (view.scope.marketplace) scope.push(Prisma.sql`${Prisma.raw(canonMarket('l.marketplace'))} = ${liveMarketCode(view.scope.marketplace)}`)
  if (view.scope.accountId) scope.push(Prisma.sql`l."channelConnectionId" = ${view.scope.accountId}`)
  if (view.scope.listingIds) scope.push(Prisma.sql`l.id = ANY(${[...view.scope.listingIds]}::text[])`)
  const destination = `upper(btrim(channel)) AS channel, ${canonMarket('market')} AS cmarket, account, alias`
  const raw = (text: string) => Prisma.raw(text)
  return Prisma.sql`
    ${raw(prefix)}mem AS (SELECT DISTINCT root, pid FROM ${raw(src)}),
    ${raw(prefix)}pair AS (${fill
      ? raw(`SELECT DISTINCT m.root, m.pid, d.channel, d.cmarket, d.account, d.alias FROM ${prefix}mem m
          JOIN (SELECT DISTINCT root, ${destination} FROM ${src} WHERE channel IS NOT NULL) d ON d.root = m.root`)
      : raw(`SELECT DISTINCT root, pid, ${destination} FROM ${src} WHERE channel IS NOT NULL`)}),
    ${raw(prefix)}cl AS (
      SELECT l.id, l."productId" AS pid, upper(btrim(l.channel)) AS channel, ${raw(canonMarket('l.marketplace'))} AS cmarket,
             l."channelConnectionId" AS account, NULLIF(l."aliasKey", '') AS alias, ${liveStateSql()} AS state,
             ${flags.error} AS error, ${flags.suppressed} AS suppressed, ${flags.outOfSync} AS "outOfSync", ${flags.lowStock} AS "lowStock"
        FROM "ChannelListing" l ${liveJoinsSql({ presence: view.presence })}
       WHERE l."productId" IN (SELECT pid FROM ${raw(prefix)}mem)${scope.length ? Prisma.sql` AND ${Prisma.join(scope, ' AND ')}` : Prisma.empty})`
}

/**
 * The live filters in SQL: `lf_keep` = the families (roots) of `src` with a product × destination pair that satisfies
 * them — a listing there whose state is ANY of `states` (none given: any) and that carries ALL of `flags`; or, when
 * `not_listed` is asked and no flag is, no listing there (or only removed ones). Null when no live filter is set.
 */
export function liveFilterCtes(src: string, fill: boolean, view: LiveSqlView | null): Prisma.Sql | null {
  if (!liveFiltering(view)) return null
  const ok = [view.states.length ? Prisma.sql`c.state = ANY(${[...view.states]}::text[])` : Prisma.sql`TRUE`, ...view.flags.map(flag => Prisma.raw(FLAG_COLUMN[flag]))]
  const absent = view.states.includes('not_listed') && !view.flags.length
    ? Prisma.sql` OR NOT EXISTS (SELECT 1 FROM lf_cl c WHERE ${Prisma.raw(PAIR_MATCH)} AND c.state <> 'not_listed')` : Prisma.empty
  return Prisma.sql`${liveCtes(src, 'lf_', fill, view)},
    lf_keep AS (SELECT DISTINCT x.root FROM lf_pair x WHERE EXISTS (SELECT 1 FROM lf_cl c WHERE ${Prisma.raw(PAIR_MATCH)} AND ${Prisma.join(ok, ' AND ')})${absent})`
}

/**
 * The live tiles in SQL over the result `src`: `lt_tiles` (one row) — the result's listings in scope (`ChannelListing`
 * rows; under a language filter only those on a destination the result shows) by state and flag; `notListed` = pairs
 * with no listing there, or only removed ones; `unmatched` = listings on no readiness destination of the business.
 */
export function liveTileCtes(src: string, fill: boolean, view: LiveSqlView, languageFiltered: boolean): Prisma.Sql {
  const same = 'd.channel = c.channel AND d.cmarket = c.cmarket AND d.account = c.account AND d.alias IS NOT DISTINCT FROM c.alias'
  const count = (where: string) => Prisma.raw(`(count(*) FILTER (WHERE ${where}))::int`)
  return Prisma.sql`${liveCtes(src, 'lt_', fill, view)},
    lt_fp AS (SELECT DISTINCT upper(btrim(channel)) AS channel, ${Prisma.raw(canonMarket('market'))} AS cmarket, "accountId" AS account, "aliasId" AS alias
                FROM "ReadinessIndex" WHERE channel IS NOT NULL),
    lt_shown AS (SELECT DISTINCT upper(btrim(channel)) AS channel, ${Prisma.raw(canonMarket('market'))} AS cmarket, account, alias FROM ${Prisma.raw(src)} WHERE channel IS NOT NULL),
    lt_v AS (SELECT c.*, EXISTS (SELECT 1 FROM lt_fp d WHERE ${Prisma.raw(same)}) AS footprint FROM lt_cl c
              ${languageFiltered ? Prisma.raw(`WHERE EXISTS (SELECT 1 FROM lt_shown d WHERE ${same})`) : Prisma.empty}),
    lt_tiles AS (SELECT count(*)::int AS listings, ${count(`state = 'active'`)} AS active, ${count(`state = 'paused'`)} AS paused, ${count(`state = 'draft'`)} AS draft,
        ${count(`state = 'ended'`)} AS ended, ${count(`state = 'unknown'`)} AS unknown, ${count('error')} AS error, ${count('suppressed')} AS suppressed,
        ${count('"outOfSync"')} AS "outOfSync", ${count('"lowStock"')} AS "lowStock", ${count('NOT footprint')} AS unmatched,
        (SELECT count(*)::int FROM lt_pair x WHERE NOT EXISTS (SELECT 1 FROM lt_cl c WHERE ${Prisma.raw(PAIR_MATCH)} AND c.state <> 'not_listed')) AS "notListed"
      FROM lt_v)`
}

/** `lt_tiles`' row in the page's words. */
export function liveTilesOf(row: ReadinessLiveCounts & { unmatched: number }): LiveTiles {
  const { unmatched, ...counts } = row
  return { counts, unmatched }
}

/** The readiness destinations of the business (its footprint, aliases included): canonical key → the index's own key. */
export async function readinessFootprint(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<Array<{ key: string }>>(Prisma.sql`SELECT DISTINCT "coordinateKey" AS key FROM "ReadinessIndex" WHERE channel IS NOT NULL`)
  return new Map(rows.map(r => [canonicalDestinationKey(r.key), r.key]))
}

const CHANNEL_NAMES: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' }
const channelWords = (channel: string) => CHANNEL_NAMES[channel] ?? channel

export interface ExtraDestinationFacts {
  aliases: ReadonlyMap<string, { status: string; label: string }>
  stores: ReadonlyMap<string, { active: boolean; name: string | null }>
}

/** Why a listing's destination is not a readiness destination, in words (null: it is one, only not on this row yet). */
export function unmatchedNote(key: string, footprint: ReadonlyMap<string, string>, facts: ExtraDestinationFacts): string | null {
  if (footprint.has(key)) return null
  const { market, accountId, aliasId } = coordinateOfKey(key)
  if (!accountId) return 'No account is recorded for this listing, so Nexus does not check its readiness.'
  if (!market || market === 'DEFAULT') return 'No market is recorded for this listing, so Nexus does not check its readiness.'
  if (aliasId && facts.aliases.get(aliasId)?.status !== 'ACTIVE') return 'This listing customization is archived, so Nexus does not check its readiness.'
  if (!facts.stores.get(accountId)?.active) return 'This account is not connected any more, so Nexus does not check its readiness.'
  return 'Nexus does not check readiness for this account on this market (the market is switched off, or the account does not sell there).'
}

/** An extra destination's words: channel, market, the customization and the store. */
export function extraDestination(key: string, footprint: ReadonlyMap<string, string>, facts: ExtraDestinationFacts): ReadinessDestination {
  const { channel, market, accountId, aliasId } = coordinateOfKey(key)
  const where = market && market !== 'GLOBAL' && market !== 'DEFAULT' ? ` ${market}` : ''
  const alias = aliasId ? ` · ${facts.aliases.get(aliasId)?.label || 'Listing customization'}` : ''
  const store = accountId ? ` · ${facts.stores.get(accountId)?.name || `Store …${accountId.slice(-6)}`}` : ''
  const note = unmatchedNote(key, footprint, facts)
  return { key: footprint.get(key) ?? key, channel: channel ?? 'SHARED', marketplace: market ?? '', accountId, aliasKey: aliasId ?? '',
    label: `${channelWords(channel ?? '')}${where}${alias}${store}`, ...(note ? { note } : {}) }
}

async function extraDestinationFacts(keys: readonly string[]): Promise<ExtraDestinationFacts> {
  const coordinates = keys.map(coordinateOfKey)
  const aliasIds = [...new Set(coordinates.map(c => c.aliasId).filter((id): id is string => !!id))]
  const accountIds = [...new Set(coordinates.map(c => c.accountId).filter((id): id is string => !!id))]
  const [aliases, stores] = await Promise.all([
    aliasIds.length ? prisma.productListingAlias.findMany({ where: { id: { in: aliasIds } }, select: { id: true, status: true, label: true } }) : [],
    accountIds.length ? prisma.channelConnection.findMany({ where: { id: { in: accountIds } }, select: { id: true, isActive: true, accountLabel: true, displayName: true } }) : [],
  ])
  return { aliases: new Map(aliases.map((a): [string, { status: string; label: string }] => [a.id, { status: a.status, label: a.label }])),
    stores: new Map(stores.map((s): [string, { active: boolean; name: string | null }] => [s.id, { active: s.isActive, name: s.accountLabel || s.displayName || null }])) }
}

/** Is `presence` (the raw-SQL presence columns `endedAt` / `endedReason`) on this database? (`oldClosePauses` asks the same.) */
export async function livePresenceColumns(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ChannelListing' AND column_name IN ('endedAt', 'endedReason')`)
  return (rows[0]?.n ?? 0) === 2
}

/**
 * THE post-step of the families and members pages (live layer step 3). It fills, for a caller with `listings.view`:
 *  - every channel chip's `live` (family and member rows) and a member row's `listing` (its own listing; null when not
 *    listed there, or when GB and UK twins leave two);
 *  - EXTRA chips for a row's listings that match none of its chips: readiness `absent` with the destination's `note`
 *    when Nexus does not check that destination at all (counted in `unmatchedListings`), `notComputed` when it does
 *    but this family was not checked there yet. A language filter shows its own destinations only: no extra chips;
 *  - the families page's `liveStats` and `unmatchedListings` (the live tiles: the caller computes them over the whole
 *    result in its SQL, `liveTileCtes`) and the extra destinations (appended after the readiness ones).
 * The pasted-list `search` summary is filled for every caller. Without `listings.view` every live field is null and
 * no chip is added. Readiness itself (states, tiles, order, paging, next step) is never changed.
 */
export async function attachLive<P extends ReadinessFamiliesPage | ReadinessMembersPage>(page: P, input: AttachLiveInput): Promise<P> {
  const familiesPage = 'destinations' in page ? page as ReadinessFamiliesPage : null
  if (familiesPage) {
    const search = await searchSummary(input.query.q)
    if (search) familiesPage.search = search
  }
  const memberRows = !familiesPage
  if (!input.live) {
    for (const row of page.rows) for (const chip of row.chips) { chip.live = null; if (memberRows) chip.listing = null }
    if (familiesPage) familiesPage.liveStats = null
    return page
  }
  const scope = liveScopeOf(input.query)
  const live = await readLive([...input.rowProducts.values()].flat(), scope)
  const footprint = await readinessFootprint()
  const pageKeys = new Map((familiesPage?.destinations ?? []).map(d => [canonicalDestinationKey(d.key), d.key]))
  const rawKey = (key: string) => pageKeys.get(key) ?? footprint.get(key) ?? key
  const extraKeys = new Set<string>()

  for (const row of page.rows) {
    const products = input.rowProducts.get(row.id) ?? [row.id]
    const own = new Set(row.chips.map(chip => canonicalDestinationKey(chip.destinationKey)))
    for (const chip of row.chips) {
      if (isSharedKey(chip.destinationKey)) { chip.live = null; if (memberRows) chip.listing = null; continue }
      chip.live = summarizeLive(products, chip.destinationKey, live)
      if (memberRows) chip.listing = singleListing(live, row.id, chip.destinationKey)
    }
    if (input.query.language) continue
    const extras = new Map<string, Set<string>>()
    for (const id of products) for (const [key, entries] of live.get(id) ?? []) {
      if (own.has(key) || !entries.length) continue
      if (!extras.has(key)) extras.set(key, new Set())
      extras.get(key)!.add(id)
    }
    for (const key of [...extras.keys()].sort(compareKeys)) {
      const state: ReadinessScopeState = footprint.has(key) ? 'notComputed' : 'absent'
      const counts = { blocked: 0, warn: 0, notComputed: 0, absent: 0, ready: 0, [state]: extras.get(key)!.size }
      const chip: ReadinessChip = { destinationKey: rawKey(key), state, counts, issueCount: 0, pending: false, computedAt: null, live: summarizeLive(products, key, live),
        ...(memberRows ? { listing: singleListing(live, row.id, key) } : {}) }
      row.chips.push(chip)
      extraKeys.add(key)
    }
  }

  if (familiesPage) {
    familiesPage.liveStats = input.tiles?.counts ?? null
    familiesPage.unmatchedListings = input.tiles?.unmatched ?? 0
    const missing = [...extraKeys].filter(key => !pageKeys.has(key)).sort(compareKeys)
    if (missing.length) {
      const facts = await extraDestinationFacts(missing)
      familiesPage.destinations.push(...missing.map(key => extraDestination(key, footprint, facts)))
    }
  }
  return page
}

const singleListing = (live: LiveRead, productId: string, key: string) => {
  const list = live.get(productId)?.get(canonicalDestinationKey(key)) ?? []
  return list.length === 1 ? list[0] : null
}
const CHANNEL_ORDER = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY']
const channelRank = (channel: string | null) => { const at = CHANNEL_ORDER.indexOf(channel ?? ''); return at < 0 ? CHANNEL_ORDER.length : at }
/** Extra destinations in the chips' order: channel, market, account, alias. */
function compareKeys(a: string, b: string): number {
  const x = coordinateOfKey(a), y = coordinateOfKey(b)
  return channelRank(x.channel) - channelRank(y.channel) || cmp(x.channel ?? '', y.channel ?? '') || cmp(x.market ?? '', y.market ?? '')
    || cmp(x.accountId ?? '', y.accountId ?? '') || cmp(x.aliasId ?? '', y.aliasId ?? '')
}

/* ── the Listing window's "On the channel" tab ────────────────────────────────────────────── */

const MESSAGES_PER_LISTING = 50
const SYNC_ATTEMPTS = 10
const severityWord = (raw: string): ReadinessChannelMessage['severity'] => {
  const value = upper(raw)
  return value === 'ERROR' ? 'error' : value === 'WARNING' ? 'warning' : 'info'
}
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const

/** `ChannelDrift.driftedFields` entries in words: { field, ours, theirs, checkedAt } → nexus / channel / foundAt. */
export function differsOf(driftCount: number, driftedFields: unknown): ReadinessDiffer[] {
  if (!(driftCount > 0) || !Array.isArray(driftedFields)) return []
  const words = (value: unknown) => value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value)
  return driftedFields.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const e = entry as Record<string, unknown>
    if (typeof e.field !== 'string' || !e.field) return []
    return [{ field: e.field, nexus: words(e.ours), channel: words(e.theirs), foundAt: typeof e.checkedAt === 'string' ? e.checkedAt : null }]
  })
}

/**
 * The Listing window's "On the channel" tab (`ReadinessDetail.channel`): the products' listings on one destination,
 * the summary, and per listing the channel's messages word for word (open `ListingIssue`s, suppressions mirrored there
 * included), open suppressions, what differs, the last publish (`readPublicationStatus`) and the newest sync attempts.
 * Null on Shared.
 */
export async function readChannelSection(productIds: readonly string[], destination: { key: string; channel: string | null },
  scope: LiveScope = {}): Promise<ReadinessChannelSection | null> {
  if (!destination.channel) return null
  const key = canonicalDestinationKey(destination.key)
  const live = await readLive(productIds, scope)
  const summary = summarizeLive(productIds, key, live)
  const entries = [...new Set(productIds)].flatMap(productId => (live.get(productId)?.get(key) ?? []).map(entry => ({ productId, entry })))
  const ids = entries.map(e => e.entry.listingId)
  if (!ids.length) return { summary, listings: [], readAt: live.facts.readAt.toISOString() }
  const issues = await prisma.listingIssue.findMany({ where: { listingId: { in: ids }, resolvedAt: null },
    select: { listingId: true, code: true, severity: true, message: true, attributeNames: true, source: true, firstSeenAt: true, lastSeenAt: true },
    orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }] })
  const suppressions = await prisma.amazonSuppression.findMany({ where: { listingId: { in: ids }, resolvedAt: null },
    select: { id: true, listingId: true, reasonCode: true, reasonText: true, severity: true, source: true, suppressedAt: true }, orderBy: [{ suppressedAt: 'desc' }, { id: 'asc' }] })
  const drifts = await prisma.channelDrift.findMany({ where: { channelListingId: { in: ids } }, select: { channelListingId: true, driftCount: true, driftedFields: true } })
  const attempts = await prisma.$queryRaw<Array<{ listingId: string; attemptedAt: Date; status: string; source: string; durationMs: number | null; error: string | null }>>(Prisma.sql`
    SELECT a."listingId", a."attemptedAt", a.status, a.source, a."durationMs", a.error
      FROM unnest(${ids}::text[]) AS x(id)
      CROSS JOIN LATERAL (SELECT s."listingId", s."attemptedAt", s.status, s.source, s."durationMs", s.error FROM "SyncAttempt" s
                           WHERE s."listingId" = x.id ORDER BY s."attemptedAt" DESC, s.id DESC LIMIT ${SYNC_ATTEMPTS}) a`)
  const lastPublish = await lastPublishes(entries.map(e => ({ productId: e.productId, row: live.facts.rows.get(e.entry.listingId)! })))

  const group = <T extends { listingId: string }>(rows: readonly T[]): Map<string, T[]> => {
    const out = new Map<string, T[]>()
    for (const row of rows) { if (!out.has(row.listingId)) out.set(row.listingId, []); out.get(row.listingId)!.push(row) }
    return out
  }
  const issuesOf = group(issues), suppressionsOf = group(suppressions), attemptsOf = group(attempts)
  const driftOf = new Map(drifts.map(d => [d.channelListingId, d]))
  const listings = entries.map(({ productId, entry }): ReadinessChannelListing => {
    const messages: ReadinessChannelMessage[] = (issuesOf.get(entry.listingId) ?? []).map(i => ({ code: i.code || null, severity: severityWord(i.severity), message: i.message,
      attributeNames: i.attributeNames, source: i.source, firstSeenAt: iso(i.firstSeenAt), lastSeenAt: iso(i.lastSeenAt) }))
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, MESSAGES_PER_LISTING)
    const drift = driftOf.get(entry.listingId)
    return {
      productId, sku: live.facts.products.get(productId)?.sku ?? '', live: entry, messages,
      suppressions: (suppressionsOf.get(entry.listingId) ?? []).map((s): ReadinessSuppression => ({ id: s.id, reasonCode: s.reasonCode, reasonText: s.reasonText,
        severity: s.severity, source: s.source, suppressedAt: iso(s.suppressedAt) })),
      differs: drift ? differsOf(drift.driftCount, drift.driftedFields) : [],
      lastPublish: lastPublish.get(entry.listingId) ?? null,
      syncAttempts: (attemptsOf.get(entry.listingId) ?? []).map((a): ReadinessSyncAttempt => ({ at: iso(a.attemptedAt)!, status: a.status, source: a.source,
        durationMs: a.durationMs ?? null, error: a.error ?? null })),
    }
  })
  return { summary, listings, readAt: live.facts.readAt.toISOString() }
}

/** The last publish of each listing, from `readPublicationStatus` (once per exact coordinate: GB and UK twins are two). */
async function lastPublishes(entries: ReadonlyArray<{ productId: string; row: LiveListingRow }>): Promise<Map<string, ReadinessChannelListing['lastPublish']>> {
  const out = new Map<string, ReadinessChannelListing['lastPublish']>()
  const coordinates = new Map<string, { productId: string; row: LiveListingRow }>()
  for (const entry of entries) {
    if (!entry.row.channelConnectionId) continue
    const k = `${entry.row.channel}\u0000${entry.row.marketplace}\u0000${entry.row.channelConnectionId}\u0000${entry.row.aliasKey}`
    if (!coordinates.has(k)) coordinates.set(k, entry)
  }
  // Loaded here: the publish reader imports the channel publication clients (and their queues); the page lists never need them.
  const { readPublicationStatus } = coordinates.size ? await import('./publication-status.service.js') : { readPublicationStatus: null }
  for (const { productId, row } of coordinates.values()) {
    try {
      const status = await readPublicationStatus!({ productId, channel: row.channel, marketplace: row.marketplace, accountId: row.channelConnectionId!,
        ...(row.aliasKey ? { aliasKey: row.aliasKey } : {}) })
      // The row's own outcome; not known (no stored per-SKU result, no journal outcome) reads UNKNOWN.
      for (const listing of status.rows) if (listing.last) out.set(listing.listingId, { at: listing.last.at, outcome: listing.last.outcome ?? 'UNKNOWN', message: listing.last.message ?? null })
    } catch (error) {
      // A destination the publish reader refuses (a market switched off, an account gone): no last publish, said as such.
      const e = error as { statusCode?: unknown; code?: unknown }
      if (!(typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500 && typeof e.code === 'string')) throw error
    }
  }
  return out
}

/* ── search: many SKUs, ASINs, Item IDs at once ───────────────────────────────────────────── */

export const SEARCH_MAX_TERMS = 500
export const SEARCH_MAX_CHARS = 4000

/** The terms of a search: split on spaces, commas and new lines; each once (case-insensitive), first spelling kept. */
export function searchTerms(q: string | null | undefined): string[] {
  const seen = new Set<string>(), out: string[] = []
  for (const raw of (q ?? '').split(/[\s,]+/)) {
    const term = raw.trim()
    if (!term || seen.has(term.toLowerCase())) continue
    seen.add(term.toLowerCase())
    out.push(term)
  }
  return out
}

export interface SearchHit { id: string; parentId: string | null }

/**
 * Each term matched EXACTLY (case-insensitive) against the product's ids (SKU, GTIN, EAN, UPC, ASIN, eBay Item ID), its
 * listings' channel ids (ASIN or Item ID, parent ASIN, channel SKU, the SKU the channel holds) and its listing
 * customizations' SKUs. One query, whatever the number of terms. `unmatched` keeps the person's spelling.
 */
export async function resolveSearchTokens(q: string | null | undefined): Promise<{ terms: string[]; hits: SearchHit[]; unmatched: string[] }> {
  const terms = searchTerms(q)
  if (terms.length > SEARCH_MAX_TERMS) throw new Error(`Search for up to ${SEARCH_MAX_TERMS} terms at once`)
  if (!terms.length) return { terms, hits: [], unmatched: [] }
  const rows = await prisma.$queryRaw<Array<{ term: string; id: string; parentId: string | null }>>(Prisma.sql`
    WITH t(term) AS (SELECT DISTINCT x FROM unnest(${terms.map(t => t.toLowerCase())}::text[]) AS x),
    ids(term, "productId") AS (
      SELECT lower(v.value), p.id FROM "Product" p
        CROSS JOIN LATERAL (VALUES (p.sku), (p.gtin), (p.ean), (p.upc), (p."amazonAsin"), (p."ebayItemId")) AS v(value)
       WHERE v.value IS NOT NULL
      UNION ALL
      SELECT lower(v.value), l."productId" FROM "ChannelListing" l
        CROSS JOIN LATERAL (VALUES (l."externalListingId"), (l."externalParentId"), (l."channelSku"), (l."liveChannelSku")) AS v(value)
       WHERE v.value IS NOT NULL
      UNION ALL
      SELECT lower(a.sku), a."productId" FROM "ProductListingAlias" a WHERE a.sku IS NOT NULL
    )
    SELECT DISTINCT t.term, p.id, p."parentId"
      FROM t JOIN ids ON ids.term = t.term JOIN "Product" p ON p.id = ids."productId" AND p."deletedAt" IS NULL`)
  const matched = new Set(rows.map(r => r.term))
  const hits = [...new Map(rows.map(r => [r.id, { id: r.id, parentId: r.parentId }])).values()]
  return { terms, hits, unmatched: terms.filter(term => !matched.has(term.toLowerCase())) }
}

/** Today's search: the whole text inside a SKU, name or barcode. */
const phraseWhere = (q: string) => {
  const contains = { contains: q, mode: 'insensitive' as const }
  return { deletedAt: null, OR: [{ sku: contains }, { name: contains }, { gtin: contains }, { ean: contains }, { upc: contains }] }
}
async function phraseHits(q: string): Promise<SearchHit[]> {
  return prisma.product.findMany({ where: phraseWhere(q), select: { id: true, parentId: true } })
}

/** The readiness search (`scopedWhere`): today's phrase search AND every term matched exactly on the ids above. */
export async function searchProductHits(q: string): Promise<SearchHit[]> {
  const [phrase, exact] = [await phraseHits(q), await resolveSearchTokens(q)]
  return [...new Map([...phrase, ...exact.hits].map(hit => [hit.id, hit])).values()]
}

/**
 * The families page's `search`: for a search of 2 or more terms, how many and the ones that matched nothing. A text
 * with spaces only that the phrase search finds ("Storm Parka") is a phrase, not a list: no summary.
 */
export async function searchSummary(q: string | undefined): Promise<ReadinessFamiliesPage['search'] | undefined> {
  if (!q) return undefined
  const terms = searchTerms(q)
  if (terms.length < 2) return undefined
  if (!/[,\n\r\t]/.test(q) && await prisma.product.findFirst({ where: phraseWhere(q), select: { id: true } })) return undefined
  const { unmatched } = await resolveSearchTokens(q)
  return { tokens: terms.length, unmatched }
}

/* ── the same state and flags in SQL ──────────────────────────────────────────────────────── */

/** The whitespace JavaScript's `trim()` removes from a status in practice. */
const WS = "E' \\t\\n\\r'"
const norm = (column: string) => `upper(btrim(COALESCE(${column}, ''), ${WS}))`

/** Nexus deleted (or unlinked) the listing `x` and it is not listed again (`readListingDeletions`, the same rule). */
const deletedSql = (x: string) => `COALESCE((NULLIF(${x}."externalListingId", '') IS NULL
    AND (${norm(`${x}."listingStatus"`)} = 'DRAFT' OR ${x}."isPublished" = false)
    AND EXISTS (SELECT 1 FROM "ChannelListingSnapshot" rm WHERE rm."channelListingId" = ${x}.id AND rm.reason IN ('delete', 'unlink')
      AND rm.outcome = 'ACCEPTED' AND rm."acceptedAt" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "ChannelListingSnapshot" rp WHERE rp."channelListingId" = ${x}.id AND rp.reason = 'publish'
        AND rp.outcome = 'ACCEPTED' AND rp."acceptedAt" > rm."acceptedAt"))), false)`

/** An eBay listing an OLDER Claude close-listing paused (`isOldClosePause`); needs the raw-SQL presence columns. */
const OLD_PAUSE_SQL = `(l.channel = 'EBAY' AND l."endedAt" IS NOT NULL AND l."endedReason" IS DISTINCT FROM 'channel-file-delete'
    AND l."offerClosedAt" IS NULL AND ${norm('l."listingStatus"')} <> 'ENDED' AND l."followMasterQuantity" = false
    AND COALESCE(l."quantityOverride", l.quantity) = 0)`

export interface LiveSqlOptions {
  /** The presence columns exist (`livePresenceColumns()`); without them no listing reads as an older close pause. */
  presence: boolean
}

/**
 * The joins the live state and flags read, for the `ChannelListing` row aliased `l`: its product (`live_p`), its
 * Shopify owner (`live_o`: the family root's listing on the same coordinate), the owner-wins facts (`live_w`), the
 * issue / suppression / drift / push facts (`live_f`) and the state itself (`live_s.state`).
 */
export function liveJoinsSql(options: LiveSqlOptions): Prisma.Sql {
  const owner = (column: string) => `CASE WHEN live_o.id IS NULL THEN l.${column} ELSE live_o.${column} END`
  return Prisma.raw(`
    LEFT JOIN "Product" live_p ON live_p.id = l."productId"
    LEFT JOIN LATERAL (
      SELECT o.id, o."listingStatus", o."isPublished", o."externalListingId", o."platformAttributes"
        FROM "ChannelListing" o
       WHERE l.channel = 'SHOPIFY' AND o."productId" = COALESCE(live_p."parentId", live_p.id) AND o.channel = l.channel AND o.marketplace = l.marketplace
         AND o."channelConnectionId" IS NOT DISTINCT FROM l."channelConnectionId" AND o."aliasKey" = l."aliasKey"
       LIMIT 1) live_o ON true
    CROSS JOIN LATERAL (
      SELECT ${norm(owner('"listingStatus"'))} AS status,
             ${owner('"isPublished"')} AS published,
             NULLIF(${owner('"externalListingId"')}, '') AS ext,
             CASE WHEN jsonb_typeof((${owner('"platformAttributes"')})->'status') = 'string'
                  THEN upper(btrim((${owner('"platformAttributes"')})->>'status', ${WS})) ELSE '' END AS shopify,
             ${norm('l."listingStatus"')} AS own_status,
             (${deletedSql('l')} OR (live_o.id IS NOT NULL AND ${deletedSql('live_o')})) AS deleted,
             ${options.presence ? OLD_PAUSE_SQL : 'false'} AS old_pause) live_w
    CROSS JOIN LATERAL (
      SELECT (SELECT count(*) FROM "ListingIssue" i WHERE i."listingId" = l.id AND i."resolvedAt" IS NULL AND upper(i.severity) = 'ERROR')::int AS errors,
             EXISTS (SELECT 1 FROM "AmazonSuppression" s WHERE s."listingId" = l.id AND s."resolvedAt" IS NULL) AS suppression,
             COALESCE((SELECT max(d."driftCount") FROM "ChannelDrift" d WHERE d."channelListingId" = l.id), 0) AS drift,
             (${norm('l."syncStatus"')} = 'FAILED' OR ${norm('l."lastSyncStatus"')} = 'FAILED') AS failed) live_f
    CROSS JOIN LATERAL (SELECT ${STATE_CASE} AS state) live_s`)
}

/** `sellingStateOf` (through `destinationSellingStates`' per-row reading) as one CASE over `live_w`. */
const STATE_CASE = `CASE
      WHEN live_w.old_pause THEN 'paused'
      WHEN live_w.ext IS NULL AND (live_w.status = 'DRAFT' OR live_w.published = false) THEN CASE WHEN live_w.deleted THEN 'not_listed' ELSE 'draft' END
      WHEN l.channel = 'SHOPIFY' THEN CASE
        WHEN live_w.shopify = 'ARCHIVED' OR live_w.status = 'ENDED' THEN 'ended'
        WHEN l."offerClosedAt" IS NOT NULL THEN 'paused'
        WHEN live_w.shopify IN ('DRAFT', 'UNLISTED') THEN 'paused'
        WHEN live_w.shopify = 'ACTIVE' OR (live_w.shopify = '' AND live_w.status = 'ACTIVE') THEN 'active'
        ELSE 'unknown' END
      WHEN live_w.status = 'ENDED' THEN CASE WHEN l.channel IN ('AMAZON', 'ETSY') THEN 'not_listed' ELSE 'ended' END
      WHEN l.channel = 'ETSY' AND (live_w.status = 'INACTIVE' OR (live_w.status = 'DRAFT' AND live_w.ext IS NOT NULL)) THEN 'paused'
      WHEN l."offerClosedAt" IS NOT NULL THEN 'paused'
      WHEN live_w.status IN ('ACTIVE', 'BUYABLE', 'DISCOVERABLE') OR (live_w.status = 'DRAFT' AND live_w.ext IS NOT NULL) THEN 'active'
      ELSE 'unknown'
    END`

/** The listing's `SellingState` (text) — the same as `sellingStateOf` per row. Needs `liveJoinsSql`. */
export function liveStateSql(): Prisma.Sql {
  return Prisma.raw('live_s.state')
}

/** The four flags as booleans — the same as `liveFlagsOf`. Need `liveJoinsSql`. */
export function liveFlagsSql(): Record<ReadinessLiveFlag, Prisma.Sql> {
  return {
    error: Prisma.raw(`(live_f.errors > 0 OR live_f.failed OR live_w.own_status = 'ERROR')`),
    suppressed: Prisma.raw(`(live_f.suppression OR live_w.own_status = 'SUPPRESSED')`),
    outOfSync: Prisma.raw(`(live_f.drift > 0 OR live_f.failed)`),
    lowStock: Prisma.raw(`(live_s.state = 'active' AND l.quantity IS NOT NULL AND live_p."lowStockThreshold" IS NOT NULL AND l.quantity <= live_p."lowStockThreshold")`),
  }
}
