/**
 * Amazon sheet gaps (gaps 4–5, D1 = A, D2 = A) — the product sheet's stock columns ARE the Matrix's own cells: Mode,
 * Qty and Buffer (`stock_mode`, `stock_qty`, `stock_buffer`) on every channel the Matrix covers, the market's ASIN
 * (`listing_asin`) on Amazon, and the eBay Item ID (`listing_item_id`, Item ID control step I1: docs/sheet-ids-sku-rows). Studio-only, like the relationship columns (`studio-relationships.ts`): never in
 * `buildSheetColumns`, so export, import and the bulk row contract never see them.
 *
 *   read  — ONE `getMatrixRead` per channel sheet; each row carries its coordinate's `MatrixCells` unchanged
 *           (`row.stock`), so the Matrix's words, tooltips and refusal sentences reach the sheet by construction;
 *   write — the sheet sends the Matrix write cell (`sheetStockWriteCell`) to `PATCH /studio/matrix` →
 *           `writeMatrixCells`: the same route, door, CAS and sentences as the Matrix tab;
 *   raw quantity columns (eBay/Etsy `quantity`, Amazon `fulfillment_availability__quantity`) leave the SHEET only —
 *           the channel specs still declare them (`withoutRawQuantityColumns`, like VT.1's raw theme columns);
 *   FBA qty — the Matrix's locked `FBA qty` column (`MatrixRowRead.fba`, Owner 2026-10-07) beside Buffer, from the same
 *           read, on the AMAZON sheet only: eBay, Shopify and Etsy sell from the pool, never from FBA stock (Owner
 *           2026-10-07). Shown, never written: not a stock key, so no write path names it, and the bulk save refuses it.
 */
import {
  MATRIX_CELL_LABELS,
  MATRIX_CELL_WIDTHS,
  MATRIX_COPY,
  type CoordinateKey,
  type MatrixCells,
  type MatrixCoordinate,
  type MatrixFbaStock,
  type MatrixWriteCell,
} from '@nexus/shared/matrix-contract'
import type { SheetColumn, SheetGroup } from './sheet-columns.service.js'
import type { StudioCellValue, StudioRow, WriteRouting } from './studio-sheet.service.js'
import type { SheetListing } from './sheet-rows.service.js'
import { getMatrixRead } from './matrix.service.js'
import { regionKeyFor } from './matrix-cells.js'
import { AMAZON_EU_SHARED_MARKETS } from '../amazon-eu-quantity-guard.js'
import prisma from '../../db.js'
import { suggestedAsinOf, takesSuggestedAsin } from '../identity/channel-id-proofs/amazon-suggested.js'

export const STUDIO_STOCK_KEYS = ['stock_mode', 'stock_qty', 'stock_buffer'] as const
export type StudioStockKey = (typeof STUDIO_STOCK_KEYS)[number]
export const LISTING_ASIN_KEY = 'listing_asin'
/** The channel's own id of a listing other than Amazon's ASIN: eBay's Item ID, Etsy's Listing ID, Shopify's Product ID. */
export const LISTING_ITEM_ID_KEY = 'listing_item_id'
/** Amazon's schema-walked quantity leaf — the raw column the Qty column replaces on the Amazon sheet. */
export const AMAZON_QUANTITY_KEY = 'fulfillment_availability__quantity'
/**
 * The FBA qty column (Owner 2026-10-07): the units Amazon holds for the row's SKU, the Matrix's locked column. NOT one of
 * `STUDIO_STOCK_KEYS` on purpose: those are written through the Matrix door; this one is written by nothing.
 */
export const STOCK_FBA_KEY = 'stock_fba'

type StockCellKind = 'syncMode' | 'syncQty' | 'syncBuffer'
const STOCK_CELL: Readonly<Record<StudioStockKey, StockCellKind>> = { stock_mode: 'syncMode', stock_qty: 'syncQty', stock_buffer: 'syncBuffer' }
/** The channels the Matrix covers (`matrix-cells.ts` CHANNEL_ORDER). */
const STOCK_CHANNELS = new Set(['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY', 'WOOCOMMERCE'])

