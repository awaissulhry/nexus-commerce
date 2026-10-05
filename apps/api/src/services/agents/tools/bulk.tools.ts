/**
 * MCP.10 — bulk changes: many products at once, always approved by a person in Nexus.
 *
 *   bulk-price-change      master price of 1–250 products: set to X, change by X %, or change by X in
 *                          the master currency. Each new price goes through the product bulk writer
 *                          (`applyProductBulkEdits`, field `basePrice`) and so through
 *                          `masterPriceService`: listings that follow the master price change with it
 *                          and are queued to their marketplace after the service's undo hold.
 *   bulk-attribute-change  master attributes of 1–250 products, in Nexus ONLY: the same bulk writer
 *                          (`attr_<code>`, master target, no market). Nothing is queued to any
 *                          marketplace; the channels change when a person publishes from Nexus.
 *
 * `handler` is the preview and changes nothing: the writer's own dry run (`dryRun: true`) judges every
 * change, so the preview keeps the writer's refusals and warnings. `execute` runs only after a person
 * approves (alwaysAsk); it resolves the products again in the business it runs in, works the change
 * out again from what is stored then, runs the dry run again, and writes nothing unless all of it
 * still holds. No business is ever read from the arguments.
 *
 * The stored preview is kept small for 250 products: totals, and at most PREVIEW_LINES lines of detail.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { channelLabel } from '@nexus/shared/channel-label'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import {
  applyProductBulkEdits,
  ProductBulkError,
  type ProductBulkChangeError,
  type ProductBulkChangeWarning,
  type ProductBulkContext,
  type ProductBulkInput,
} from '../../products/bulk-edit.service.js'
import { computeListingPrice, holdsCascadedPrice } from '../../master-price.service.js'
import { masterCurrency } from '../../fx-rate.service.js'
import { marketCurrency, type MarketCurrencyRow } from '../../pim/market-currency.js'
import { masterPriceBoundsReason, priceBoundsOf, storedPriceReason, type PriceBounds } from '../../price-bounds.service.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'
import { roundCents } from '@nexus/shared/listing-price'

/** The most products one bulk change may name. */
export const BULK_MAX_PRODUCTS = 250
/** Lines of per-product detail a preview or a result carries; the rest are counted. */
export const PREVIEW_LINES = 20
/** The bulk writer's own cap on changes in one request (`applyProductBulkEdits`). */
const WRITER_MAX_CHANGES = 1000
/** Attributes one bulk-attribute-change may set. */
export const MAX_ATTRIBUTES = 10

/**
 * The undo hold `masterPriceService` puts on each price push it queues (its `DEFAULT_HOLD_MS`).
 * Quoted to the approver; bulk.tools.vitest.test.ts measures it on the rows the service
 * really queues, so this number cannot drift from the service unnoticed.
 */
export const MASTER_PRICE_HOLD_MS = 30 * 1000

/** C1 — how big a bulk price change may be without a person, when a business lets Claude run it itself (C5). */
export const BULK_PRICE_LIMITS = z.object({
  maxProducts: z.number().int().positive().max(BULK_MAX_PRODUCTS).default(25).describe('the most products one change may reprice'),
  maxChangePercent: z.number().positive().max(100).default(10).describe('the most any master price may move, up or down, in percent'),
})

export function bulkPriceWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as {
    totals?: { changing?: number }
    changePercentRange?: { lowest: number; highest: number }
    productsWithoutPrice?: number
  }
  const maxProducts = Number(limits.maxProducts)
  const maxChange = Number(limits.maxChangePercent)
  if (typeof p.totals?.changing !== 'number') return 'the preview names no products'
  if (!(p.totals.changing <= maxProducts)) {
    return `${p.totals.changing} master prices change, more than the ${maxProducts} allowed without a person`
  }
  if (p.productsWithoutPrice || !p.changePercentRange) return 'a product has no master price yet to compare the new one with'
  const moves = Math.max(Math.abs(p.changePercentRange.lowest), Math.abs(p.changePercentRange.highest))
  if (!(moves <= maxChange)) return `a master price moves ${moves} %, more than the ${maxChange} % allowed without a person`
  return null
}

/** C1 — how many products a bulk attribute change may touch without a person (C5). */
export const BULK_ATTRIBUTE_LIMITS = z.object({
  maxProducts: z.number().int().positive().max(BULK_MAX_PRODUCTS).default(25).describe('the most products one change may touch'),
})

export function bulkAttributeWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const products = (preview as { totals?: { products?: number } } | null)?.totals?.products
  const max = Number(limits.maxProducts)
  if (typeof products !== 'number') return 'the preview names no products'
  return products <= max ? null : `${products} products change, more than the ${max} allowed without a person`
}

export const NEXUS_ONLY =
  'This changes Nexus only. Amazon, eBay, Shopify and Etsy do not change until you publish from Nexus.'

type Change = ProductBulkInput['changes'][number]
type Refusal = { error: string }

interface BulkProduct {
  id: string
  sku: string
  basePrice: number | null
  /** The product's own pricing floor and ceiling (Product.minPrice / maxPrice). */
  bounds: PriceBounds
  categoryAttributes: Record<string, unknown>
}

