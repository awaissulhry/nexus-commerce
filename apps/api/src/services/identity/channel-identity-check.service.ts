/**
 * MCP full control I8 — channel-identity-check: one family's listings, read LIVE from the channel (the publish review's
 * live read, services/live-read/index.ts, through the gateway) and compared with what Nexus holds for them: does the
 * account hold the item, is it still live, which seller lists it, and which SKUs are missing or extra.
 *
 * A read, never a write. It spends the channel's rate budget, so the tool limits it per business per hour; a listing
 * with no account, or on a channel whose live read is not built yet (Shopify, Etsy), says so instead of guessing.
 */
import prisma from '../../db.js'
import { accountSellerFor, accountSellerNames, checkSellerOwnership, parseListingStatus, parseSellerUserId } from '../ebay-itemid-relink.pure.js'

/** At most this many coordinates (channel, market, account, extra listing) are read in one call. */
export const CHECK_COORDINATES = 5

export type IdentityVerdict = 'held' | 'ended' | 'foreign' | 'unverifiable' | 'not-readable'

export interface CoordinateCheck {
  channel: string
  market: string
  accountId: string | null
  extraListing?: string
  externalId: string | null
  verdict: IdentityVerdict
  reason: string
  status?: string | null
  seller?: { onChannel: string | null; account: string | null }
  skus?: { live: number; missing: string[]; extra: string[] }
  readAt?: string
  cached?: boolean
}

const PLAIN: Record<IdentityVerdict, string> = {
  held: 'The account holds this item and it is live.',
  ended: 'The item is no longer live on the channel.',
  foreign: 'Another seller lists this item: it is not this account\'s.',
  unverifiable: 'The item was read, but it cannot be proven which seller lists it.',
  'not-readable': 'The item could not be read live.',
}

export async function checkFamilyIdentity(productId: string, filters: { channel?: string; market?: string } = {}) {
  const asked = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!asked) return null
  const rootId = asked.parentId && asked.parentId !== asked.id ? asked.parentId : asked.id
  const root = await prisma.product.findFirst({ where: { id: rootId, deletedAt: null }, select: { id: true, sku: true } })
    ?? await prisma.product.findFirstOrThrow({ where: { id: asked.id }, select: { id: true, sku: true } })
  const listings = await prisma.channelListing.findMany({
    where: {
      product: { deletedAt: null, OR: [{ id: root.id }, { parentId: root.id }] },
      ...(filters.channel ? { channel: filters.channel } : {}),
      ...(filters.market ? { marketplace: filters.market } : {}),
    },
    select: { channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, externalListingId: true, productId: true },
    orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { aliasKey: 'asc' }],
  })
  const coordinates = new Map<string, { channel: string; market: string; accountId: string | null; aliasKey: string; externalId: string | null }>()
  for (const l of listings) {
    const key = JSON.stringify([l.channel, l.marketplace, l.channelConnectionId, l.aliasKey])
    const known = coordinates.get(key)
    const externalId = l.externalListingId?.trim() || null
    if (!known) coordinates.set(key, { channel: l.channel, market: l.marketplace, accountId: l.channelConnectionId, aliasKey: l.aliasKey, externalId })
    else if (!known.externalId && externalId) known.externalId = externalId
  }
  const all = [...coordinates.values()]
  const chosen = all.slice(0, CHECK_COORDINATES)
  const accounts = new Map((await prisma.channelConnection.findMany({
    where: { id: { in: chosen.map((c) => c.accountId).filter((id): id is string => Boolean(id)) } },
    select: { id: true, externalAccountId: true, ebaySignInName: true },
  })).map((a) => [a.id, accountSellerNames(a)]))

  const checks: CoordinateCheck[] = []
  for (const c of chosen) {
    const base = { channel: c.channel, market: c.market, accountId: c.accountId, ...(c.aliasKey ? { extraListing: c.aliasKey } : {}), externalId: c.externalId }
    if (!c.accountId) {
      checks.push({ ...base, verdict: 'not-readable', reason: 'This listing names no account, so there is nothing to read it through.' })
      continue
    }
    if (!c.externalId) {
      checks.push({ ...base, verdict: 'not-readable', reason: 'This listing carries no channel id yet: there is no item to read.' })
      continue
    }
    let read: Awaited<ReturnType<typeof import('../live-read/index.js')['readLiveListing']>>
    try {
      // Loaded on use: the live read pulls the channel clients, which the tool registry need not load.
      const { readLiveListing } = await import('../live-read/index.js')
      read = await readLiveListing(root.id, { channel: c.channel, marketplace: c.market, accountId: c.accountId, aliasKey: c.aliasKey || undefined })
    } catch (error) {
      checks.push({ ...base, verdict: 'not-readable', reason: `The live read failed: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const itemError = read.errors.find((e) => e.scope === 'item')
    const variants = read.variations?.variants ?? []
    const skus = { live: variants.filter((v) => v.state === 'live').length, missing: variants.filter((v) => v.state === 'missing').map((v) => v.sku).slice(0, 20), extra: variants.filter((v) => v.state === 'extra').map((v) => v.sku).slice(0, 20) }
    const timing = { readAt: read.readAt, cached: read.cached }
    if (itemError) {
      checks.push({ ...base, verdict: 'not-readable', reason: itemError.reason, ...timing })
      continue
    }
    if (c.channel === 'EBAY') {
      const xml = (read.raw as { xml?: string | null } | null)?.xml ?? ''
      const status = xml ? parseListingStatus(xml) : null
      const onChannel = xml ? parseSellerUserId(xml) : null
      const seller = { onChannel, account: accountSellerFor(onChannel, accounts.get(c.accountId) ?? []) }
      const owner = checkSellerOwnership({ itemSeller: seller.onChannel, accountSeller: seller.account })
      const verdict: IdentityVerdict = status && status.toLowerCase() !== 'active' ? 'ended'
        : owner.verdict === 'rejected' ? 'foreign' : owner.verdict === 'unverifiable' ? 'unverifiable' : 'held'
      checks.push({ ...base, verdict, reason: verdict === 'held' ? PLAIN.held : verdict === 'ended' ? `${PLAIN.ended} eBay says "${status}".` : owner.reason, status, seller, skus, ...timing })
      continue
    }
    checks.push({ ...base, verdict: 'held', reason: PLAIN.held, skus, ...timing })
  }
  return {
    family: { rootProductId: root.id, rootSku: root.sku },
    checks,
    ...(all.length > chosen.length ? { more: `${all.length - chosen.length} more listing coordinates were not read: name channel and market to read them.` } : {}),
  }
}
