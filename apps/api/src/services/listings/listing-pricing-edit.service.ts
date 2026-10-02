/**
 * A listing's pricing edits from the listings screens — the drawer's PATCH, the bulk bar, the grid's price cell and
 * the product page's "reset to master" — each sent through the ONE channel price door (`writeChannelPrices`).
 *
 * Before (2026-10-01): `PATCH /api/listings/:id` and `POST /api/listings/bulk-action` wrote `pricingRule`,
 * `priceAdjustmentPercent`, `followMasterPrice` and `priceOverride` as plain columns. Nothing recomputed the price and
 * nothing was queued, so a listing set to "master +10%" kept its old price on the channel until something unrelated
 * pushed it; the bulk "Set price" stored a price with no PRICE_UPDATE row; the grid's price cell sent `{ price }`,
 * which the PATCH did not accept, so it always failed; and the PATCH's version check read the row and then wrote it
 * without the version in the `where`.
 *
 * Now a rule, a percent or a follow change is the door's follower mode (the price recomputed by the cascade's rules
 * and sent, or refused by name), a typed price is the door's pin, and the other columns land in the same transaction
 * under the same version.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { activeDatabaseTransaction, inDatabaseTransaction } from '../../lib/database-context.js'
import { adjustmentPercentProblem, normalisePricingRule, PRICING_RULE_REFUSAL } from '@nexus/shared/listing-price'
import { writeChannelPrices, type PriceWriteOutcome, type PriceWriteTarget, type PriceWriteUnguardedReason } from '../pim/channel-price-write.service.js'
import { PRICE_EDIT_PERMISSION, PRICE_EDIT_REFUSAL } from '../master-price.service.js'

/** A refusal with the HTTP status the route answers it with. */
export class ListingPricingError extends Error {
  constructor(readonly statusCode: number, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ListingPricingError'
  }
}

/** The pricing half of a listing edit. Every key optional; at least one present when it is used. */
export interface ListingPricingEdit {
  pricingRule?: string
  priceAdjustmentPercent?: number
  /** `true` hands the listing back to the master; `false` stops following and keeps its price. */
  followMasterPrice?: boolean
  /** A number pins the listing at it; `null` hands it back to the master. */
  priceOverride?: number | null
}

const has = (body: object, key: string) => Object.prototype.hasOwnProperty.call(body, key)

/** A typed price (a pin) that is not above 0: the listing PATCH, the grid's price cell and the bulk "Set price". */
export const PRICE_ABOVE_ZERO = 'The price must be above 0.'
/** A follow flag and a pin (or a stop-following and a hand-back) in one change. */
export const FOLLOW_OR_OWN_PRICE = 'A listing cannot follow the master price and keep its own price at the same time. Choose one.'

/**
 * Read the pricing keys of a request body into an edit, or throw the 400 sentence. `undefined` when the body carries
 * none of them. The percent and the rule are checked by the same functions the door checks with. Every sentence is the
 * operator's: short, no field names (the listings screens show it as it comes).
 */
export function parseListingPricingEdit(body: Record<string, unknown>): ListingPricingEdit | undefined {
  const edit: ListingPricingEdit = {}
  if (has(body, 'pricingRule') && body.pricingRule !== undefined && body.pricingRule !== null && body.pricingRule !== '') {
    const rule = normalisePricingRule(body.pricingRule)
    if (!rule) throw new ListingPricingError(400, PRICING_RULE_REFUSAL)
    edit.pricingRule = rule
  }
  if (has(body, 'priceAdjustmentPercent') && body.priceAdjustmentPercent !== undefined && body.priceAdjustmentPercent !== null) {
    const problem = adjustmentPercentProblem(body.priceAdjustmentPercent)
    if (problem) throw new ListingPricingError(400, problem)
    edit.priceAdjustmentPercent = Number(body.priceAdjustmentPercent)
  }
  if (typeof body.followMasterPrice === 'boolean') edit.followMasterPrice = body.followMasterPrice
  if (has(body, 'priceOverride')) {
    const raw = body.priceOverride
    if (raw === null) edit.priceOverride = null
    else if (raw !== undefined) {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
      // A typed price is above 0 (the price door refuses 0 too); null hands the listing back to the master.
      if (!Number.isFinite(n) || n <= 0) throw new ListingPricingError(400, PRICE_ABOVE_ZERO)
      edit.priceOverride = n
    }
  }
  if ((edit.followMasterPrice === true && typeof edit.priceOverride === 'number') || (edit.followMasterPrice === false && edit.priceOverride === null)) {
    throw new ListingPricingError(400, FOLLOW_OR_OWN_PRICE)
  }
  return Object.keys(edit).length ? edit : undefined
}