export const STUDIO_STOCK_GROUP: SheetGroup = { key: 'master:inventory', label: 'Inventory', channelLabel: null, order: 0 }
export const STUDIO_IDENTIFIERS_GROUP: SheetGroup = { key: 'master:identifiers', label: 'Identifiers', channelLabel: null, order: 0 }

/** What a sheet row carries for its stock cells: the Matrix coordinate it shows and writes, and that coordinate's cells. */
export interface StudioRowStock {
  /** The coordinate whose inventory cells this row shows and writes: `AMAZON:EU` (every EU market), `AMAZON:UK`, `EBAY:IT`, `EBAY:IT#<aliasId>`. */
  key: CoordinateKey
  /** The row's own market coordinate. It must hold this row's listing, or the cells belong to another account's. */
  marketKey: CoordinateKey
  /** The Matrix's cells for `key`, unchanged; null when this row has no listing there (or the Matrix holds another one). */
  cells: MatrixCells | null
  coordinate: MatrixCoordinate | null
  /** The Matrix row's FBA stock (`MatrixRowRead.fba`): null = no FBA stock row; absent = not read. Read-only. */
  fba?: MatrixFbaStock | null
}
type StockRow = StudioRow & { stock?: StudioRowStock }

const upper = (s: string | null | undefined) => String(s ?? '').toUpperCase()

/** The coordinate keys of one sheet row: an alias is its own group; an Amazon EU market's inventory sits on `AMAZON:EU`. */
export function studioStockKeys(channel: string, marketplace: string, aliasId: string | null): { key: CoordinateKey; marketKey: CoordinateKey } {
  const ch = upper(channel), mk = upper(marketplace)
  if (aliasId) return { key: `${ch}:${mk}#${aliasId}`, marketKey: `${ch}:${mk}#${aliasId}` }
  return { key: regionKeyFor(ch, mk) ?? `${ch}:${mk}`, marketKey: `${ch}:${mk}` }
}

/* ── columns ───────────────────────────────────────────────────────────────────────────────── */

const STOCK_HELP: Readonly<Record<StudioStockKey, string>> = {
  stock_mode: 'Follow: the quantity follows your stock, minus the buffer. Pinned: Nexus sends the number you set. The Matrix tab shows the same cell.',
  stock_qty: 'The quantity Nexus sends. Typing a number pins it. On Amazon EU it is one quantity for every EU market.',
  stock_buffer: 'Units held back from the stock a following listing sends. A pinned listing ignores it.',
}

/**
 * The three stock columns (never bulk-writable: their write is the Matrix door), then, on Amazon only, the locked FBA qty
 * column (never editable). Empty on a channel the Matrix does not cover.
 */
export function studioStockColumns(channel: string): SheetColumn[] {
  if (!STOCK_CHANNELS.has(upper(channel))) return []
  return [...STUDIO_STOCK_KEYS.map((key): SheetColumn => ({
    key, writeField: key, label: MATRIX_CELL_LABELS[STOCK_CELL[key]], width: MATRIX_CELL_WIDTHS[STOCK_CELL[key]],
    group: STUDIO_STOCK_GROUP.label, groupKey: STUDIO_STOCK_GROUP.key, kind: 'stockControl', storage: 'listing', scope: 'per_variant',
    requiredBy: [], editable: true, defaultVisible: true, formulaWritable: false, helpText: STOCK_HELP[key], matrixCell: STOCK_CELL[key],
  })), ...(upper(channel) === 'AMAZON' ? [fbaColumn()] : [])]
}

