/**
 * MCP full control 08 S11 — prices across many listings, and the floor and ceiling every price is held to.
 *
 *   set-price-bounds            a product's pricing floor and ceiling (Product.minPrice / maxPrice), through the
 *                               product write the grid uses (`applyProductBulkEdits`). The preview names the listings
 *                               whose price would then sit outside them: the price door refuses to send those.
 *   bulk-listing-price-change   up to 250 listings' own prices by a percent, by an amount, to one price, or each to its
 *                               own price (an undo), optionally rounded down to .99 — each through the ONE channel price
 *                               door (`writeChannelPrices`), checked against the price the person approved (2.3: not the
 *                               listing's version, which an order's stock cascade moves). Amazon Business step 6: or up to 250
 *                               Amazon listings' business prices and quantity tiers (`businessPrices`), each through the business
 *                               price door the Matrix writes with (`writeBusinessPrices`, previewed by its dry run), in one
 *                               approval that a person always gives (never by rule).
 *   resend-prices               send the price each listing already carries again, through the door's send mode
 *                               (`pushPriceUpdate`, `/pricing`'s "Push price"); on Amazon also the business price Nexus keeps
 *                               (`queueBusinessSends`: Amazon is sent only what differs).
 *
 * The rules are the door's, held here before anything is queued so the preview is the truth: a typed price only in a
 * market that sells in the master currency (another currency is refused: Nexus never converts, and the floor and
 * ceiling are master-currency numbers); never below 0.01, never outside the product's floor or ceiling. A price change
 * on an Amazon FBA listing changes its PRICE only: a price write never carries a quantity, and FBA quantity is Amazon's.
 * Nothing names another business: listings and products are found in the caller's business only.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { assertPushAllowed } from '@nexus/shared/push-lock'
import prisma from '../../../db.js'
import { masterCurrency } from '../../fx-rate.service.js'
import { priceBoundsOf, storedPriceReason, type PriceBounds } from '../../price-bounds.service.js'
import { holdsCascadedPrice, listingMarketCurrency, listingSendPrice } from '../../pim/follower-price.js'
import { roundDownTo99 } from '../../bulk-action/price-rounding.js'
import { logger } from '../../../utils/logger.js'
import type { ProductBulkContext } from '../../products/bulk-edit.service.js'
import { approvedOnVersion, BASIS_ON_FIELDS, type AgentTool, type PlanFacts, type PlanWrite, type ToolContext, type ToolResult, type ToolUndo } from '../tool-types.js'
import { listingPlanFacts, listingPriceFacts, pinnedPrice, type ListingFacts } from './listing-facts.js'
import { PRODUCT_NOT_FOUND } from './live-product.js'
import {
  BUSINESS_FIELDS, businessSettingWords, businessUndoRequest, currentBusinessRecords, planBusinessPrices,
  type BusinessInput, type BusinessLine, type BusinessRecord,
} from './business-price-plan.js'
import { businessPriceOf, type BusinessPriceSetting } from '@nexus/shared/business-price'
import { businessNormalPrice, storedBusinessSetting } from '../../amazon/business-offer.js'
import { businessHeld } from '../../pim/business-held.js'

const PREVIEW_LINES = 20
const MAX_LISTINGS = 250
const MAX_PRODUCTS = 250
const NOT_YET = 'Nothing changes until a person approves this in Nexus.'
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
/** A yes/no argument; the words true and false count as one (z.coerce.boolean would read "false" as true). */
const flag = z.preprocess((value) => (value === 'true' ? true : value === 'false' ? false : value), z.boolean())
const basisOf = (facts: unknown) => createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16)
const listed = (lines: string[]) => (lines.length > 5 ? `${lines.slice(0, 5).join('; ')}; and ${lines.length - 5} more` : lines.join('; '))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const cents = (n: number) => Math.round(n * 100) / 100
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const actorOf = (ctx: ToolContext, tool: string) => ctx.userId ?? `agent:${tool}`
const LISTING_NOT_FOUND = 'Listing not found'

type Refusal = { error: string }
const refused = (r: unknown): r is Refusal => !!r && typeof r === 'object' && 'error' in r

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, version: true,
  price: true, priceOverride: true, followMasterPrice: true, pricingRule: true, priceAdjustmentPercent: true,
  syncPaused: true, listingStatus: true, isPublished: true, externalListingId: true, fulfillmentMethod: true,
  product: { select: { sku: true, basePrice: true, minPrice: true, maxPrice: true, deletedAt: true } },
} as const

interface PriceListing {
  id: string; productId: string; channel: string; marketplace: string; channelConnectionId: string | null; aliasKey: string; version: number
  price: unknown; priceOverride: unknown; followMasterPrice: boolean | null; pricingRule: string | null; priceAdjustmentPercent: unknown
  syncPaused: boolean; listingStatus: string; isPublished: boolean; externalListingId: string | null; fulfillmentMethod: string | null
  product: { sku: string; basePrice: unknown; minPrice: unknown; maxPrice: unknown; deletedAt: Date | null } | null
}

/** The listings named, in this business, each once; a missing one (or another business's) refuses the request. */
async function listingsById(ids: string[]): Promise<Map<string, PriceListing> | Refusal> {
  const wanted = [...new Set(ids)]
  const rows = await prisma.channelListing.findMany({ where: { id: { in: wanted } }, select: LISTING_SELECT }) as unknown as PriceListing[]
  if (rows.length !== wanted.length || rows.some((r) => !r.product || r.product.deletedAt)) return { error: LISTING_NOT_FOUND }
  return new Map(rows.map((r) => [r.id, r]))
}

/** Each listing's market currency (the door's own reading of a market: GB is UK, EBAY_IT is IT). */
async function currencies(listings: PriceListing[]) {
  const channels = [...new Set(listings.map((l) => l.channel))]
  const rows = channels.length ? await prisma.marketplace.findMany({ where: { channel: { in: channels } }, select: { channel: true, code: true, currency: true } }) : []
  return (l: PriceListing) => listingMarketCurrency(l, rows)
}

const where = (l: PriceListing) => `${l.product?.sku ?? l.productId} on ${l.channel} ${l.marketplace}`
/** The listing's own price state: a number when it is pinned at its own price, null when it follows the master. */
const ownPrice = (l: { followMasterPrice: boolean | null; priceOverride: unknown; price: unknown }) =>
  l.followMasterPrice === false ? num(l.priceOverride) ?? num(l.price) : null

