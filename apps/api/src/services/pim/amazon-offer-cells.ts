/**
 * Amazon sheet gaps (D4=B, D5=B, D3) — the product sheet's Amazon offer cells: ONE pure rule and ONE loader per sheet read.
 *
 * For each offer column (`offer-fields.ts`, lane `draft`) of an Amazon listing:
 *   - value = what Publish sends: the saved draft over the live value (`readAmazonOfferFacts`, publish lane);
 *   - the hold and its reason, in the Matrix's order: the parent, a missing `products.price.edit` (every leaf the price door
 *     writes), FBA on a leaf that applies only to orders the seller ships;
 *   - `pendingPublish`: the saved change waiting for Publish, beside the live value Amazon keeps until then, in the words of
 *     design-draft-and-remote §A (D7=A: a live change after the save is shown, the saved value still goes);
 *   - the price column carries the Matrix's own price cell (`priceCellOf`, the same facts); D5 warnings for Always available
 *     and the Automate Pricing rule.
 * The Fulfillment method cell shows the REAL code: a Remote Fulfilment / VCS code is read-only, with its words (D3).
 */
import type { Prisma } from '@prisma/client'
import type { PriceCell } from '@nexus/shared/matrix-contract'
import { pricingRuleLabel } from '@nexus/shared/listing-price'
import prisma from '../../db.js'
import { isFbaCoordinate } from '../../lib/amazon-fulfillment.js'
import { describeAmazonFulfilmentCode, keptAmazonFulfilmentCodes } from '../../lib/amazon-fulfilment-programme.js'
import { masterCurrency } from '../fx-rate.service.js'
import { liveDraftValues, readAmazonOfferFacts, type AmazonOfferFacts } from '../amazon/offer-facts.js'
import { FBA_FULFILMENT_REASON, amazonOfferFieldFor, type AmazonOfferField, type AmazonOfferLeaf } from '../amazon/offer-fields.js'
import { amazonOfferValuesEqual, readAmazonOfferDraft } from '../amazon/offer-draft.js'
import { AMAZON_FULFILMENT_KEY } from './channel-specs/amazon.js'
import { listingMarketCurrency, listingSendPrice } from './follower-price.js'
import { PRICE_PERMISSION_REASON, priceCellOf } from './matrix-cells.js'
import { readSaleWindows } from './sale-window.js'

export const OFFER_DRAFT_WORDS = {
  saved: 'Saved — sent when you publish',
  pinsAt: (price: string) => `Saved — pins at ${price} when you publish`,
  follows: (rule: string) => `Saved — follows ${rule} when you publish`,
  liveChanged: (from: string, to: string) => `Live changed since you saved: ${from} → ${to}. Publish sends your saved value.`,
  restockPassed: 'Restock date has passed — not sent. Change it or discard it.',
  liveRestockPassed: 'Restock date has passed — not sent.',
} as const
export const ALWAYS_AVAILABLE_WARNING =
  'Always available: Amazon ignores the quantity Nexus sends and keeps the offer buyable at any stock. Use it only for made-to-order items.'
export const AUTOMATE_PRICING_WARNING =
  'Automate Pricing: Amazon changes this price by your Seller Central rule, inside your minimum and maximum price. Nexus still sends its own price; the rule can change it again.'

/** The saved change of one cell waiting for Publish. */
export interface AmazonOfferPending {
  /** The saved value as the cell shows it (`null` = removed on Amazon when you publish). */
  value: unknown
  /** The live value: what Amazon keeps until Publish. */
  live: unknown
  savedAt: string
  savedBy: string
  note: string
  /** False: the saved value is not sent (a restock date that has passed). */
  sent: boolean
  /** D7=A — live moved after the save. */
  liveChangedSince?: { from: unknown; to: unknown; note: string }
}

/** What an offer cell adds to a sheet cell. */
export interface AmazonOfferCellExtras {
  pendingPublish?: AmazonOfferPending | null
  /** The price column: the Matrix's own price cell for this listing (`priceCellOf`). */
  priceCell?: PriceCell
  offerWarning?: string
  /** The Fulfillment method cell of a code Nexus does not set (Remote Fulfilment, VCS): its words. */
  fulfilmentLabel?: string
}

