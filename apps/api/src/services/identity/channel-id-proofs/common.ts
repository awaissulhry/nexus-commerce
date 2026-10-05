/**
 * Item ID control (docs/sheet-ids-sku-rows/A2-item-id-control.md, steps I1–I4) — what every channel's proof shares: the
 * coordinate a link writes, the proof's shape, the channel's words, and the one rule for which rows a proven item
 * carries (and which rows it moves off another item, or leaves alone). No channel call here.
 *
 * One rule, every channel (Owner, 2026-10-05): a row is written only when the channel shows that row's OWN channel SKU
 * (this channel, market and account: `channel-sku.ts`) on the item — or it is the family's main row and the item proved
 * this family's. A row holding ANOTHER item moves to this one only on its own proven SKU; otherwise it is kept as it is.
 */
import prisma from '../../../db.js'
import { CHANNEL_SKU_LISTING_SELECT } from '../../listings/channel-sku.js'
import { liveChannelSku, wantedChannelSku, type ChannelSkuListing } from '../../listings/channel-sku.pure.js'
import { heldIdKey } from '../channel-held.service.js'

/** Why a plan or a run refused: `not_found` (no such listing here), `conflict` (it changed meanwhile), `refused` (the rule). */
export type IdentityFixRefusalCode = 'refused' | 'conflict' | 'not_found'

export class IdentityFixRefusal extends Error {
  constructor(message: string, readonly code: IdentityFixRefusalCode = 'refused') {
    super(message)
    this.name = 'IdentityFixRefusal'
  }
}

export interface CoordinateRow {
  id: string
  productId: string
  sku: string
  listingStatus: string
  isPublished: boolean
  syncPaused: boolean
  quantity: number | null
  externalListingId: string | null
  externalParentId: string | null
  platformAttributes: unknown
  version: number
}

export interface Coordinate {
  channel: string
  market: string
  accountId: string | null
  aliasKey: string
  /** The business the listing belongs to (a Shopify product's Nexus identity names it). */
  workspaceId: string | null
  root: { id: string; sku: string }
  /** The id the coordinate carries now (the asked listing's), or null. */
  externalId: string | null
  rows: CoordinateRow[]
  /** The listing asked about: its version (the sheet's fence) and whether it is the family's main row. */
  asked: { id: string; productId: string; version: number; isMain: boolean }
  /** Amazon: the ASIN a draft row lists on at Publish (`overrideData.merchant_suggested_asin`), or null. */
  suggestedId?: string | null
}

/** The channels whose id a family shares (one item per family) and that a link proves on the channel. */
export type SharedIdChannel = 'EBAY' | 'ETSY' | 'SHOPIFY'

export interface ChannelWords {
  channel: string
  /** "eBay", "Etsy", "Shopify", "Amazon". */
  name: string
  /** What the id names: "item", "listing", "product", "ASIN". */
  noun: string
  /** The column's label: "Item ID", "Listing ID", "Product ID", "ASIN". */
  idLabel: string
}

export const CHANNEL_WORDS: Readonly<Record<string, ChannelWords>> = {
  EBAY: { channel: 'EBAY', name: 'eBay', noun: 'item', idLabel: 'Item ID' },
  ETSY: { channel: 'ETSY', name: 'Etsy', noun: 'listing', idLabel: 'Listing ID' },
  SHOPIFY: { channel: 'SHOPIFY', name: 'Shopify', noun: 'product', idLabel: 'Product ID' },
  AMAZON: { channel: 'AMAZON', name: 'Amazon', noun: 'ASIN', idLabel: 'ASIN' },
}
export const wordsOf = (channel: string): ChannelWords => CHANNEL_WORDS[String(channel).toUpperCase()] ?? { channel, name: channel, noun: 'item', idLabel: 'id' }

/** "the EBAY IT listing of JKT" — the place a sentence names. */
export const where = (c: Pick<Coordinate, 'channel' | 'market' | 'root'>) => `the ${c.channel} ${c.market} listing of ${c.root.sku}`
export const lower = (s: string) => s.trim().toLowerCase()
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** A row an item carries: the only rows a link writes. */
export interface CarriedRow {
  id: string
  productId: string
  /** The product's SKU (what a person reads in the sheet). */
  sku: string
  /** The SKU the channel holds for this row, when the item names it; null for the main row of a variation item. */
  channelSku: string | null
  externalListingId: string | null
  listingStatus: string
  isPublished: boolean
  version: number
  /** Shopify: the row's listing attributes as the link writes them (product, variant and inventory item ids). */
  platformAttributes?: Record<string, unknown>
}