// ── bulk-listing-price-change ─────────────────────────────────────────────────────────────────────────

export const BULK_LISTING_PRICE_LIMITS = z.object({
  maxListings: z.number().int().positive().max(MAX_LISTINGS).default(MAX_LISTINGS).describe('the most listings one request reprices'),
  maxChangePct: z.number().positive().max(100).default(10).describe('the largest move of one price, in percent, allowed without a person'),
})

/** Amazon Business step 6 — a business price change never runs by a business's rule: a person approves it. */
export const BUSINESS_NEEDS_A_PERSON = 'it changes business prices (Amazon Business), which a person approves in Nexus'

export function bulkListingPriceWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  if ((preview as { businessPrices?: unknown } | null)?.businessPrices === true) return BUSINESS_NEEDS_A_PERSON
  const totals = (preview as { totals?: { listings?: unknown; maxChangePct?: unknown } } | null)?.totals
  if (typeof totals?.listings !== 'number' || typeof totals.maxChangePct !== 'number') return 'the request does not say how many prices it moves, or how far'
  if (totals.listings > Number(limits.maxListings)) return `it reprices ${totals.listings} listings, more than the ${limits.maxListings} allowed without a person`
  if (totals.maxChangePct > Number(limits.maxChangePct)) return `one price moves ${totals.maxChangePct}%, more than the ${limits.maxChangePct}% allowed without a person`
  return null
}

const priceInput = z.object({
  listingIds: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_LISTINGS).optional()
    .describe('the Nexus listing ids to reprice with mode and value (listing-coordinates names them)'),
  mode: z.preprocess(lower, z.enum(['percent', 'amount', 'set'])).optional()
    .describe('with listingIds: percent — each price moves by value % (-5 lowers 5 %); amount — value is added (negative lowers); set — every listing at value'),
  value: z.coerce.number().min(-100_000).max(100_000).optional().describe('with mode: the percent, the amount or the price, in the master currency'),
  endIn99: flag.optional().describe('round each new price down to the largest price ending in .99 (25.40 → 24.99)'),
  prices: z.array(z.object({
    listingId: z.string().trim().min(1).max(64).describe('the Nexus listing id'),
    price: z.coerce.number().positive().max(1_000_000).nullable().describe('its own price; null hands it back to the master price (its rule)'),
  })).min(1).max(MAX_LISTINGS).optional().describe('instead of listingIds: each listing to its own price (how an undo puts prices back)'),
  businessPrices: z.array(z.object({
    listingId: z.string().trim().min(1).max(64).describe('the Nexus id of an Amazon listing (listing-coordinates or listing-matrix names it)'),
    ...BUSINESS_FIELDS,
  })).min(1).max(MAX_LISTINGS).optional().describe('instead of listingIds or prices: Amazon listings\' business prices for business buyers (Amazon Business), '
    + 'each with its own rule (PERCENT_OFF with percent, FIXED with price) and quantity discounts (tiers), or remove: true; what is left out keeps what the listing has'),
})

interface PriceLine { listing: PriceListing; from: number | null; to: number | null; currency: string; held: boolean }

interface PricePlan { lines: PriceLine[]; unchanged: number; ids: string[] }

async function planListingPrices(args: Record<string, unknown>): Promise<PricePlan | Refusal> {
  const listingIds = (args.listingIds as string[] | undefined) ?? []
  const prices = (args.prices as Array<{ listingId: string; price: number | null }> | undefined) ?? []
  if (listingIds.length && prices.length) return { error: 'Name listingIds with mode and value, or prices — one of the two.' }
  if (!listingIds.length && !prices.length) return { error: 'Name the listings to reprice (listingIds with mode and value), prices, or businessPrices.' }
  const mode = args.mode as 'percent' | 'amount' | 'set' | undefined
  const value = args.value as number | undefined
  if (listingIds.length && (!mode || value === undefined)) return { error: 'Name how to change the prices: mode (percent, amount or set) and value.' }
  if (prices.length && (mode || value !== undefined)) return { error: 'prices names each price itself: leave mode and value out.' }
  if (mode === 'set' && !(value! > 0)) return { error: 'A price is above 0.' }
  const ids = listingIds.length ? listingIds : prices.map((p) => p.listingId)
  if (new Set(ids).size !== ids.length) return { error: 'A listing is named twice. Name each listing once.' }
  const byId = await listingsById(ids)
  if (refused(byId)) return byId
  const currencyOf = await currencies([...byId.values()])
  const master = masterCurrency()
  const problems: string[] = []
  const lines: PriceLine[] = []
  let unchanged = 0
  for (const id of ids) {
    const l = byId.get(id)!
    const currency = currencyOf(l)
    // Refuse, don't convert: a typed price is in the master currency, and only such a market takes one (the floor and
    // ceiling are master-currency numbers too).
    if (currency !== master) {
      problems.push(`${where(l)} sells in ${currency ?? 'a currency not configured in Nexus'}, not ${master}: Nexus never converts a price, so change it there in Nexus`)
      continue
    }
    const send = listingSendPrice(l, { masterPrice: l.product?.basePrice, marketCurrency: currency, masterCurrency: master, where: `${l.channel} ${l.marketplace}` })
    const from = send.price
    let to: number | null
    if (prices.length) {
      to = prices.find((p) => p.listingId === id)!.price
      if (to !== null) to = cents(to)
    } else {
      if (from === null && mode !== 'set') { problems.push(`${where(l)} has no price to start from (${send.reason})`); continue }
      to = mode === 'set' ? cents(value!) : mode === 'percent' ? cents(from! * (1 + value! / 100)) : cents(from! + value!)
    }
    if (to !== null && args.endIn99 === true) {
      const rounded = roundDownTo99(to)
      if (rounded === null) { problems.push(`${where(l)}: ${to.toFixed(2)} has no lower price ending in .99`); continue }
      to = rounded
    }
    if (to !== null) {
      const why = storedPriceReason(to, priceBoundsOf(l.product ?? {}))
      if (why) { problems.push(`${where(l)}: ${why}`); continue }
    }
    // Already so: the same own price (a pin), or already following the master for a hand-back.
    if (to === null ? l.followMasterPrice !== false : l.followMasterPrice === false && ownPrice(l) === to) { unchanged++; continue }
    lines.push({ listing: l, from, to, currency, held: holdsCascadedPrice(l) })
  }
  if (problems.length) return { error: `Not queued: ${listed(problems)}.` }
  if (!lines.length) return { error: `Every listing named already has that price (${plural(unchanged, 'listing')}). Nothing to change.` }
  return { lines, unchanged, ids }
}

