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
import { Conflict, pinTypedQuantity, writeQuantityMode, type Target } from '../pim/matrix-write.service.js'
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

type QuantityListing = { id: string; productId: string; channel: string; marketplace: string; channelConnectionId: string | null; aliasKey: string | null; version: number; followMasterQuantity: boolean | null }

/**
 * The rows a quantity change on this listing lands on, as the matrix's EU inventory group: the listing itself, or — on
 * an Amazon EU market — every open EU row of the SKU on the same account (Amazon keeps ONE merchant quantity per SKU
 * across the EU markets), `expandedTo` naming those markets. The listing keeps the version the caller saw.
 */
async function quantityTargetsOf(listing: QuantityListing): Promise<{ targets: Target[]; expandedTo?: string[]; following: boolean[] }> {
  const own: Target = { id: listing.id, marketplace: listing.marketplace, version: listing.version }
  const ownFollows = listing.followMasterQuantity !== false
  if (!isAmazonEuMarket(listing.channel.toUpperCase(), listing.marketplace) || (listing.aliasKey ?? '') !== '') return { targets: [own], following: [ownFollows] }
  const group = await prisma.channelListing.findMany({
    where: { productId: listing.productId, channel: 'AMAZON', marketplace: { in: [...AMAZON_EU_SHARED_MARKETS] }, aliasKey: '',
      channelConnectionId: listing.channelConnectionId, offerClosedAt: null },
    select: { id: true, marketplace: true, version: true, followMasterQuantity: true },
  })
  const targets = group.map((g) => (g.id === listing.id ? own : { id: g.id, marketplace: g.marketplace, version: g.version }))
  const following = group.map((g) => (g.id === listing.id ? ownFollows : g.followMasterQuantity !== false))
  if (!targets.some((t) => t.id === listing.id)) { targets.push(own); following.push(ownFollows) }
  return { targets, expandedTo: targets.map((t) => t.marketplace), following }
}
const coordinatesOf = (listing: QuantityListing, targets: readonly Target[]) =>
  targets.map((t) => ({ productId: listing.productId, channel: listing.channel.toUpperCase(), marketplace: t.marketplace, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey ?? '' }))

/**
 * A listing's quantity FOLLOWS the stock again, or is PINNED at the number it shows now — the matrix's Mode cell
 * (`writeQuantityMode`), for the listing drawer's toggle, the bulk bar's follow / unfollow master and the reset to
 * master (2026-10-01). Before, those wrote `followMasterQuantity` alone: nothing recomputed or sent the quantity.
 * An Amazon-managed (FBA) listing: `onFba: 'refuse'` (an explicit quantity change) throws the matrix's sentence;
 * `'skip'` (a change of every field at once) leaves the quantity to Amazon and says so in `skipped`. The same for a
 * PIN on a SKU that sells from another business's stock (shared stock by SKU, #230): refused, or skipped and named,
 * with the matrix's `sharedStockReason` — its quantity follows the lender's stock.
 */
export async function setListingQuantityFollow(input: {
  listingId: string
  follow: boolean
  actor: string
  onFba: 'refuse' | 'skip'
  /** The version the operator saw, when this change is the whole request. */
  expectedVersion?: number
}): Promise<{ outcome: 'applied' | 'noop' | 'skipped'; expandedTo?: string[]; skipped?: string }> {
  const listing = await prisma.channelListing.findUnique({
    where: { id: input.listingId },
    select: { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, version: true, followMasterQuantity: true, product: { select: { isParent: true } } },
  })
  if (!listing) throw new ListingPricingError(404, 'Listing not found')
  if (input.expectedVersion != null && input.expectedVersion !== listing.version) throw conflict(listing.version)
  if (listing.product?.isParent) {
    if (input.onFba === 'skip') return { outcome: 'skipped', skipped: PARENT_REASON }
    throw new ListingPricingError(400, PARENT_REASON)
  }
  const { targets, expandedTo, following } = await quantityTargetsOf(listing)
  // Already so — on every market of an Amazon EU group too — is a no-op, as the matrix's Mode cell answers: no write,
  // no version spent (a version bump would cost the other markets' open editors a needless conflict).
  if (following.every((f) => f === input.follow)) return { outcome: 'noop' }
  let moded: Awaited<ReturnType<typeof writeQuantityMode>>
  try {
    moded = await writeQuantityMode({ productId: listing.productId, channel: listing.channel.toUpperCase(), targets, follow: input.follow, actor: input.actor, coordinates: coordinatesOf(listing, targets) })
  } catch (err) {
    if (err instanceof Conflict) throw conflict(err.version)
    throw err
  }
  if (moded.refused) {
    if (input.onFba === 'skip' && !moded.staged) return { outcome: 'skipped', skipped: moded.refused }
    throw new ListingPricingError(400, moded.refused, { code: 'QUANTITY_REFUSED' })
  }
  return { outcome: 'applied', ...(expandedTo ? { expandedTo } : {}) }
}

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
    const { targets, expandedTo } = await quantityTargetsOf(listing)
    if (!expandedTo && listing.followMasterQuantity === false && listing.quantity === n) {
      return { id: listing.id, version: listing.version, outcome: 'noop' }
    }
    let pinned: Awaited<ReturnType<typeof pinTypedQuantity>>
    try {
      pinned = await pinTypedQuantity({ productId: listing.productId, channel, targets, quantity: n, actor: input.actor, coordinates: coordinatesOf(listing, targets) })
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

/** A listing's current version (the routes hold no database call). */
export async function listingVersionOf(listingId: string): Promise<number | null> {
  return (await prisma.channelListing.findUnique({ where: { id: listingId }, select: { version: true } }))?.version ?? null
}