/** A row that holds another item and that the link MOVES to this one: the channel shows its channel SKU on this item. */
export interface MovedRow {
  id: string
  sku: string
  channelSku: string
  /** The item it holds now. */
  fromItemId: string
  /** "M holds item 1234; eBay shows its SKU M-IT on item 5678; Link moves it to 5678." */
  sentence: string
}

/** A row that holds an item and that the link leaves alone: the channel does not show its SKU on this item. */
export interface KeptRow {
  id: string
  sku: string
  externalListingId: string
  sentence: string
}

export const movedSentence = (sku: string, from: string, channelSku: string, itemId: string, words: ChannelWords = CHANNEL_WORDS.EBAY) =>
  `${sku} holds ${words.noun} ${from}; ${words.name} shows its SKU ${channelSku} on ${words.noun} ${itemId}; Link moves it to ${itemId}.`
export const keptSentence = (sku: string, held: string, itemId: string, words: ChannelWords = CHANNEL_WORDS.EBAY) =>
  `${sku} holds ${words.noun} ${held}; ${words.name} does not show its SKU on ${words.noun} ${itemId}, so Link leaves it as it is.`

/** The status a linked row takes, in Nexus words. */
export type LinkStatus = 'ACTIVE' | 'INACTIVE' | 'ENDED'

/** What a channel says of one item, and what a link of it would write here. Built once; the plan, the check and the run read it. */
export interface ChannelItemProof {
  channel: SharedIdChannel
  itemId: string
  verdict: 'verified' | 'unverifiable' | 'rejected' | 'invalid'
  /** The proof's own sentence(s). */
  reason: string
  /** The channel's own word for the item's state ("Active", "Completed", "expired", "ARCHIVED"). */
  channelStatus: string | null
  /** What the rows read after a link; null when the channel said nothing Nexus can record. */
  status: LinkStatus | null
  title: string | null
  /** eBay: the item's seller and the account's. */
  seller: { item: string | null; account: string | null } | null
  liveSkus: string[]
  matchedSkus: string[]
  /** Every row a link writes: the rows the item carries, the moved rows included (they are also in `moved`). */
  rows: CarriedRow[]
  moved: MovedRow[]
  kept: KeptRow[]
  /** The id is the one the rows hold, and every row it carries already reads what the channel says: nothing to write. */
  unchanged: boolean
  /** Why a link cannot be written, or null. Unverifiable is a refusal unless the caller's person said yes explicitly. */
  refusal: string | null
  /** Further plain sentences the check shows (a Shopify store with several locations, a colour product's sizes). */
  notes: string[]
  /** Shopify colour store: the colour product a link confirms (Find's proposal), and what Confirm writes on Shopify. */
  colour?: { valueKey: string; name: string; shopifyProductId: string; sizes: Array<{ productId: string; sku: string }>; writes: string }
}

export const emptyProof = (channel: SharedIdChannel, itemId: string): ChannelItemProof => ({
  channel, itemId, verdict: 'invalid', reason: '', channelStatus: null, status: null, title: null, seller: null, liveSkus: [], matchedSkus: [],
  rows: [], moved: [], kept: [], unchanged: false, refusal: null, notes: [],
})

export type FamilyRow = ChannelSkuListing & {
  id: string; productId: string; version: number; listingStatus: string; isPublished: boolean; externalListingId: string | null
  lastSyncStatus?: string | null; platformAttributes?: unknown; product: { sku: string } | null
}

/** The SKUs one listing row stands for on its channel: the one the channel holds and the one Nexus sends (`channel-sku.ts`). */
export function channelSkusOf(row: FamilyRow): string[] {
  const out = new Set<string>()
  const productSku = row.product?.sku ?? null
  const live = liveChannelSku(row, productSku)
  if (live?.sku) out.add(live.sku)
  const wanted = wantedChannelSku(row, productSku)
  if (wanted.sku) out.add(wanted.sku)
  // Two SKUs on record for one listing: either may be the one the item carries.
  for (const candidate of wanted.conflict?.candidates ?? []) out.add(candidate.sku)
  return [...out]
}

/** This family's rows on THIS coordinate (channel, market, account, extra listing), with what the channel-SKU rules read. */
export async function familyRowsOf(coordinate: Coordinate): Promise<FamilyRow[]> {
  return await prisma.channelListing.findMany({
    where: {
      channel: coordinate.channel, marketplace: coordinate.market, channelConnectionId: coordinate.accountId, aliasKey: coordinate.aliasKey,
      product: { deletedAt: null, OR: [{ id: coordinate.root.id }, { parentId: coordinate.root.id }] },
    },
    select: { ...CHANNEL_SKU_LISTING_SELECT, lastSyncStatus: true },
    orderBy: { id: 'asc' },
  }) as unknown as FamilyRow[]
}