/** The door target for an edit: a typed price pins; `priceOverride: null` or a follow flag is the follower mode. */
export function pricingTarget(
  listingId: string,
  edit: ListingPricingEdit,
  guard: { expectedVersion: number } | { unguardedReason: PriceWriteUnguardedReason },
): PriceWriteTarget {
  const rule = edit.pricingRule !== undefined || edit.priceAdjustmentPercent !== undefined
    ? { rule: { ...(edit.pricingRule !== undefined ? { pricingRule: edit.pricingRule } : {}), ...(edit.priceAdjustmentPercent !== undefined ? { priceAdjustmentPercent: edit.priceAdjustmentPercent } : {}) } }
    : {}
  const price = edit.priceOverride !== undefined ? { price: edit.priceOverride } : {}
  // A pin already says "stops following"; a follow flag beside it would only repeat it.
  const follow = edit.followMasterPrice !== undefined && typeof edit.priceOverride !== 'number' ? { follow: edit.followMasterPrice } : {}
  return { listingId, ...rule, ...price, ...follow, ...guard } as PriceWriteTarget
}

/** A door outcome that did not apply, as the refusal the caller answers with. */
function refusalOf(outcome: PriceWriteOutcome | undefined): ListingPricingError | null {
  if (!outcome) return new ListingPricingError(500, 'The price write returned no outcome for this listing.')
  if (outcome.outcome === 'conflict') return new ListingPricingError(409, 'Version conflict — another tab edited this listing. Refresh and retry.', { currentVersion: outcome.version })
  if (outcome.outcome === 'refused') return new ListingPricingError(outcome.reason === 'No listing with this id' ? 404 : 400, outcome.reason ?? 'The price was not changed.', { code: 'PRICE_REFUSED' })
  return null
}

export interface ListingPatchResult {
  id: string
  version: number
  /** The door's sentence when the change was saved but no price was sent (another currency, paused, MATCH_AMAZON…). */
  notSent?: string
  /** The PRICE_UPDATE row queued by this edit, if any. */
  queueId: string | null
}

/**
 * `PATCH /api/listings/:id` — the pricing keys through the door, every other column in the same transaction and under
 * the same version (`updateMany … where version`), so a stale tab can overwrite nothing. Without `expectedVersion`
 * (the reset buttons that send none) the door names why it has none.
 */
