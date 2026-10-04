/**
 * Delete and relist (Owner 2026-10-04; simplified the same day) — which listing rows Nexus deleted, read from records
 * that already exist; nothing is stored for it. Such a row is a row NOT on the channel: its Status reads Not listed
 * ("Deleted on Amazon · IT on 4 Oct."), its default is Not listed, and its Status Active or Inactive lists it again.
 *
 * A row is deleted when the listing-action engine's last Delete of it was accepted by the channel (its audit record:
 * `ChannelListingSnapshot`, reason 'delete', outcome ACCEPTED), the row still has the draft shape that Delete left (no
 * channel number; DRAFT or unpublished — `returnToDraft`), and no publish of it was accepted after the delete. Once a
 * publish lists it again (Amazon promotes the accepted draft, eBay writes the item number, Shopify its product), it is
 * no longer deleted and its Status reads Active again by itself.
 *
 * An OLDER relist choice (the first build, before the simplify): a Partial update or Full update set on the row's
 * Action column AFTER the delete — Full update stored as `FULL_UPDATE`, Partial update as no value WITH a time
 * (`publishActionAt`). It is kept as `relistChosenAt` and read as the row's Status choice Active
 * (`new-listing-choices.ts`); `isRelistChoice` (@nexus/shared/publish-actions) is the rule. Nothing writes it any more.
 */
import type { FbaUnits, ListingDeletion } from '@nexus/shared/listing-actions'
import { isRelistChoice, PAN_EU_MARKETS } from '@nexus/shared/publish-actions'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

/** The listing facts a deletion is read from (every field is on `ChannelListing`). */
export interface DeletionCandidate {
  id: string
  channel: string
  marketplace: string
  externalListingId: string | null
  listingStatus: string | null
  isPublished: boolean | null
  /** The Action column's stored value and its time: an older relist choice made after the delete reads as Status Active. */
  publishAction?: string | null
  publishActionAt?: Date | null
}

const CHANNEL_LABEL: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' }
/** "Amazon · IT", "eBay · DE", "Shopify" (as the listing-action engine names a destination). */
export const deletionWhere = (channel: string, marketplace: string) =>
  channel === 'SHOPIFY' || marketplace === 'GLOBAL' ? CHANNEL_LABEL[channel] ?? channel : `${CHANNEL_LABEL[channel] ?? channel} · ${marketplace}`

/** The draft shape a Delete leaves (`returnToDraft`): no channel number, DRAFT or unpublished. */
export const hasDeletedShape = (row: Pick<DeletionCandidate, 'externalListingId' | 'listingStatus' | 'isPublished'>) =>
  !row.externalListingId && (String(row.listingStatus ?? '').trim().toUpperCase() === 'DRAFT' || row.isPublished === false)

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** listing id → its deletion, for the rows Nexus deleted and that are not listed again. Two reads at most. */
export async function readListingDeletions(rows: readonly DeletionCandidate[]): Promise<Map<string, ListingDeletion>> {
  const out = new Map<string, ListingDeletion>()
  const candidates = new Map(rows.filter(hasDeletedShape).map(row => [row.id, row]))
  if (!candidates.size) return out
  const deletes = await prisma.channelListingSnapshot.findMany({
    where: { channelListingId: { in: [...candidates.keys()] }, reason: 'delete', outcome: 'ACCEPTED', acceptedAt: { not: null } },
    select: { channelListingId: true, acceptedAt: true, payload: true },
    orderBy: [{ acceptedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  })
  const latest = new Map<string, { at: Date; payload: unknown }>()
  for (const row of deletes) if (row.acceptedAt && !latest.has(row.channelListingId)) latest.set(row.channelListingId, { at: row.acceptedAt, payload: row.payload })
  if (!latest.size) return out
  // A publish accepted after the delete listed it again (whatever the row still says).
  const earliest = new Date(Math.min(...[...latest.values()].map(entry => entry.at.getTime())))
  const relisted = await prisma.channelListingSnapshot.findMany({
    where: { channelListingId: { in: [...latest.keys()] }, reason: 'publish', outcome: 'ACCEPTED', acceptedAt: { gt: earliest } },
    select: { channelListingId: true, acceptedAt: true },
  })
  for (const [id, entry] of latest) {
    if (relisted.some(row => row.channelListingId === id && row.acceptedAt && row.acceptedAt > entry.at)) continue
    const row = candidates.get(id)!
    const at = entry.at.toISOString()
    const evidence = object(object(entry.payload).evidence)
    const old = evidence.oldExternalListingId
    const chosen = isRelistChoice({ value: row.publishAction ?? null, at: row.publishActionAt ?? null }, at)
    out.set(id, { at, where: deletionWhere(row.channel, row.marketplace), oldReference: typeof old === 'string' && old ? old : null,
      relistChosenAt: chosen && row.publishActionAt ? row.publishActionAt.toISOString() : null })
  }
  return out
}

// ── FBA facts for a Delete and a relist (S1, S2, S4) ─────────────────────────────────────────────

/** The Amazon marketplace of a market code: its SP-API id and the seller's FBA program there (`Marketplace.fbaProgram`). */
export async function amazonMarket(code: string): Promise<{ marketplaceId: string | null; fbaProgram: string | null }> {
  const row = await prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code: code.toUpperCase() }, select: { marketplaceId: true, fbaProgram: true } })
  let marketplaceId = row?.marketplaceId ?? null
  if (!marketplaceId) marketplaceId = (await import('../amazon/flat-file.service.js')).MARKETPLACE_ID_MAP[code.toUpperCase()] ?? null
  return { marketplaceId, fbaProgram: row?.fbaProgram ?? null }
}