/** The FBA qty column: the Matrix's words, locked (`editable: false` routes it as not writable, with this reason). */
function fbaColumn(): SheetColumn {
  return {
    key: STOCK_FBA_KEY, writeField: STOCK_FBA_KEY, label: 'FBA qty', width: 96,
    group: STUDIO_STOCK_GROUP.label, groupKey: STUDIO_STOCK_GROUP.key, kind: 'number', storage: 'listing', scope: 'per_variant',
    requiredBy: [], editable: false, defaultVisible: true, formulaWritable: false, helpText: MATRIX_COPY.fbaLocked,
  }
}

/**
 * The market's ASIN (per market `externalListingId`; the parent row shows the parent ASIN). Amazon only. Not a bulk or
 * formula column: on a row not on Amazon its own control (Item ID control, step I4) sets the ASIN it lists on at Publish.
 */
export function listingAsinColumn(): SheetColumn {
  return {
    key: LISTING_ASIN_KEY, writeField: LISTING_ASIN_KEY, label: 'ASIN', width: 168,
    group: STUDIO_IDENTIFIERS_GROUP.label, groupKey: STUDIO_IDENTIFIERS_GROUP.key, kind: 'text', storage: 'listing', scope: 'per_variant',
    requiredBy: [], editable: false, defaultVisible: true, formulaWritable: false,
    helpText: 'The ASIN Amazon gave this listing on this market. On a row not on Amazon yet, Enter or a double-click sets the ASIN it lists on at Publish (checked in Amazon\'s catalog first).',
  }
}

/** The Item ID column per channel: eBay's Item ID (I1), Etsy's Listing ID (I2), Shopify's Product ID (I3). */
const ITEM_ID_COLUMNS: Readonly<Record<string, { label: string; help: string }>> = {
  EBAY: {
    label: 'Item ID',
    help: 'The eBay Item ID of this listing on this market, shared by the whole variation family. On the main row, Enter or a double-click links another item (checked on eBay first) or clears it.',
  },
  ETSY: {
    label: 'Listing ID',
    help: 'The Etsy Listing ID of this family, one listing for the whole family. On the main row, Enter or a double-click links another listing (checked on Etsy first) or clears it.',
  },
  SHOPIFY: {
    label: 'Product ID',
    help: 'The Shopify product of this listing. It counts only when Shopify returned it as the sheet opened. On the main row, Enter or a double-click links another product (checked on Shopify first) or clears it.',
  },
}

/**
 * The listing's own channel id column (eBay: "Item ID"), or null on a channel that has none here yet. Not a bulk or
 * formula column: the cell changes only through its own control (link / clear, `routes/channel-id.routes.ts`).
 */
export function listingItemIdColumn(channel: string): SheetColumn | null {
  const spec = ITEM_ID_COLUMNS[upper(channel)]
  if (!spec) return null
  return {
    key: LISTING_ITEM_ID_KEY, writeField: LISTING_ITEM_ID_KEY, label: spec.label, width: 168,
    group: STUDIO_IDENTIFIERS_GROUP.label, groupKey: STUDIO_IDENTIFIERS_GROUP.key, kind: 'text', storage: 'listing', scope: 'per_variant',
    requiredBy: [], editable: false, defaultVisible: true, formulaWritable: false, helpText: spec.help,
  }
}

/**
 * Where a stock column's edit lands: the listing, through the Matrix door — never the bulk PATCH. Its write field is
 * not a channel field (`isChannelWritable` refuses it) and not a master field, so no bulk caller can write it.
 */
export function stockControlRouting(col: Pick<SheetColumn, 'key' | 'editable' | 'helpText'>): WriteRouting {
  return { writeField: col.key, writeVerb: 'channel', writeTarget: 'channelListing', affectsAllChannels: false,
    writable: col.editable !== false, writeBlockedReason: col.editable === false ? col.helpText ?? null : null }
}