/**
 * Another family of this business that holds the id on this account (any market): the item is that product's, so a link
 * here cannot work. Returns the holder's SKU, or null.
 */
export async function heldByAnotherFamily(coordinate: Coordinate, itemId: string, extra: Array<Record<string, unknown>> = []): Promise<string | null> {
  // The family's products by id (a `NOT (id = r OR parentId = r)` filter drops every product whose parentId is NULL).
  const family = (await prisma.product.findMany({ where: { OR: [{ id: coordinate.root.id }, { parentId: coordinate.root.id }] }, select: { id: true } })).map((p) => p.id)
  const holder = await prisma.channelListing.findFirst({
    where: {
      channel: coordinate.channel, channelConnectionId: coordinate.accountId,
      OR: [{ externalListingId: itemId }, ...extra],
      productId: { notIn: family },
      product: { deletedAt: null },
    },
    select: { product: { select: { sku: true } } },
  })
  return holder?.product.sku ?? null
}

/**
 * The rows an item carries, by the one rule: a row whose own channel SKU the item names (`ownOf`), and the family's main
 * row once the item proved this family's. A row holding ANOTHER item moves only on its own SKU; the main row of a
 * variation item names no SKU of its own, so it never moves off another item without one. A SKU-less item a person
 * linked anyway (Claude's explicit yes) carries the rows that hold no other item.
 */
export function carryRows(coordinate: Coordinate, family: FamilyRow[], proof: ChannelItemProof,
  ownOf: (row: FamilyRow) => { sku: string | null } | null, extra: (row: FamilyRow, own: { sku: string | null } | null) => Partial<CarriedRow> = () => ({}),
  options: { anyRow?: boolean } = {}): void {
  const words = wordsOf(proof.channel)
  // `anyRow`: an item that names no SKU (and no variant) of any row, linked anyway on a person's explicit yes.
  const anyRow = options.anyRow ?? proof.liveSkus.length === 0
  const matched = proof.matchedSkus.length > 0
  for (const row of family) {
    const own = ownOf(row)
    const isMain = row.productId === coordinate.root.id
    const sku = row.product?.sku ?? row.id
    const held = heldIdKey(proof.channel, row.externalListingId)
    const elsewhere = held && held !== coordinate.externalId && held !== proof.itemId ? held : null
    const carried = anyRow ? true : !!own || (isMain && matched)
    if (!carried || (elsewhere && !own)) {
      if (held && held !== proof.itemId) proof.kept.push({ id: row.id, sku, externalListingId: held, sentence: keptSentence(sku, held, proof.itemId, words) })
      continue
    }
    if (elsewhere && own) proof.moved.push({ id: row.id, sku, channelSku: own.sku ?? '', fromItemId: elsewhere, sentence: movedSentence(sku, elsewhere, own.sku ?? '', proof.itemId, words) })
    proof.rows.push({
      id: row.id, productId: row.productId, sku: row.product?.sku ?? '', channelSku: own?.sku ?? null,
      externalListingId: row.externalListingId, listingStatus: row.listingStatus, isPublished: row.isPublished, version: row.version,
      ...extra(row, own),
    })
  }
}

/** The SKU on the item that one row stands for (exact text when `exact`, else ignoring case and outer spaces). */
export function ownSkuOn(row: FamilyRow, skusByRow: ReadonlyMap<string, string[]>, item: readonly string[], exact = false): { sku: string } | null {
  const on = exact ? new Set(item.map((s) => s.trim())) : new Set(item.map(lower))
  const found = (skusByRow.get(row.id) ?? []).find((sku) => on.has(exact ? sku.trim() : lower(sku)))
  return found ? { sku: found } : null
}

/** The SKUs of the family that are on the item (for "N are this listing's"). */
export function matchedSkusOf(family: FamilyRow[], skusByRow: ReadonlyMap<string, string[]>, item: readonly string[], exact = false): string[] {
  const out = new Set<string>()
  for (const row of family) { const own = ownSkuOn(row, skusByRow, item, exact); if (own) out.add(own.sku) }
  return [...out]
}

/** "It carries 3 SKUs (A, B, C); 2 are this listing's." */
export function skuSentence(proof: Pick<ChannelItemProof, 'liveSkus' | 'matchedSkus'>): string | null {
  if (!proof.liveSkus.length) return null
  const shown = proof.liveSkus.slice(0, 8).join(', ')
  return `It carries ${proof.liveSkus.length} SKU${proof.liveSkus.length === 1 ? '' : 's'} (${shown}${proof.liveSkus.length > 8 ? ', …' : ''}); ${proof.matchedSkus.length} ${proof.matchedSkus.length === 1 ? 'is' : 'are'} this listing's.`
}
