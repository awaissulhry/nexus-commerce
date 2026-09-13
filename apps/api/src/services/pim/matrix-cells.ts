/**
 * MX.1 — the Matrix read's PURE rules: the listing-state table, the queue fold, the writable rules, the
 * coordinate order and the per-channel absences. No Prisma, no I/O — `matrix.service.ts` runs the queries and
 * hands the facts here, so every rule is pinned by `matrix-cells.vitest.test.ts` without a database and the
 * web fixture's cases (`_studio/matrix/matrix.vitest.test.ts`) can be replayed against the LIVE rules.
 *
 * One truth per cell (design §3.1): `sync.kind` is `resolveIntendedQuantity`'s verdict carried verbatim (the
 * resolver runs in the service; this module only SHAPES its output), `price.value` is the number the push reads,
 * `listing.state` is the nine-word vocabulary derived from the columns named in the table below. Every sentence
 * an operator can see is `MATRIX_COPY`'s (`@nexus/shared/matrix-contract`) — the page's own words, one source.
 */
import {
  INVENTORY_CELL_KINDS,
  MATRIX_CELL_KINDS,
  MATRIX_COPY,
  type CoordinateKey,
  type FulfilmentMethod,
  type ListingCell,
  type ListingState,
  type MatrixCellKind,
  type MatrixCells,
  type PriceCell,
  type QueueCell,
  type QueueState,
  type SyncCell,
} from '@nexus/shared/matrix-contract'
import { AMAZON_EU_SHARED_MARKETS } from '../amazon-eu-quantity-guard.js'
import type { IntendedResolution } from '../sync-control-core.js'

/* ── coordinates ───────────────────────────────────────────────────────────────────────────── */

/** Design D-MX12: Amazon · eBay · Shopify · Etsy · WooCommerce; anything else after. */
const CHANNEL_ORDER = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY', 'WOOCOMMERCE']
export const channelRank = (channel: string): number => {
  const i = CHANNEL_ORDER.indexOf(channel.toUpperCase())
  return i === -1 ? CHANNEL_ORDER.length : i
}

/**
 * Market order inside a channel: the guard's own EU set in its declared order (IT DE FR ES NL BE PL SE IE — the
 * home market first, then the order the SCT.4 programme wrote them in), then UK, then the rest alphabetically.
 * `Marketplace` has no sort column of its own; this is the one order every Matrix strip agrees on.
 */
const MARKET_ORDER = [...AMAZON_EU_SHARED_MARKETS, 'UK', 'TR', 'US', 'GLOBAL']
export const marketRank = (market: string): number => {
  const i = MARKET_ORDER.indexOf(market.toUpperCase())
  return i === -1 ? MARKET_ORDER.length : i
}
export const compareMarkets = (a: string, b: string): number => marketRank(a) - marketRank(b) || a.localeCompare(b)

export const isAmazonEuMarket = (channel: string, market: string): boolean =>
  channel.toUpperCase() === 'AMAZON' && AMAZON_EU_SHARED_MARKETS.has(market.toUpperCase())

export const CHANNEL_LABEL: Readonly<Record<string, string>> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' }
export const channelLabel = (channel: string): string => CHANNEL_LABEL[channel.toUpperCase()] ?? channel

/** ① … ⑳ for an alias position (position 1 = the second listing = ②), matching the preview fixture's labels. */
export const circled = (n: number): string => (n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : `(${n})`)