/** The studio columns this unit adds to a channel sheet, with their routing: the stock columns, then the ASIN on Amazon. */
export function studioStockSheetColumns(channel: string): Array<SheetColumn & WriteRouting & { localizable: boolean; axis: boolean }> {
  const itemId = listingItemIdColumn(channel)
  const cols = [...studioStockColumns(channel), ...(upper(channel) === 'AMAZON' ? [listingAsinColumn()] : []), ...(itemId ? [itemId] : [])]
  return cols.map((col) => ({ ...col, localizable: false, axis: false, formulaWritable: false, ...stockControlRouting(col) }))
}

/** The groups those columns sit in, appended to the sheet's groups when absent. */
export function withStudioStockGroups(groups: readonly SheetGroup[], channel: string): SheetGroup[] {
  if (!STOCK_CHANNELS.has(upper(channel))) return [...groups]
  const wanted = [STUDIO_STOCK_GROUP, ...(upper(channel) === 'AMAZON' || listingItemIdColumn(channel) ? [STUDIO_IDENTIFIERS_GROUP] : [])]
  let order = groups.reduce((max, g) => Math.max(max, g.order), 0)
  return [...groups, ...wanted.filter((g) => !groups.some((h) => h.key === g.key)).map((g) => ({ ...g, order: ++order }))]
}

/**
 * A raw quantity column the stock columns replace on the sheet: a channel field stored in the listing's `quantity`
 * column (eBay, Etsy), and Amazon's quantity leaf. The ONE rule the sheet filter and the bulk quantity door share.
 */
export function isRawQuantityColumn(col: Pick<SheetColumn, 'key' | 'channels'>, channel: string): boolean {
  if (upper(channel) === 'AMAZON' && col.key === AMAZON_QUANTITY_KEY) return true
  return Object.values(col.channels ?? {}).some((f) => f.store?.kind === 'listingColumn' && f.store.column === 'quantity')
}

/** The sheet's columns without the raw quantity columns (the specs keep declaring them). */
export function withoutRawQuantityColumns<C extends Pick<SheetColumn, 'key' | 'channels'>>(columns: readonly C[], channel: string): C[] {
  return columns.filter((col) => !isRawQuantityColumn(col, channel))
}

/* ── values ────────────────────────────────────────────────────────────────────────────────── */

function stockValue(key: string, value: unknown, writable: boolean, reason: string | null, alias: boolean): StudioCellValue {
  return {
    value, source: 'matrix', inheritedFrom: null, inherited: false, layer: alias ? 'alias' : 'channel', pinned: false, follows: null,
    editable: writable, linkGroupId: null, mapped: null, resettable: false,
    writeField: key, writeTarget: 'channelListing', writeVerb: 'channel', affectsAllChannels: false,
    writable, writeBlockedReason: writable ? null : reason,
  }
}

const PARENT_ASIN = 'Parent ASIN — not buyable'
const ASIN_READ_ONLY = 'Amazon assigns the ASIN; Nexus shows it.'
const ASIN_LISTS_ON = (asin: string) => `Lists on ${asin} at Publish: the ASIN this row lists on when Publish sends it (not on Amazon yet). Enter or a double-click changes or clears it.`

/**
 * A channel id cell with what it does not hold yet: Amazon's draft row carries the ASIN it lists on at Publish
 * (`pendingId`, never its value — the value is the id that counts). The web reads it to say "Lists on B0X at Publish".
 */
export type ListingIdCellValue = StudioCellValue & { pendingId?: { id: string; sentence: string } }

/**
 * The ASIN cell of one row: the listing's `externalListingId` on this market (a parent row: the parent ASIN). A row with
 * a listing is its control's door (`writable`, so Enter opens the control without a refusal); the control decides what
 * may change (a live offer's ASIN is Amazon's). `suggested`: the ASIN a row not on Amazon lists on at Publish.
 */
