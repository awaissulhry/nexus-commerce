/**
 * Per-listing channel SKU, the eBay SENDING side (plan docs/sheet-ids-sku-rows/PLAN.md, step S4). No rule of its own:
 * the S2 resolver (`channel-sku.pure.ts`) with the eBay rule —
 *   wanted = `channelSku` ?? an extra listing's own SKU (`ProductListingAlias.sku`, on its main row) ?? `Product.sku`;
 *   live   = `liveChannelSku` ?? `Product.sku` (eBay never received an alias SKU; a still-draft row holds nothing).
 *
 *   - A push or a listing action addresses what eBay HOLDS: `listingSendSku` (listing-send-sku.ts), the live SKU.
 *   - Publish (create, Full and Partial update) sends each row's WANTED SKU (`ebayPublishSku`). A row eBay already holds
 *     under ANOTHER SKU keeps eBay's: moving a live eBay SKU is step S10 (`waitsForMove` marks those rows).
 *   - The custom-label guard and the label / relabel / add-variation services name the listing's WANTED SKU
 *     (`ebayItemLabel`, `ebayRowsOnItem`), so a listing with its own SKU is never put back to `Product.sku`.
 *
 * A listing with no SKU of its own gets exactly the SKU it got before, on every path (parity).
 */
import type { Prisma } from '@prisma/client'
import { liveChannelSku, wantedChannelSku, type ChannelSkuListing } from './channel-sku.pure.js'
import { CHANNEL_SKU_LISTING_SELECT } from './channel-sku.js'

type Db = Prisma.TransactionClient
type EbayFacts = Omit<ChannelSkuListing, 'channel'>

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const facts = (listing: EbayFacts | null | undefined): ChannelSkuListing => ({ ...(listing ?? {}), channel: 'EBAY' })

/** What Publish sends for one row of an eBay listing. */
export interface EbayPublishSku {
  /** The SKU Publish sends; '' when there is none (the review names an empty SKU). */
  sku: string
  /** The SKU Nexus wants on eBay for this row. */
  wanted: string | null
  /** The SKU eBay holds for this row; null = no listing, or a still-draft row (eBay holds nothing yet). */
  live: string | null
  /**
   * TODO(S10): the row wants another SKU than the one eBay holds. Publish keeps sending eBay's SKU (a Full update matches
   * variations by SKU, and Nexus cannot move a live eBay SKU yet); S10 moves it in place (Trading) or says it cannot.
   */
  waitsForMove: boolean
}

/**
 * The SKU Publish sends for one row: a row eBay holds sends the SKU eBay holds (its own when it has one, as before
 * otherwise); a row eBay does not hold yet (no listing, or still a draft) sends its wanted SKU.
 */
export function ebayPublishSku(listing: EbayFacts | null | undefined, productSku: string | null | undefined): EbayPublishSku {
  const wanted = wantedChannelSku(facts(listing), productSku).sku
  const held = listing ? liveChannelSku(facts(listing), productSku) : null
  const live = held?.sku ?? null
  if (live) return { sku: live, wanted, live, waitsForMove: !!wanted && wanted !== live }
  return { sku: wanted ?? '', wanted, live: null, waitsForMove: false }
}

/**
 * The extra-listing facts (`ProductListingAlias`: its own SKU and main product) of rows read without them, by alias id:
 * an extra listing's own SKU is the wanted SKU of its main row. Rows that are not an extra listing are not read.
 */
export async function readListingAliases(db: Db, rows: ReadonlyArray<{ aliasId?: string | null }>): Promise<Map<string, { sku: string | null; productId: string }>> {
  const ids = [...new Set(rows.map(row => row.aliasId).filter((id): id is string => !!id))]
  if (!ids.length) return new Map()
  const aliases = await db.productListingAlias.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, productId: true } })
  return new Map(aliases.map(alias => [alias.id, { sku: alias.sku, productId: alias.productId }]))
}

/** A listing row of an eBay item, with the facts the label and SKU rules read. */
export type EbayItemRow = EbayFacts & { id: string; productId: string; product?: { sku: string; parentId?: string | null } | null }

/** The custom label (Item.SKU) one eBay item should carry, and the labels that may stay. */
export interface EbayItemLabel {
  /** The label to write when eBay holds none of `keep`. */
  target: string
  /** Labels left as they are: the wanted SKU, and the SKU eBay holds (TODO(S10): moving that one is S10's). */
  keep: string[]
  /** The root row whose SKU the label is (recorded as what eBay holds once eBay takes it); null = the caller's fallback. */
  listingId: string | null
  /** No single label: the item's main rows want different SKUs. Nothing is written. */
  refusal: string | null
}

