/**
 * PLAN A-39 slice b2 (R-41, R-43) — "ours" for ONE eBay ItemID: the title and item-level item specifics the studio
 * builder WOULD SEND, taken from the builder itself (`buildEbayListingInput`, extracted from `prepareEbayPublication`),
 * never from a second copy of its rules.
 *
 * The unit is the ItemID's OWNER listing — its one parentless `ChannelListing` (the eBay quantity read-back's mapping,
 * `298364359`). Title and item specifics are item-level, so they belong to the owner, not to a variant's listing.
 *
 * What the builder would NOT send is reported as not compared, with the reason — never as clean:
 *   · a SHELL owner (`EBAY_LISTING_SHELL`): Nexus never writes a live shell's title or item specifics (R-43);
 *   · any refusal of the builder itself (several ItemIDs in the family, an ItemID used outside the selection, a missing
 *     category, an FBA listing, a transport-only field, a missing axis value …) — its sentence is the reason;
 *   · a destination the studio cannot resolve (no account, no market) — its sentence is the reason.
 * Schemas are read from the cache only (`withCachedSchemas`): a read job never starts provider work.
 */
import prisma from '../../db.js'
import { withCachedSchemas } from '../pim/cached-schema-context.js'
import { readPublicationFacts } from '../pim/studio-publication-plan.js'
import { buildEbayListingInput } from '../pim/studio-publication-ebay.js'
import { EBAY_SHELL_REASON, type EbayOursContent } from './ebay-content-compare.js'

export interface EbayOurs extends EbayOursContent { listingId: string; itemId: string; accountId: string; market: string }
export type EbayOursResult = { ok: true; ours: EbayOurs } | { ok: false; reason: string }

export async function ebayContentOurs(listingId: string): Promise<EbayOursResult> {
  const listing = await prisma.channelListing.findUnique({ where: { id: listingId },
    select: { id: true, productId: true, marketplace: true, channelConnectionId: true, externalListingId: true,
      product: { select: { productType: true, parentId: true, deletedAt: true } } } })
  if (!listing || listing.product?.deletedAt) return { ok: false, reason: 'the listing or its product no longer exists' }
  if (listing.product?.productType === 'EBAY_LISTING_SHELL') return { ok: false, reason: EBAY_SHELL_REASON }
  if (listing.product?.parentId) return { ok: false, reason: 'not the ItemID\'s owner listing (a variant\'s listing)' }
  if (!listing.externalListingId || !listing.channelConnectionId) return { ok: false, reason: 'the listing has no eBay ItemID or no account' }
  try {
    return await withCachedSchemas(async () => {
      const facts = await readPublicationFacts(listing.productId, { channel: 'EBAY', marketplace: listing.marketplace,
        accountId: listing.channelConnectionId!, listingId: listing.id })
      const built = await buildEbayListingInput(facts, { currency: facts.destination.currency ?? undefined })
      if (built.itemId !== listing.externalListingId) {
        return { ok: false as const, reason: `the builder targets ItemID ${built.itemId ?? 'none'}, not ${listing.externalListingId}` }
      }
      return { ok: true as const, ours: { listingId: listing.id, itemId: listing.externalListingId!, accountId: listing.channelConnectionId!,
        market: listing.marketplace, title: built.shared.title, itemSpecifics: built.shared.itemSpecifics ?? {} } }
    })
  } catch (error) {
    return { ok: false, reason: `the eBay builder refused: ${error instanceof Error ? error.message : String(error)}` }
  }
}