export function listingAsinValue(row: Pick<StudioRow, 'isParent' | 'aliasId'> & { listing: Pick<SheetListing, 'externalListingId'> | null }, suggested: string | null = null): ListingIdCellValue {
  const asin = row.listing?.externalListingId ?? null
  const reason = !row.listing ? MATRIX_COPY.noListingYet : row.isParent ? PARENT_ASIN : ASIN_READ_ONLY
  const value: ListingIdCellValue = stockValue(LISTING_ASIN_KEY, asin, !!row.listing, !asin && suggested ? ASIN_LISTS_ON(suggested) : reason, !!row.aliasId)
  if (!asin && suggested && row.listing) value.pendingId = { id: suggested, sentence: `Lists on ${suggested} at Publish` }
  return value
}

/* ── the eBay Item ID cell (Item ID control, step I1) ───────────────────────────────────────── */

type ItemIdListing = Pick<SheetListing, 'externalListingId' | 'listingStatus' | 'isPublished'> & Partial<Pick<SheetListing, 'lastSyncStatus'>>
type ItemIdRow = Pick<StudioRow, 'id' | 'parentId' | 'aliasId'> & { listing: ItemIdListing | null }

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const statusOf = (listing: ItemIdListing) => upper(listing.listingStatus).trim()

/** The sentences of the Item ID cell, one per state (A-item-ids.md, "States"). Exported for the tests and the web's mirror. */
export const ITEM_ID_COPY = {
  live: 'eBay Item ID of this listing. On the main row, Enter or a double-click links another item or clears it.',
  ended: 'This item ended on eBay. Relist makes a new Item ID.',
  draft: 'Draft · not published: eBay gives the Item ID when Nexus publishes it.',
  notConfirmed: (id: string, status: string) => `Not confirmed: Nexus holds Item ID ${id}, but this listing reads ${status ? status.toLowerCase() : 'no status'} in Nexus, so it is not known to sell on eBay. On the main row, Check asks eBay.`,
  otherItem: (id: string, main: string | null) => `Not confirmed: this row holds Item ID ${id}, ${main ? `but the main row holds ${main}` : 'but the main row holds none'}. One eBay item carries the whole variation family: check it on the main row.`,
  noNumber: 'No number recorded: this listing reads live in Nexus, but Nexus holds no eBay Item ID for it. On the main row, type the Item ID to link it.',
  none: 'No eBay Item ID here.',
  variation: 'Set on the main row: one eBay Item ID carries the whole variation family.',
} as const

/** Etsy's Listing ID cell (step I2): one listing per family; Etsy is read every 4 hours (`etsy-content-refresh.job.ts`). */
export const ETSY_LISTING_ID_COPY = {
  live: 'Etsy Listing ID of this family. On the main row, Enter or a double-click links another listing or clears it.',
  ended: 'This listing ended on Etsy (expired or removed).',
  draft: 'Draft · not published: Etsy gives the Listing ID when Nexus publishes it.',
  notConfirmed: (id: string, status: string) => `Not confirmed: Nexus holds Listing ID ${id}, but this listing reads ${status ? status.toLowerCase() : 'no status'} in Nexus, so it is not known to sell on Etsy. On the main row, Check asks Etsy.`,
  missing: (id: string) => `Not confirmed: Nexus holds Listing ID ${id}, but Etsy did not return it on its last read of this shop. On the main row, Check asks Etsy.`,
  otherItem: (id: string, main: string | null) => `Not confirmed: this row holds Listing ID ${id}, ${main ? `but the main row holds ${main}` : 'but the main row holds none'}. One Etsy listing carries the whole family: check it on the main row.`,
  noNumber: 'No number recorded: this listing reads live in Nexus, but Nexus holds no Etsy Listing ID for it. On the main row, type the Listing ID to link it.',
  none: 'No Etsy Listing ID here.',
  variation: 'Set on the main row: one Etsy listing carries the whole family.',
} as const