/**
 * The label of one eBay item from its MAIN rows (the rows of a product with no parent: a family's parent, a single
 * product, an extra listing's main row). A main row with its own SKU (a wanted or confirmed SKU that is not its product
 * SKU): its wanted SKU is the label, and the SKU eBay holds may stay. No main row, or none with its own SKU: `fallback`,
 * exactly what the caller used before.
 */
export function ebayItemLabel(rows: ReadonlyArray<EbayItemRow>, fallback: string): EbayItemLabel {
  const before: EbayItemLabel = { target: fallback, keep: fallback ? [fallback] : [], listingId: null, refusal: null }
  const roots = rows.filter(row => row.product && !row.product.parentId)
  const answers = roots.map(row => {
    const product = text(row.product?.sku)
    const wanted = wantedChannelSku(facts(row), product).sku
    const live = liveChannelSku(facts(row), product)?.sku ?? null
    // Its own SKU: one that is not the product SKU (a confirmed SKU equal to the product SKU is no SKU of its own).
    const own = (!!wanted && wanted !== product) || (!!live && live !== product)
    return { row, wanted, live, own }
  })
  const owners = answers.filter(answer => answer.own)
  if (!owners.length) return before
  const targets = [...new Set(answers.map(answer => answer.wanted).filter((sku): sku is string => !!sku))]
  if (targets.length !== 1) {
    return { ...before, keep: [], refusal: `This eBay item's main listings want different SKUs (${targets.join(', ') || 'none'}). Nexus did not pick one; the label was not sent.` }
  }
  const keep = [...new Set([targets[0], ...answers.map(answer => answer.live).filter((sku): sku is string => !!sku)])]
  return { target: targets[0], keep, listingId: owners.length === 1 && answers.length === 1 ? owners[0].row.id : null, refusal: null }
}

const ROW_SELECT = {
  ...CHANNEL_SKU_LISTING_SELECT,
  product: { select: { sku: true, deletedAt: true, parentId: true } },
} satisfies Prisma.ChannelListingSelect

/** The listing rows of one eBay item on one account and market (every row that carries its item number). */
export async function readEbayItemRows(db: Db, input: { itemId: string; marketplace: string; accountId: string | null | undefined }) {
  if (!input.itemId || !input.accountId) return []
  return db.channelListing.findMany({
    where: { channel: 'EBAY', externalListingId: input.itemId, marketplace: input.marketplace.toUpperCase(), channelConnectionId: input.accountId },
    select: ROW_SELECT, orderBy: { id: 'asc' },
  })
}

/** One product's row on an eBay item, and the SKU it wants there (its own, else its product SKU). */
export interface EbayRowOnItem {
  productId: string
  listingId: string | null
  wanted: string
  live: string | null
}

/**
 * For each product, its row on one eBay item (this account and market) and the SKU that row wants: the row carrying
 * the item number; else, when every row of the item is under one listing (alias), the product's row there (a variation
 * not on eBay yet). No row: the product SKU, exactly as before. Products of another account are never read.
 */
export async function ebayRowsOnItem(db: Db, input: {
  itemId: string; marketplace: string; accountId: string | null | undefined
  products: ReadonlyArray<{ id: string; sku: string }>
}): Promise<Map<string, EbayRowOnItem>> {
  const out = new Map<string, EbayRowOnItem>()
  for (const product of input.products) out.set(product.id, { productId: product.id, listingId: null, wanted: product.sku, live: null })
  if (!input.products.length || !input.accountId) return out
  const market = input.marketplace.toUpperCase()
  const itemRows = await readEbayItemRows(db, input)
  const aliasKeys = [...new Set(itemRows.map(row => row.aliasKey ?? ''))]
  const rows = await db.channelListing.findMany({
    where: { channel: 'EBAY', marketplace: market, channelConnectionId: input.accountId, productId: { in: input.products.map(p => p.id) },
      OR: [{ externalListingId: input.itemId }, ...(aliasKeys.length === 1 ? [{ aliasKey: aliasKeys[0], externalListingId: null }] : [])] },
    select: ROW_SELECT, orderBy: { id: 'asc' },
  })
  for (const product of input.products) {
    const mine = rows.filter(row => row.productId === product.id)
    const onItem = mine.filter(row => row.externalListingId === input.itemId)
    const row = onItem.length === 1 ? onItem[0] : !onItem.length && mine.length === 1 ? mine[0] : null
    if (!row) continue
    const sku = ebayPublishSku(row, product.sku)
    out.set(product.id, { productId: product.id, listingId: row.id, wanted: text(sku.wanted) ?? product.sku, live: sku.live })
  }
  return out
}