const products = z
  .array(z.string().trim().min(1).max(191))
  .min(1)
  .max(BULK_MAX_PRODUCTS)
  .describe(`the products to change: Nexus product ids or SKUs, 1 to ${BULK_MAX_PRODUCTS}`)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const listed = (items: string[]) =>
  items.length > PREVIEW_LINES ? `${items.slice(0, PREVIEW_LINES).join(', ')} and ${items.length - PREVIEW_LINES} more` : items.join(', ')
const money = (n: number | null) => (n == null ? '—' : n.toFixed(2))
/** A refusal, then what did not happen: one full stop between them, never two. */
const refused = (reason: string, nothing: string) => `${reason.trim().replace(/[.\s]+$/, '')}. ${nothing}`
/** Rounded to cents by the one helper the cascade and the price door use: 1.005 is 1.01, not the float 1.00. */
const cents = roundCents
const holdText = () => `${Math.round(MASTER_PRICE_HOLD_MS / 1000)} seconds`
/**
 * A short fingerprint of EVERYTHING a preview was worked out from, not only the lines it shows. The approval
 * re-check (MATERIAL_PREVIEW_FIELDS, agent-fleet/approval-inbox.service.ts) compares it, so a price or value
 * that moved on product 21 of 250 makes the approval stale although no shown line changed.
 */
const basisOf = (facts: unknown) => createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16)

/**
 * The products named, in THIS business (the principal's; call-tool.ts binds it), ids first, then SKUs.
 * One not found refuses the whole change: an approval covers exactly the products it names.
 */
async function resolveProducts(refs: string[], nothing: string): Promise<BulkProduct[] | Refusal> {
  const wanted = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))]
  const rows = await prisma.product.findMany({
    where: { deletedAt: null, OR: [{ id: { in: wanted } }, { sku: { in: wanted } }] },
    select: { id: true, sku: true, basePrice: true, minPrice: true, maxPrice: true, categoryAttributes: true },
  })
  const byId = new Map(rows.map((row) => [row.id, row]))
  const bySku = new Map(rows.map((row) => [row.sku, row]))
  const found = new Map<string, BulkProduct>()
  const missing: string[] = []
  for (const ref of wanted) {
    const row = byId.get(ref) ?? bySku.get(ref)
    if (!row) {
      missing.push(ref)
      continue
    }
    const attributes = row.categoryAttributes
    found.set(row.id, {
      id: row.id,
      sku: row.sku,
      basePrice: row.basePrice != null ? Number(row.basePrice) : null,
      bounds: priceBoundsOf(row),
      categoryAttributes: attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? (attributes as Record<string, unknown>) : {},
    })
  }
  if (missing.length) {
    return { error: `${plural(missing.length, 'product')} not found in this business: ${listed(missing)}. ${nothing}` }
  }
  return [...found.values()]
}

/** The writer's context. It logs as pino does (details, message); Nexus's logger takes (message, details). */
function writerContext(userId: string | null | undefined): ProductBulkContext {
  const log = (level: 'warn' | 'error') => (details: unknown, message?: string) =>
    logger[level](message ?? '[agents/bulk] product bulk writer', { details })
  return {
    formulaCascade: false,
    userId: userId ?? null,
    logger: { warn: log('warn'), error: log('error') } as unknown as ProductBulkContext['logger'],
  }
}

/**
 * MCP.12 — two of the writer's refusals are written for the product sheet, which always sends a language address and a
 * marketplace scope; to a person reading a change Claude asked for they are internal words ("needs a ContentAddress",
 * "not in the business dictionary … (marketplaceContexts)"). Said plainly here, and the tool's description names both
 * limits. Every other refusal stays the writer's own words.
 */
export const REFUSED_PER_LANGUAGE =
  'this is text kept per language, which this tool cannot set: change it in the product sheet, in the language it is for'
export const REFUSED_NOT_IN_FAMILY =
  "this is not an attribute of the product's family and the product holds no value for it, so it cannot be set here"

export function plainRefusal(error: string): string {
  if (/needs a ContentAddress before it can be saved/.test(error)) return REFUSED_PER_LANGUAGE
  if (/^No marketplace context — this attribute is not in the business dictionary/.test(error)) return REFUSED_NOT_IN_FAMILY
  return error
}

function writerRefusal(errors: ProductBulkChangeError[], skuOf: Map<string, string>): string {
  const lines = errors.map((e) => `${skuOf.get(e.id) ?? e.id} ${e.field.replace(/^attr_/, '')}: ${plainRefusal(e.error)}`)
  return `${plural(errors.length, 'change')} would be refused: ${listed(lines)}`
}

/**
 * The bulk writer's own verdict on every change, writing nothing (`dryRun: true`, the early return above
 * every write in applyProductBulkEdits). Warnings travel with values the writer can store.
 */
async function writerDryRun(changes: Change[], skuOf: Map<string, string>): Promise<{ refusal: string } | { warnings: ProductBulkChangeWarning[] }> {
  try {
    const out = (await applyProductBulkEdits({ changes, dryRun: true }, writerContext(null))) as {
      dryRun?: boolean
      wouldUpdate?: number
      errors?: ProductBulkChangeError[]
      warnings?: ProductBulkChangeWarning[]
    }
    if (out.errors?.length) return { refusal: writerRefusal(out.errors, skuOf) }
    if (out.dryRun !== true || out.wouldUpdate !== changes.length) {
      return { refusal: `The product writer could not check every change (${out.wouldUpdate ?? 0} of ${changes.length}).` }
    }
    return { warnings: out.warnings ?? [] }
  } catch (error) {
    if (!(error instanceof ProductBulkError)) throw error
    const errors = error.details.errors
    return { refusal: Array.isArray(errors) && errors.length ? writerRefusal(errors as ProductBulkChangeError[], skuOf) : error.message }
  }
}