const pct = (from: number | null, to: number | null) => (from && to !== null ? Math.round(((to - from) / from) * 1000) / 10 : null)

/**
 * 2.3 — every fact the preview stands on (listing-facts.ts: each named listing's own price, sale and pricing, its
 * product's master price) and what it sets. The basis is both: an order's stock cascade moves none of them; a price or a
 * sale someone else set does. A listing's sale is part of it, so a new price never runs past a sale nobody saw.
 */
async function priceFacts(plan: PricePlan): Promise<{ facts: ListingFacts; planFacts: PlanFacts }> {
  const facts = await listingPriceFacts(plan.ids)
  return { facts, planFacts: listingPlanFacts(facts, Object.fromEntries(plan.lines.map((line) => [`listing:${line.listing.id}:price`, line.to]))) }
}

function listingPricePreview(plan: PricePlan, planFacts: PlanFacts) {
  const moves = plan.lines.map((line) => pct(line.from, line.to)).filter((p): p is number => p !== null)
  const maxChangePct = moves.length ? Math.max(...moves.map(Math.abs)) : 0
  const up = plan.lines.filter((line) => line.from !== null && line.to !== null && line.to > line.from).length
  const held = plan.lines.filter((line) => line.held)
  return {
    action: 'bulk-listing-price-change',
    summary: `New prices on ${plural(plan.lines.length, 'listing')}${plan.unchanged ? ` (${plan.unchanged} already at that price)` : ''}: ${up} up, ${plan.lines.length - up} down or handed back.`,
    changes: plan.lines.slice(0, PREVIEW_LINES).map((line) => ({
      sku: line.listing.product?.sku ?? line.listing.productId, channel: line.listing.channel, market: line.listing.marketplace, currency: line.currency,
      from: line.from, to: line.to ?? 'follows the master price', ...(pct(line.from, line.to) !== null ? { changePct: pct(line.from, line.to) } : {}),
      ...(line.listing.fulfillmentMethod === 'FBA' ? { note: 'Amazon FBA: its price only; its quantity stays Amazon\'s' } : {}),
      ...(line.held ? { held: line.listing.syncPaused ? 'paused: kept in Nexus, sent when it resumes' : 'a draft: kept in Nexus, sent by Publish' } : {}),
    })),
    ...(plan.lines.length > PREVIEW_LINES ? { moreChanges: plan.lines.length - PREVIEW_LINES } : {}),
    totals: { listings: plan.lines.length, unchanged: plan.unchanged, up, maxChangePct, held: held.length },
    // 2.3 — what each price stands on and what it sets (`planFacts`): never the listing's version, which an order's stock
    // cascade moves, so the price change would have been refused for nothing.
    basisOn: BASIS_ON_FIELDS,
    planFacts,
    basis: basisOf(planFacts),
    // The basis a request approved before 2.3 stood on (each listing's version): it is checked on it, as it was approved.
    versionBasis: basisOf(plan.lines.map((line) => [line.listing.id, line.listing.version, num(line.listing.price), num(line.listing.priceOverride), line.listing.followMasterPrice, num(line.listing.product?.basePrice), line.to])),
    note: `${NOT_YET} Each price goes through the Nexus price door as the person who approves it: a listing given its own price stops `
      + 'following the master price; one that changed since the approval is not touched. Prices are sent in the market\'s own currency, never a quantity.',
  }
}

/** Amazon Business step 6 — business prices of many listings: one line per listing, from → to, each as the door decides. */
async function planBusinessBulk(args: Record<string, unknown>, ctx: ToolContext): Promise<{ lines: BusinessLine[]; unchanged: number } | Refusal> {
  const asked = args.businessPrices as Array<{ listingId: string } & BusinessInput>
  if ((args.listingIds as unknown[] | undefined)?.length || (args.prices as unknown[] | undefined)?.length || args.mode !== undefined || args.value !== undefined || args.endIn99 !== undefined) {
    return { error: 'businessPrices names each business price itself: leave listingIds, prices, mode, value and endIn99 out (one request changes normal prices or business prices).' }
  }
  if (new Set(asked.map((b) => b.listingId)).size !== asked.length) return { error: 'A listing is named twice. Name each listing once.' }
  const byId = await listingsById(asked.map((b) => b.listingId))
  if (refused(byId)) return byId
  const plan = await planBusinessPrices(asked.map(({ listingId, ...input }) => ({ listingId, input })), actorOf(ctx, 'bulk-listing-price-change'))
  // As for normal prices: a listing the door would refuse refuses the request, before anything is queued.
  if (plan.refused.length) return { error: `Not queued: ${listed(plan.refused.map((r) => `${r.sku} on AMAZON ${r.marketplace ?? ''}: ${r.reason}`))}.` }
  if (!plan.lines.length) return { error: `Every listing named already has that business price (${plural(plan.unchanged, 'listing')}). Nothing to change.` }
  return { lines: plan.lines, unchanged: plan.unchanged }
}

