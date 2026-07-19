/**
 * FFT.3a — the listing-content write choke point.
 *
 * The flat-file grids read back `ChannelListing.flatFileSnapshot` (the saved
 * grid ROW, verbatim); ~20 writers mutate listing content WITHOUT rewriting
 * it, so their edits are invisible in the grids ("not consistent with the
 * platforms"). This service is the one door: CL content write + partial
 * snapshot patch + product event, with the CAS semantics of the Amazon save
 * preserved (`casUpdateChannelListing`).
 *
 * Snapshot-patch rules (deliberate, safety-first):
 *  - PATCH ONLY — spread-merge over an EXISTING non-empty snapshot (precedent:
 *    ebay-flat-file.routes.ts _plannedChildren merge). A listing with no
 *    snapshot is served by the legacy expand-from-attributes read path, which
 *    already shows CL columns; creating a partial snapshot would make the read
 *    return ONLY those keys (snapshot is verbatim) and vaporize every other
 *    column. Never create here.
 *  - LIVE-overlay keys are refused loudly (programmer error): they are
 *    stripped/overridden on read, and freezing them into the snapshot is the
 *    exact trap class this program kills.
 *  - Only STABLE structured content keys belong here (title/description/
 *    bullets/theme families). Attribute-derived expanded keys are manifest-
 *    dependent and stay owned by the full-row grid saves.
 */

import { casUpdateChannelListing } from '../channel-listing-cas.js'
import { productEventService } from '../product-event.service.js'

/** Keys that must never be frozen into a snapshot (read strips/overrides them). */
const REFUSED_SNAPSHOT_KEYS: RegExp[] = [
  /^_/,
  /^item_sku$/, /^sku$/,
  /^follow$/, /^buffer$/,
  /^external_product_id(_type)?$/,
  /^ebay_item_id$/, /^listing_status$/, /^sync_status$/, /^last_pushed_at$/,
  /^platformProductId$/, /^parent_sku$/, /^parentage(_level)?$/,
  /^(it|de|fr|es|uk|gb)_(item_id|status|listing_id|qty|price|follow|buffer)$/,
  /^purchasable_offer__(our_price|sale_price)$/,
  /^fulfillment_availability__quantity$/,
]

export function assertPatchableSnapshotKeys(keys: Record<string, unknown>): void {
  for (const k of Object.keys(keys)) {
    if (REFUSED_SNAPSHOT_KEYS.some((re) => re.test(k))) {
      throw new Error(`listing-content-write: snapshot key '${k}' is LIVE/system-owned and must not be written into flatFileSnapshot`)
    }
  }
}

/** eBay ChannelListings are keyed by REGION (UK→GB); Amazon by marketplace. */
export function resolveListingRegion(channel: string, marketplace: string): string {
  const mp = marketplace.toUpperCase()
  return channel === 'EBAY' && mp === 'UK' ? 'GB' : mp
}

/**
 * Merge a partial snapshot patch over an existing snapshot. Returns undefined
 * when there is nothing to write (no existing snapshot, or no keys).
 */
export function mergeSnapshotPatch(
  existing: unknown,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!patch || Object.keys(patch).length === 0) return undefined
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return undefined
  if (Object.keys(existing as Record<string, unknown>).length === 0) return undefined
  assertPatchableSnapshotKeys(patch)
  return { ...(existing as Record<string, unknown>), ...patch }
}

interface PrismaLikeCl {
  channelListing: {
    findFirst: (args: unknown) => Promise<any>
    findUnique: (args: unknown) => Promise<any>
    update: (args: unknown) => Promise<any>
    create: (args: unknown) => Promise<any>
  }
}

export interface WriteListingContentInput {
  listingId?: string
  target?: { productId: string; channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'; marketplace: string }
  /** ChannelListing columns to write (title, description, price, platformAttributes …). */
  fields: Record<string, unknown>
  /** Grid ROW keys to patch into an existing snapshot (channel-correct spelling). */
  snapshotKeys?: Record<string, unknown>
  /** Thread the grid's optimistic-concurrency version when the caller has one. */
  expectedVersion?: number | null
  /** Create the listing when missing (unified-grid upsert semantics). Snapshot is NEVER created. */
  createIfMissing?: Record<string, unknown>
  event?: {
    productId: string
    eventType: 'TITLE_UPDATED' | 'DESCRIPTION_UPDATED' | 'BULLETS_UPDATED' | 'PRICE_CHANGED' | 'CHANNEL_LISTING_UPDATED' | 'PRODUCT_UPDATED' | 'FLAT_FILE_IMPORTED'
    source: 'OPERATOR' | 'API' | 'AUTOMATION' | 'FLAT_FILE_IMPORT' | 'SYSTEM'
    data?: Record<string, unknown>
  }
}

export async function writeListingContent(
  db: PrismaLikeCl,
  input: WriteListingContentInput,
): Promise<{ listingId: string | null; version: number | null; created: boolean }> {
  const { listingId, target, fields, snapshotKeys, expectedVersion, createIfMissing, event } = input

  let existing: { id: string; version: number | null; flatFileSnapshot: unknown } | null = null
  if (listingId) {
    existing = await db.channelListing.findUnique({
      where: { id: listingId },
      select: { id: true, version: true, flatFileSnapshot: true },
    })
  } else if (target) {
    const region = resolveListingRegion(target.channel, target.marketplace)
    existing = await db.channelListing.findFirst({
      where: {
        productId: target.productId,
        channel: target.channel,
        OR: [{ marketplace: region }, { region }],
      },
      select: { id: true, version: true, flatFileSnapshot: true },
    })
  }

  const emit = () => {
    if (!event) return
    void productEventService.emit({
      aggregateId: event.productId,
      aggregateType: 'Product',
      eventType: event.eventType,
      data: event.data,
      metadata: { source: event.source },
    } as Parameters<typeof productEventService.emit>[0])
  }

  if (!existing) {
    if (!createIfMissing) return { listingId: null, version: null, created: false }
    const created = await db.channelListing.create({
      data: { ...createIfMissing, ...fields },
      select: { id: true, version: true },
    })
    emit()
    return { listingId: created.id, version: created.version ?? null, created: true }
  }

  const merged = mergeSnapshotPatch(existing.flatFileSnapshot, snapshotKeys)
  const updated = await casUpdateChannelListing(
    db as never,
    existing.id,
    expectedVersion ?? undefined,
    { ...fields, ...(merged ? { flatFileSnapshot: merged } : {}) },
  )
  emit()
  return { listingId: existing.id, version: updated?.version ?? null, created: false }
}