const warningLines = (warnings: ProductBulkChangeWarning[], skuOf: Map<string, string>) =>
  warnings.map((w) => `${skuOf.get(w.id) ?? w.id} ${w.field.replace(/^attr_/, '')}: ${w.warning}`).sort()

const warningOutput = (lines: string[]) => lines.length ? {
  warnings: lines.slice(0, PREVIEW_LINES),
  ...(lines.length > PREVIEW_LINES ? { moreWarnings: lines.length - PREVIEW_LINES } : {}),
} : {}

/** Repeat warnings in the approval detail and bind every warning, including hidden lines, to the approval. */
function withWriterWarnings<T extends { effect: string; basis: string }>(preview: T, warnings: ProductBulkChangeWarning[], skuOf: Map<string, string>) {
  const lines = warningLines(warnings, skuOf)
  if (!lines.length) return preview
  return {
    ...preview,
    ...warningOutput(lines),
    effect: `${preview.effect} Warnings: ${listed(lines)}.`,
    basis: basisOf({ values: preview.basis, warnings: lines }),
  }
}

/** The real write. A throw rolls the whole transaction back, so "nothing changed" is true then. */
async function writerRun(changes: Change[], userId: string | null | undefined) {
  return (await applyProductBulkEdits({ changes }, writerContext(userId))) as {
    operationId?: string
    updated?: number
    errors?: ProductBulkChangeError[]
    warnings?: ProductBulkChangeWarning[]
  }
}

// ── bulk-price-change ────────────────────────────────────────────────────────────────────────────

const PRICE_OPERATIONS = ['set', 'percent', 'amount'] as const
type PriceOperation = (typeof PRICE_OPERATIONS)[number]

/** C2 — `each`: every product to its own price (set-master-prices, the undo of a bulk price change). */
type PlanOperation = PriceOperation | 'each'

interface PricePlan {
  operation: PlanOperation
  /** set / percent / amount: the one value; each: null (every item has its own). */
  value: number | null
  currency: string
  products: BulkProduct[]
  /** Products whose master price changes, with the new price. */
  items: Array<{ id: string; sku: string; from: number | null; to: number; bounds: PriceBounds }>
  /** SKUs already at the new price. */
  unchanged: string[]
}

function describeOperation(operation: PlanOperation, value: number | null, currency: string): string {
  if (operation === 'each') return `set product by product (${currency})`
  if (operation === 'set') return `set to ${currency} ${money(value)}`
  if (operation === 'percent') return `${value > 0 ? 'raised' : 'lowered'} by ${Math.abs(value)} %`
  return `${value > 0 ? 'raised' : 'lowered'} by ${currency} ${money(Math.abs(value))}`
}

/** Each product's new master price, from its base price as stored NOW. All or nothing. */
async function planPrices(args: Record<string, unknown>, nothing: string): Promise<PricePlan | Refusal> {
  const operation = args.operation as PriceOperation
  const value = Number(args.value)
  if (!Number.isFinite(value)) return { error: `value must be a number. ${nothing}` }
  if (operation === 'set' && value <= 0) return { error: `A price must be above 0. ${nothing}` }
  if (operation !== 'set' && value === 0) return { error: `A change of 0 changes nothing. ${nothing}` }
  const found = await resolveProducts(args.products as string[], nothing)
  if ('error' in found) return found
  const items: PricePlan['items'] = []
  const unchanged: string[] = []
  const refused: string[] = []
  const outOfBounds: string[] = []
  for (const product of found) {
    const from = product.basePrice
    if (operation !== 'set' && from == null) {
      refused.push(`${product.sku} has no base price to change`)
      continue
    }
    const to = cents(operation === 'set' ? value : operation === 'percent' ? from! * (1 + value / 100) : from! + value)
    if (!(to > 0)) {
      refused.push(`${product.sku} would go to ${money(to)}`)
      continue
    }
    // The push refuses a price outside the product's own floor or ceiling, after Nexus has stored it; refused
    // here instead, so Nexus and the channels never disagree. A product already at that price is left alone.
    const outside = from != null && cents(from) === to ? null : masterPriceBoundsReason(to, product.bounds)
    if (outside) {
      outOfBounds.push(`${product.sku} (${outside})`)
      continue
    }
    if (from != null && cents(from) === to) unchanged.push(product.sku)
    else items.push({ id: product.id, sku: product.sku, from, to, bounds: product.bounds })
  }
  if (refused.length) {
    return { error: `A master price must stay above 0: ${listed(refused)}. ${nothing}` }
  }
  if (outOfBounds.length) {
    return {
      error:
        `A master price must stay within the pricing floor and ceiling set on the product: ${listed(outOfBounds)}. ` +
        `Change the plan, change the floor or ceiling on those products in Nexus, or leave them out. ${nothing}`,
    }
  }
  return { operation, value, currency: masterCurrency(), products: found, items, unchanged }
}

/** One shape, not a union: apps/api is not strict, so a union would not narrow. */
interface ListingFate {
  kind: 'queued' | 'paused' | 'draft' | 'own-price' | 'already' | 'other-currency' | 'refused'
  /** queued / paused / draft / refused: the listing price before and after (refused: the price it would follow at). */
  from?: number | null
  to?: number
  /** other-currency: what the market sells in (null = not configured). */
  currency?: string | null
  /** refused: why (`storedPriceReason`: outside the product's own floor or ceiling, or not above 0). */
  reason?: string
}