function businessBulkPreview(plan: { lines: BusinessLine[]; unchanged: number }) {
  const removed = plan.lines.filter((l) => !l.to).length
  const warnings = plan.lines.flatMap((l) => l.warnings.map((w) => `${l.sku} on Amazon ${l.marketplace}: ${w}`))
  return {
    action: 'bulk-listing-price-change',
    // Never run by rule (`bulkListingPriceWithinLimits`): a person approves every business price change.
    businessPrices: true,
    summary: `New business prices (Amazon Business) on ${plural(plan.lines.length, 'listing')}${plan.unchanged ? ` (${plan.unchanged} already so)` : ''}: `
      + `${plan.lines.length - removed} set or changed, ${removed} removed.`,
    changes: plan.lines.slice(0, PREVIEW_LINES).map((l) => ({
      sku: l.sku, channel: 'AMAZON', market: l.marketplace, label: 'B2B price', currency: l.currency,
      fromLabel: businessSettingWords(l.from, l.currency), toLabel: businessSettingWords(l.to, l.currency),
    })),
    ...(plan.lines.length > PREVIEW_LINES ? { moreChanges: plan.lines.length - PREVIEW_LINES } : {}),
    // What the settings give today (a percent follows the normal price; the door checks each again when it writes).
    prices: plan.lines.slice(0, PREVIEW_LINES).map((l) => ({ sku: l.sku, market: l.marketplace, currency: l.currency, normalPrice: l.normalPrice, now: l.priceNow, after: l.priceAfter })),
    totals: { listings: plan.lines.length, unchanged: plan.unchanged, removed },
    // 2.3 — it stands on each listing's business setting as it is and as it gets, never the listing's version.
    basisOn: BASIS_ON_FIELDS,
    basis: basisOf(plan.lines.map((l) => [l.listingId, l.from, l.to])),
    ...(warnings.length ? { warnings: warnings.slice(0, PREVIEW_LINES) } : {}),
    note: `${NOT_YET} Each business price goes through the Nexus business price door (the Matrix's own), as the person who approves it, `
      + 'and is then sent to Amazon — or kept in Nexus until a paused, draft or Inactive listing can be sent to. One that changed since is not touched.',
  }
}

async function runBusinessBulk(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const plan = await planBusinessBulk(args, ctx)
  if (refused(plan)) return { ok: false, error: plan.error }
  const approved = ctx.approvedPreview as { basis?: unknown; businessPrices?: unknown } | undefined
  if (approved?.businessPrices !== true || typeof approved.basis !== 'string') return { ok: false, error: 'A business price change runs only after a person approved its preview. Nothing changed.' }
  if (approved.basis !== businessBulkPreview(plan).basis) return { ok: false, error: 'A listing\'s business price changed since this was approved. Nothing changed; ask Claude again.' }
  const { writeBusinessPrices } = await import('../../pim/business-price-write.service.js')
  // At the version just read: anything landing on a listing between this read and its write is a conflict for that listing.
  const written = await writeBusinessPrices({
    targets: plan.lines.map((l) => ({ listingId: l.listingId, setting: l.to, expectedVersion: l.version })),
    actor: actorOf(ctx, 'bulk-listing-price-change'), reason: 'Claude bulk-listing-price-change (approved in Nexus)',
  })
  const appliedIds = new Set(written.results.filter((r) => r.outcome === 'applied').map((r) => r.listingId))
  const failed = written.results.filter((r) => r.outcome === 'refused' || r.outcome === 'conflict')
  const done = plan.lines.filter((l) => appliedIds.has(l.listingId))
  if (!done.length) return { ok: false, error: `Nothing changed: ${listed(failed.map((r) => `${r.listingId}: ${r.reason ?? r.outcome}`))}` }
  const record = (l: BusinessLine, setting: BusinessLine['from']): BusinessRecord => ({ listingId: l.listingId, setting })
  return {
    ok: true,
    data: {
      changed: done.length,
      notChanged: failed.map((r) => ({ listingId: r.listingId, reason: r.reason ?? r.outcome })),
      notSent: written.results.filter((r) => r.notSent).slice(0, PREVIEW_LINES).map((r) => ({ listingId: r.listingId, why: r.notSent })),
    },
    change: {
      before: { businessPrices: done.map((l) => ({ ...record(l, l.from), sku: l.sku, ...(l.amazonOwn ? { amazonOwn: l.amazonOwn } : {}) })) },
      after: { businessPrices: done.map((l) => record(l, l.to)) },
    },
  }
}

const LISTING_PRICE_UNDO: ToolUndo = {
  async current(change) {
    // Amazon Business: each listing's business setting as stored now.
    const business = (change.after as { businessPrices?: BusinessRecord[] } | null)?.businessPrices
    if (business) return { businessPrices: await currentBusinessRecords(business) }
    const after = ((change.after as { prices?: Array<{ listingId: string }> } | null)?.prices ?? [])
    const rows = after.length ? await prisma.channelListing.findMany({ where: { id: { in: after.map((p) => p.listingId) } }, select: { id: true, followMasterPrice: true, priceOverride: true, price: true } }) : []
    const byId = new Map(rows.map((r) => [r.id, r]))
    return { prices: after.map((p) => { const r = byId.get(p.listingId); return { listingId: p.listingId, price: r ? ownPrice(r) : null } }) }
  },
  request(change) {
    const business = (change.before as { businessPrices?: BusinessRecord[] } | null)?.businessPrices
    if (business) return businessUndoRequest(business)
    const before = ((change.before as { prices?: Array<{ listingId: string; price: number | null }> } | null)?.prices ?? [])
    if (!before.length) return { refusal: 'This change does not name the prices it replaced.' }
    return { tool: 'bulk-listing-price-change', args: { prices: before.map(({ listingId, price }) => ({ listingId, price })) } }
  },
}