/** One listing's facts for its offer cells. */
export interface AmazonOfferListingFacts {
  /** Publish lane: the draft over live (what Publish sends). */
  facts: AmazonOfferFacts
  /** Job lane: live only (what Amazon keeps until Publish). */
  live: AmazonOfferFacts
  isFba: boolean
  pricingRule: string | null
  priceAdjustmentPercent: unknown
  priceCell: PriceCell | null
}

export interface AmazonOfferCell extends AmazonOfferCellExtras {
  /** The value to show; absent when the row has no listing (the cell keeps its own). */
  value?: unknown
  /** The cell is held, and why; `null` = it keeps its own editability. */
  hold: string | null
  pendingPublish: AmazonOfferPending | null
}

type Part = 'value' | 'start' | 'end'
const SALE_PART: Record<Part, 'price' | 'start' | 'end'> = { value: 'price', start: 'start', end: 'end' }
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)

/** The value a column shows from a facts object (either lane). */
function factsValue(facts: AmazonOfferFacts, leaf: AmazonOfferLeaf, part: Part | undefined): unknown {
  if (leaf === 'our_price') return facts.values.our_price.price
  if (leaf === 'sale') return facts.values.sale ? facts.values.sale[SALE_PART[part ?? 'value']] ?? null : null
  return (facts.values as unknown as Record<string, unknown>)[leaf] ?? null
}

/** The words of one leaf's value in the draft's shape, for a sentence. */
export function offerValueWords(leaf: AmazonOfferLeaf, value: unknown, rule?: string): string {
  if (value === null || value === undefined) return 'none'
  const money = (n: unknown) => (typeof n === 'number' ? n.toFixed(2) : String(n))
  switch (leaf) {
    case 'our_price': {
      const v = record(value)
      return v?.follow === true ? `follows ${rule ?? 'its rule'}` : money(v?.pin)
    }
    case 'sale': {
      const v = record(value)
      return v ? `${money(v.price)}, ${v.start ?? '—'} – ${v.end ?? '—'}` : 'none'
    }
    case 'minimum_seller_allowed_price': case 'maximum_seller_allowed_price': case 'map_price': return money(value)
    case 'is_inventory_available': return value === true ? 'On' : 'Off'
    case 'lead_time_to_ship_max_days': return value === 1 ? '1 day' : `${String(value)} days`
    default: return String(value)
  }
}

/** The hold of one field on one row (the Matrix's order: parent, permission, then FBA). */
export function amazonOfferHold(field: AmazonOfferField, row: { isParent: boolean; isFba: boolean; canEditPrice: boolean }): string | null {
  if (row.isParent) return field.parentReason
  if (field.writeService === 'writeChannelPrices' && !row.canEditPrice) return PRICE_PERMISSION_REASON
  if (!field.fbaApplies && row.isFba) return FBA_FULFILMENT_REASON
  return null
}

