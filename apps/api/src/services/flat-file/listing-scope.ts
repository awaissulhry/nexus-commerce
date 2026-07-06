/**
 * Family-coherent "is listed on this channel (+ market)" Prisma where-fragment
 * for the scoped flat-file views. A product qualifies if IT, its PARENT, or a
 * CHILD has a matching ChannelListing — so variation families stay intact.
 * scope 'all' → {} (no filtering, i.e. the whole catalog).
 */
export type ListingScope = 'listed' | 'all'

export function buildListingScopeWhere(opts: {
  channel: string
  marketplace?: string
  scope: ListingScope
}): Record<string, unknown> {
  if (opts.scope === 'all') return {}
  const listingWhere = {
    channel: opts.channel,
    ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
  }
  const hasListing = { channelListings: { some: listingWhere } }
  return {
    OR: [
      hasListing,
      { parent: hasListing },
      { children: { some: hasListing } },
    ],
  }
}