const bulkListingPriceChange: AgentTool = {
  name: 'bulk-listing-price-change',
  title: 'Change many listing prices',
  input: priceInput,
  requires: [F.productsPriceEdit, F.listingsEdit],
  category: 'pricing',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: BULK_LISTING_PRICE_LIMITS,
  withinLimits: bulkListingPriceWithinLimits,
  undo: LISTING_PRICE_UNDO,
  // 2.3 — a later step of a plan re-based on an earlier step's own price writes: its lines, totals and basis follow the
  // facts it stands on (`planFacts`), which are checked one by one.
  planRebase: () => ['changes', 'totals', 'basis'],
  description:
    `Change the own price of up to ${MAX_LISTINGS} listings: by a percent, by an amount, all to one price, or each to its own price, `
    + 'optionally rounded down to .99. Each listing given a price stops following the master price (a price of null hands it '
    + 'back). Refused before anything is queued: a market that sells in another currency than the master (Nexus never '
    + 'converts), a price outside the product\'s floor or ceiling, a price of 0. On an Amazon FBA listing only the price '
    + 'changes. Or (businessPrices) up to 250 Amazon listings\' business prices for business buyers (Amazon Business), each with '
    + 'its own rule — PERCENT_OFF (the normal price minus percent, following it) or FIXED (exact) — and up to 5 quantity '
    + 'discounts, or remove: true, through the business price door the Matrix uses: refused before anything is queued where '
    + 'Amazon lists no Amazon Business, on a parent, or where Amazon would refuse or hide it; a business price Amazon shows '
    + 'that Nexus never kept is never removed from here; a business price change is never run by rule. Waits for a person '
    + 'to approve it in Nexus unless the business lets Claude make small moves itself; a listing that changed since is not '
    + 'touched.',
  async handler(args, ctx): Promise<ToolResult> {
    if (args.businessPrices) {
      const plan = await planBusinessBulk(args, ctx)
      if (refused(plan)) return { ok: false, error: plan.error }
      return { ok: true, preview: businessBulkPreview(plan) }
    }
    const plan = await planListingPrices(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    return { ok: true, preview: listingPricePreview(plan, (await priceFacts(plan)).planFacts) }
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (args.businessPrices) return runBusinessBulk(args, ctx)
    const plan = await planListingPrices(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const approved = ctx.approvedPreview as { basis?: unknown; basisOn?: unknown } | undefined
    if (typeof approved?.basis !== 'string') return { ok: false, error: 'A price change runs only after a person approved its preview. Nothing changed.' }
    // 2.3 — the prices (and sales) as the person saw them; a request approved before stands on each listing's version, as
    // approved.
    const { facts, planFacts } = await priceFacts(plan)
    const now = listingPricePreview(plan, planFacts)
    if (approved.basis !== (approvedOnVersion(approved) ? now.versionBasis : now.basis)) return { ok: false, error: 'A listing\'s price or sale changed since this was approved. Nothing changed; ask Claude again.' }
    const { writeChannelPrices } = await import('../../pim/channel-price-write.service.js')
    const written = await writeChannelPrices({
      // At the version just read: anything landing on a listing between this read and its write (a sale set on the Matrix,
      // a price) is a conflict for that listing. No `expectedPrice`: the door's A-17 retry compares the own price only and
      // would write past a sale set in that gap.
      targets: plan.lines.map((line) => ({ listingId: line.listing.id, price: line.to, expectedVersion: line.listing.version })),
      actor: actorOf(ctx, 'bulk-listing-price-change'), source: 'BULK_OVERRIDE', reason: 'Claude bulk-listing-price-change (approved in Nexus)',
    })
    const applied = new Set(written.results.filter((r) => r.outcome === 'applied' || r.outcome === 'noop').map((r) => r.listingId))
    const failed = written.results.filter((r) => r.outcome === 'refused' || r.outcome === 'conflict')
    const done = plan.lines.filter((line) => applied.has(line.listing.id))
    if (!done.length) return { ok: false, error: `Nothing changed: ${listed(failed.map((r) => `${r.listingId}: ${r.reason ?? r.outcome}`))}` }
    const after = await prisma.channelListing.findMany({ where: { id: { in: done.map((line) => line.listing.id) } }, select: { id: true, followMasterPrice: true, priceOverride: true, price: true } })
    const afterById = new Map(after.map((r) => [r.id, r]))
    // 2.3 — what this run wrote, from the price door's own answer: each listing pinned at its new price (a hand-back to the
    // master price is not named — a later step standing on it is checked as approved).
    const pinned = new Set(written.results.filter((r) => r.outcome === 'applied').map((r) => r.listingId))
    const planWrites: PlanWrite[] = plan.lines.filter((line) => pinned.has(line.listing.id) && line.to !== null).map((line) => ({
      key: `listing:${line.listing.id}:price`, before: facts.writable.get(`listing:${line.listing.id}:price`), after: pinnedPrice(line.to!),
    }))
    return {
      planWrites,
      ok: true,
      data: {
        changed: done.length,
        notChanged: failed.map((r) => ({ listingId: r.listingId, reason: r.reason ?? r.outcome })),
        notSent: written.results.filter((r) => r.notSent).slice(0, PREVIEW_LINES).map((r) => ({ listingId: r.listingId, why: r.notSent })),
      },
      change: {
        before: { prices: done.map((line) => ({ listingId: line.listing.id, sku: line.listing.product?.sku ?? null, price: ownPrice(line.listing) })) },
        after: { prices: done.map((line) => { const r = afterById.get(line.listing.id); return { listingId: line.listing.id, price: r ? ownPrice(r) : null } }) },
      },
    }
  },
}

// ── set-price-bounds ──────────────────────────────────────────────────────────────────────────────────

const boundValue = z.coerce.number().min(0).max(1_000_000).nullable().optional()

const boundsInput = z.object({
  items: z.array(z.object({
    productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
    minPrice: boundValue.describe('the pricing floor in the master currency; null removes it; left out keeps it'),
    maxPrice: boundValue.describe('the pricing ceiling in the master currency; null removes it; left out keeps it'),
  })).min(1).max(MAX_PRODUCTS).describe(`the products and their new floor and ceiling, 1 to ${MAX_PRODUCTS}`),
})

interface BoundsLine { productId: string; sku: string; from: PriceBounds; to: PriceBounds; basePrice: number | null; outside: Array<{ where: string; price: number; why: string }> }

async function planBounds(args: Record<string, unknown>): Promise<{ lines: BoundsLine[] } | Refusal> {
  const items = (args.items ?? []) as Array<{ productId: string; minPrice?: number | null; maxPrice?: number | null }>
  if (new Set(items.map((i) => i.productId)).size !== items.length) return { error: 'A product is named twice. Name each product once.' }
  if (items.some((i) => i.minPrice === undefined && i.maxPrice === undefined)) return { error: 'Name a floor (minPrice) or a ceiling (maxPrice) for each product.' }
  const products = await prisma.product.findMany({ where: { id: { in: items.map((i) => i.productId) }, deletedAt: null }, select: { id: true, sku: true, basePrice: true, minPrice: true, maxPrice: true } })
  if (products.length !== items.length) return { error: PRODUCT_NOT_FOUND }
  const byId = new Map(products.map((p) => [p.id, p]))
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: products.map((p) => p.id) }, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
    select: LISTING_SELECT,
  }) as unknown as PriceListing[]
  const currencyOf = await currencies(listings)
  const master = masterCurrency()
  const problems: string[] = []
  const lines: BoundsLine[] = []
  for (const item of items) {
    const p = byId.get(item.productId)!
    const from = priceBoundsOf(p)
    const to: PriceBounds = {
      minPrice: item.minPrice === undefined ? from.minPrice : item.minPrice === null ? null : cents(item.minPrice),
      maxPrice: item.maxPrice === undefined ? from.maxPrice : item.maxPrice === null ? null : cents(item.maxPrice),
    }
    if (to.minPrice !== null && to.maxPrice !== null && to.minPrice > to.maxPrice) { problems.push(`${p.sku}: the floor ${to.minPrice.toFixed(2)} would be above the ceiling ${to.maxPrice.toFixed(2)}`); continue }
    if (to.minPrice === from.minPrice && to.maxPrice === from.maxPrice) continue
    // The prices that would then sit outside: the door refuses to send them (master-currency markets only).
    const outside: BoundsLine['outside'] = []
    for (const l of listings.filter((x) => x.productId === p.id)) {
      const currency = currencyOf(l)
      if (currency !== master) continue
      const send = listingSendPrice(l, { masterPrice: p.basePrice, marketCurrency: currency, masterCurrency: master })
      const why = send.price === null ? null : storedPriceReason(send.price, to)
      if (why && send.price !== null) outside.push({ where: `${l.channel} ${l.marketplace}`, price: send.price, why })
    }
    lines.push({ productId: p.id, sku: p.sku, from, to, basePrice: num(p.basePrice), outside })
  }
  if (problems.length) return { error: `Not queued: ${listed(problems)}.` }
  if (!lines.length) return { error: 'Every product already has that floor and ceiling. Nothing to change.' }
  return { lines }
}