export async function patchListing(input: {
  id: string
  actor: string
  expectedVersion?: number
  pricing?: ListingPricingEdit
  /** The other columns, already validated by the route. */
  columns: Prisma.ChannelListingUpdateManyMutationInput
  /** Keys shallow-merged into `platformAttributes`. */
  mergePlatformAttributes?: Record<string, unknown> | null
  /** S1 (F5) — the acting person's permissions: a pricing edit needs `products.price.edit`. */
  can?: (permission: string) => boolean
}): Promise<ListingPatchResult> {
  // S1 (F5) — refused before anything is read or written, the other columns of the edit included.
  if (input.pricing && input.can) assertPriceEditAllowed(input.can)
  return inDatabaseTransaction(prisma, async () => {
    const db = activeDatabaseTransaction() ?? prisma
    const current = await db.channelListing.findUnique({ where: { id: input.id }, select: { id: true, version: true, platformAttributes: true } })
    if (!current) throw new ListingPricingError(404, 'Listing not found')
    if (input.expectedVersion != null && input.expectedVersion !== current.version) {
      throw new ListingPricingError(409, 'Version conflict — another tab edited this listing. Refresh and retry.', { currentVersion: current.version })
    }
    let version = current.version
    let notSent: string | undefined
    let queueId: string | null = null
    if (input.pricing) {
      const guard = input.expectedVersion != null ? { expectedVersion: input.expectedVersion } : { unguardedReason: 'listing-patch-unversioned' as const }
      const written = await writeChannelPrices({ targets: [pricingTarget(input.id, input.pricing, guard)], actor: input.actor, source: 'MANUAL_OVERRIDE', reason: 'Listing edit' })
      const outcome = written.results[0]
      const refusal = refusalOf(outcome)
      if (refusal) throw refusal
      version = outcome.version
      notSent = outcome.notSent
      queueId = outcome.queueId
    }
    const data: Prisma.ChannelListingUpdateManyMutationInput = { ...input.columns }
    if (input.mergePlatformAttributes) {
      const existing = current.platformAttributes && typeof current.platformAttributes === 'object' && !Array.isArray(current.platformAttributes)
        ? current.platformAttributes as Record<string, unknown> : {}
      data.platformAttributes = { ...existing, ...input.mergePlatformAttributes } as Prisma.InputJsonValue
    }
    if (Object.keys(data).length) {
      // The version the door left (or the one the caller saw): a write in the gap fails this, never overwrites it.
      const updated = await db.channelListing.updateMany({ where: { id: input.id, version }, data: { ...data, version: { increment: 1 } } })
      if (updated.count !== 1) throw new ListingPricingError(409, 'Version conflict — another tab edited this listing. Refresh and retry.')
      version += 1
    }
    return { id: input.id, version, queueId, ...(notSent ? { notSent } : {}) }
  })
}

/** S1 (F5) — a person changing a listing's price (a pin, a rule, a percent, a follow flag) needs `products.price.edit`. */
export function assertPriceEditAllowed(can: (permission: string) => boolean): void {
  if (!can(PRICE_EDIT_PERMISSION)) throw new ListingPricingError(403, PRICE_EDIT_REFUSAL, { code: 'PRICE_PERMISSION' })
}

/** The listings bulk bar's pricing actions, one listing at a time. */
export type ListingBulkPricingAction = 'set-price' | 'set-pricing-rule' | 'follow-master' | 'unfollow-master'

// The quantity's flag is not among them: it goes through the matrix's Mode write (`setListingQuantityFollow`).
const FOLLOW_FLAGS = ['followMasterTitle', 'followMasterDescription', 'followMasterImages', 'followMasterBulletPoints'] as const

/**
 * `POST /api/listings/bulk-action` for one listing. A selection carries no version per row, so the door is told why
 * (`listings-bulk-action`). A refusal throws its sentence (the job records it against the listing) and writes nothing.
 * Follow / unfollow master move every follow flag: the price through the door, the others in the same transaction.
 */
export async function applyListingBulkPricing(input: {
  action: ListingBulkPricingAction
  listingId: string
  actor: string
  payload?: { price?: unknown; pricingRule?: unknown; priceAdjustmentPercent?: unknown }
}): Promise<{ outcome: PriceWriteOutcome['outcome']; notSent?: string; quantitySkipped?: string }> {
  const { action, listingId } = input
  const edit: ListingPricingEdit =
    action === 'set-price' ? { priceOverride: Number(input.payload?.price) }
      : action === 'set-pricing-rule' ? {
          pricingRule: normalisePricingRule(input.payload?.pricingRule) ?? String(input.payload?.pricingRule ?? ''),
          // The percent rides along only with the percent rule, as before.
          ...(normalisePricingRule(input.payload?.pricingRule) === 'PERCENT_OF_MASTER' && input.payload?.priceAdjustmentPercent != null && input.payload.priceAdjustmentPercent !== ''
            ? { priceAdjustmentPercent: Number(input.payload.priceAdjustmentPercent) } : {}),
        }
        : { followMasterPrice: action === 'follow-master' }
  return inDatabaseTransaction(prisma, async () => {
    const written = await writeChannelPrices({
      targets: [pricingTarget(listingId, edit, { unguardedReason: 'listings-bulk-action' })],
      actor: input.actor, source: 'BULK_OVERRIDE', reason: `Listings bulk ${action}`,
    })
    const outcome = written.results[0]
    const refusal = refusalOf(outcome)
    if (refusal) throw refusal
    let quantitySkipped: string | undefined
    if (action === 'follow-master' || action === 'unfollow-master') {
      const follows = action === 'follow-master'
      const db = activeDatabaseTransaction() ?? prisma
      await db.channelListing.update({ where: { id: listingId }, data: { ...Object.fromEntries(FOLLOW_FLAGS.map(flag => [flag, follows])), version: { increment: 1 } } })
      // The quantity: recomputed (follow) or pinned at what it shows (unfollow) and sent, as the matrix's Mode cell; an
      // Amazon-managed (FBA) listing's quantity is Amazon's, so it is left alone and said.
      const { setListingQuantityFollow } = await import('./listing-matrix-cell.service.js')
      quantitySkipped = (await setListingQuantityFollow({ listingId, follow: follows, actor: input.actor, onFba: 'skip' })).skipped
    }
    return { outcome: outcome.outcome, ...(outcome.notSent ? { notSent: outcome.notSent } : {}), ...(quantitySkipped ? { quantitySkipped } : {}) }
  })
}

