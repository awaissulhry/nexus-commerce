/**
 * P0.7 (docs/channel-connections/FINAL-PLAN.md) — the wrong-account guard.
 *
 * Nexus can hold several seller accounts per channel, and each listing records its own
 * (`ChannelListing.channelConnectionId`, and for shared eBay listings
 * `SharedListingMembership.channelConnectionId`). But most eBay write paths still pick the
 * account with `{ channel: 'EBAY', primary: true }`, and Amazon's default seller is "the one
 * active account" — so a change meant for a listing of a second account went to the first one.
 *
 * Until P1.3 gives every queued write its own destination, a write path calls
 * `assertWriteAccount(channel, <the account it is about to use>, <what it writes>)` right before
 * the call. If every listing the write touches belongs to other accounts, the write is refused
 * loudly and nothing is sent. A listing with no recorded account, or a target no listing names,
 * is not refused: there is nothing to contradict. If the ownership lookup itself fails, the write
 * is refused — an unverified write is the risk this guard exists for.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { normalizeMarketplaceCode } from '../utils/marketplace-code.js'

export type GuardedChannel = 'EBAY' | 'AMAZON'

export class WrongAccountWriteError extends Error {
  readonly code = 'WRONG_ACCOUNT_WRITE'
  readonly statusCode = 409
  constructor(
    message: string,
    readonly detail: { channel: GuardedChannel; usedConnectionId: string; ownerConnectionIds: string[] },
  ) {
    super(message)
    this.name = 'WrongAccountWriteError'
  }
}

export interface WriteTarget {
  /** ChannelListing ids the write is for. */
  listingIds?: ReadonlyArray<string | null | undefined>
  /** Products whose listing on this channel (and marketplace) the write is for. */
  productIds?: ReadonlyArray<string | null | undefined>
  /**
   * Seller SKUs: the product SKU, or a listing's own channel SKU (S8: `channelSku` / confirmed `liveChannelSku`, per
   * market); for shared eBay listings the variant SKU.
   */
  skus?: ReadonlyArray<string | null | undefined>
  /** eBay ItemIDs. */
  itemIds?: ReadonlyArray<string | null | undefined>
  /** Narrows product / SKU matches: 'IT', 'EBAY_IT', or an Amazon marketplace id. */
  marketplace?: string | null
}

const CHANNEL_NAME: Record<GuardedChannel, string> = { EBAY: 'eBay', AMAZON: 'Amazon' }

const clean = (values?: ReadonlyArray<string | null | undefined>): string[] =>
  [...new Set((values ?? []).filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))]

/**
 * S8 — listings whose own channel SKU is one of `skus`: the SKU Nexus sends (`channelSku`) or the one the channel
 * confirmed (`liveChannelSku`). Both columns are written trimmed and indexed per account; no JSON store is read.
 */
export function ownSkuIn(skus: string[]): Prisma.ChannelListingWhereInput {
  return { OR: [{ channelSku: { in: skus } }, { liveChannelSku: { in: skus } }] }
}

/** 'EBAY_IT' | 'IT' | 'APJ6JRA9NG5V4' → 'IT'; null when it cannot be read. */
export function marketplaceCodeOf(value: string | null | undefined): string | null {
  if (!value) return null
  const code = normalizeMarketplaceCode(value.trim().toUpperCase().startsWith('EBAY_') ? value.trim().slice(5) : value)
  return code === 'UNKNOWN' ? null : code
}

/** Readable names for the refusal sentence. Never throws: a refusal must not become a crash. */
async function accountNames(ids: string[]): Promise<Map<string, string>> {
  try {
    const rows = await prisma.channelConnection.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, externalAccountId: true },
    })
    return new Map(rows.map((r) => [r.id, r.displayName || r.externalAccountId || r.id]))
  } catch {
    return new Map()
  }
}

