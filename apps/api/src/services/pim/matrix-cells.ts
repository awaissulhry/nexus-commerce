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
 *
 * Build shape v2 (P7): the Listing cell's selling word (Active · Inactive · Mixed · Ended · Not listed) is THE
 * engine's (`destinationSellingStates`, listing-action.service.ts — the sheet's Status column reads the same), carried
 * as `listing.selling`; `listing.state` follows it below the health words.
 */
import type { SellingStateRead } from '@nexus/shared/listing-actions'
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
  type PushFailure,
  type QueueCell,
  type QueueState,
  type SourceCell,
  type SyncCell,
} from '@nexus/shared/matrix-contract'
import { AMAZON_EU_SHARED_MARKETS } from '../amazon-eu-quantity-guard.js'
import { amazonFulfilmentCodes, describeAmazonFulfilmentCode, isFbaFulfilmentCode } from '../../lib/amazon-fulfilment-programme.js'
import { locationServes, marketSourceKey, sellsFrom, type IntendedResolution, type MarketSources, type SyncLedger } from '../sync-control-core.js'

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
  // 2026-09-30 — Etsy's listing API has no sale price (Etsy sales are shop promotions), so the cell is absent, not offered.
  if (ch === 'ETSY') { cells = cells.filter((k) => k !== 'salePrice'); absent.push({ cell: 'salePrice', reason: MATRIX_COPY.absentSaleEtsy }) }
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
    ? MATRIX_COPY.absentBusinessUnchecked()
    : input.audience.includes('B2B')
      ? MATRIX_COPY.absentBusinessNotBuilt(input.productType)
      : MATRIX_COPY.absentBusiness(input.productType)
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
  /** An OPEN `AmazonSuppression` episode (resolvedAt null) exists for this listing. */
  suppressed: boolean
  /** VP.2's `variationExcluded` flag. */
  excluded: boolean
  /** A variant missing a value for at least one family axis (VP.2's `needs_value`). */
  needsValue: boolean
  /** The engine's selling state of this row on this coordinate (`destinationSellingStates`; a main product reads its variations). */
  selling: SellingStateRead
}

/** The Listing cell with its selling facts (the word the sheet's Status column shows, and why). */
export type MatrixListingCell = ListingCell & { selling: SellingStateRead }

/**
 * The listing-state TABLE (pinned by the test; precedence top to bottom). The health words win; then the engine's
 * selling state decides, so the Matrix and the sheet never disagree (a Shopify pause is a quantity-0 hold with
 * `offerClosedAt`: Inactive on both, never "Listed · inactive"):
 *
 *   excluded (variationExcluded)                       → excluded
 *   an open AmazonSuppression                          → suppressed
 *   listingStatus ERROR                                → error
 *   a variant missing an axis value                    → needs-value
 *   selling Ended (eBay ENDED, Shopify ARCHIVED)       → ended
 *   selling Inactive (offer paused, Etsy inactive,
 *     Shopify hold / Draft / Unlisted)                 → closed   (the wire's key for Inactive; the word is `selling`)
 *   selling Not listed (never sent, or deleted by
 *     Nexus and not listed again)                      → draft    (the wire's key; the Matrix says "Not listed")
 *   selling Active or Mixed                            → listed · detail `not buyable` for DISCOVERABLE (Amazon's meaning)
 *   selling Unknown: REMOVED                           → ended
 *                    ACTIVE | BUYABLE | DISCOVERABLE | INACTIVE, or an external id → listed
 *                    anything else                     → draft
 *
 * `selling` rides along verbatim (state + reason); the wire's `closed` and `draft` are keys, never words on screen (one
 * set of selling words, Owner 2026-10-04: Active · Inactive · Not listed · Ended · Mixed). `published` is
 * `isPublished` verbatim on every row; it is a separate fact from the word.
 */