/**
 * What `masterPriceService.update` does to one listing when the master becomes `master`: the same
 * exported `computeListingPrice`, the same currency refusal, the same per-listing floor/ceiling refusal (2026-10-01:
 * a follower price outside the product's own bounds is neither stored nor queued — `storedPriceReason`, master-currency
 * markets only, paused and drafts included) and the same paused/draft rule. The tests compare this with what the
 * service really stores and queues.
 */
function listingFate(
  listing: { price: unknown; pricingRule: Parameters<typeof computeListingPrice>[1]; followMasterPrice: boolean; priceAdjustmentPercent: Parameters<typeof computeListingPrice>[3]; syncPaused: boolean; listingStatus: string | null; isPublished: boolean; externalListingId: string | null; channel: string; marketplace: string },
  master: number,
  currencies: MarketCurrencyRow[],
  masterCurrencyCode: string,
  bounds: PriceBounds,
): ListingFate {
  const next = computeListingPrice(master, listing.pricingRule, listing.followMasterPrice, listing.priceAdjustmentPercent)
  const old = listing.price != null ? Number(listing.price) : null
  if (next == null) return { kind: 'own-price' }
  if (next === old) return { kind: 'already' }
  let currency: string | null
  try {
    currency = marketCurrency(listing.channel, listing.marketplace, currencies)
  } catch {
    currency = null
  }
  if (currency !== masterCurrencyCode) return { kind: 'other-currency', currency }
  const outside = storedPriceReason(next, bounds)
  if (outside) return { kind: 'refused', from: old, to: next, reason: outside }
  if (holdsCascadedPrice(listing)) return { kind: listing.syncPaused ? 'paused' : 'draft', from: old, to: next }
  return { kind: 'queued', from: old, to: next }
}

async function pricePreview(plan: PricePlan) {
  const ids = plan.items.map((item) => item.id)
  const [listings, currencies] = await Promise.all([
    ids.length
      ? prisma.channelListing.findMany({
          where: { productId: { in: ids } },
          select: {
            id: true,
            productId: true,
            channel: true,
            marketplace: true,
            price: true,
            pricingRule: true,
            priceAdjustmentPercent: true,
            followMasterPrice: true,
            syncPaused: true,
            listingStatus: true,
            isPublished: true,
            externalListingId: true,
          },
          orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { id: 'asc' }],
        })
      : Promise.resolve([]),
    prisma.marketplace.findMany({ select: { channel: true, code: true, currency: true } }) as Promise<MarketCurrencyRow[]>,
  ])
  const itemById = new Map(plan.items.map((item) => [item.id, item]))
  const counts = { queued: 0, paused: 0, draft: 0, ownPrice: 0, otherCurrency: 0, alreadyAtPrice: 0 }
  const lines: string[] = []
  const fates: unknown[] = []
  /**
   * Listings whose pricing rule would take them outside the product's floor or ceiling: refused at the write — not
   * changed, not sent (each keeps its price). Counted apart from the sent, paused and draft ones, as the service does.
   */
  const refused: unknown[] = []
  for (const listing of listings) {
    const item = itemById.get(listing.productId)
    if (!item) continue
    const fate = listingFate(listing, item.to, currencies, plan.currency, item.bounds)
    fates.push([listing.id, fate.kind, fate.from ?? null, fate.to ?? null, fate.currency ?? null])
    const where = `${item.sku} · ${channelLabel(listing.channel)} ${listing.marketplace}`
    if (fate.kind === 'queued' || fate.kind === 'paused' || fate.kind === 'draft') {
      counts[fate.kind]++
      const held = fate.kind === 'queued' ? '' : ` (${fate.kind}: stored, not sent)`
      lines.push(`${where}: ${money(fate.from ?? null)} → ${money(fate.to ?? null)}${held}`)
    } else if (fate.kind === 'refused') {
      refused.push([listing.id, fate.reason])
      lines.push(`${where}: refused, not changed and not sent — it would follow at ${money(fate.to ?? null)}, but ${fate.reason}; it keeps ${money(fate.from ?? null)}`)
    } else if (fate.kind === 'own-price') counts.ownPrice++
    else if (fate.kind === 'already') counts.alreadyAtPrice++
    else {
      counts.otherCurrency++
      lines.push(`${where}: not sent — ${fate.currency ? `that market sells in ${fate.currency}` : 'no currency is configured for that market'}`)
    }
  }
  const changes: Record<string, { from: number | null; to: number }> = {}
  for (const item of plan.items.slice(0, PREVIEW_LINES)) changes[`${item.sku} base price`] = { from: item.from, to: item.to }
  const deltas = plan.items.filter((item) => item.from).map((item) => ((item.to - item.from!) / item.from!) * 100)
  const pct = (n: number) => Math.round(n * 10) / 10
  const how = describeOperation(plan.operation, plan.value, plan.currency)
  const one = counts.queued === 1
  const sent = counts.queued === 0
    ? 'No listing that follows the master price is sent to a marketplace.'
    : `${plural(counts.queued, 'listing')} that follow${one ? 's' : ''} the master price ${one ? 'is' : 'are'} sent to ${one ? 'its' : 'their'} marketplace after a hold of ${holdText()}.`
  return {
    action: plan.operation === 'each' ? 'set-master-prices' : 'bulk-price-change',
    effect:
      `Master price ${how} on ${plural(plan.items.length, 'product')}` +
      (plan.unchanged.length ? ` (${plan.unchanged.length} already at that price)` : '') +
      `. ${sent}`,
    change: { operation: plan.operation, value: plan.value, currency: plan.currency },
    changes,
    ...(plan.items.length > PREVIEW_LINES ? { moreProducts: plan.items.length - PREVIEW_LINES } : {}),
    ...(deltas.length ? { changePercentRange: { lowest: pct(Math.min(...deltas)), highest: pct(Math.max(...deltas)) } } : {}),
    // C1 — only when there are some (a `set` can price a product that had none), so other previews read as before.
    ...(plan.items.length > deltas.length ? { productsWithoutPrice: plan.items.length - deltas.length } : {}),
    listings: lines.slice(0, PREVIEW_LINES),
    ...(lines.length > PREVIEW_LINES ? { moreListings: lines.length - PREVIEW_LINES } : {}),
    totals: {
      products: plan.products.length,
      changing: plan.items.length,
      alreadyAtPrice: plan.unchanged.length,
      listingsSent: counts.queued,
      listingsPaused: counts.paused,
      listingsDrafts: counts.draft,
      listingsWithOwnPrice: counts.ownPrice,
      listingsOtherCurrency: counts.otherCurrency,
      listingsAlreadyAtPrice: counts.alreadyAtPrice,
      // Only when there are some, so a preview without any reads (and fingerprints) as it did before.
      ...(refused.length ? { listingsRefused: refused.length } : {}),
    },
    ...(refused.length
      ? {
          warning:
            `${plural(refused.length, 'listing')} would follow the new master price outside the pricing floor or ceiling set on the product ` +
            '(its pricing rule adjusts the master price), so it is refused: not changed and not sent, and it keeps its current price.',
        }
      : {}),
    basis: basisOf({
      items: plan.items.map((item) => [item.id, item.from, item.to]),
      unchanged: plan.unchanged,
      fates,
      ...(refused.length ? { refused } : {}),
    }),
    note:
      'Nothing changes until a person approves this in Nexus. It sets each master price through the master price service: every listing that ' +
      `follows the master price is updated and queued to its marketplace, held for ${holdText()} (the undo window), then sent on the outbound ` +
      "queue's next pass. A listing with its own price, a paused listing, or a market that sells in another currency is not sent; " +
      "a listing whose pricing rule would take it outside the product's floor or ceiling is not changed either." +
      (plan.operation === 'set' || plan.operation === 'each' ? '' : " A percent or amount change is worked out again from each product's base price when it runs."),
  }
}