/** PURE — one offer cell. `null` = the key is not an Amazon offer draft column. */
export function amazonOfferCellOf(input: {
  key: string
  listing: AmazonOfferListingFacts | null
  isParent: boolean
  canEditPrice: boolean
  today?: string
}): AmazonOfferCell | null {
  const field = amazonOfferFieldFor(input.key)
  if (!field || field.lane !== 'draft' || !field.leaf) return null
  const leaf = field.leaf
  const l = input.listing
  const hold = amazonOfferHold(field, { isParent: input.isParent, isFba: !!l?.isFba, canEditPrice: input.canEditPrice })
  if (!l) return { hold, pendingPublish: null }
  const today = input.today ?? new Date().toISOString().slice(0, 10)
  const entry = l.facts.draft?.leaves[leaf]
  // The live price shows as the Matrix shows it (`priceCellOf`); a saved price shows what Publish sends.
  const livePrice = leaf === 'our_price' && l.priceCell ? l.priceCell.value : undefined
  const liveValue = livePrice !== undefined ? livePrice : factsValue(l.live, leaf, field.part)
  const value = entry || livePrice === undefined ? factsValue(l.facts, leaf, field.part) : livePrice
  const rule = pricingRuleLabel(l.pricingRule, l.priceAdjustmentPercent as never)
  const cell: AmazonOfferCell = { value, hold, pendingPublish: null }

  if (entry) {
    const saved = record(entry.value)
    const passed = leaf === 'restock_date' && typeof entry.value === 'string' && entry.value.slice(0, 10) < today
    // "pins at" only when the live listing follows its rule: an already pinned listing just gets a new number.
    const note = passed ? OFFER_DRAFT_WORDS.restockPassed
      : leaf === 'our_price' && saved?.follow === true ? OFFER_DRAFT_WORDS.follows(rule)
      : leaf === 'our_price' && typeof saved?.pin === 'number' && l.live.values.our_price.mode !== 'pin' ? OFFER_DRAFT_WORDS.pinsAt(saved.pin.toFixed(2))
      : OFFER_DRAFT_WORDS.saved
    const liveNow = liveDraftValues(l.live)[leaf]
    const moved = !amazonOfferValuesEqual(leaf, entry.base, liveNow)
    cell.pendingPublish = {
      value, live: liveValue, savedAt: entry.savedAt, savedBy: entry.savedBy, note, sent: !passed,
      ...(moved ? { liveChangedSince: { from: entry.base, to: liveNow,
        note: OFFER_DRAFT_WORDS.liveChanged(offerValueWords(leaf, entry.base, rule), offerValueWords(leaf, liveNow, rule)) } } : {}),
    }
  }
  if (leaf === 'our_price' && l.priceCell) cell.priceCell = l.priceCell
  if (!hold) {
    if (leaf === 'is_inventory_available' && value === true) cell.offerWarning = ALWAYS_AVAILABLE_WARNING
    if (leaf === 'automated_pricing_rule_id' && typeof value === 'string' && value.trim()) cell.offerWarning = AUTOMATE_PRICING_WARNING
    if (leaf === 'restock_date' && !entry && typeof value === 'string' && value < today) cell.offerWarning = OFFER_DRAFT_WORDS.liveRestockPassed
  }
  return cell
}

/** PURE — the Fulfillment method cell of a listing carrying a code Nexus does not set (Remote Fulfilment, VCS, another
 * `AMAZON_*`): the real code, read-only, with its words. `null` = an ordinary FBA / FBM cell. */
export function amazonFulfilmentMethodCell(platformAttributes: unknown): { value: string; label: string; reason: string } | null {
  const code = keptAmazonFulfilmentCodes(platformAttributes)[0]
  if (!code) return null
  const d = describeAmazonFulfilmentCode(code)
  return { value: d.code, label: d.label, reason: d.readOnlyReason ?? `Amazon reports ${d.code} for this listing. Nexus keeps the code Amazon reports.` }
}

/**
 * The Matrix's tooltip-only `PriceCell.waiting` / `SaleCell.waiting` from a listing's offer draft (contract: `value: null` =
 * back to the base price / remove the sale). Null = nothing waits for that cell.
 */
export function amazonOfferWaiting(platformAttributes: unknown): { price: { value: number | null } | null; sale: { value: number | null; start: string | null; end: string | null } | null } {
  const draft = readAmazonOfferDraft(platformAttributes)
  const price = record(draft?.leaves.our_price?.value)
  const saleEntry = draft?.leaves.sale
  const sale = record(saleEntry?.value)
  return {
    price: price ? { value: typeof price.pin === 'number' ? price.pin : null } : null,
    sale: saleEntry ? (sale ? { value: typeof sale.price === 'number' ? sale.price : null, start: (sale.start as string) ?? null, end: (sale.end as string) ?? null } : { value: null, start: null, end: null }) : null,
  }
}

type Db = Pick<Prisma.TransactionClient, 'channelListing' | 'stockLevel' | 'offer' | 'marketplace' | 'cellFormula' | 'pricingSnapshot' | '$queryRawUnsafe' | '$executeRawUnsafe'>

/**
 * The listings among `rows` that Amazon fulfils (FBA) — fail closed, the fulfilment door's evidence: `isFbaCoordinate`
 * with the product's FBA stock (an `AMAZON_FBA` location or `AMAZON-EU-FBA`) and an active FBA offer.
 */