/**
 * Does an FBA SKU here use Pan-European FBA? Nexus's signal is the seller's program for the marketplace
 * (`Marketplace.fbaProgram` = 'PAN_EU'). When it was never set, an FBA offer in a Pan-EU market (DE, FR, IT, ES, NL)
 * counts as Pan-European (the warning is about what Amazon MAY do; saying it too often is the safe side).
 */
export const usesPanEu = (code: string, fbaProgram: string | null) =>
  fbaProgram ? fbaProgram.toUpperCase() === 'PAN_EU' : PAN_EU_MARKETS.includes(code.toUpperCase())

/**
 * Amazon's FBA units per product in one marketplace, as Nexus last read them (`FbaInventoryDetail`, the 15-minute FBA
 * sync), matched by product or seller SKU; `asin` narrows them to the units labelled for that ASIN. A product with no
 * row is absent (Nexus holds no count). The read time is the OLDEST contributing row (the freshest must not disguise a
 * stale one). Never throws: an unreadable count is absent.
 */
export async function readFbaUnits(marketplaceId: string | null, products: ReadonlyArray<{ productId: string; sku: string }>,
  options: { asin?: string | null } = {}): Promise<Map<string, FbaUnits>> {
  const out = new Map<string, FbaUnits>()
  if (!marketplaceId || !products.length) return out
  try {
    const rows = await prisma.fbaInventoryDetail.findMany({
      where: { marketplaceId, OR: [{ productId: { in: products.map(p => p.productId) } }, { sku: { in: products.map(p => p.sku) } }],
        ...(options.asin ? { asin: options.asin } : {}) },
      select: { productId: true, sku: true, condition: true, quantity: true, lastSyncedAt: true },
    })
    for (const product of products) {
      const mine = rows.filter(row => row.productId === product.productId || row.sku === product.sku)
      if (!mine.length) continue
      const units: FbaUnits = { sellable: 0, inbound: 0, reserved: 0, other: 0, readAt: null }
      for (const row of mine) {
        const quantity = Math.max(0, row.quantity)
        if (row.condition === 'SELLABLE') units.sellable += quantity
        else if (row.condition === 'INBOUND') units.inbound += quantity
        else if (row.condition === 'RESERVED') units.reserved += quantity
        else units.other += quantity
      }
      units.readAt = mine.map(row => row.lastSyncedAt.toISOString()).sort()[0] ?? null
      out.set(product.productId, units)
    }
  } catch (error) {
    logger.warn('[listing-deletions] FBA units unreadable; the warning names no count', { error: error instanceof Error ? error.message : String(error) })
  }
  return out
}
