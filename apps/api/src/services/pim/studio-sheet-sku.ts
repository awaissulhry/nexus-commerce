/**
 * S11 — the product sheet's FIRST column in a channel scope: each row's SKU facts (plan docs/sheet-ids-sku-rows/PLAN.md,
 * step S11). The Shared scope's first column is `Product.sku` and carries none of this.
 *
 * The Owner's rule (2026-10-05): a SKU typed in a channel scope belongs to that listing only (that channel, that market;
 * each Amazon EU market on its own); the Shared scope edits the product SKU. So a channel row's first column shows the
 * SKU Publish sends for its listing (`wantedChannelSku`, the S2 resolver Publish itself reads), says when that is not
 * the Shared SKU (`differsFromProduct`: the sheet draws its "differs from Shared" mark), and says whether the cell can
 * be edited here, with the reason when it cannot. The write is the `channel_sku` field (`CHANNEL_SKU_FIELD`) → the one
 * writer `setChannelSku`; the server stays the authority (a held listing's move, uniqueness, characters).
 *
 * Read cost: the sheet already selects `platformAttributes` and `overrideData`; this adds the two SKU columns, the
 * active offers' SKUs, the extra listing's SKU and, on Amazon only, the flat-file SKU key's VALUE (never the snapshot).
 */
import { Prisma } from '@prisma/client'
import { AMAZON_LISTING_SKU_KEYS } from '../channel-mapping/defaults.js'
import { differsFromProduct, liveChannelSku, wantedChannelSku, type ChannelSkuListing, type ChannelSkuSource } from '../listings/channel-sku.pure.js'
import { listingPlace } from '../listings/channel-sku-live-move.js'

/** A channel-scope row's first-column SKU, as the sheet reads it (`StudioRow.skuFacts`). */
export interface StudioRowSku {
  /** What the first column shows: the SKU Publish sends for this row's listing. Null = no single SKU (`conflict` says why). */
  wanted: string | null
  /** Where `wanted` came from (the resolver's source); `'product'` = the listing simply follows the Shared SKU. */
  source: ChannelSkuSource | null
  /** The SKU the channel holds for this listing; null while it is still a Nexus draft (never on the channel). */
  live: string | null
  /** True when `live` is the channel's own confirmation (`liveChannelSku`), not a value read from an older store. */
  liveConfirmed: boolean
  /** The listing does not simply send the Shared SKU: its own SKU, or no single SKU at all. */
  differs: boolean
  /** The resolver's sentence when the listing has no single SKU. */
  conflict?: string
  /** The first column can be edited on this row (the server still decides each save). */
  editable: boolean
  /** Why it cannot, in one plain sentence; null when it can. */
  reason: string | null
}

/** The SKU stores of one listing that the sheet's own listing read does not select. */
export interface SheetSkuStores {
  channelSku: string | null
  liveChannelSku: string | null
  offers: Array<{ sku: string | null; isActive: boolean; fulfillmentMethod: string | null }>
  alias: { sku: string | null; productId: string } | null
  /** Only the flat-file SKU keys (`AMAZON_LISTING_SKU_KEYS.flatFileSnapshot`), never the whole snapshot. */
  flatFileSnapshot: Record<string, string | null> | null
}

type SkuStoreDb = Pick<Prisma.TransactionClient, '$queryRaw'> & { channelListing: Pick<Prisma.TransactionClient['channelListing'], 'findMany'> }

/**
 * The SKU stores of these listings (one coordinate's), by listing id. The columns and relations in one Prisma read; on
 * Amazon, the flat-file SKU keys in ONE SQL statement that returns only those JSON values (`"flatFileSnapshot" ->> key`)
 * — never the snapshot, a whole flat-file row per listing, on a read the sheet repeats after every save (the Owner's
 * database bill is mostly data transfer). The ids come from the sheet's own scoped listing read, so they are this
 * business's; the statement is also under row-level security.
 */