const priceChanges = (plan: PricePlan): Change[] =>
  plan.items.map((item) => ({ id: item.id, field: 'basePrice', value: item.to, target: 'master' as const }))

const skuMap = (list: Array<{ id: string; sku: string }>) => new Map(list.map((p) => [p.id, p.sku]))

/**
 * C1 — the master prices a run changed, by product id: `after` is exactly what undo compares with what is stored
 * then; `before` adds each SKU for a person.
 */
export function priceChangeRecord(items: Array<{ id: string; sku: string; from: number | null; to: number }>) {
  return {
    before: {
      prices: Object.fromEntries(items.map((item) => [item.id, item.from])),
      skus: Object.fromEntries(items.map((item) => [item.id, item.sku])),
    },
    after: { prices: Object.fromEntries(items.map((item) => [item.id, item.to])) },
  }
}

/** C1 — the master attribute values a run changed, by product id and attribute code. */
function attributeChangeRecord(changes: Array<{ id: string; sku: string; code: string; from: unknown; to: unknown }>) {
  const side = (pick: 'from' | 'to') => {
    const out: Record<string, Record<string, unknown>> = {}
    for (const c of changes) (out[c.id] ??= {})[c.code] = c[pick] ?? null
    return out
  }
  return {
    before: { attributes: side('from'), skus: Object.fromEntries(changes.map((c) => [c.id, c.sku])) },
    after: { attributes: side('to') },
  }
}

/** The preview of a price plan: the writer's own dry run judges every change; nothing is written. */
async function previewPrices(plan: PricePlan | Refusal, nothing: string, none: string): Promise<ToolResult> {
  if ('error' in plan) return { ok: false, error: plan.error }
  if (!plan.items.length) return { ok: false, error: `${none} ${nothing}` }
  const skuOf = skuMap(plan.items)
  const checked = await writerDryRun(priceChanges(plan), skuOf)
  if ('refusal' in checked) return { ok: false, error: refused(checked.refusal, nothing) }
  return { ok: true, preview: withWriterWarnings(await pricePreview(plan), checked.warnings, skuOf) }
}

/**
 * MCP.10 — runs hours after the preview, perhaps: the plan is worked out again from what is stored now (by the
 * caller), and nothing is written unless every product still exists here and every price still holds.
 */