/** The accounts that own what this write touches (empty = no recorded owner). */
export async function ownersOfWriteTarget(channel: GuardedChannel, target: WriteTarget): Promise<Set<string>> {
  const listingIds = clean(target.listingIds)
  const productIds = clean(target.productIds)
  const skus = clean(target.skus)
  const itemIds = clean(target.itemIds)
  const owners = new Set<string>()
  if (!listingIds.length && !productIds.length && !skus.length && !itemIds.length) return owners

  const code = marketplaceCodeOf(target.marketplace)
  const inMarket: Prisma.ChannelListingWhereInput = code ? { OR: [{ marketplace: code }, { region: code }] } : {}
  const or: Prisma.ChannelListingWhereInput[] = []
  if (listingIds.length) or.push({ id: { in: listingIds } })
  if (itemIds.length) or.push({ externalListingId: { in: itemIds } })
  if (productIds.length) or.push({ AND: [{ productId: { in: productIds } }, inMarket] })
  if (skus.length) {
    or.push({ AND: [{ product: { sku: { in: skus } } }, inMarket] })
    // S8 — a listing's own channel SKU (per market), in the same statement: without it, a write naming a listing's own
    // SKU found no owner and was never refused. A hot path (every guarded write): the indexed columns only, never the
    // JSON stores. A SKU only an old store holds is matched once the backfill copies it into these columns.
    or.push({ AND: [ownSkuIn(skus), inMarket] })
  }
  const listings = await prisma.channelListing.findMany({
    where: { channel, channelConnectionId: { not: null }, OR: or },
    select: { channelConnectionId: true },
  })
  for (const row of listings) if (row.channelConnectionId) owners.add(row.channelConnectionId)

  if (channel === 'EBAY' && (itemIds.length || skus.length)) {
    const memberOr: Prisma.SharedListingMembershipWhereInput[] = []
    if (itemIds.length) memberOr.push({ itemId: { in: itemIds } })
    if (skus.length) memberOr.push({ sku: { in: skus }, ...(code ? { marketplace: code } : {}) })
    const members = await prisma.sharedListingMembership.findMany({
      where: { channelConnectionId: { not: null }, OR: memberOr },
      select: { channelConnectionId: true },
    })
    for (const row of members) if (row.channelConnectionId) owners.add(row.channelConnectionId)
  }
  return owners
}

/**
 * Refuse the write when what it touches belongs only to OTHER accounts than `usedConnectionId`.
 * No-op when the account being used is unknown, or nothing the write touches has a recorded owner.
 */
export async function assertWriteAccount(
  channel: GuardedChannel,
  usedConnectionId: string | null | undefined,
  target: WriteTarget,
): Promise<void> {
  if (!usedConnectionId) return
  let owners: Set<string>
  try {
    owners = await ownersOfWriteTarget(channel, target)
  } catch (err) {
    throw new WrongAccountWriteError(
      `Nothing was sent to ${CHANNEL_NAME[channel]}: Nexus could not confirm which ${CHANNEL_NAME[channel]} account this listing belongs to (${err instanceof Error ? err.message : String(err)}).`,
      { channel, usedConnectionId, ownerConnectionIds: [] },
    )
  }
  if (owners.size === 0 || owners.has(usedConnectionId)) return
  const ownerIds = [...owners]
  const names = await accountNames([usedConnectionId, ...ownerIds])
  const ownerNames = ownerIds.map((id) => `"${names.get(id) ?? id}"`).join(', ')
  throw new WrongAccountWriteError(
    `Nothing was sent to ${CHANNEL_NAME[channel]}: this change is for a listing of the ${CHANNEL_NAME[channel]} account ${ownerNames}, ` +
      `but this path can only send through "${names.get(usedConnectionId) ?? usedConnectionId}". ` +
      'Changes for a second account are held until they can be routed to the right account.',
    { channel, usedConnectionId, ownerConnectionIds: ownerIds },
  )
}

/**
 * The batch form: each SKU is checked on its own, so one SKU owned only by another account refuses
 * the whole batch (and names the SKUs), even when other SKUs in it belong to `usedConnectionId`.
 */