export async function readSheetSkuStores(db: SkuStoreDb, listingIds: readonly string[], channel: string): Promise<Map<string, SheetSkuStores>> {
  const ids = [...new Set(listingIds)]
  if (!ids.length) return new Map()
  const flatKeys = String(channel).toUpperCase() === 'AMAZON' ? AMAZON_LISTING_SKU_KEYS.flatFileSnapshot : []
  const [rows, flat] = await Promise.all([
    db.channelListing.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, channelSku: true, liveChannelSku: true,
        // Oldest first, as `CHANNEL_SKU_LISTING_SELECT` reads them, so a conflict lists its SKUs in a stable order.
        offers: { where: { isActive: true }, select: { sku: true, isActive: true, fulfillmentMethod: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        alias: { select: { sku: true, productId: true } },
      },
    }),
    flatKeys.length ? readFlatFileSkus(db, ids, flatKeys) : Promise.resolve(new Map<string, Record<string, string | null>>()),
  ])
  return new Map(rows.map(row => [row.id, {
    channelSku: row.channelSku ?? null,
    liveChannelSku: row.liveChannelSku ?? null,
    // `?? []`: a hand-mocked database (unit tests) answers every listing read with the same rows.
    offers: (row.offers ?? []).map(offer => ({ sku: offer.sku ?? null, isActive: offer.isActive, fulfillmentMethod: offer.fulfillmentMethod ?? null })),
    alias: row.alias ? { sku: row.alias.sku ?? null, productId: row.alias.productId } : null,
    flatFileSnapshot: flatKeys.length ? flat.get(row.id) ?? null : null,
  }]))
}

/** The flat-file SKU keys of these listings' snapshots — only those values — by listing id (one statement). */
async function readFlatFileSkus(db: Pick<Prisma.TransactionClient, '$queryRaw'>, ids: string[], keys: readonly string[]): Promise<Map<string, Record<string, string | null>>> {
  const rows = await db.$queryRaw<Array<{ id: string; skus: Array<string | null> | null }>>`
    SELECT id, ARRAY[${Prisma.join(keys.map(key => Prisma.sql`"flatFileSnapshot" ->> ${key}::text`))}]::text[] AS skus
    FROM "ChannelListing"
    WHERE id = ANY(${ids}::text[]) AND "flatFileSnapshot" IS NOT NULL`
  return new Map((rows ?? []).map(row => [row.id, Object.fromEntries(keys.map((key, i) => [key, row.skus?.[i] ?? null]))]))
}

export interface SheetRowSkuInput {
  channel: string
  marketplace: string
  /** The row's product SKU — the Shared SKU. */
  productSku: string
  /** The row's listing on this coordinate with its SKU stores, or null when the row has none. */
  listing: (ChannelSkuListing & Partial<SheetSkuStores>) | null
  /** The extra listing (listing alias) this row is projected through; null on the primary listing. */
  alias: { id: string; label: string | null } | null
  /** The row is its listing group's band: the family's own row (the alias band on an extra listing). */
  band: boolean
}

/** One channel row's first-column facts. Pure. */
export function sheetRowSku(input: SheetRowSkuInput): StudioRowSku {
  const place = listingPlace({ channel: input.channel, marketplace: input.marketplace, aliasKey: input.alias?.id ?? null })
  if (!input.listing) {
    // No listing here: Publish would start one that follows the Shared SKU, so that is what the column shows.
    return { wanted: input.productSku, source: 'product', live: null, liveConfirmed: false, differs: false, editable: false,
      reason: input.alias
        ? `There is no ${place} listing for this product, so it has no SKU of its own here.`
        : `There is no ${place} listing on this row yet, so it has no SKU of its own here: it follows the Shared SKU ${input.productSku}. Start its listing first (for example by setting its Status), then change its SKU here.` }
  }
  const wanted = wantedChannelSku(input.listing, input.productSku)
  const live = liveChannelSku(input.listing, input.productSku)
  const facts = {
    wanted: wanted.sku, source: wanted.source,
    live: live?.sku ?? null, liveConfirmed: live?.source === 'live',
    differs: differsFromProduct(input.listing, input.productSku),
    ...(wanted.conflict ? { conflict: wanted.conflict.sentence } : {}),
  }
  // Every row with a listing is editable, an extra listing's own row (its band) included (F7, browser check 2026-10-05):
  // its SKU is the listing's own (`setChannelSku`, which keeps the extra listing's SKU in step).
  return { ...facts, editable: true, reason: null }
}