async function runPrices(plan: PricePlan | Refusal, userId: string | null | undefined, none: string): Promise<ToolResult> {
  if ('error' in plan) return { ok: false, error: plan.error }
  if (!plan.items.length) return { ok: true, data: { changed: 0, note: `${none} when this ran. Nothing changed.` } }
  const changes = priceChanges(plan)
  const checked = await writerDryRun(changes, skuMap(plan.items))
  if ('refusal' in checked) return { ok: false, error: refused(checked.refusal, 'Nothing changed.') }
  try {
    const out = await writerRun(changes, userId)
    const skuOf = skuMap(plan.items)
    return {
      ok: true,
      data: {
        changed: out.updated ?? 0,
        operationId: out.operationId ?? null,
        prices: plan.items.slice(0, PREVIEW_LINES).map((item) => `${item.sku}: ${money(item.from)} → ${money(item.to)}`),
        ...(plan.items.length > PREVIEW_LINES ? { moreProducts: plan.items.length - PREVIEW_LINES } : {}),
        alreadyAtPrice: plan.unchanged.length,
        ...warningOutput(warningLines(out.warnings ?? [], skuOf)),
        ...(out.errors?.length ? { notChanged: out.errors.slice(0, PREVIEW_LINES).map((e) => `${skuOf.get(e.id) ?? e.id}: ${e.error}`) } : {}),
        note: `Listings that follow the master price are queued to their marketplace and sent after a hold of ${holdText()}.`,
      },
      change: priceChangeRecord(plan.items.filter((item) => !out.errors?.some((e) => e.id === item.id))),
    }
  } catch (error) {
    if (!(error instanceof ProductBulkError)) throw error
    return { ok: false, error: refused(error.message, 'Nothing changed.') }
  }
}

/**
 * C2 — undo of a bulk price change (or of set-master-prices): every product back to the master price it had, in ONE
 * request of set-master-prices, through the same gate. Refused while any of those prices is no longer the one the
 * change wrote, and when a product had no master price before (a master price cannot be taken away).
 */
export const PRICES_UNDO: ToolUndo = {
  async current(change) {
    const ids = Object.keys((change.after as { prices?: Record<string, unknown> } | null)?.prices ?? {})
    const rows = await prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, basePrice: true } })
    const now = new Map(rows.map((row) => [row.id, row.basePrice != null ? Number(row.basePrice) : null]))
    return { prices: Object.fromEntries(ids.map((id) => [id, now.get(id) ?? null])) }
  },
  request(change) {
    const before = (change.before ?? {}) as { prices?: Record<string, number | null>; skus?: Record<string, string> }
    const entries = Object.entries(before.prices ?? {})
    if (!entries.length) return { refusal: 'This change names no product.' }
    const none = entries.filter(([, price]) => price == null || !(price > 0)).map(([id]) => before.skus?.[id] ?? id)
    if (none.length) {
      return { refusal: `${plural(none.length, 'product')} had no master price before this change (${listed(none)}), and a master price cannot be taken away.` }
    }
    return { tool: 'set-master-prices', args: { prices: entries.map(([product, price]) => ({ product, price })) } }
  },
}

const bulkPriceChange: AgentTool = {
  name: 'bulk-price-change',
  title: 'Change many master prices',
  input: z.object({
    products,
    operation: z
      .enum(PRICE_OPERATIONS)
      .describe('set = set every master price to value; percent = change each by value % (e.g. -10 lowers it by 10 %); amount = change each by value in the master currency (e.g. 2.5 or -3)'),
    value: z.coerce.number().describe('the new price (set), the percent (percent), or the amount (amount). Every resulting price must stay above 0'),
  }),
  requires: [F.productsPriceEdit, F.productsBulkRun],
  category: 'pricing',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — every previous master price is recorded (AgentChange); undo sets each one again, through the same gate.
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: BULK_PRICE_LIMITS,
  withinLimits: bulkPriceWithinLimits,
  description:
    `Change the master price of up to ${BULK_MAX_PRODUCTS} products at once: set a price, or change it by a percent or an amount. ` +
    'Listings that follow the master price change too and are sent to their marketplace. Waits for a person to approve it in Nexus, unless the business set it to run by its rule (inside its limits, after a short window in which a person can stop it).',
  undo: PRICES_UNDO,
  async handler(args): Promise<ToolResult> {
    return previewPrices(await planPrices(args, 'Nothing was queued.'), 'Nothing was queued.', 'Every product already has that master price.')
  },
  // MCP.10 — runs hours after the preview, perhaps: everything is worked out again from what is stored
  // now, and nothing is written unless every product still exists here and every price still holds.
  async execute(args, ctx): Promise<ToolResult> {
    return runPrices(await planPrices(args, 'Nothing changed.'), ctx.userId, 'Every product already had that master price')
  },
}

// ── set-master-prices (C2) ───────────────────────────────────────────────────────────────────────

