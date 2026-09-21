/**
 * P1.3 — creating OutboundSyncQueue rows: the listing-claim check for shared accounts (BP.S3) and the
 * destination account, before any row exists. A light module on purpose: the enqueue module next door
 * loads the queue (a Redis connection); a creation site must not pay that to write a row.
 */
import { getTraceId } from '../utils/request-context.js'
import type { Prisma } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { sellerSkuForClaim } from './listing-claim-identity.js'

// Structural typing matching the repo's SharedFanoutDeps precedent — accepts
// PrismaClient or a TransactionClient without fighting Prisma's generics.
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
interface OutboundEnqueueDb {
  outboundSyncQueue: { createMany: Function; findMany: Function }
}

/** One coordinate the BP.S3 preflight refused, and the sentence that says why. */
export interface BlockedCoordinate {
  channelListingId: string
  sellerSku: string | null
  marketplace: string
  reason: string
  heldByWorkspaceName?: string
}

/**
 * BP.S3 — the publish preflight for a SHARED seller account.
 *
 * Two businesses behind one account share one SKU namespace, so before either may
 * push into a coordinate it must hold `ChannelListingClaim` for it. This is the one
 * place that check can live: every OutboundSyncQueue row in the instant lane is
 * created here, and it runs BEFORE the rows exist, so a refused coordinate never
 * becomes a durable job someone has to cancel.
 *
 * 🔴 It is a NO-OP unless the account is shared. `sharedConnectionIds` is one
 * indexed read, and an account with a single business behind it takes the early
 * return — so nothing about existing publishing changes, which is what keeps the
 * blast radius of this feature at zero for every account nobody has shared.
 *
 * Returns the rows that may proceed, plus a refusal per coordinate that may not.
 * Refusals are collected rather than thrown: a bulk publish must report every
 * blocked coordinate at once, not stop on the first.
 */