export function listingStateOf(f: ListingFacts): MatrixListingCell {
  const status = String(f.listingStatus ?? '').toUpperCase()
  const selling = f.selling.state
  let state: ListingState
  let detail: string | null = null
  if (f.excluded) state = 'excluded'
  else if (f.suppressed) state = 'suppressed'
  else if (status === 'ERROR') state = 'error'
  else if (f.needsValue) state = 'needs-value'
  else if (selling === 'ended') state = 'ended'
  else if (selling === 'paused') state = 'closed'
  // Not on the channel here: never sent (a draft), or deleted by Nexus and not listed again (it reads Not listed).
  else if (selling === 'draft' || selling === 'not_listed') state = 'draft'
  else if (selling === 'active' || selling === 'mixed') { state = 'listed'; if (status === 'DISCOVERABLE') detail = 'not buyable' }
  else if (status === 'REMOVED') state = 'ended'
  else if (['ACTIVE', 'BUYABLE', 'DISCOVERABLE', 'INACTIVE'].includes(status) || f.externalListingId) state = 'listed'
  else state = 'draft'
  return { state, externalId: f.externalListingId ?? null, detail, published: f.isPublished === true, selling: { state: f.selling.state, reason: f.selling.reason } }
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

/**
 * 2026-09-27 — ONE rule for "which fulfilment does this Amazon coordinate use", read by the product sheet's
 * Fulfillment method cell, the Matrix and the Amazon publish step. It used to be three: the Matrix read
 * `typed ?? flat mirror ?? product`, publish read `active offer ?? typed ?? product`, and the sheet read the nested
 * code first — so a listing Amazon runs as FBA, with no typed column and a product flag of FBM, was shown FBA and
 * published as FBM.
 *
 * Order: an active offer's method → the typed column (`setFulfillmentMethod` writes it with both mirrors) → Amazon's
 * own reported code (the nested key a pull writes and the FBA guard reads) → the flat mirror → the product's flag.
 * D9 = A: Amazon's report (either place) ranks below the typed method — an old pulled copy saying FBA is shown as
 * "Amazon reports AFN — differs from Nexus" (`matrixReportedDiffers`), not as the listing's method. The guard decides
 * what is pushed (`isFbaCoordinate`).
 * `null` when nothing says anything: a new listing must still choose (the publish step refuses it by name).
 */
export function effectiveFulfilment(input: {
  activeOfferMethod?: string | null
  typed?: string | null
  platformAttributes?: unknown
  productMethod?: string | null
}): { method: 'FBA' | 'FBM'; source: 'offer' | 'set' | 'reported' | 'mirror' | 'product' } | null {
  const named = (v: unknown): 'FBA' | 'FBM' | null => {
    const s = typeof v === 'string' ? v.toUpperCase() : ''
    return s === 'FBA' || s === 'AFN' ? 'FBA' : s === 'FBM' || s === 'MFN' || s === 'MERCHANT' ? 'FBM' : null
  }
  const offer = named(input.activeOfferMethod)
  const typed = named(input.typed)
  const reported = named(reportedFulfilment(input.platformAttributes))
  if (offer) return { method: offer, source: 'offer' }
  if (typed) return { method: typed, source: 'set' }
  if (reported) return { method: reported, source: 'reported' }
  const mirror = named((input.platformAttributes as { fulfillmentChannel?: unknown } | null)?.fulfillmentChannel)
  if (mirror) return { method: mirror, source: 'mirror' }
  const product = named(input.productMethod)
  return product ? { method: product, source: 'product' } : null
}

/**
 * Amazon's REPORTED channel — every fulfilment code the listing carries, in BOTH places (the nested key the fulfilment
 * door writes and `attributes.fulfillment_availability`, which Amazon's pull writes), every entry. Fail-closed: ANY FBA
 * code (FBA, Remote Fulfilment, VCS) → AFN; otherwise a merchant code (an old label value counts as its code) → MFN.
 */
export function reportedFulfilment(platformAttributes: unknown): 'AFN' | 'MFN' | null {
  const codes = amazonFulfilmentCodes(platformAttributes)
  if (codes.some(isFbaFulfilmentCode)) return 'AFN'
  if (codes.some((c) => describeAmazonFulfilmentCode(c).method === 'FBM')) return 'MFN'
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
  // FOLLOW with nothing routed happens only when the stock counts as 0 (the SKU left a pool and holds no row here):
  // 0 is pushed, so the cell says 0 available, not "nothing is pushed".
  const poolAvailable = f.routed.length === 0 ? (res.kind === 'FOLLOW' ? 0 : null) : f.routed.reduce((s, r) => s + r.available, 0)
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
  /** The row's `createdAt`, ISO — which push of a lane is the newest (`lanePushFailure`). */
  createdAt?: string | null
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

/* ── per-lane push failure (2026-10-08, Owner: the Sync column folds into Qty and Price) ─────── */

/**
 * The words a push refusal is saved with when the dispatcher answered a CODE rather than a sentence (`error` lands on the
 * row's `errorMessage`): the Qty cell leads with the reason, so it says what the code means.
 */
const PUSH_CODE_SENTENCES: Readonly<Record<string, string>> = {
  'eu-shared-qty-conflict': 'Refused by the Amazon EU guard — the EU markets ask for different quantities',
  'eu-shared-qty-guard-unavailable': 'Held — the Amazon EU quantity guard could not be checked',
  'sync-paused-policy': 'Held — the channel policy holds pushes on this market (Sync Control)',
  'offer-suppressed': 'Not sent — the offer is suppressed',
}

/** A failed row's reason as the cell says it: the server's sentence, a known code in words, never empty. */
export function pushFailureReason(errorMessage: string | null | undefined): string {
  const said = String(errorMessage ?? '').trim()
  if (!said) return 'The channel refused the change'
  return PUSH_CODE_SENTENCES[said] ?? said
}

/**
 * PURE — did the newest push of ONE lane fail? Per listing: its newest row of the lane (by `createdAt`) decides — FAILED
 * (dead-lettered, or failed and waiting for its next try) is a failure; SUCCESS, a push on its way (PENDING / IN_PROGRESS)
 * or a deliberate skip (SKIPPED: nothing was sent, by design — a held price, a dry run, a lane another lane owns) is not.
 * Several listings (Amazon EU's region cell): the markets whose newest push failed (`named`), the newest failure's words.
 * `null` = no failure: success shows nothing.
 */
export function lanePushFailure(
  listings: ReadonlyArray<{ market: string; rows: readonly QueueRowFacts[] }>,
  lane: 'QUANTITY_UPDATE' | 'PRICE_UPDATE',
  named = false,
): PushFailure | null {
  const failures: Array<{ market: string; row: QueueRowFacts }> = []
  for (const l of listings) {
    let newest: QueueRowFacts | null = null
    for (const r of l.rows) {
      if (r.syncType !== lane) continue
      if (!newest || String(r.createdAt ?? r.at ?? '') > String(newest.createdAt ?? newest.at ?? '')) newest = r
    }
    if (newest && newest.syncStatus.toUpperCase() === 'FAILED') failures.push({ market: l.market.toUpperCase(), row: newest })
  }
  if (failures.length === 0) return null
  const last = failures.reduce((a, b) => (String(b.row.at ?? '') > String(a.row.at ?? '') ? b : a))
  return {
    reason: pushFailureReason(last.row.errorMessage),
    at: last.row.at,
    final: last.row.isDead,
    markets: named ? [...new Set(failures.map((f) => f.market))].sort(compareMarkets) : [],
  }
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
  /** Shared stock by SKU: the business whose lent stock this SKU sells from, or null (its own stock). */
  sharedFrom?: string | null
}

/**
 * Owner 2026-10-01: "I should not be able to change the quantity unless it's deriving from its own pool or unless I'm
 * changing it directly from the profile we are sourcing from." The database refuses a fixed number on such a SKU
 * (stock-pool.sql, nexus_stock_pool_quantity_guard); the Matrix holds the cells that would make one, with this sentence.
 */
export const sharedStockReason = (lender: string) =>
  `Sells from ${lender}'s stock, so the quantity follows it. Change the stock in ${lender}, or disconnect it first (Stock source).`

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
    // Shared stock by SKU: no typed or fixed quantity; a fixed number it still has may only go back to Follow.
    if (input.sharedFrom && (k === 'syncQty' || (k === 'syncMode' && input.sync?.mode !== 'PINNED'))) { hold(k, sharedStockReason(input.sharedFrom)); continue }
    if (k === 'syncBuffer' && input.sync?.mode === 'PINNED') { hold(k, PINNED_BUFFER_REASON); continue }
    if (k === 'price' && input.price?.source === 'formula') { hold(k, FORMULA_REASON); continue }
    writable[k] = true
  }
  return { writable, writeBlockedReason }
}

