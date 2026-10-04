/**
 * Amazon sheet gaps (design-sync §1.A) — the bulk PATCH's QUANTITY door. A listing quantity typed, pasted, imported or
 * written by a formula on the product sheet goes through the Matrix's own Mode / Qty writes (`writeQuantityMode`,
 * `pinTypedQuantity`): FBA refused before anything is staged, a SKU selling from another business's stock refused with
 * its sentence, CAS on the listing version, the FOLLOW / PIN primitive with its QUANTITY_UPDATE, and on an Amazon EU
 * market every open EU row of the SKU (`loadSharedInventoryTargets`).
 *
 * Before, eBay's and Etsy's quantity saved through the generic channel writer — `quantity` + `followMasterQuantity =
 * false` only: no buffer, no shared-stock refusal, nothing queued, a number the Matrix never showed (a second write path
 * to the same fact). A number pins the listing at it; an empty cell or a reset makes it follow the stock again.
 */
import prisma from '../../db.js'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { channelLabel } from '@nexus/shared/channel-label'
import { ProductBulkError } from '../../lib/product-bulk-error.js'
import type { ListingCoordinate } from '../../lib/listing-coordinate.js'
import type { ChannelStore } from './channel-specs/types.js'
import { CHANNEL_FIELD_MAP } from './channel-field-map.js'
import { PARENT_REASON } from './matrix-cells.js'
import { Conflict, pinTypedQuantity, writeQuantityMode } from './matrix-write.service.js'
import { loadSharedInventoryTargets } from './shared-inventory-targets.js'
import { AMAZON_QUANTITY_KEY } from './studio-stock.js'

export interface SheetQuantityChange {
  /** The product id (the bulk PATCH's `changes[].id`). */
  id: string
  field: string
  value: unknown
  reset?: boolean
  target?: string
}

export interface SheetQuantityContext {
  /** The request's coordinates (`effectiveContexts`). */
  contexts: ReadonlyArray<{ channel: string; marketplace: string; aliasKey?: string }>
  /** The account each channel's listings are on (`connFor`). */
  accountFor: (channel: string) => string | null
  /** The channel store the change's column declares (`storeFor`), when the caller knows it. */
  storeOf?: (change: SheetQuantityChange) => ChannelStore | null | undefined
  /** The listing version the caller saw (the request's token); absent = the version read here. */
  expectedVersion?: number
  /** For the 409 body: the token as the caller sent it. */
  originalExpectedVersion?: number
  /** Listing id → the version a door already moved it to in this request (`priceWrittenIds`); updated here. */
  moved: Map<string, number>
  actor: string
}

export interface SheetQuantityOutcome {
  change: SheetQuantityChange
  listingId: string
  productId: string
  outcome: 'applied' | 'noop'
  /** The listing's version after the write. */
  version: number
  /** Amazon EU: the markets the quantity landed on. */
  expandedTo?: string[]
}

const upper = (s: string | null | undefined) => String(s ?? '').toUpperCase()

/** Is this bulk change a listing quantity on this channel? (eBay `ebay_quantity`; a channel field stored in the listing's `quantity` column; Amazon's quantity leaf.) */
export function isSheetQuantityChange(change: Pick<SheetQuantityChange, 'field' | 'target'>, channel: string, store?: ChannelStore | null): boolean {
  const ch = upper(channel)
  // A prefixed field routes on its NAME (`ebay_quantity`), whatever the target.
  if (CHANNEL_FIELD_MAP[change.field] === 'quantity') return change.field.startsWith(`${ch.toLowerCase()}_`)
  if (!change.field.startsWith('attr_') || change.target !== 'channel') return false
  const key = change.field.slice('attr_'.length)
  if (ch === 'AMAZON') return key === AMAZON_QUANTITY_KEY
  if (store) return store.kind === 'listingColumn' && store.column === 'quantity'
  return key === 'quantity' && (ch === 'EBAY' || ch === 'ETSY' || ch === 'WOOCOMMERCE')
}

const conflict = (ctx: SheetQuantityContext, current: number, listingId: string) => new ProductBulkError(409, {
  code: 'VERSION_CONFLICT', error: MATRIX_COPY.changedElsewhere, expectedVersion: ctx.originalExpectedVersion ?? ctx.expectedVersion,
  currentVersion: current, listingId, versionOf: 'channelListing',
})
const refused = (error: string) => new ProductBulkError(400, { error, code: 'QUANTITY_REFUSED' })

