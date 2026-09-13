import type { Prisma } from '@prisma/client'

/** A listing address, inside the caller's verified workspace context. */
export interface ListingCoordinate {
  productId: string
  channel: string
  marketplace: string
  channelConnectionId: string | null
  aliasKey: string
}

export class ListingCoordinateError extends Error {
  readonly statusCode = 400
  constructor(
    readonly code: 'LISTING_COORDINATE_MISSING_LEVEL' | 'LISTING_COORDINATE_INVALID_LEVEL',
    readonly level: keyof ListingCoordinate,
  ) {
    super(`${code}: ${level}`)
    this.name = 'ListingCoordinateError'
  }
}

/**
 * Use this SAME predicate for the pre-read and the write. Never put nullable
 * levels into Prisma's compound-unique input: it rejects null at runtime.
 * Explicit `channelConnectionId: null` means IS NULL; undefined drops a Prisma
 * clause and would select every account, so a missing level always throws.
 *
 * NULL rule (local DB verified 2026-09-13): aliasId is nullable, aliasKey is NOT
 * NULL. Explicit aliasKey:'' addresses the primary row; null is invalid, never
 * converted to ''. The historical NULLS NOT DISTINCT *_conn_key indexes remain
 * alongside the *_akey_key indexes; their old “NULL alias” comment names aliasId,
 * not aliasKey. Do not infer query semantics or alias availability from it.
 */
export function whereCoordinate(c: ListingCoordinate): ListingCoordinate {
  const levels = ['productId', 'channel', 'marketplace', 'channelConnectionId', 'aliasKey'] as const
  for (const level of levels) {
    if (!c || !Object.prototype.hasOwnProperty.call(c, level) || c[level] === undefined) {
      throw new ListingCoordinateError('LISTING_COORDINATE_MISSING_LEVEL', level)
    }
    const value = c[level]
    if (level === 'channelConnectionId' && value === null) continue
    if (typeof value !== 'string' || (level !== 'aliasKey' && !value.trim())) {
      throw new ListingCoordinateError('LISTING_COORDINATE_INVALID_LEVEL', level)
    }
  }
  return {
    productId: c.productId,
    channel: c.channel,
    marketplace: c.marketplace,
    channelConnectionId: c.channelConnectionId,
    aliasKey: c.aliasKey,
  } satisfies Prisma.ChannelListingWhereInput
}
