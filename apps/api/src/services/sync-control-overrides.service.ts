import prisma from '../db.js'

/**
 * Shared stock plan steps 3 and 5 (docs/2026-09-19-shared-stock-plan.md §5) — the Sync Control writes
 * that set when an override ends, and a shared eBay variant's Fixed number. The route decides which
 * rows and writes the history; these do the writes, so the route file gains no database call
 * (scripts/check-route-prisma-ratchet.mjs). The job in listing-end-times.service.ts ends what these set.
 */

export interface MembershipCoordinate {
  itemId: string
  marketplace: string
  sku: string
}

/**
 * The end of a Fixed number, on the listings that are pinned now (a listing that follows has no end).
 * Returns each listing's previous end (ISO, or null for none), for the history.
 */
export async function setListingPinEnds(listingIds: string[], until: Date | null): Promise<Map<string, string | null>> {
  const rows = await prisma.channelListing.findMany({ where: { id: { in: listingIds } }, select: { id: true, pinnedUntil: true } })
  const before = new Map(rows.map((row) => [row.id, row.pinnedUntil?.toISOString() ?? null]))
  await prisma.channelListing.updateMany({ where: { id: { in: listingIds }, followMasterQuantity: false }, data: { pinnedUntil: until } })
  return before
}

/** The end of a pause, on the listings that are paused now. */
export async function setListingPauseEnds(listingIds: string[], until: Date | null): Promise<void> {
  await prisma.channelListing.updateMany({ where: { id: { in: listingIds }, syncPaused: true }, data: { pausedUntil: until } })
}

/** The end of an exclusion, on the shared variants that are excluded now. */
export async function setMembershipExclusionEnds(membershipIds: string[], until: Date | null): Promise<void> {
  await prisma.sharedListingMembership.updateMany({ where: { id: { in: membershipIds }, followPool: false }, data: { pausedUntil: until } })
}

/** A shared variant's Fixed number (null: it follows the pool again) and, when given, its end. */
export async function setMembershipFixedNumber(membershipId: string, pinnedQuantity: number | null, until?: Date | null): Promise<void> {
  await prisma.sharedListingMembership.update({
    where: { id: membershipId },
    data: { pinnedQuantity, ...(until !== undefined ? { pinnedUntil: until } : {}) },
  })
}

/** Plan apply, by the variant's eBay coordinate: included, and following the pool (null) or a Fixed number. */
export async function setMembershipModeByCoordinate(coordinate: MembershipCoordinate, pinnedQuantity: number | null): Promise<void> {
  await prisma.sharedListingMembership.updateMany({
    where: { itemId: coordinate.itemId, marketplace: coordinate.marketplace, sku: coordinate.sku },
    data: { followPool: true, pinnedQuantity },
  })
}