export async function loadAmazonFbaListingIds(
  db: Pick<Prisma.TransactionClient, 'stockLevel' | 'offer'>,
  rows: ReadonlyArray<{ id: string; productId: string; fulfillmentMethod?: string | null; platformAttributes?: unknown; product?: { fulfillmentMethod?: string | null } | null }>,
): Promise<Set<string>> {
  if (rows.length === 0) return new Set()
  const productIds = [...new Set(rows.map((r) => r.productId))]
  const [stock, offers] = await Promise.all([
    db.stockLevel.findMany({
      where: { productId: { in: productIds }, OR: [{ location: { type: 'AMAZON_FBA' } }, { location: { code: 'AMAZON-EU-FBA' } }] },
      select: { productId: true, quantity: true },
    }),
    db.offer.findMany({ where: { channelListingId: { in: rows.map((r) => r.id) }, fulfillmentMethod: 'FBA', isActive: true }, select: { channelListingId: true } }),
  ])
  const fbaStock = new Map<string, number>()
  for (const s of stock) fbaStock.set(s.productId, (fbaStock.get(s.productId) ?? 0) + s.quantity)
  const offered = new Set(offers.map((o) => o.channelListingId))
  return new Set(rows.filter((r) => isFbaCoordinate(r, r.product, { fbaStockQty: fbaStock.get(r.productId) ?? 0, hasActiveFbaOffer: offered.has(r.id) })).map((r) => r.id))
}

const CELL_LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, aliasKey: true, price: true, priceOverride: true, followMasterPrice: true,
  pricingRule: true, priceAdjustmentPercent: true, salePrice: true, platformAttributes: true, fulfillmentMethod: true,
  product: { select: { sku: true, basePrice: true, isParent: true, fulfillmentMethod: true } },
} satisfies Prisma.ChannelListingSelect

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(String(v))
  return Number.isFinite(n) ? n : null
}
const upper = (v: unknown) => String(v ?? '').toUpperCase()

/** The cells a sheet writes into (structurally the studio sheet's cell). */
export type OfferSheetCell = { value: unknown; editable: boolean; writable: boolean; writeBlockedReason: string | null; source?: string; inherited?: boolean; inheritedFrom?: string | null } & AmazonOfferCellExtras

/**
 * ONE loader per sheet read: the listings' offer facts (both lanes), sale windows, FBA evidence and the Matrix's price-cell
 * facts (market currency, a price formula, a clamped snapshot). `apply` lays the rule over one row's built cells.
 */
