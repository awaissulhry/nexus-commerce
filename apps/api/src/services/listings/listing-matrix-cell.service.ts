/**
 * A listing's quantity or sale, edited from the listings screens, with the Studio matrix's own rules (2026-10-01):
 *
 *   - quantity: a typed number PINS the listing at it through `pinTypedQuantity` — the one implementation of the
 *     matrix's Qty cell (FBA refused before anything is written, the value staged under CAS, the PIN primitive and its
 *     QUANTITY_UPDATE). On an Amazon EU market the quantity is ONE number for every EU market of the SKU (Amazon keeps
 *     one merchant quantity per SKU), so — as the matrix's EU inventory group does — every open EU row of the SKU on
 *     the same account is written, and the answer says which markets (`expandedTo`).
 *   - sale: the price door's sale with its window (both dates, or none), queued with the price, exactly the matrix's
 *     sale cell: eBay's and Etsy's listings have no sale (the matrix's own sentences), a family parent is not buyable,
 *     and the price permission applies.
 *
 * Why not `writeMatrixCells` itself: the matrix is a FAMILY editor, and it holds its root row as the parent, so a
 * standalone product's listing (its own root) could never be edited through it. The rules are the same; the door is
 * shared where it can be (`pinTypedQuantity`, `writeChannelPrices`).
 *
 * Before, `PATCH /api/listings/:id` refused `{ quantity }` (the grid's stock cell always failed) and wrote `salePrice`
 * as a bare column: no dates, no audit, nothing queued.
 */
import prisma from '../../db.js'
import { AMAZON_EU_SHARED_MARKETS } from '../amazon-eu-quantity-guard.js'
import { channelShape, isAmazonEuMarket, PARENT_PRICE_REASON, PARENT_REASON, PRICE_PERMISSION_REASON } from '../pim/matrix-cells.js'
import { Conflict, pinTypedQuantity, type Target } from '../pim/matrix-write.service.js'
import { writeChannelPrices, type PriceWriteTarget } from '../pim/channel-price-write.service.js'
import { ListingPricingError } from './listing-pricing-edit.service.js'

export type ListingMatrixCell =
  | { cell: 'syncQty'; value: number }
  | { cell: 'salePrice'; value: { value: number | null; start: string | null; end: string | null } }

export interface ListingMatrixCellResult {
  id: string
  version: number
  outcome: 'applied' | 'noop'
  /** Amazon EU: the markets the quantity was written on (one number for the whole EU group). */
  expandedTo?: string[]
}

const PRICE_PERMISSION = 'products.price.edit'
const conflict = (version?: number) => new ListingPricingError(409, 'Version conflict — another tab edited this listing. Refresh and retry.', version == null ? {} : { currentVersion: version })

export async function writeListingCellThroughMatrix(input: {
  listingId: string
  expectedVersion?: number
  write: ListingMatrixCell
  actor: string
  can: (permission: string) => boolean
}): Promise<ListingMatrixCellResult> {
  const listing = await prisma.channelListing.findUnique({
    where: { id: input.listingId },
    select: {
      id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, version: true,
      quantity: true, followMasterQuantity: true, salePrice: true,
      product: { select: { isParent: true } },
    },
  })
  if (!listing) throw new ListingPricingError(404, 'Listing not found')
  if (input.expectedVersion != null && input.expectedVersion !== listing.version) throw conflict(listing.version)
  const channel = listing.channel.toUpperCase()

  if (input.write.cell === 'syncQty') {
    if (listing.product?.isParent) throw new ListingPricingError(400, PARENT_REASON)
    const n = input.write.value
    // The listing as the operator saw it (the matrix's own read, here a single row).
    let targets: Target[] = [{ id: listing.id, marketplace: listing.marketplace, version: listing.version }]
    let expandedTo: string[] | undefined
    if (isAmazonEuMarket(channel, listing.marketplace) && (listing.aliasKey ?? '') === '') {
      const group = await prisma.channelListing.findMany({
        where: { productId: listing.productId, channel: 'AMAZON', marketplace: { in: [...AMAZON_EU_SHARED_MARKETS] }, aliasKey: '',
          channelConnectionId: listing.channelConnectionId, offerClosedAt: null },
        select: { id: true, marketplace: true, version: true },
      })
      targets = group.map((g) => ({ id: g.id, marketplace: g.marketplace, version: g.id === listing.id ? listing.version : g.version }))
      if (!targets.some((t) => t.id === listing.id)) targets.push({ id: listing.id, marketplace: listing.marketplace, version: listing.version })
      expandedTo = targets.map((t) => t.marketplace)
    } else if (listing.followMasterQuantity === false && listing.quantity === n) {
      return { id: listing.id, version: listing.version, outcome: 'noop' }
    }
    let pinned: Awaited<ReturnType<typeof pinTypedQuantity>>
    try {
      pinned = await pinTypedQuantity({
        productId: listing.productId, channel, targets, quantity: n, actor: input.actor,
        coordinates: targets.map((t) => ({ productId: listing.productId, channel, marketplace: t.marketplace, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey ?? '' })),
      })
    } catch (err) {
      if (err instanceof Conflict) throw conflict(err.version)
      throw err
    }
    if (pinned.refused) throw new ListingPricingError(400, pinned.refused, { code: 'QUANTITY_REFUSED' })
    const fresh = await prisma.channelListing.findUnique({ where: { id: listing.id }, select: { version: true } })
    return { id: listing.id, version: fresh?.version ?? listing.version, outcome: 'applied', ...(expandedTo ? { expandedTo } : {}) }
  }

  // The sale — the matrix's sale cell: the channel must have one, a parent is not buyable, the price permission.
  const absent = channelShape(channel).absent.find((a) => a.cell === 'salePrice')
  if (absent) throw new ListingPricingError(400, absent.reason, { code: 'SALE_ABSENT' })
  if (listing.product?.isParent) throw new ListingPricingError(400, PARENT_PRICE_REASON)
  if (!input.can(PRICE_PERMISSION)) throw new ListingPricingError(403, PRICE_PERMISSION_REASON)
  const target: PriceWriteTarget = input.expectedVersion != null
    ? { listingId: listing.id, sale: input.write.value, expectedVersion: input.expectedVersion }
    : { listingId: listing.id, sale: input.write.value, unguardedReason: 'listing-patch-unversioned' }
  const written = await writeChannelPrices({ targets: [target], actor: input.actor, source: 'MANUAL_OVERRIDE', reason: 'Listing edit' })
  const outcome = written.results[0]
  if (!outcome) throw new ListingPricingError(500, 'The price write returned no outcome for this listing.')
  if (outcome.outcome === 'conflict') throw conflict(outcome.version)
  if (outcome.outcome === 'refused') throw new ListingPricingError(400, outcome.reason ?? 'The price write refused this sale.', { code: 'PRICE_REFUSED' })
  return { id: listing.id, version: outcome.version, outcome: outcome.outcome === 'applied' ? 'applied' : 'noop' }
}