export const MERCHANT_CHANNELS = new Set(['EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])

/** The kinds a channel SERVES, the ones it has no store for (with the operator's sentence), and its fulfilment words. */
export function channelShape(channel: string): { cells: MatrixCellKind[]; absent: Array<{ cell: MatrixCellKind; reason: string }>; fulfilment: FulfilmentMethod[] | null } {
  const ch = channel.toUpperCase()
  let cells: MatrixCellKind[] = [...MATRIX_CELL_KINDS]
  const absent: Array<{ cell: MatrixCellKind; reason: string }> = []
  if (ch === 'EBAY') { cells = cells.filter((k) => k !== 'salePrice'); absent.push({ cell: 'salePrice', reason: MATRIX_COPY.absentSaleEbay }) }
  if (ch !== 'AMAZON' && ch !== 'EBAY') { cells = cells.filter((k) => k !== 'fulfilment'); absent.push({ cell: 'fulfilment', reason: MATRIX_COPY.absentFulfilment(channelLabel(ch)) }) }
  const fulfilment: FulfilmentMethod[] | null = ch === 'AMAZON' ? ['FBA', 'FBM'] : ch === 'EBAY' ? ['FBM', 'MCF'] : null
  return { cells, absent, fulfilment }
}

/* ── business pricing (design §3.11, D-MX5) ───────────────────────────────────────────────── */

export type BusinessAbsence = { cell: 'businessPrice' | 'businessTiers'; reason: string }

/**
 * Business pricing is served ABSENT on an Amazon market coordinate until that market's cached product-type schema exposes
 * the B2B audience (`purchasable_offer … audience` enum ∋ `B2B`) — derived per coordinate from the cache the read already
 * trusts, never hardcoded (MX.1 phase 0(b): every cached schema says `["ALL"]` today). Three honest sentences: no cached
 * schema (nothing to check against), a schema without B2B (Amazon has not enabled it), a schema WITH B2B (the cells are not
 * built yet — the day this arm fires, a lane adds `businessPrice`/`businessTiers` to `MatrixCellKind`). `audience` is the
 * flattened enum; `null` = no active schema is cached for (productType, market).
 */
export function businessAbsence(input: { productType: string | null; market: string; audience: readonly string[] | null }): BusinessAbsence[] {
  const reason = input.audience === null || !input.productType
    ? MATRIX_COPY.absentBusinessUnchecked(input.market)
    : input.audience.includes('B2B')
      ? MATRIX_COPY.absentBusinessNotBuilt(input.productType, input.market)
      : MATRIX_COPY.absentBusiness(input.productType, input.market)
  return [{ cell: 'businessPrice', reason }, { cell: 'businessTiers', reason }]
}

/** The flattened `audience` enum out of `jsonb_path_query_array(… '$.properties.purchasable_offer.**.audience.**.enum')` — `[["ALL"]]` → `['ALL']`. */
export function flattenAudience(raw: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown) => { if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'string') out.push(v) }
  walk(raw)
  return [...new Set(out)]
}

/** A market coordinate inside a shared region carries NO inventory kinds — they live on the region group. */
export const withoutInventory = (cells: readonly MatrixCellKind[]): MatrixCellKind[] => cells.filter((k) => !INVENTORY_CELL_KINDS.includes(k))

/* ── listing state ─────────────────────────────────────────────────────────────────────────── */

export interface ListingFacts {
  listingStatus: string
  isPublished: boolean
  externalListingId: string | null
  offerClosedAt: Date | string | null
  /** An OPEN `AmazonSuppression` episode (resolvedAt null) exists for this listing. */
  suppressed: boolean
  /** VP.2's `variationExcluded` flag. */
  excluded: boolean
  /** A variant missing a value for at least one family axis (VP.2's `needs_value`). */
  needsValue: boolean
}

/**
 * The listing-state TABLE (pinned by the test; precedence top to bottom):
 *
 *   excluded (variationExcluded)                       → excluded
 *   offerClosedAt set                                  → closed
 *   an open AmazonSuppression                          → suppressed
 *   listingStatus ENDED | REMOVED                      → ended
 *   listingStatus ERROR                                → error
 *   a variant missing an axis value                    → needs-value
 *   listingStatus DISCOVERABLE                         → listed · detail `not buyable` (Amazon's own meaning)
 *   listingStatus INACTIVE                             → listed · detail `inactive`
 *   listingStatus ACTIVE | BUYABLE, or an external id  → listed
 *   anything else (DRAFT …)                            → draft
 *
 * `published` is `isPublished` verbatim on every row; it is a separate fact from the word.
 */
export function listingStateOf(f: ListingFacts): ListingCell {
  const status = String(f.listingStatus ?? '').toUpperCase()
  let state: ListingState
  let detail: string | null = null
  if (f.excluded) state = 'excluded'
  else if (f.offerClosedAt) state = 'closed'
  else if (f.suppressed) state = 'suppressed'
  else if (status === 'ENDED' || status === 'REMOVED') state = 'ended'
  else if (status === 'ERROR') state = 'error'
  else if (f.needsValue) state = 'needs-value'
  else if (status === 'DISCOVERABLE') { state = 'listed'; detail = 'not buyable' }
  else if (status === 'INACTIVE') { state = 'listed'; detail = 'inactive' }
  else if (status === 'ACTIVE' || status === 'BUYABLE' || f.externalListingId) state = 'listed'
  else state = 'draft'
  return { state, externalId: f.externalListingId ?? null, detail, published: f.isPublished === true }
}

/* ── fulfilment ────────────────────────────────────────────────────────────────────────────── */

/** The route's own derivation (`product-channel-data.routes.ts` FCF.4b), for a listing whose typed column is null. */
export function deriveFulfilment(channel: string, flatChannel: unknown, productMethod: string | null): FulfilmentMethod {
  if (MERCHANT_CHANNELS.has(channel.toUpperCase())) return 'FBM'
  const s = typeof flatChannel === 'string' ? flatChannel.toUpperCase() : ''
  if (s === 'AFN' || s === 'FBA') return 'FBA'
  if (s === 'MFN' || s === 'FBM' || s === 'MERCHANT') return 'FBM'
  return String(productMethod ?? '').toUpperCase() === 'FBA' ? 'FBA' : 'FBM'
}