/** Shopify's Product ID cell (step I3): it counts only when the open sheet's Shopify read returned the row. */
export const SHOPIFY_PRODUCT_ID_COPY = {
  live: 'Shopify Product ID of this listing, as Shopify returned it when the sheet opened. On the main row, Enter or a double-click links another product or clears it.',
  notConfirmed: (id: string) => `Not confirmed: Nexus holds Shopify product ${id}, but Shopify did not return it when the sheet opened. On the main row, Check asks Shopify.`,
  draft: 'Draft · not published: Shopify gives the product its id when Nexus publishes it.',
  noNumber: 'No number recorded: this listing reads live in Nexus, but Nexus holds no Shopify product for it. On the main row, type the Product ID to link it.',
  none: 'No Shopify product here.',
  variation: 'Set on the main row: the family\'s Shopify product (in a colour store, each colour\'s product) is linked there.',
} as const

/** What one row's Item ID reads as (A-item-ids.md, "States"). */
export type ItemIdState = 'noListing' | 'draft' | 'live' | 'ended' | 'notConfirmed' | 'otherItem' | 'noNumber' | 'none'

/**
 * The state of one row's channel id and its sentence (the hover); `value` is the id only when it counts (live, ended).
 * eBay and Etsy: the Nexus record (Active / Inactive / Ended), a variation holding the main row's id; Etsy also "Not
 * confirmed" when its last read did not find the listing (MISSING). Shopify: never confirmed here — only the open
 * sheet's Shopify read confirms a row (`confirmShopifyItemIds`); a held id reads "Not confirmed" until then.
 */
export function listingItemIdState(row: ItemIdRow, main: ItemIdRow | null, channel = 'EBAY'): { state: ItemIdState; value: string | null; sentence: string } {
  const listing = row.listing
  if (!listing) return { state: 'noListing', value: null, sentence: MATRIX_COPY.noListingYet }
  const ch = upper(channel)
  const copy = ch === 'ETSY' ? ETSY_LISTING_ID_COPY : ch === 'SHOPIFY' ? null : ITEM_ID_COPY
  const id = text(listing.externalListingId)
  const status = statusOf(listing)
  if (id) {
    if (!copy) return { state: 'notConfirmed', value: null, sentence: SHOPIFY_PRODUCT_ID_COPY.notConfirmed(id) }
    const mainId = main?.listing ? text(main.listing.externalListingId) || null : null
    if (row.parentId && main && mainId !== id) return { state: 'otherItem', value: null, sentence: copy.otherItem(id, mainId) }
    if (ch === 'ETSY' && upper(listing.lastSyncStatus) === 'MISSING') return { state: 'notConfirmed', value: null, sentence: ETSY_LISTING_ID_COPY.missing(id) }
    if (status === 'ACTIVE' || status === 'INACTIVE') return { state: 'live', value: id, sentence: copy.live }
    if (status === 'ENDED') return { state: 'ended', value: id, sentence: copy.ended }
    return { state: 'notConfirmed', value: null, sentence: copy.notConfirmed(id, status) }
  }
  const words = copy ?? SHOPIFY_PRODUCT_ID_COPY
  if (status === 'DRAFT' && listing.isPublished === false) return { state: 'draft', value: null, sentence: words.draft }
  if (status === 'ACTIVE' || listing.isPublished) return { state: 'noNumber', value: null, sentence: words.noNumber }
  return { state: 'none', value: null, sentence: words.none }
}

/**
 * The eBay Item ID cell of one row: the id only when it counts (the listing reads live or ended in Nexus, and a
 * variation holds the same item as its main row); otherwise null. Nothing here asks eBay: a held id Nexus cannot vouch
 * for is "Not confirmed", and the main row's Check asks eBay. The main row's cell is writable — its own control links
 * or clears it (never the bulk or formula paths: the column is not editable) — so the sheet does not announce a refusal
 * when Enter opens that control; a variation row is read-only and says why ("Set on the main row").
 */
