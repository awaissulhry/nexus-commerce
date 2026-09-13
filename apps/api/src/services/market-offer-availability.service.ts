import prisma from '../db.js'
import { whereCoordinate, type ListingCoordinate } from '../lib/listing-coordinate.js'

/** Explicit NULL is supported by the plain predicate; Prisma compound-unique
 * inputs cannot represent it. Serializable creation races fail rather than widen. */
export async function writeCoordinateOffer(c: ListingCoordinate, offerActive: boolean) {
  const where = whereCoordinate(c)
  if (typeof offerActive !== 'boolean') throw new Error('OFFER_ACTIVE_REQUIRED')
  return prisma.$transaction(async tx => {
    const row = await tx.channelListing.findFirst({ where })
    if (offerActive && (row?.offerClosedAt || row?.listingStatus === 'ENDED' ||
      ['ENDED', 'DISCONTINUED', 'RELEASED'].includes((row as any)?.presenceIntent))) {
      throw new Error('OFFER_REOPEN_REQUIRED: use the acknowledged reopen action')
    }
    const select = { id: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, offerActive: true } as const
    if (row) return tx.channelListing.update({ where: { id: row.id, ...where }, data: { offerActive }, select })
    return tx.channelListing.create({ data: { ...where, region: c.marketplace, channelMarket: `${c.channel}_${c.marketplace}`, listingStatus: 'DRAFT', offerActive }, select })
  }, { isolationLevel: 'Serializable' })
}