export async function reserveSharedCoordinates(
  db: OutboundEnqueueDb,
  rows: Array<Record<string, unknown>>,
): Promise<{ allowed: Array<Record<string, unknown>>; blocked: BlockedCoordinate[] }> {
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') return { allowed: rows, blocked: [] }
  const listingIds = [...new Set(rows.map(r => r.channelListingId).filter((id): id is string => typeof id === 'string' && !!id))]
  if (listingIds.length === 0) return { allowed: rows, blocked: [] }
  /*
   * Imported HERE, past the flag check, on purpose. This module is on the hot path
   * of every outbound push; the claim service pulls in the prisma client, and a
   * single-business install never reaches this line. It also keeps that client out
   * of the import graph of callers that mock `@nexus/database` partially —
   * `channel-delist.vitest.test.ts` mocks it with no default export, which a
   * top-level import here turned into a suite-load failure.
   */
  const { claimCoordinate, sharedConnectionIds } = await import('./listing-claim.service.js')
  // P1.3 — read through the caller's client: inside a transaction, no second connection is taken.
  const grantReader = typeof (db as { channelAccountGrant?: { findMany?: unknown } }).channelAccountGrant?.findMany === 'function' ? db as never : undefined

  /*
   * The GATE first, the listing read only if the gate opens.
   *
   * A P1.3 row names the account it will be sent through (`channelConnectionId`), and
   * that account — the one the gateway opens, services/gateway/account.js — is the
   * namespace a claim protects: a coordinate on an account nothing publishes to cannot
   * collide. So when every row names its account, the gate is answerable from the one
   * indexed grant read this feature promised, and the listing read below (a join over
   * product + offers) is not paid at all on the single-business path.
   *
   * It stays the documented no-op: a row that names no account still takes the full
   * path, and an account that IS shared falls through to exactly the code below.
   *
   * Why this matters beyond a query count: creation sites call this once per row inside
   * a chunked interactive transaction (follow-master), where a per-row read is the P2028
   * shape those chunks exist to keep out.
   */
  const namedAccounts = rows
    .filter(r => typeof r.channelListingId === 'string' && r.channelListingId)
    .map(r => (typeof r.channelConnectionId === 'string' && r.channelConnectionId ? r.channelConnectionId : null))
  if (namedAccounts.length > 0 && namedAccounts.every((id): id is string => !!id)) {
    const sharedNamed = await sharedConnectionIds(namedAccounts, grantReader)
    if (sharedNamed.size === 0) return { allowed: rows, blocked: [] }
  }

  const listings = await (db as unknown as { channelListing: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> } }).channelListing.findMany({
    where: { id: { in: listingIds } },
    select: {
      id: true, marketplace: true, channelConnectionId: true,
      product: { select: { sku: true } },
      offers: { select: { sku: true, fulfillmentMethod: true, isActive: true } },
    },
  })
  const byId = new Map(listings.map(l => [l.id as string, l]))
  const shared = await sharedConnectionIds(listings.map(l => l.channelConnectionId as string).filter(Boolean), grantReader)
  if (shared.size === 0) return { allowed: rows, blocked: [] }

  const blocked: BlockedCoordinate[] = []
  const refusedListingIds = new Set<string>()
  for (const id of listingIds) {
    const listing = byId.get(id)
    const connectionId = listing?.channelConnectionId as string | undefined
    if (!listing || !connectionId || !shared.has(connectionId)) continue
    const marketplace = (listing.marketplace as string) ?? 'DEFAULT'
    const sellerSku = sellerSkuForClaim(listing as never)
    const outcome = await claimCoordinate({ connectionId, marketplace, sellerSku, channelListingId: id })
    if (outcome.result === 'blocked') {
      refusedListingIds.add(id)
      blocked.push({ channelListingId: id, sellerSku, marketplace, reason: outcome.reason ?? 'That coordinate belongs to another business profile.', heldByWorkspaceName: outcome.heldBy?.workspaceName })
    }
  }
  if (blocked.length > 0) {
    logger.warn('BP.S3 publish refused: coordinate held by another business profile', { count: blocked.length, coordinates: blocked.map(b => `${b.marketplace}/${b.sellerSku}`) })
  }
  return { allowed: rows.filter(r => !refusedListingIds.has(r.channelListingId as string)), blocked }
}


/**
 * P4.3c / P4.4b — a push that carries a NUMBER must name what it is pushing to.
 *
 * `syncToAmazon` loads the ChannelListing ONLY from `queueItem.channelListingId`
 * (there is no product fallback there, although `pushLockListings` two hundred
 * lines above has one — the same function, two resolutions of "which listing is
 * this row for"). With no listing:
 *
 *   - the send-time re-read (`resolveDispatchQuantity`) is skipped, so the
 *     enqueue-time snapshot goes out even if a fresher value was committed;
 *   - `stockBuffer` reads as 0, so the buffer is not held back;
 *   - the Amazon EU shared-quantity guard never runs at all — it is gated on
 *     `AMAZON_EU_SHARED_MARKETS.has(cl?.marketplace ?? '')`, and `''` is in no
 *     set. That is D9's guard, silently off.
 *
 * `PATCH /api/catalog/products/:id` produced exactly that row, carrying the
 * product's GROSS `totalStock` — beside the resolver-derived, per-listing rows
 * that the same request's stock movement cascade had just enqueued correctly.
 * Its twin, `PATCH /api/products/:id`, leaves the cascade to do it and queues
 * nothing. Two builders, one lesson learned in only one of them.
 *
 * The shared eBay fan-out is the one legitimate row with no listing: a shared
 * SKU is not a ChannelListing, so the row names its ItemID instead and the
 * dispatcher routes it by `payload.pushVia === 'TRADING'`.
 */
export type OutboundRowTarget = 'NOT_A_NUMBER_ROW' | 'LISTING' | 'SHARED_ITEM' | 'UNNAMED'
/** @deprecated the rule covers price as well as quantity; kept for readability at old call sites. */
export type QuantityRowTarget = OutboundRowTarget

const namedString = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''