export function listingItemIdValue(row: ItemIdRow, main: ItemIdRow | null, channel = 'EBAY'): StudioCellValue {
  const { state, value, sentence } = listingItemIdState(row, main, channel)
  const isMain = !row.parentId
  const writable = isMain && !!row.listing
  const variation = upper(channel) === 'ETSY' ? ETSY_LISTING_ID_COPY.variation : upper(channel) === 'SHOPIFY' ? SHOPIFY_PRODUCT_ID_COPY.variation : ITEM_ID_COPY.variation
  const reason = isMain ? sentence
    : state === 'live' || state === 'ended' ? variation
    : state === 'otherItem' ? sentence
    : `${sentence} ${variation}`
  return stockValue(LISTING_ITEM_ID_KEY, value, writable, reason, !!row.aliasId)
}

/**
 * Shopify (step I3): a row counts as live only when the open sheet's Shopify read returned it (`row.shopify`, set by
 * `projectShopifyChannelSheet`). Runs after `enrichShopifyChannelSheet` (information-sheet.ts): a returned row's Product
 * ID is its value (with the status Shopify reported on the row's listing); every other row keeps "Not confirmed".
 */
export function confirmShopifyItemIds<R extends StudioRow>(rows: R[]): R[] {
  let changed = false
  const out = rows.map((row) => {
    const cell = row.values?.[LISTING_ITEM_ID_KEY]
    const id = text(row.listing?.externalListingId)
    if (!cell || !row.shopify || !id) return row
    changed = true
    // The main row is its control's door (writable, no refusal to announce); a variation row says where it is set.
    return { ...row, values: { ...row.values, [LISTING_ITEM_ID_KEY]: { ...cell, value: id, writeBlockedReason: cell.writable ? null : SHOPIFY_PRODUCT_ID_COPY.variation } } }
  })
  // Nothing returned by Shopify: the same rows (callers may compare by identity).
  return changed ? out : rows
}

/**
 * Fill every row's stock cells (and, on Amazon, its ASIN) from ONE Matrix read of the family. Each row gets
 * `row.stock` (the cells the web draws and writes) and `values.stock_*` (value = mode / `sync.intended` / `sync.buffer`
 * for counts and export; writable and the reason are the Matrix's `writable` / `writeBlockedReason`). A row without a
 * listing, or whose market the Matrix shows with another listing (another account's), is held with the Matrix's words.
 */