/** Amazon's last REPORTED channel — the nested key the flat-file PULL writes from Amazon's own data. */
export function reportedFulfilment(platformAttributes: unknown): 'AFN' | 'MFN' | null {
  const code = String((platformAttributes as { fulfillment_availability?: Array<{ fulfillment_channel_code?: unknown }> } | null)?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '').toUpperCase()
  if (code.startsWith('AMAZON') || code === 'AFN') return 'AFN'
  if (code === 'DEFAULT' || code === 'MFN') return 'MFN'
  return null
}

/* ── sync ──────────────────────────────────────────────────────────────────────────────────── */

export interface SyncFacts {
  followMasterQuantity: boolean | null
  /** `ChannelListing.quantity` — what the channel currently holds. */
  held: number | null
  buffer: number
  /** The rows of the WAREHOUSE ledger that ROUTE to this coordinate (`locationServes`), or [] when none do. */
  routed: ReadonlyArray<{ locationCode: string; available: number }>
  fbaAtAmazon: number | null
  /** `computeAvailableToPublish(...).available` for an FBM row — the ceiling the channel may not exceed. */
  publishable: number | null
}

/** `resolveIntendedQuantity`'s output VERBATIM in `kind`/`via`/`intended`; the rest are the facts beside it. */
export function syncCellOf(res: IntendedResolution, f: SyncFacts): SyncCell {
  const poolAvailable = f.routed.length === 0 ? null : f.routed.reduce((s, r) => s + r.available, 0)
  const intended = res.kind === 'FOLLOW' ? res.quantity : res.kind === 'PINNED' ? res.quantity : null
  return {
    kind: res.kind,
    via: res.kind === 'PAUSED' ? res.via : null,
    mode: f.followMasterQuantity === false ? 'PINNED' : 'FOLLOW',
    intended,
    held: f.held,
    buffer: f.buffer,
    poolAvailable,
    routedLocations: f.routed.map((r) => r.locationCode),
    fbaAtAmazon: f.fbaAtAmazon,
    oversold: res.kind !== 'FBA_EXCLUDED' && f.held != null && f.publishable != null && f.held > f.publishable,
  }
}

/* ── queue ─────────────────────────────────────────────────────────────────────────────────── */

export interface QueueRowFacts {
  syncType: string
  syncStatus: string
  isDead: boolean
  errorMessage: string | null
  /** The newest of syncedAt / updatedAt / createdAt, ISO. */
  at: string | null
}

const QUEUE_RANK: Record<QueueState, number> = { dead: 6, failed: 5, sending: 4, queued: 3, paused: 2, sent: 1, never: 0 }

function queueStateOf(row: QueueRowFacts): { state: QueueState; reason: string | null } {
  const s = row.syncStatus.toUpperCase()
  if (s === 'PENDING') return { state: 'queued', reason: null }
  if (s === 'IN_PROGRESS') return { state: 'sending', reason: null }
  if (s === 'SUCCESS') return { state: 'sent', reason: null }
  if (s === 'FAILED') return { state: row.isDead ? 'dead' : 'failed', reason: row.errorMessage }
  /* SKIPPED (gated, dry-run, guard-held) reached no channel: an honest non-success carrying the server's sentence. */
  return { state: row.isDead ? 'dead' : 'failed', reason: row.errorMessage ?? `Skipped (${s.toLowerCase()})` }
}

/**
 * Fold the newest QUANTITY_UPDATE and PRICE_UPDATE rows to ONE state — the WORST of the two (design §3.4).
 * `rows` are the newest non-cancelled row per syncType (the service selects them distinct). A PAUSED resolver
 * verdict wins outright; on an FBA row the quantity lane is `never` (nothing is ever pushed) so only a price
 * row can speak.
 */
export function foldQueue(rows: readonly QueueRowFacts[], sync: SyncCell | null): QueueCell {
  if (sync?.kind === 'PAUSED') return { state: 'paused', at: null, reason: null, syncType: null, via: sync.via }
  const usable = sync?.kind === 'FBA_EXCLUDED' ? rows.filter((r) => r.syncType !== 'QUANTITY_UPDATE') : rows
  let best: QueueCell | null = null
  for (const r of usable) {
    const { state, reason } = queueStateOf(r)
    const cell: QueueCell = { state, at: r.at, reason, syncType: r.syncType === 'PRICE_UPDATE' ? 'PRICE_UPDATE' : 'QUANTITY_UPDATE', via: null }
    if (!best || QUEUE_RANK[state] > QUEUE_RANK[best.state]) best = cell
  }
  return best ?? { state: 'never', at: null, reason: null, syncType: null, via: null }
}