/** The pinned quantity a cell asks for, or `'follow'` (empty / reset). */
function quantityOf(change: SheetQuantityChange): number | 'follow' {
  if (change.reset || change.value === null || change.value === undefined || (typeof change.value === 'string' && change.value.trim() === '')) return 'follow'
  const n = typeof change.value === 'number' ? change.value : Number(String(change.value).trim())
  if (!Number.isInteger(n) || n < 0) throw refused('A pinned quantity is a whole number, zero or more')
  return n
}

/**
 * Apply every quantity change through the Matrix's Mode / Qty writes. Runs inside the caller's transaction (the door's
 * CAS joins it), so a refusal (400, the door's sentence) or a lost CAS (409 `VERSION_CONFLICT`) rolls the whole save back.
 */
export async function applySheetQuantityChanges(changes: readonly SheetQuantityChange[], ctx: SheetQuantityContext): Promise<SheetQuantityOutcome[]> {
  const destinations = changes.flatMap((change) => ctx.contexts
    .filter((c) => isSheetQuantityChange(change, c.channel, ctx.storeOf?.(change)))
    .map((c) => ({ change, channel: upper(c.channel), marketplace: c.marketplace, aliasKey: c.aliasKey ?? '', channelConnectionId: ctx.accountFor(upper(c.channel)) })))
  if (!destinations.length) return []
  const listings = await prisma.channelListing.findMany({
    where: { OR: destinations.map((d) => ({ productId: d.change.id, channel: d.channel, marketplace: d.marketplace, channelConnectionId: d.channelConnectionId, aliasKey: d.aliasKey })) },
    select: { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, version: true,
      quantity: true, followMasterQuantity: true, offerClosedAt: true, product: { select: { isParent: true } } },
  })

  const out: SheetQuantityOutcome[] = []
  for (const d of destinations) {
    const listing = listings.find((l) => l.productId === d.change.id && upper(l.channel) === d.channel && l.marketplace === d.marketplace
      && l.channelConnectionId === d.channelConnectionId && l.aliasKey === d.aliasKey)
    // Only a non-primary alias can get here (the bulk save's draft step starts every missing primary listing).
    if (!listing) throw new ProductBulkError(400, { error: `This listing alias has no ${channelLabel(d.channel)} listing on ${d.marketplace} for this product. An edit never creates an alias listing, so its quantity cannot be set here.` })
    // The Matrix's holds, with its words: the parent has no offer, a closed offer is reopened only in Sync Control.
    if (listing.product?.isParent) throw refused(PARENT_REASON)
    if (listing.offerClosedAt) throw refused(MATRIX_COPY.closedHint)
    const asked = quantityOf(d.change)
    const version = ctx.moved.get(listing.id) ?? ctx.expectedVersion ?? listing.version
    if (version !== listing.version) throw conflict(ctx, listing.version, listing.id)

    const resolved = await loadSharedInventoryTargets(prisma, { ...listing, channel: d.channel, version })
    if ('conflict' in resolved) throw conflict(ctx, resolved.conflict, listing.id)
    const { targets, expandedTo } = resolved
    // Already so on every target (the whole Amazon EU group too) is a no-op: no write, no version spent.
    const rows = targets.length === 1 && targets[0]!.id === listing.id ? [listing]
      : await prisma.channelListing.findMany({ where: { id: { in: targets.map((t) => t.id) } }, select: { id: true, quantity: true, followMasterQuantity: true } })
    const already = asked === 'follow' ? rows.every((r) => r.followMasterQuantity !== false)
      : rows.every((r) => r.followMasterQuantity === false && r.quantity === asked)
    if (already) { out.push({ change: d.change, listingId: listing.id, productId: listing.productId, outcome: 'noop', version, ...(expandedTo ? { expandedTo } : {}) }); continue }

    // Exactly these listings (never another account's or an alias's on the same market).
    const coordinates: ListingCoordinate[] = targets.map((t) => ({ productId: listing.productId, channel: d.channel, marketplace: t.marketplace, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey ?? '' }))
    let written: Awaited<ReturnType<typeof writeQuantityMode>>
    try {
      written = asked === 'follow'
        ? await writeQuantityMode({ productId: listing.productId, channel: d.channel, targets, follow: true, actor: ctx.actor, coordinates })
        : await pinTypedQuantity({ productId: listing.productId, channel: d.channel, targets, quantity: asked, actor: ctx.actor, coordinates })
    } catch (err) {
      if (err instanceof Conflict) throw conflict(ctx, err.version, listing.id)
      throw err
    }
    if (written.refused) throw refused(written.refused)
    for (const t of targets) ctx.moved.set(t.id, t.version + 1)
    out.push({ change: d.change, listingId: listing.id, productId: listing.productId, outcome: 'applied', version: version + 1, ...(expandedTo ? { expandedTo } : {}) })
  }
  return out
}