/**
 * P4.4b — a PRICE row is the same shape of defect as a quantity row.
 *
 * `masterPriceService.update` cascades a price PER LISTING, honouring
 * `followMasterPrice`, `pricingRule` and `priceAdjustmentPercent`. A row that
 * names only a product carries the RAW master price and knows none of that, so
 * it overwrites a listing's deliberately different price with the master
 * number — and on Amazon it reaches `buildAmazonListingPatch` with no listing,
 * so it cannot even read the stored sale window to avoid wiping the sale.
 */
export function quantityRowTarget(row: unknown): OutboundRowTarget {
  const r = (row ?? {}) as Record<string, any>
  const payload = (r.payload ?? {}) as Record<string, any>
  // Either half is enough: a QUANTITY_UPDATE whose number is re-read at dispatch
  // carries no `payload.quantity`, and a FULL_SYNC can carry one.
  const carriesQuantity =
    r.syncType === 'QUANTITY_UPDATE' ||
    payload.quantity !== undefined ||
    (Array.isArray(payload.updates) && payload.updates.length > 0)
  const carriesPrice = r.syncType === 'PRICE_UPDATE' || payload.price !== undefined
  if (!carriesQuantity && !carriesPrice) return 'NOT_A_NUMBER_ROW'
  // The checked create form names its listing through `connect`; a loaded row
  // carries the relation. Read every form, never one.
  if (namedString(r.channelListingId) || namedString(r.channelListing?.connect?.id) || namedString(r.channelListing?.id)) return 'LISTING'
  if (payload.pushVia === 'TRADING' && (namedString(payload.itemId) || namedString(r.externalListingId))) return 'SHARED_ITEM'
  return 'UNNAMED'
}

/** The sentence a refused row answers with, at birth and at dispatch. */
export function unnamedQuantitySentence(channel: string, kind: 'quantity' | 'price' = 'quantity'): string {
  return kind === 'price'
    ? `Nothing was sent to ${channel}: this price change does not say which listing it is for, so the listing's own pricing rule, its market and its scheduled sale cannot be applied to it. Change the price on the product and the listings follow, or save it from the listing itself.`
    : `Nothing was sent to ${channel}: this stock change does not say which listing it is for, so the market, the stock buffer and the Amazon EU shared-quantity check cannot be applied to it. Change the stock on the product and the listings follow, or save it from the listing itself.`
}

/** Which sentence an unnamed row earns: a row that carries a price and no quantity is a price row. */
export function unnamedRowKind(row: unknown): 'quantity' | 'price' {
  const r = (row ?? {}) as Record<string, any>
  const payload = (r.payload ?? {}) as Record<string, any>
  const carriesQuantity = r.syncType === 'QUANTITY_UPDATE' || payload.quantity !== undefined || (Array.isArray(payload.updates) && payload.updates.length > 0)
  return carriesQuantity ? 'quantity' : 'price'
}

export class UnnamedQuantityRowError extends Error {
  readonly code = 'UNNAMED_QUANTITY_ROW'
  constructor(channel: string, kind: 'quantity' | 'price' = 'quantity') {
    super(unnamedQuantitySentence(channel, kind))
    this.name = 'UnnamedQuantityRowError'
  }
}