const money = (n: number | null) => (n === null ? 'none' : n.toFixed(2))

function boundsPreview(plan: { lines: BoundsLine[] }) {
  const outside = plan.lines.flatMap((line) => line.outside.map((o) => `${line.sku} on ${o.where} at ${o.price.toFixed(2)}`))
  const masterOutside = plan.lines.filter((line) => line.basePrice !== null && storedPriceReason(line.basePrice, line.to))
  return {
    action: 'set-price-bounds',
    summary: `New pricing floor or ceiling on ${plural(plan.lines.length, 'product')} (master currency ${masterCurrency()}).`,
    changes: plan.lines.slice(0, PREVIEW_LINES).map((line) => ({
      sku: line.sku, floor: { from: money(line.from.minPrice), to: money(line.to.minPrice) }, ceiling: { from: money(line.from.maxPrice), to: money(line.to.maxPrice) },
      ...(line.outside.length ? { listingsOutside: line.outside.length } : {}),
    })),
    ...(plan.lines.length > PREVIEW_LINES ? { moreChanges: plan.lines.length - PREVIEW_LINES } : {}),
    totals: { products: plan.lines.length, listingsOutside: outside.length, masterPricesOutside: masterOutside.length },
    basis: basisOf(plan.lines.map((line) => [line.productId, line.from.minPrice, line.from.maxPrice, line.to.minPrice, line.to.maxPrice])),
    ...(outside.length || masterOutside.length ? {
      warnings: [
        ...(outside.length ? [`${plural(outside.length, 'listing price')} would sit outside the new bounds, and the price door refuses to send them: ${listed(outside)}.`] : []),
        ...(masterOutside.length ? [`The master price of ${listed(masterOutside.map((line) => `${line.sku} (${money(line.basePrice)})`))} would sit outside: a master price change is refused until it is inside.`] : []),
      ],
    } : {}),
    note: `${NOT_YET} The floor and ceiling are master-currency numbers: every price Nexus stores or sends in a master-currency market is held to them (refused, never clamped). Nothing is sent to a channel by this change.`,
  }
}

const BOUNDS_UNDO: ToolUndo = {
  async current(change) {
    const items = ((change.after as { items?: Array<{ productId: string }> } | null)?.items ?? [])
    const rows = items.length ? await prisma.product.findMany({ where: { id: { in: items.map((i) => i.productId) } }, select: { id: true, minPrice: true, maxPrice: true } }) : []
    const byId = new Map(rows.map((r) => [r.id, priceBoundsOf(r)]))
    return { items: items.map((i) => ({ productId: i.productId, ...(byId.get(i.productId) ?? { minPrice: null, maxPrice: null }) })) }
  },
  request(change) {
    const before = ((change.before as { items?: Array<{ productId: string; minPrice: number | null; maxPrice: number | null }> } | null)?.items ?? [])
    if (!before.length) return { refusal: 'This change does not name the floors and ceilings it replaced.' }
    return { tool: 'set-price-bounds', args: { items: before.map(({ productId, minPrice, maxPrice }) => ({ productId, minPrice, maxPrice })) } }
  },
}

const setPriceBounds: AgentTool = {
  name: 'set-price-bounds',
  title: 'Set pricing floor and ceiling',
  input: boundsInput,
  requires: [F.productsPriceEdit],
  category: 'pricing',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: BOUNDS_UNDO,
  description:
    `Set the pricing floor and ceiling (master currency) of up to ${MAX_PRODUCTS} products: every price Nexus stores or sends in `
    + 'a master-currency market is held to them — refused, never clamped. The preview names the listing prices and master '
    + 'prices that would then sit outside. Sends nothing to a channel. Waits for a person to approve it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planBounds(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    return { ok: true, preview: boundsPreview(plan) }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planBounds(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const { applyProductBulkEdits, ProductBulkError } = await import('../../products/bulk-edit.service.js')
    const changes = plan.lines.flatMap((line) => [
      ...(line.to.minPrice !== line.from.minPrice ? [{ id: line.productId, field: 'minPrice', value: line.to.minPrice }] : []),
      ...(line.to.maxPrice !== line.from.maxPrice ? [{ id: line.productId, field: 'maxPrice', value: line.to.maxPrice }] : []),
    ])
    try {
      // The writer logs as pino does (details, message); Nexus's logger takes (message, details).
      const log = (level: 'warn' | 'error') => (details: unknown, message?: string) => logger[level](message ?? '[agents/set-price-bounds] product writer', { details })
      const out = await applyProductBulkEdits({ changes }, {
        formulaCascade: false, userId: ctx.userId ?? null, can: (permission: string) => ctx.can(permission as never),
        logger: { warn: log('warn'), error: log('error') } as unknown as ProductBulkContext['logger'],
      }) as { success?: boolean; errors?: Array<{ id: string; field: string; error: string }> }
      if (out.success === false) return { ok: false, error: `Nothing changed: ${listed((out.errors ?? []).map((e) => `${plan.lines.find((l) => l.productId === e.id)?.sku ?? e.id} ${e.field}: ${e.error}`))}` }
    } catch (error) {
      if (error instanceof ProductBulkError) return { ok: false, error: `Nothing changed: ${String((error as { body?: { error?: unknown } }).body?.error ?? error.message)}` }
      throw error
    }
    return {
      ok: true,
      data: { products: plan.lines.length, bounds: plan.lines.slice(0, PREVIEW_LINES).map((line) => ({ sku: line.sku, minPrice: line.to.minPrice, maxPrice: line.to.maxPrice })) },
      change: {
        before: { items: plan.lines.map((line) => ({ productId: line.productId, sku: line.sku, minPrice: line.from.minPrice, maxPrice: line.from.maxPrice })) },
        after: { items: plan.lines.map((line) => ({ productId: line.productId, minPrice: line.to.minPrice, maxPrice: line.to.maxPrice })) },
      },
    }
  },
}