/** Each product to its own new master price, from what is stored NOW. All or nothing. */
async function planEachPrice(args: Record<string, unknown>, nothing: string): Promise<PricePlan | Refusal> {
  const entries = (args.prices ?? []) as Array<{ product: string; price: number }>
  const refs = entries.map((entry) => entry.product.trim())
  const twice = refs.filter((ref, i) => refs.indexOf(ref) !== i)
  if (twice.length) return { error: `Each product may be named once: ${listed([...new Set(twice)])}. ${nothing}` }
  const found = await resolveProducts(refs, nothing)
  if ('error' in found) return found
  const byRef = (ref: string) => found.find((product) => product.id === ref) ?? found.find((product) => product.sku === ref)!
  const seen = new Set<string>()
  const items: PricePlan['items'] = []
  const unchanged: string[] = []
  const outOfBounds: string[] = []
  for (const entry of entries) {
    const product = byRef(entry.product.trim())
    if (seen.has(product.id)) return { error: `${product.sku} is named twice (by its id and its SKU). ${nothing}` }
    seen.add(product.id)
    const to = cents(Number(entry.price))
    if (!(to > 0)) return { error: `A master price must stay above 0: ${product.sku} would go to ${money(to)}. ${nothing}` }
    const from = product.basePrice
    const outside = from != null && cents(from) === to ? null : masterPriceBoundsReason(to, product.bounds)
    if (outside) {
      outOfBounds.push(`${product.sku} (${outside})`)
      continue
    }
    if (from != null && cents(from) === to) unchanged.push(product.sku)
    else items.push({ id: product.id, sku: product.sku, from, to, bounds: product.bounds })
  }
  if (outOfBounds.length) {
    return {
      error:
        `A master price must stay within the pricing floor and ceiling set on the product: ${listed(outOfBounds)}. ` +
        `Change the floor or ceiling on those products in Nexus, or leave them out. ${nothing}`,
    }
  }
  return { operation: 'each', value: null, currency: masterCurrency(), products: found, items, unchanged }
}

const setMasterPrices: AgentTool = {
  name: 'set-master-prices',
  title: 'Set master prices, one by one',
  input: z.object({
    prices: z
      .array(
        z.object({
          product: z.string().trim().min(1).max(191).describe('a Nexus product id or SKU'),
          price: z.coerce.number().positive().describe('its new master price, in the master currency; above 0'),
        }),
      )
      .min(1)
      .max(BULK_MAX_PRODUCTS)
      .describe(`each product with its own new master price, 1 to ${BULK_MAX_PRODUCTS}`),
  }),
  requires: [F.productsPriceEdit, F.productsBulkRun],
  category: 'pricing',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: BULK_PRICE_LIMITS,
  withinLimits: bulkPriceWithinLimits,
  undo: PRICES_UNDO,
  description:
    `Set the master price of up to ${BULK_MAX_PRODUCTS} products, each to its own price (undo of a bulk price change uses it). ` +
    'Listings that follow the master price change too and are sent to their marketplace. Waits for a person to approve it in Nexus, unless the business set it to run by its rule (inside its limits, after a short window in which a person can stop it).',
  async handler(args): Promise<ToolResult> {
    return previewPrices(await planEachPrice(args, 'Nothing was queued.'), 'Nothing was queued.', 'Every product already has that master price.')
  },
  async execute(args, ctx): Promise<ToolResult> {
    return runPrices(await planEachPrice(args, 'Nothing changed.'), ctx.userId, 'Every product already had that master price')
  },
}

// ── bulk-attribute-change ────────────────────────────────────────────────────────────────────────

const ATTRIBUTE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,99}$/

const attributeValue = z
  .union([
    z.string().max(5000),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string().max(5000), z.number()])).min(1).max(100),
    z.object({ value: z.number(), unit: z.string().min(1).max(40) }),
  ])
  .describe('text, a number, true/false, a list, or a measure { value, unit }')