/**
 * P1.3 (docs/channel-connections/FINAL-PLAN.md) — the ONE way an OutboundSyncQueue row is created.
 *
 * Every creation site calls one of these three instead of `db.outboundSyncQueue.create / createMany /
 * createManyAndReturn` (same arguments, same answer; a ratchet keeps it that way). Before the row
 * exists: the listing-claim check for shared accounts runs (BP.S3 — before P1.3 only one of 34 sites
 * ran it), and the row gets its destination account (`channelConnectionId`, services/outbound-
 * destination.ts). A row whose destination cannot be told stays null; the sender refuses it.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type QueueCreateDb<K extends 'create' | 'createMany' | 'createManyAndReturn'> = { outboundSyncQueue: Record<K, Function> }
type QueueRowData = object & { payload?: unknown }
type CreateData = Prisma.OutboundSyncQueueCreateInput | Prisma.OutboundSyncQueueUncheckedCreateInput
type CreateManyData = Prisma.OutboundSyncQueueCreateManyInput

async function prepareRows(db: object, rows: QueueRowData[]): Promise<QueueRowData[]> {
  if (rows.length === 0) return rows
  const { allowed, blocked } = await reserveSharedCoordinates(db as unknown as OutboundEnqueueDb, rows)
  if (blocked.length > 0) {
    const { notifyPublishRefused } = await import('./publish-refusal-notify.service.js')
    await notifyPublishRefused(blocked)
    if (allowed.length === 0) {
      const { WorkspaceError } = await import('../lib/workspace-context.js')
      throw new WorkspaceError('listing_coordinate_claimed', blocked[0].reason, 409)
    }
  }
  // P4.3c — refuse an unnamed quantity row HERE, before it exists. Every creation
  // site passes through this function (P1.3, and a ratchet keeps it that way), so
  // this is the one place the rule cannot be forgotten by a new producer.
  for (const row of allowed) {
    if (quantityRowTarget(row) === 'UNNAMED') {
      const channel = String((row as Record<string, unknown>).targetChannel ?? 'the channel')
      const kind = unnamedRowKind(row)
      logger.warn('P4.3c/P4.4b: refused an outbound row that carries a number and names no listing', { channel, kind, syncType: (row as Record<string, unknown>).syncType })
      throw new UnnamedQuantityRowError(channel, kind)
    }
  }
  const { resolveDestinations } = await import('./outbound-destination.js')
  // The checked create form names its product / listing through `connect`; the rule reads either form.
  const connected = (row: Record<string, any>, relation: string, scalar: string) => row[scalar] ?? row[relation]?.connect?.id ?? null
  const destinations = await resolveDestinations(db as never, allowed.map((row) => {
    const r = row as Record<string, any>
    return { ...r, productId: connected(r, 'product', 'productId'), channelListingId: connected(r, 'channelListing', 'channelListingId') }
  }))
  // P3.6 — the change's trace, stamped where every row is born.
  //
  // This is the only place an OutboundSyncQueue row is created (P1.3, and a ratchet
  // keeps it that way), so it is the only place the operator's request id can be
  // handed to the row. Without it the trace dies here: the worker picks the row up
  // inside its own cron tick and stamps the tick's id on the channel call instead.
  const traceId = getTraceId() ?? null
  return allowed.map((row, i) => ({
    ...row,
    channelConnectionId: destinations[i].connectionId,
    // Never overwrite a trace a caller set deliberately (a replay carries the
    // ORIGINAL change's id, so the story stays one story).
    traceId: (row as Record<string, unknown>).traceId ?? traceId,
  }))
}

/** `db.outboundSyncQueue.create(args)`, with the claim check and the destination account. */
export async function createOutboundRow(db: QueueCreateDb<'create'>, args: { data: CreateData; select?: unknown }): Promise<any> {
  const [data] = await prepareRows(db, [args.data])
  return db.outboundSyncQueue.create({ ...args, data })
}

/** `db.outboundSyncQueue.createMany(args)`, with the claim check and the destination accounts. */
export async function createOutboundRows(db: QueueCreateDb<'createMany'>, args: { data: CreateManyData[]; skipDuplicates?: boolean }): Promise<{ count: number }> {
  const data = await prepareRows(db, args.data)
  if (data.length === 0) return { count: 0 }
  return db.outboundSyncQueue.createMany({ ...args, data })
}

/** `db.outboundSyncQueue.createManyAndReturn(args)`, with the claim check and the destination accounts. */
export async function createOutboundRowsAndReturn(db: QueueCreateDb<'createManyAndReturn'>, args: { data: CreateManyData[]; select?: unknown; skipDuplicates?: boolean }): Promise<any[]> {
  const data = await prepareRows(db, args.data)
  if (data.length === 0) return []
  return db.outboundSyncQueue.createManyAndReturn({ ...args, data })
}