/* ── "Sells from" (Step 2, Owner 2026-10-07) ───────────────────────────────────────────────── */

/** One of this business's WAREHOUSE locations as the From cell needs it. */
export interface SourceLocation { code: string; active: boolean; isDefault: boolean; syncRoutes: readonly string[] }

/** Sale order when no list decides: the default warehouse first, then by code (the loader's own order). */
export const inSourceOrder = <T extends { code: string; isDefault?: boolean }>(locations: readonly T[]): T[] =>
  [...locations].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))

export interface SourceFacts {
  role: 'parent' | 'variant'
  channel: string
  /** The listing's market (an EU group: its primary row's market — every EU row carries the same list). */
  market: string
  /** The listing's stored `sourceLocationCodes`. */
  own: readonly string[]
  /** The product's ledger (`loadSyncLedgers`); undefined = none read. */
  ledger: SyncLedger | undefined
  /** The business's lists per market (`loadMarketSources`). */
  marketSources: MarketSources
  /** This business's WAREHOUSE locations (any order). */
  locations: readonly SourceLocation[]
  /** The listing's FBA verdict (`listingQuantityVerdict`). */
  isFba: boolean
  /** Shared stock by SKU: the lender's name, or null. */
  sharedFrom: string | null
  /** `inventory.adjust` for the caller. */
  canAdjustStock: boolean
}