interface AttributePlan {
  products: BulkProduct[]
  attributes: Array<[string, unknown]>
  changes: Array<{ id: string; sku: string; code: string; from: unknown; to: unknown }>
  alreadySet: number
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

async function planAttributes(args: Record<string, unknown>, nothing: string): Promise<AttributePlan | Refusal> {
  // Stored approval arguments are jsonb: key order can change without any value changing.
  const attributes = Object.entries((args.attributes ?? {}) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  const refs = args.products as string[]
  if (attributes.length * new Set(refs).size > WRITER_MAX_CHANGES) {
    return {
      error: `At most ${WRITER_MAX_CHANGES} product-attribute changes at once (${new Set(refs).size} products × ${attributes.length} attributes). Split it. ${nothing}`,
    }
  }
  const found = await resolveProducts(refs, nothing)
  if ('error' in found) return found
  // A formula reading one of these attributes is re-evaluated by the writer, and its result can be a
  // price that is queued to a marketplace. This tool promises Nexus only, so it refuses those products.
  const codes = attributes.map(([code]) => code)
  const ids = found.map((product) => product.id)
  const formulas = await prisma.cellFormula.findMany({
    where: {
      OR: [{ productId: { in: ids } }, { product: { parentId: { in: ids } } }],
      dependsOn: { hasSome: [...codes, ...codes.map((code) => `attr_${code}`)] },
    },
    select: { fieldKey: true, product: { select: { sku: true } } },
  })
  if (formulas.length) {
    const lines = [...new Set(formulas.map((f) => `${f.product.sku} (${f.fieldKey})`))]
    return {
      error: `${plural(lines.length, 'formula')} read${lines.length === 1 ? 's' : ''} these attributes and would be recalculated, which can reach a marketplace: ${listed(lines)}. Change these products in the product sheet. ${nothing}`,
    }
  }
  const changes: AttributePlan['changes'] = []
  let alreadySet = 0
  for (const product of found) {
    for (const [code, to] of attributes) {
      const from = product.categoryAttributes[code]
      if (sameValue(from, to)) alreadySet++
      else changes.push({ id: product.id, sku: product.sku, code, from: from ?? null, to })
    }
  }
  return { products: found, attributes, changes, alreadySet }
}

const attributeChanges = (plan: AttributePlan): Change[] =>
  plan.changes.map((c) => ({ id: c.id, field: `attr_${c.code}`, value: c.to, target: 'master' as const }))

function attributePreview(plan: AttributePlan) {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const c of plan.changes.slice(0, PREVIEW_LINES)) changes[`${c.sku} ${c.code}`] = { from: c.from, to: c.to }
  return {
    action: 'bulk-attribute-change',
    scope: 'Nexus only',
    effect: `${NEXUS_ONLY} Sets ${plural(plan.attributes.length, 'attribute')} on ${plural(plan.products.length, 'product')}: ${plural(plan.changes.length, 'change')}${plan.alreadySet ? `, ${plan.alreadySet} already set` : ''}.`,
    changes,
    ...(plan.changes.length > PREVIEW_LINES ? { moreChanges: plan.changes.length - PREVIEW_LINES } : {}),
    attributes: plan.attributes.map(([code, value]) => ({
      attribute: code,
      value,
      changing: plan.changes.filter((c) => c.code === code).length,
      alreadySet: plan.products.length - plan.changes.filter((c) => c.code === code).length,
    })),
    totals: { products: plan.products.length, changes: plan.changes.length, alreadySet: plan.alreadySet },
    basis: basisOf({ changes: plan.changes.map((c) => [c.id, c.code, c.from, c.to]), alreadySet: plan.alreadySet }),
    note: `${NEXUS_ONLY} Nothing changes until a person approves this in Nexus. Every attribute not named here stays as it is.`,
  }
}

const bulkAttributeChange: AgentTool = {
  name: 'bulk-attribute-change',
  title: 'Change many attributes (Nexus)',
  input: z.object({
    products,
    attributes: z
      .record(z.string().regex(ATTRIBUTE_CODE), attributeValue)
      .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= MAX_ATTRIBUTES, {
        message: `name 1 to ${MAX_ATTRIBUTES} attributes`,
      })
      .describe(
        `the master attributes to set, by attribute code, e.g. { "fit": "slim" }; 1 to ${MAX_ATTRIBUTES}. Only an attribute of the product's family, `
        + 'or one saved on the product WITH a value, can be set: a key stored empty or null does not count. Text kept per language '
        + '(title, description, bullet points, keywords, and any attribute the family marks translatable) cannot be set here',
      ),
  }),
  requires: [F.productsEdit, F.productsBulkRun],
  category: 'products',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  // C1 — Nexus only, and every previous value is recorded (AgentChange).
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: BULK_ATTRIBUTE_LIMITS,
  withinLimits: bulkAttributeWithinLimits,
  description:
    `Set master attributes on up to ${BULK_MAX_PRODUCTS} products at once. ${NEXUS_ONLY} Waits for a person to approve it in Nexus, unless the business set it to run by its rule (inside its limits, after a short window in which a person can stop it). `
    + "It sets an attribute of the product's family, or one the product already holds a value for (a key saved empty or null does not count). "
    + 'It cannot set text kept per language — title, description, bullet points, keywords, or an attribute the family marks translatable: '
    + 'those are changed in the product sheet, in the language they are for.',
  async handler(args): Promise<ToolResult> {
    const plan = await planAttributes(args, 'Nothing was queued.')
    if ('error' in plan) return { ok: false, error: plan.error }
    if (!plan.changes.length) return { ok: false, error: 'Every product already has these values. Nothing was queued.' }
    const skuOf = skuMap(plan.products)
    const checked = await writerDryRun(attributeChanges(plan), skuOf)
    if ('refusal' in checked) return { ok: false, error: refused(checked.refusal, 'Nothing was queued.') }
    return { ok: true, preview: withWriterWarnings(attributePreview(plan), checked.warnings, skuOf) }
  },
  // MCP.10 — worked out again from what is stored when it runs; nothing is written unless all of it holds.
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planAttributes(args, 'Nothing changed.')
    if ('error' in plan) return { ok: false, error: plan.error }
    if (!plan.changes.length) {
      return { ok: true, data: { changed: 0, note: `Every product already had these values when this ran. Nothing changed. ${NEXUS_ONLY}` } }
    }
    const changes = attributeChanges(plan)
    const skuOf = skuMap(plan.products)
    const checked = await writerDryRun(changes, skuOf)
    if ('refusal' in checked) return { ok: false, error: refused(checked.refusal, 'Nothing changed.') }
    try {
      const out = await writerRun(changes, ctx.userId)
      return {
        ok: true,
        data: {
          changed: out.updated ?? 0,
          operationId: out.operationId ?? null,
          alreadySet: plan.alreadySet,
          ...warningOutput(warningLines(out.warnings ?? [], skuOf)),
          ...(out.errors?.length ? { notChanged: out.errors.slice(0, PREVIEW_LINES).map((e) => `${skuOf.get(e.id) ?? e.id} ${e.field.replace(/^attr_/, '')}: ${plainRefusal(e.error)}`) } : {}),
          note: NEXUS_ONLY,
        },
        change: attributeChangeRecord(plan.changes.filter((c) => !out.errors?.some((e) => e.id === c.id && e.field === `attr_${c.code}`))),
      }
    } catch (error) {
      if (!(error instanceof ProductBulkError)) throw error
      return { ok: false, error: refused(error.message, 'Nothing changed.') }
    }
  },
}

export const BULK_TOOLS: AgentTool[] = [bulkPriceChange, setMasterPrices, bulkAttributeChange]