export async function loadAmazonOfferCells(input: { listingIds: readonly string[]; canEditPrice: boolean; today?: string
  /** The sheet's column keys: without an offer or Fulfillment method column there is nothing to lay, and nothing is read. */
  keys?: readonly string[] }, db: Db = prisma) {
  const covers = !input.keys || input.keys.some((k) => k === AMAZON_FULFILMENT_KEY || amazonOfferFieldFor(k)?.lane === 'draft')
  const ids = covers ? [...new Set(input.listingIds)] : []
  const rows = ids.length ? await db.channelListing.findMany({ where: { id: { in: ids }, channel: 'AMAZON' }, select: CELL_LISTING_SELECT }) : []
  const byListing = new Map<string, { facts: AmazonOfferListingFacts; platformAttributes: unknown }>()
  // No Amazon listing on the sheet (or no offer column): only the row holds apply, and nothing more is read.
  if (rows.length) {
    const listed = rows.map((r) => r.id)
    const productIds = [...new Set(rows.map((r) => r.productId))]
    const skus = [...new Set(rows.map((r) => r.product?.sku).filter((s): s is string => !!s))]
    const [windows, currencies, fba, formulas, snapshots] = await Promise.all([
      readSaleWindows(db as never, listed),
      db.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { channel: true, code: true, currency: true } }),
      loadAmazonFbaListingIds(db, rows),
      db.cellFormula.findMany({ where: { productId: { in: productIds }, scope: 'channel', fieldKey: 'price' }, select: { productId: true, channel: true, marketplace: true, aliasKey: true, expr: true } }),
      db.pricingSnapshot.findMany({ where: { sku: { in: skus }, fulfillmentMethod: null }, select: { sku: true, channel: true, marketplace: true, isClamped: true, clampedFrom: true, computedPrice: true } }),
    ])
    const formulaOf = new Map(formulas.map((f) => [`${f.productId}|${upper(f.channel)}|${upper(f.marketplace)}|${f.aliasKey ?? ''}`, f.expr]))
    const snapshotOf = new Map(snapshots.map((s) => [`${s.sku}|${upper(s.channel)}|${upper(s.marketplace)}`, s]))
    const master = masterCurrency()

    for (const row of rows) {
      const saleWindow = windows.get(row.id) ?? null
      const marketCurrency = listingMarketCurrency(row, currencies)
      const draft = readAmazonOfferDraft(row.platformAttributes)
      // Only a draft that sets the price back to Follow needs the rule's price now (what Publish would send).
      const followPrice = record(draft?.leaves.our_price?.value)?.follow === true
        ? listingSendPrice({ ...row, followMasterPrice: true, priceOverride: null }, { masterPrice: row.product?.basePrice, marketCurrency, masterCurrency: master }).price
        : undefined
      const formula = formulaOf.get(`${row.productId}|AMAZON|${upper(row.marketplace)}|${row.aliasKey ?? ''}`)
      const snapshot = row.product?.sku ? snapshotOf.get(`${row.product.sku}|AMAZON|${upper(row.marketplace)}`) : undefined
      const isParent = !!row.product?.isParent
      byListing.set(row.id, {
        platformAttributes: row.platformAttributes,
        facts: {
          facts: readAmazonOfferFacts({ ...row, saleWindow }, 'publish', { followPrice }),
          live: readAmazonOfferFacts({ ...row, saleWindow }, 'job'),
          isFba: fba.has(row.id),
          pricingRule: row.pricingRule ?? null,
          priceAdjustmentPercent: row.priceAdjustmentPercent,
          // The Matrix's price cell, from the same facts (`matrix.service.ts`).
          priceCell: priceCellOf({
            price: isParent ? null : num(row.price), priceOverride: num(row.priceOverride), followMasterPrice: row.followMasterPrice,
            basePrice: isParent ? null : num(row.product?.basePrice), currency: marketCurrency ?? '',
            formula: formula != null ? `= ${formula}` : null,
            clamped: snapshot?.isClamped ? (num(snapshot.clampedFrom) ?? 0) > (num(snapshot.computedPrice) ?? 0) ? 'ceiling' : 'floor' : null,
          }),
        },
      })
    }
  }

  return {
    /** The facts of one listing's offer cells (tests, other readers). */
    listing: (listingId: string): AmazonOfferListingFacts | null => byListing.get(listingId)?.facts ?? null,
    /** Lay the rule over one row's cells, in place. */
    apply(values: Record<string, OfferSheetCell>, row: { listingId: string | null; isParent: boolean }): void {
      const hit = row.listingId ? byListing.get(row.listingId) ?? null : null
      for (const key of Object.keys(values)) {
        const target = values[key]
        if (key === AMAZON_FULFILMENT_KEY) {
          const kept = hit ? amazonFulfilmentMethodCell(hit.platformAttributes) : null
          if (kept) Object.assign(target, { value: kept.value, source: 'channelExplicit', inherited: false, inheritedFrom: null, fulfilmentLabel: kept.label,
            editable: false, writable: false, writeBlockedReason: kept.reason })
          continue
        }
        const cell = amazonOfferCellOf({ key, listing: hit?.facts ?? null, isParent: row.isParent, canEditPrice: input.canEditPrice, today: input.today })
        if (!cell) continue
        // The cell keeps its column's shape: a list column (Amazon's schedule) carries its one value as a list.
        if (cell.value !== undefined) target.value = Array.isArray(target.value) ? (cell.value == null ? [] : [cell.value]) : cell.value
        if (cell.hold) Object.assign(target, { editable: false, writable: false, writeBlockedReason: cell.hold })
        // Absent, not null, when nothing waits (the wire's rule for optional cell facts).
        if (cell.pendingPublish) target.pendingPublish = cell.pendingPublish
        if (cell.priceCell) target.priceCell = cell.priceCell
        if (cell.offerWarning) target.offerWarning = cell.offerWarning
      }
    },
  }
}
export type AmazonOfferCellBook = Awaited<ReturnType<typeof loadAmazonOfferCells>>