export async function assertWriteAccountPerSku(
  channel: GuardedChannel,
  usedConnectionId: string | null | undefined,
  skus: ReadonlyArray<string | null | undefined>,
  marketplace?: string | null,
): Promise<void> {
  if (!usedConnectionId) return
  const wanted = clean(skus)
  if (!wanted.length) return
  const code = marketplaceCodeOf(marketplace)
  const ownersBySku = new Map<string, Set<string>>()
  const add = (sku: string | null | undefined, owner: string | null) => {
    if (!sku || !owner) return
    if (!ownersBySku.has(sku)) ownersBySku.set(sku, new Set())
    ownersBySku.get(sku)!.add(owner)
  }
  try {
    const listings = await prisma.channelListing.findMany({
      where: { channel, channelConnectionId: { not: null }, product: { sku: { in: wanted } }, ...(code ? { OR: [{ marketplace: code }, { region: code }] } : {}) },
      select: { channelConnectionId: true, product: { select: { sku: true } } },
    })
    for (const row of listings) add(row.product?.sku, row.channelConnectionId)
    // S8 — and every listing whose own channel SKU is one of them: the indexed columns only, a few columns back.
    const own = await prisma.channelListing.findMany({
      where: { channel, channelConnectionId: { not: null }, AND: [ownSkuIn(wanted), ...(code ? [{ OR: [{ marketplace: code }, { region: code }] }] : [])] },
      select: { channelConnectionId: true, channelSku: true, liveChannelSku: true },
    })
    for (const row of own) {
      for (const sku of new Set([row.channelSku, row.liveChannelSku])) if (sku && wanted.includes(sku)) add(sku, row.channelConnectionId)
    }
    if (channel === 'EBAY') {
      const members = await prisma.sharedListingMembership.findMany({
        where: { channelConnectionId: { not: null }, sku: { in: wanted }, ...(code ? { marketplace: code } : {}) },
        select: { channelConnectionId: true, sku: true },
      })
      for (const row of members) add(row.sku, row.channelConnectionId)
    }
  } catch (err) {
    throw new WrongAccountWriteError(
      `Nothing was sent to ${CHANNEL_NAME[channel]}: Nexus could not confirm which ${CHANNEL_NAME[channel]} account these listings belong to (${err instanceof Error ? err.message : String(err)}).`,
      { channel, usedConnectionId, ownerConnectionIds: [] },
    )
  }
  const foreign = [...ownersBySku].filter(([, owners]) => !owners.has(usedConnectionId))
  if (!foreign.length) return
  const ownerIds = [...new Set(foreign.flatMap(([, owners]) => [...owners]))]
  const names = await accountNames([usedConnectionId, ...ownerIds])
  const shown = foreign.slice(0, 10).map(([sku]) => sku).join(', ') + (foreign.length > 10 ? ` and ${foreign.length - 10} more` : '')
  throw new WrongAccountWriteError(
    `Nothing was sent to ${CHANNEL_NAME[channel]}: ${foreign.length === 1 ? 'SKU' : 'SKUs'} ${shown} belong to the ${CHANNEL_NAME[channel]} account ` +
      `${ownerIds.map((id) => `"${names.get(id) ?? id}"`).join(', ')}, but this path can only send through "${names.get(usedConnectionId) ?? usedConnectionId}". ` +
      'Remove them from this push, or wait until changes for a second account can be routed to it.',
    { channel, usedConnectionId, ownerConnectionIds: ownerIds },
  )
}

/**
 * For a primary-only route that looked up "a" listing of a product in a market: the same product's
 * listing that belongs to `usedConnectionId`, if there is one (with its product SKU, as the routes
 * load it). Null means the product has no listing of that account there.
 */
export async function ownListingFor(channel: GuardedChannel, usedConnectionId: string, where: { productId: string; region: string }) {
  return prisma.channelListing.findFirst({
    where: { productId: where.productId, channel, region: where.region, channelConnectionId: usedConnectionId },
    include: { product: { select: { sku: true } } },
  })
}

export function isWrongAccountWriteError(err: unknown): err is WrongAccountWriteError {
  return err instanceof WrongAccountWriteError || (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'WRONG_ACCOUNT_WRITE')
}