export async function attachStudioStock(input: {
  rows: StockRow[]
  rootId: string
  channel: string
  marketplace: string
  /** The sheet's account (`context.connectionId`): the Matrix reads with it, as the Matrix tab does. */
  accountId: string | null
}): Promise<{ ms: number }> {
  const t0 = Date.now()
  const ch = upper(input.channel)
  if (!STOCK_CHANNELS.has(ch) || input.rows.length === 0) return { ms: 0 }
  const keys = new Map(input.rows.map((row) => [row, studioStockKeys(ch, input.marketplace, row.aliasId)]))
  // An EU group row also reads every EU market's cells: the account check below finds the group's listing among them.
  const only = [...new Set([...keys.values()].flatMap((k) => [k.key, k.marketKey, ...(k.key === k.marketKey ? [] : [...AMAZON_EU_SHARED_MARKETS].map((m) => `${ch}:${m}`))]))]
  const read = await getMatrixRead({ productId: input.rootId, accountId: input.accountId, canEditPrice: false, only })
  const matrixRow = new Map(read.rows.map((r) => [r.id, r]))
  const coordinate = new Map(read.coordinates.map((c) => [c.key, c]))
  // Amazon (step I4): the ASIN each row not on Amazon lists on at Publish — one read of those rows' own store.
  const suggested = ch === 'AMAZON' ? await suggestedAsins(input.rows) : new Map<string, string>()

  for (const row of input.rows) {
    const { key, marketKey } = keys.get(row)!
    const cells = matrixRow.get(row.id)?.cells ?? {}
    // The Matrix must hold THIS row's listing on its market — and an EU group must be the sheet account's: its account,
    // and its listing one this account holds on an EU market. Otherwise its write would land on another account's rows.
    const groupListing = cells[key]?.listingId
    const sameAccount = cells[marketKey]?.listingId === row.listing?.id && (key === marketKey || (coordinate.get(key)?.accountId === input.accountId
      && read.coordinates.some((c) => c.inventoryOn === key && c.accountId === input.accountId && cells[c.key]?.listingId === groupListing)))
    const held = !row.listing ? MATRIX_COPY.noListingYet
      : !sameAccount ? MATRIX_COPY.accountMismatch
      : !cells[key] ? MATRIX_COPY.noListingYet : null
    const own = held ? null : cells[key]!
    // Amazon only: FBA units belong to the SKU, not to a listing, so a held row shows them too. `undefined` (not read) stays absent.
    const fba = ch === 'AMAZON' ? matrixRow.get(row.id)?.fba : undefined
    row.stock = { key, marketKey, cells: own, coordinate: coordinate.get(key) ?? null, ...(fba !== undefined ? { fba } : {}) }
    const sync = own?.sync ?? null
    const valueOf: Record<StudioStockKey, unknown> = { stock_mode: sync?.mode ?? null, stock_qty: sync?.intended ?? null, stock_buffer: sync?.buffer ?? null }
    for (const k of STUDIO_STOCK_KEYS) {
      const kind = STOCK_CELL[k]
      const writable = !!own && own.writable[kind] === true
      row.values[k] = stockValue(k, valueOf[k], writable, held ?? own?.writeBlockedReason[kind] ?? 'This cell cannot be changed here', !!row.aliasId)
    }
    if (ch === 'AMAZON') row.values[STOCK_FBA_KEY] = stockValue(STOCK_FBA_KEY, fba?.units ?? null, false, MATRIX_COPY.fbaLocked, !!row.aliasId)
    if (ch === 'AMAZON') row.values[LISTING_ASIN_KEY] = listingAsinValue(row, row.listing ? suggested.get(row.listing.id) ?? null : null)
    if (ITEM_ID_COLUMNS[ch]) {
      // A variation's main row is its parent's row in the same group (the primary listing, or the same alias).
      const main = row.parentId ? input.rows.find((r) => r.id === row.parentId && (r.aliasId ?? null) === (row.aliasId ?? null)) ?? null : null
      row.values[LISTING_ITEM_ID_KEY] = listingItemIdValue(row, main, ch)
    }
  }
  return { ms: Date.now() - t0 }
}

/** listing id → the ASIN it lists on at Publish, for the Amazon rows not on Amazon (no ASIN; DRAFT or unpublished). */
async function suggestedAsins(rows: readonly StockRow[]): Promise<Map<string, string>> {
  const ids = rows.flatMap((row) => row.listing && takesSuggestedAsin(row.listing) ? [row.listing.id] : [])
  if (!ids.length) return new Map()
  const listings = await prisma.channelListing.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, overrideData: true } })
  return new Map(listings.flatMap((l) => { const asin = suggestedAsinOf(l.overrideData); return asin ? [[l.id, asin] as [string, string]] : [] }))
}

/** The Matrix write cell for one stock column edit on a sheet row — exactly what the Matrix tab sends for that cell. */
export function sheetStockWriteCell(row: { id: string; stock?: StudioRowStock }, column: StudioStockKey, value: unknown): MatrixWriteCell | null {
  const cells = row.stock?.cells
  if (!row.stock || !cells?.listingId) return null
  return { rowId: row.id, coordinateKey: row.stock.key, cell: STOCK_CELL[column], value, expectedVersion: cells.version, expectedListingId: cells.listingId }
}

/* ── Shopify (D2 = A) ──────────────────────────────────────────────────────────────────────── */

/** Shopify's native "Inventory quantity" field (its available / on-hand columns). */
export const isShopifyInventoryColumn = (col: Pick<SheetColumn, 'shopifyField'>): boolean => col.shopifyField?.id === 'inventory'

export { shopifyInventoryHeldReason } from './shopify-inventory-hold.js'
