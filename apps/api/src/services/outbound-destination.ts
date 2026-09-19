/**
 * P1.3 (docs/channel-connections/FINAL-PLAN.md) — which channel account an outbound queue row is sent
 * through. Fixed when the row is created (services/outbound-enqueue.ts) and read again by the sender for
 * rows created before P1.3.
 *
 * In this order:
 *   1. the account the row already names (`channelConnectionId`, or `payload.channelConnectionId`);
 *   2. the account of the listing the row names (`channelListingId`, or `payload.channelListingId`);
 *   3. for a row that names only a product: the one account that holds that product in the row's market
 *      on that channel;
 *   4. else the channel's only active account.
 * Two or more candidates at step 3 or 4 → no account (reason `AMBIGUOUS`): the sender refuses the row.
 * It is never sent through "the primary account" by default (D7: refuse loudly; MAP.7 builds the fan-out).
 */
import { chooseConnection, listActiveConnections, AmbiguousConnectionError, NoConnectionError } from './connection-resolver.service.js'
import { logger } from '../utils/logger.js'

export interface DestinationRowInput {
  channelConnectionId?: string | null
  channelListingId?: string | null
  productId?: string | null
  targetChannel?: string | null
  targetRegion?: string | null
  payload?: unknown
}

export type DestinationReason = 'NAMED' | 'LISTING' | 'PRODUCT_IN_MARKET' | 'ONLY_ACCOUNT' | 'AMBIGUOUS' | 'NO_ACCOUNT'
export interface Destination { connectionId: string | null; reason: DestinationReason }

interface ListingReader {
  channelListing: { findMany: (args: unknown) => Promise<Array<Record<string, unknown>>> }
}

const marketKey = (market: unknown) => {
  const m = String(market ?? '').trim().toUpperCase()
  return m === 'GB' ? 'UK' : m
}
const payloadField = (payload: unknown, name: string): string | null => {
  const value = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[name] : null
  return typeof value === 'string' && value ? value : null
}

/** The destination of each row, in order. Batched: a few reads for any number of rows. */
export async function resolveDestinations(db: ListingReader, rows: DestinationRowInput[]): Promise<Destination[]> {
  // A client without the listing table (a narrowed test double) cannot tell listings apart: those rows stay
  // unresolved here and the sender resolves them again — the safe side, never a guess.
  const canReadListings = typeof (db as Partial<ListingReader>).channelListing?.findMany === 'function'
  const out: Array<Destination | null> = rows.map((row) => {
    const named = row.channelConnectionId ?? payloadField(row.payload, 'channelConnectionId')
    return named ? { connectionId: named, reason: 'NAMED' } : null
  })

  // 2. the listing's own account
  const listingIdOf = (row: DestinationRowInput) => row.channelListingId ?? payloadField(row.payload, 'channelListingId')
  const listingIds = [...new Set(rows.filter((_, i) => !out[i]).map(listingIdOf).filter((id): id is string => !!id))]
  if (listingIds.length && canReadListings) {
    const listings = await db.channelListing.findMany({ where: { id: { in: listingIds } }, select: { id: true, channelConnectionId: true } })
    const accountOf = new Map(listings.map((l) => [String(l.id), (l.channelConnectionId as string | null) ?? null]))
    rows.forEach((row, i) => {
      if (out[i]) return
      const account = accountOf.get(listingIdOf(row) ?? '')
      if (account) out[i] = { connectionId: account, reason: 'LISTING' }
    })
  }

  // 3. the product's account in this market on this channel
  const productRows = rows.map((row, i) => ({ row, i })).filter(({ row, i }) => !out[i] && row.productId && row.targetChannel)
  if (productRows.length && canReadListings) {
    const productIds = [...new Set(productRows.map(({ row }) => row.productId as string))]
    const channels = [...new Set(productRows.map(({ row }) => row.targetChannel as string))]
    const held = await db.channelListing.findMany({
      where: { productId: { in: productIds }, channel: { in: channels }, channelConnectionId: { not: null } },
      select: { productId: true, channel: true, marketplace: true, region: true, channelConnectionId: true },
    })
    for (const { row, i } of productRows) {
      const market = marketKey(row.targetRegion)
      const accounts = [...new Set(held
        .filter((l) => l.productId === row.productId && l.channel === row.targetChannel && (!market || marketKey(l.marketplace) === market || marketKey(l.region) === market))
        .map((l) => String(l.channelConnectionId)))]
      if (accounts.length === 1) out[i] = { connectionId: accounts[0], reason: 'PRODUCT_IN_MARKET' }
      else if (accounts.length > 1) out[i] = { connectionId: null, reason: 'AMBIGUOUS' }
    }
  }

  // 4. the channel's only account
  const rest = rows.map((row, i) => ({ row, i })).filter(({ i }) => !out[i])
  const onlyAccount = new Map<string, Destination>()
  for (const channel of [...new Set(rest.map(({ row }) => row.targetChannel).filter((c): c is string => !!c))]) {
    try {
      const chosen = chooseConnection(await listActiveConnections(channel), { channel })
      onlyAccount.set(channel, { connectionId: chosen.id, reason: 'ONLY_ACCOUNT' })
    } catch (err) {
      if (err instanceof AmbiguousConnectionError) onlyAccount.set(channel, { connectionId: null, reason: 'AMBIGUOUS' })
      else {
        // No account, or the account list could not be read: no destination now; the sender resolves the
        // row again and refuses it if it still cannot — a save never fails on this lookup.
        if (!(err instanceof NoConnectionError)) logger.warn('outbound-destination: account list unavailable', { channel, error: err instanceof Error ? err.message : String(err) })
        onlyAccount.set(channel, { connectionId: null, reason: 'NO_ACCOUNT' })
      }
    }
  }
  return rest.length === 0
    ? (out as Destination[])
    : out.map((d, i) => d ?? onlyAccount.get(rows[i].targetChannel ?? '') ?? { connectionId: null, reason: 'NO_ACCOUNT' })
}

/** The sentence the sender answers with when a row has no account. */
export function noDestinationSentence(channel: string, reason: DestinationReason): string {
  return reason === 'AMBIGUOUS'
    ? `Nothing was sent to ${channel}: more than one ${channel} account holds this product, and the change does not say which one. Save it again from the listing of the account it is for.`
    : `Nothing was sent to ${channel}: no connected ${channel} account holds this listing.`
}