/** The fields `POST /products/:id/channel-listing/:clId/reset` hands back to the master. */
export type ResettableField = 'title' | 'description' | 'price' | 'quantity' | 'bulletPoints'

/**
 * `POST /api/products/:id/channel-listing/:clId/reset` — one field, or all, back to the master. The price goes through
 * the door's follower mode (recomputed by its rule and sent, or refused by name with nothing written); the other
 * fields' flags and overrides are written in the same transaction.
 */
export async function resetListingToMaster(input: {
  productId: string
  listingId: string
  fields: ResettableField[]
  actor: string
  /** S1 (F5) — handing the price back to the master changes it: `products.price.edit`. */
  can?: (permission: string) => boolean
}): Promise<{ notSent?: string; quantityFollowTurnedOn: boolean; quantitySkipped?: string }> {
  if (input.fields.includes('price') && input.can) assertPriceEditAllowed(input.can)
  return inDatabaseTransaction(prisma, async () => {
    const db = activeDatabaseTransaction() ?? prisma
    const listing = await db.channelListing.findUnique({ where: { id: input.listingId }, select: { productId: true, followMasterQuantity: true } })
    if (!listing || listing.productId !== input.productId) throw new ListingPricingError(404, 'Channel listing not found for product')
    let notSent: string | undefined
    if (input.fields.includes('price')) {
      const written = await writeChannelPrices({
        targets: [{ listingId: input.listingId, follow: true, unguardedReason: 'channel-listing-reset' }],
        actor: input.actor, source: 'MANUAL_OVERRIDE', reason: 'Reset to master',
      })
      const refusal = refusalOf(written.results[0])
      if (refusal) throw refusal
      notSent = written.results[0].notSent
    }
    const data: Record<string, unknown> = {}
    for (const field of input.fields) {
      if (field === 'title') Object.assign(data, { followMasterTitle: true, titleOverride: null })
      if (field === 'description') Object.assign(data, { followMasterDescription: true, descriptionOverride: null })
      if (field === 'bulletPoints') Object.assign(data, { followMasterBulletPoints: true, bulletPointsOverride: [] })
    }
    if (Object.keys(data).length) await db.channelListing.update({ where: { id: input.listingId }, data })
    // The quantity follows the stock again through the matrix's Mode write: recomputed and sent. Reset alone, an
    // Amazon-managed (FBA) listing is refused by the matrix's sentence; in "all" its quantity is left to Amazon.
    let quantitySkipped: string | undefined
    if (input.fields.includes('quantity')) {
      const { setListingQuantityFollow } = await import('./listing-matrix-cell.service.js')
      quantitySkipped = (await setListingQuantityFollow({ listingId: input.listingId, follow: true, actor: input.actor, onFba: input.fields.length === 1 ? 'refuse' : 'skip' })).skipped
    }
    return { quantityFollowTurnedOn: input.fields.includes('quantity') && listing.followMasterQuantity === false && !quantitySkipped, ...(notSent ? { notSent } : {}), ...(quantitySkipped ? { quantitySkipped } : {}) }
  })
}