// ── resend-prices ─────────────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000

interface ResendLine { listing: PriceListing & Record<string, unknown>; price: number; currency: string | null; minutesSinceLastSend: number | null }
/** Amazon Business — a listing whose business price Nexus keeps (or removed, still to reach Amazon): sent again as kept. */
interface BusinessResendLine { listing: PriceListing & Record<string, unknown>; setting: BusinessPriceSetting | null; price: number | null; currency: string | null }
type ResendPlan = { lines: ResendLine[]; business: BusinessResendLine[]; leftOut: Array<{ where: string; reason: string }> }
const RESEND_WHICH = ['both', 'price', 'business'] as const

async function planResend(args: Record<string, unknown>): Promise<ResendPlan | Refusal> {
  const ids = [...new Set((args.listingIds as string[] | undefined) ?? [])]
  const which = (args.which as (typeof RESEND_WHICH)[number] | undefined) ?? 'both'
  // Every column (the push lock reads the listing's intent columns, as `pushPriceUpdate` does).
  const rows = await prisma.channelListing.findMany({ where: { id: { in: ids } }, include: { product: { select: { sku: true, basePrice: true, minPrice: true, maxPrice: true, deletedAt: true } } } }) as unknown as Array<PriceListing & Record<string, unknown>>
  if (rows.length !== ids.length || rows.some((r) => !r.product || r.product.deletedAt)) return { error: LISTING_NOT_FOUND }
  const currencyOf = await currencies(rows)
  const master = masterCurrency()
  const { closedMarketSet } = await import('../../amazon-market-offer.service.js')
  const closed = await closedMarketSet([...new Set(rows.filter((r) => r.channel === 'AMAZON').map((r) => r.productId))])
  const lastSends = await prisma.outboundSyncQueue.groupBy({
    by: ['channelListingId'], where: { channelListingId: { in: ids }, syncType: 'PRICE_UPDATE', createdAt: { gte: new Date(Date.now() - 24 * HOUR_MS) } }, _max: { createdAt: true },
  })
  const lastById = new Map(lastSends.map((r) => [r.channelListingId, r._max.createdAt]))
  const lines: ResendLine[] = []
  const business: BusinessResendLine[] = []
  const leftOut: Array<{ where: string; reason: string }> = []
  // Amazon Business: the listings whose business price Nexus keeps now, or has kept (a removal still to reach Amazon).
  const amazonIds = rows.filter((r) => r.channel === 'AMAZON').map((r) => r.id)
  const everKept = which !== 'price' && amazonIds.length
    ? new Set((await prisma.channelListingOverride.findMany({ where: { channelListingId: { in: amazonIds }, fieldName: 'businessPrice' }, distinct: ['channelListingId'], select: { channelListingId: true } })).map((r) => r.channelListingId))
    : new Set<string>()
  for (const l of rows) {
    const closedHere = closed.has(`${l.productId}|${l.marketplace.toUpperCase()}`)
    if (which !== 'price') {
      const setting = l.channel === 'AMAZON' ? storedBusinessSetting(l as never) : null
      if (l.channel === 'AMAZON' && (setting || everKept.has(l.id))) {
        const held = businessHeld(l as never) ?? (closedHere ? 'this listing is Inactive here: its business price is sent when it is set Active again' : null)
        if (held) leftOut.push({ where: `${where(l)} (business price)`, reason: held })
        else {
          const currency = currencyOf(l)
          const normal = businessNormalPrice(l as never, null, { masterPrice: l.product?.basePrice, marketCurrency: currency })
          business.push({ listing: l, setting, price: setting ? businessPriceOf(setting, normal) : null, currency })
        }
      } else if (which === 'business') leftOut.push({ where: where(l), reason: l.channel === 'AMAZON' ? 'Nexus keeps no business price for it' : 'only an Amazon listing has a business price' })
    }
    if (which === 'business') continue
    const lock = assertPushAllowed(l as never) ?? (closedHere ? assertPushAllowed({ offerClosedAt: 'closed' } as never) : null)
    if (lock) { leftOut.push({ where: where(l), reason: lock.sentence }); continue }
    if (holdsCascadedPrice(l)) { leftOut.push({ where: where(l), reason: 'a draft that has not been published: Publish sends its price' }); continue }
    const currency = currencyOf(l)
    const send = listingSendPrice(l, { masterPrice: l.product?.basePrice, marketCurrency: currency, masterCurrency: master, where: `${l.channel} ${l.marketplace}` })
    if (send.price === null) { leftOut.push({ where: where(l), reason: send.reason }); continue }
    const why = currency === master ? storedPriceReason(send.price, priceBoundsOf(l.product ?? {})) : (send.price > 0 ? null : 'a price must be above 0')
    if (why) { leftOut.push({ where: where(l), reason: why }); continue }
    const last = lastById.get(l.id)
    lines.push({ listing: l, price: send.price, currency, minutesSinceLastSend: last ? Math.floor((Date.now() - last.getTime()) / 60_000) : null })
  }
  if (!lines.length && !business.length) return { error: `Nothing to send: ${listed(leftOut.map((o) => `${o.where}: ${o.reason}`))}.` }
  return { lines, business, leftOut }
}