/**
 * PURE — the From cell. The default is the market's list (`marketSourceKey`), or — with none — the ACTIVE warehouses whose
 * routes allow the market, in sale order. `effective` is the core's own choice (`sellsFrom`, the rows every push reads):
 * a list's codes in its order, or (routes) the default, each with this SKU's available there (0 without a stock row).
 * Not writable, with the sentence, on the parent, an FBA listing, a SKU that sells from another business's stock, and for
 * a caller without `inventory.adjust` — in that order.
 */
export function sourceCellOf(f: SourceFacts): SourceCell {
  const list = f.marketSources.get(marketSourceKey(f.channel, f.market)) ?? []
  const routed = inSourceOrder(f.locations.filter((l) => l.active && locationServes([...l.syncRoutes], f.channel, f.market))).map((l) => l.code)
  const marketDefault = list.length ? [...list] : routed
  const pooled = !!f.sharedFrom
  const own = f.role === 'parent' ? [] : f.own.map((c) => c.trim()).filter(Boolean)
  const chosen = f.ledger && f.role !== 'parent'
    ? sellsFrom({ ledger: f.ledger, channel: f.channel, marketplace: f.market, sourceLocationCodes: pooled ? [] : [...own] })
    : null
  const availableAt = new Map<string, number>((chosen?.rows ?? f.ledger ?? []).map((r): [string, number] => [r.locationCode.trim().toUpperCase(), r.available]))
  const codes = !chosen ? (own.length ? own : marketDefault) : chosen.origin === 'routes' && !pooled ? marketDefault : chosen.codes
  const effective = f.role === 'parent' ? [] : codes.map((code) => ({ code, available: availableAt.get(code.trim().toUpperCase()) ?? 0 }))
  const blockedReason = f.role === 'parent' ? MATRIX_COPY.sourceParent
    : f.isFba ? MATRIX_COPY.sourceFba
      : f.sharedFrom ? sharedStockReason(f.sharedFrom)
        : !f.canAdjustStock ? MATRIX_COPY.sourcePermission
          : null
  return { own, marketDefault, defaultOrigin: list.length ? 'market' : 'routes', effective, writable: blockedReason === null, blockedReason }
}

/** Which coordinate carries a target's INVENTORY cells — the region group for an EU market (mirrors the preview's rule). */
export const regionKeyFor = (channel: string, market: string): CoordinateKey | null =>
  isAmazonEuMarket(channel, market) ? 'AMAZON:EU' : null