/* ── price ─────────────────────────────────────────────────────────────────────────────────── */

export interface PriceFacts {
  price: number | null
  priceOverride: number | null
  followMasterPrice: boolean | null
  basePrice: number | null
  currency: string
  formula: string | null
  /** From the pricing snapshot when one exists: `isClamped` + which bound bit. */
  clamped: 'floor' | 'ceiling' | null
}

/** `value` is what the push reads (`ChannelListing.price`), falling back to the base price ONLY on a master-following row. */
export function priceCellOf(f: PriceFacts): PriceCell {
  const source: PriceCell['source'] = f.formula != null ? 'formula' : f.followMasterPrice === false ? 'override' : 'master'
  const value = f.price ?? (source === 'master' ? f.basePrice : f.priceOverride)
  return { value, currency: f.currency, source, formula: f.formula, clamped: f.clamped }
}

/* ── writable ──────────────────────────────────────────────────────────────────────────────── */

export interface WritableInput {
  role: 'parent' | 'variant'
  cells: readonly MatrixCellKind[]
  sync: SyncCell | null
  /** The stored method vs the guard's verdict — a stored FBM under an FBA guard says WHY with the guard's sentence. */
  fulfilment: { method: FulfilmentMethod | null; guard: 'FBA' | 'FBM' | null } | null
  price: PriceCell | null
  canEditPrice: boolean
}

export const PARENT_REASON = 'Set on the variants — the parent has no listing of its own'
export const PARENT_PRICE_REASON = 'The parent is not buyable — set prices on the variants'
export const PINNED_BUFFER_REASON = 'A pinned listing ignores its buffer — set it to Follow first'
export const FORMULA_REASON = 'A formula owns this cell — edit the formula'
export const PRICE_PERMISSION_REASON = 'You do not have permission to change prices (products.price.edit)'

/**
 * The SAME rules `fixtures.ts` encodes (parent · FBA → Amazon-managed · pinned buffer · formula-owned), plus the
 * two the live read can know: a missing `products.price.edit` holds the price cells, a CLOSED offer holds the
 * inventory lane. ONE deliberate difference from the fixture (MX.P's live reading, 2026-09-13): the PARENT's price
 * cells are held too — a parent ASIN has no offer, and offer data on the parent message is the documented
 * "attribute not valid for parent" feed failure (FFP.3) — so the parent writes NOTHING. A stored FBM under an FBA guard is held with the GUARD's sentence rather than `Amazon-managed`,
 * so the operator sees the disagreement instead of a lock.
 */
export function writableFor(input: WritableInput): Pick<MatrixCells, 'writable' | 'writeBlockedReason'> {
  const writable: MatrixCells['writable'] = {}
  const writeBlockedReason: MatrixCells['writeBlockedReason'] = {}
  const hold = (k: MatrixCellKind, reason: string) => { writable[k] = false; writeBlockedReason[k] = reason }
  for (const k of input.cells) {
    if (k === 'listing' || k === 'syncState') continue
    const inventory = INVENTORY_CELL_KINDS.includes(k)
    if (input.role === 'parent') { hold(k, k === 'price' || k === 'salePrice' ? PARENT_PRICE_REASON : PARENT_REASON); continue }
    if ((k === 'price' || k === 'salePrice') && !input.canEditPrice) { hold(k, PRICE_PERMISSION_REASON); continue }
    if (inventory && input.sync?.kind === 'CLOSED') { hold(k, MATRIX_COPY.closedHint); continue }
    if (inventory && k !== 'fulfilment' && input.sync?.kind === 'FBA_EXCLUDED') {
      hold(k, input.fulfilment?.method === 'FBM' && input.fulfilment.guard === 'FBA' ? MATRIX_COPY.guardFba : MATRIX_COPY.amazonManaged)
      continue
    }
    if (k === 'syncBuffer' && input.sync?.mode === 'PINNED') { hold(k, PINNED_BUFFER_REASON); continue }
    if (k === 'price' && input.price?.source === 'formula') { hold(k, FORMULA_REASON); continue }
    writable[k] = true
  }
  return { writable, writeBlockedReason }
}

/** Which coordinate carries a target's INVENTORY cells — the region group for an EU market (mirrors the preview's rule). */
export const regionKeyFor = (channel: string, market: string): CoordinateKey | null =>
  isAmazonEuMarket(channel, market) ? 'AMAZON:EU' : null