function resendPreview(plan: ResendPlan) {
  const recent = plan.lines.map((line) => line.minutesSinceLastSend).filter((m): m is number => m !== null)
  const sends = [
    ...(plan.lines.length ? [`the price ${plural(plan.lines.length, 'listing')} already carr${plan.lines.length === 1 ? 'ies' : 'y'}`] : []),
    ...(plan.business.length ? [`the business price Nexus keeps for ${plural(plan.business.length, 'Amazon listing')}`] : []),
  ]
  return {
    action: 'resend-prices',
    summary: `Send ${sends.join(', and ')} again${plan.leftOut.length ? ` (${plan.leftOut.length} left out)` : ''}.`,
    send: plan.lines.slice(0, PREVIEW_LINES).map((line) => ({
      sku: line.listing.product?.sku ?? line.listing.productId, channel: line.listing.channel, market: line.listing.marketplace, price: line.price, currency: line.currency,
      ...(line.minutesSinceLastSend !== null && line.minutesSinceLastSend < 60 ? { lastSent: `${line.minutesSinceLastSend} minutes ago` } : {}),
    })),
    ...(plan.lines.length > PREVIEW_LINES ? { moreSent: plan.lines.length - PREVIEW_LINES } : {}),
    // Amazon Business: what Nexus keeps, sent as kept (Amazon is sent only what differs from what it holds).
    ...(plan.business.length ? { businessPrices: plan.business.slice(0, PREVIEW_LINES).map((line) => ({
      sku: line.listing.product?.sku ?? line.listing.productId, market: line.listing.marketplace, currency: line.currency,
      setting: businessSettingWords(line.setting, line.currency), price: line.price,
      ...(line.setting ? {} : { note: 'Nexus keeps no business price here: Amazon\'s is removed if it still shows one' }),
    })) } : {}),
    ...(plan.business.length > PREVIEW_LINES ? { moreBusiness: plan.business.length - PREVIEW_LINES } : {}),
    ...(plan.leftOut.length ? { leftOut: plan.leftOut.slice(0, PREVIEW_LINES) } : {}),
    totals: { listings: plan.lines.length, ...(plan.business.length ? { businessListings: plan.business.length } : {}), leftOut: plan.leftOut.length, sentInLastHour: recent.filter((m) => m < 60).length },
    // 2.3 — what is sent: each listing's price as it carries it now (and the business price Nexus keeps), never its version
    // (an order's stock cascade moves it).
    basisOn: BASIS_ON_FIELDS,
    basis: basisOf(plan.business.length
      ? [plan.lines.map((line) => [line.listing.id, line.price]), plan.business.map((line) => [line.listing.id, line.setting])]
      : plan.lines.map((line) => [line.listing.id, line.price])),
    // The basis a request approved before 2.3 stood on (each listing's version): it is checked on it, as it was approved.
    versionBasis: basisOf(plan.lines.map((line) => [line.listing.id, line.listing.version, line.price])),
    note: `${NOT_YET} Each price is queued through the Nexus price door, as /pricing's Push price does: the price the listing carries now, in its market's currency, and nothing else (never a quantity).`
      + (plan.business.length ? ' Each business price is queued as Nexus keeps it, through the business price send: Amazon is sent only what differs from what it holds.' : ''),
  }
}

const resendPrices: AgentTool = {
  name: 'resend-prices',
  title: 'Send listing prices again',
  input: z.object({
    listingIds: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_LISTINGS)
      .describe('the Nexus listing ids whose current price is sent again (listing-coordinates names them)'),
    which: z.preprocess(lower, z.enum(RESEND_WHICH)).optional()
      .describe('both (default): the price and, on Amazon, the business price Nexus keeps (Amazon Business); price: the price only; business: the business price only'),
  }),
  requires: [F.pricingEdit],
  category: 'pricing',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // Nothing in Nexus changes to put back: the channel is sent the price Nexus already holds.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    `Send the price each of up to ${MAX_LISTINGS} listings already carries to its channel again, as /pricing's Push price does `
    + '(through the Nexus price door, in the market\'s own currency, never a quantity), and on Amazon the business price '
    + 'and quantity discounts Nexus keeps (Amazon Business; Amazon is sent only what differs; which: price or business for one '
    + 'of the two). A paused, closed or draft listing, or a price outside the product\'s floor or ceiling, is left out and '
    + 'named. Waits for a person to approve it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planResend(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    return { ok: true, preview: resendPreview(plan) }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planResend(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const { pushPriceUpdate } = await import('../../pricing-outbound.service.js')
    const sent: Array<{ sku: string; channel: string; marketplace: string; price: number | null; currency: string | null }> = []
    const failed: string[] = []
    for (const line of plan.lines) {
      const l = line.listing
      const out = await pushPriceUpdate(prisma as never, { sku: l.product!.sku, channel: l.channel, marketplace: l.marketplace, channelConnectionId: l.channelConnectionId, aliasKey: l.aliasKey })
      if (out.ok) sent.push({ sku: out.sku, channel: out.channel, marketplace: out.marketplace, price: out.pushedPrice, currency: out.currency })
      else failed.push(`${where(l)}: ${out.error ?? 'not sent'}`)
    }
    // Amazon Business: one business send per listing, as Nexus keeps it (the send compares with Amazon and sends a difference).
    let businessQueued = 0
    if (plan.business.length) {
      const { queueBusinessSends } = await import('../../pim/business-price-write.service.js')
      businessQueued = (await queueBusinessSends({ listingIds: plan.business.map((line) => line.listing.id), actor: actorOf(ctx, 'resend-prices'), source: 'BUSINESS_PRICE_RESEND' })).length
    }
    if (!sent.length && !businessQueued) return { ok: false, error: `Nothing was sent: ${listed(failed.length ? failed : ['no business price could be queued'])}` }
    return { ok: true, data: { queued: sent.length, sent: sent.slice(0, PREVIEW_LINES), ...(plan.business.length ? { businessQueued } : {}), ...(failed.length ? { notSent: failed.slice(0, PREVIEW_LINES) } : {}) } }
  },
}

export const PRICE_CHANGE_TOOLS: AgentTool[] = [setPriceBounds, bulkListingPriceChange, resendPrices]
