import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * G.1.2 — Pricing engine.
 *
 * `resolvePrice({ sku, channel, marketplace, fulfillmentMethod })` returns
 * a deterministic price + currency + breakdown for any (sku × channel ×
 * marketplace × fulfillment-method) tuple by walking a layered chain of
 * inputs in precedence order:
 *
 *   1. SCHEDULED_SALE     ChannelListing.salePrice (in active window)
 *   2. OFFER_OVERRIDE     Offer.price (FBA-specific or FBM-specific)
 *   3. CHANNEL_OVERRIDE   ChannelListing.priceOverride (when followMasterPrice = false)
 *   4. CHANNEL_RULE       pricingRule × priceAdjustmentPercent (PERCENT_OF_MASTER, MATCH_AMAZON, FIXED)
 *   5. PRICING_RULE       PricingRule engine — cost-plus / match-low / etc.
 *   6. MASTER_INHERIT     Product.basePrice × FX rate (with VAT applied for tax-inclusive markets)
 *   7. FALLBACK           Returns 0 with warning when nothing matches
 *
 * After source resolution the engine clamps to:
 *   - floor   = max(minPrice, costPrice × (1+minMargin) + fbaFee + referralFee, mapPrice)
 *   - ceiling = maxPrice
 *
 * Pure: same DB state + same `asOf` clock yields the same result every
 * time. Zero side effects. Materialization writes the output to
 * PricingSnapshot; the engine itself does not.
 */

import type { PrismaClient } from '@prisma/client'
import { FxRateMissingError, masterCurrency, storedFxRate } from './fx-rate.service.js'
import { followerListingPrice, pricingRuleLabel, roundCents } from '@nexus/shared/listing-price'
import { marketCurrency } from './pim/market-currency.js'
import { AmbiguousConnectionError, listActiveConnections, primaryConnectionIds } from './connection-resolver.service.js'

export type PriceSource =
  | 'SCHEDULED_SALE'
  | 'OFFER_OVERRIDE'
  | 'CHANNEL_OVERRIDE'
  | 'CHANNEL_RULE'
  | 'PRICING_RULE'
  | 'MASTER_INHERIT'
  /** 2026-10-01 — the price the listing holds, and nothing computed it: Match Amazon, or a market in another currency. */
  | 'LISTING_PRICE'
  | 'FALLBACK'

/**
 * A number the engine works out that is NOT the listing's price and is never sent by Nexus's own rules (2026-10-01):
 * a PricingRule's price, or Match Amazon's undercut of the lowest competitor. Shown labelled as a suggestion.
 */
export interface PriceSuggestion {
  kind: 'PRICING_RULE' | 'MATCH_AMAZON'
  price: number
  /** The suggestion before the engine's floor/ceiling clamp, when it was clamped. */
  clampedFrom?: number
  ruleId?: string
  ruleType?: string
  reason: string
}

export interface PriceResolutionInput {
  sku: string
  channel: string
  marketplace: string
  fulfillmentMethod?: 'FBA' | 'FBM' | null
  /**
   * The account whose listing is meant (an active connection of this business). Absent: the business's one account
   * for the channel (or its primary), else the account of the product's one listing there — several, a refusal.
   */
  channelConnectionId?: string | null
  /** For promotion-aware queries; defaults to now. */
  asOf?: Date
}

export interface PriceBreakdown {
  masterPrice: number | null
  fxRate: number
  appliedRule?: {
    id?: string
    type: string
    adjustment?: number
  }
  fbaFee: number
  referralFee: number
  vatRate: number
  taxInclusive: boolean
  costPrice: number | null
  /**
   * C.1 — landed cost = unitCost + freight + duty + insurance + broker
   * (per unit, EUR). Read from the latest StockCostLayer row for the
   * product. Null when no receipts exist; the engine falls back to
   * costPrice for the floor calc.
   */
  landedCost: number | null
  /**
   * The cost basis the floor calculation actually used. Equal to
   * landedCost when present, otherwise costPrice.
   */
  effectiveCostBasis: number | null
  minMarginPercent: number | null
  salePriceWindow?: { startsAt: Date | null; endsAt: Date | null }
  /** A number that is not the listing's price (`PriceSuggestion`). */
  suggestion?: PriceSuggestion
}

export interface PriceResolution {
  price: number
  currency: string
  source: PriceSource
  breakdown: PriceBreakdown
  constraints: {
    floor: number
    ceiling: number | null
    isClamped: boolean
    clampedFrom: number
  }
  warnings: string[]
  reasoning: string[]
  computedAt: Date
}

const DEFAULT_MIN_MARGIN_PERCENT = 10

/**
 * C.1 — Resolve the most recent landed cost from StockCostLayer (S.20).
 *
 *   landedCost = unitCost + (freightCents + dutyCents + insuranceCents +
 *                brokerCents) / 100
 *
 * All per unit, in EUR. Returns null when no receipts exist — caller
 * falls back to costPrice (the operator-entered planning estimate).
 *
 * Receipts trump estimates because they reflect what the seller actually
 * paid; we want the floor to enforce profitability against reality, not
 * an aging guess. Picks the most recent receipt regardless of
 * unitsRemaining: even when the layer is depleted, it's the most accurate
 * replacement-cost signal we have until the next inbound shipment.
 */
async function getLatestLandedCost(
  prisma: PrismaClient,
  productId: string,
): Promise<number | null> {
  const layer = await prisma.stockCostLayer.findFirst({
    where: { productId },
    orderBy: { receivedAt: 'desc' },
    select: {
      unitCost: true,
      freightCents: true,
      dutyCents: true,
      insuranceCents: true,
      brokerCents: true,
    },
  })
  if (!layer) return null
  const feeCents =
    (layer.freightCents ?? 0) +
    (layer.dutyCents ?? 0) +
    (layer.insuranceCents ?? 0) +
    (layer.brokerCents ?? 0)
  const landed = Number(layer.unitCost) + feeCents / 100
  return Number.isFinite(landed) && landed > 0 ? landed : null
}

/** CX — the engine's configuration refusals (no FX rate, no market currency): a batch refuses that one cell. */
export function isPriceRefusal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'fx_rate_missing' || code === 'market_currency_unconfigured' || code === 'account_ambiguous'
}

/**
 * MCP full control 08 (integration) — which account's listing a price is for, when the caller did not say. A business
 * with two eBay accounts and no primary made the primary lookup throw, and /pricing/explain answered 500. Now: the
 * account of the product's one listing in that market; listed on several accounts, a refusal (400) naming them.
 */
export class AccountAmbiguousError extends Error {
  readonly code = 'account_ambiguous'
  readonly statusCode = 400
  constructor(channel: string, marketplace: string, accounts: Array<{ id: string; label: string | null }>, listed: boolean) {
    super(
      `${listed ? `This product is listed on ${accounts.length} ${channel} accounts in ${marketplace}` : `${accounts.length} ${channel} accounts are active and none is primary`}: `
      + `name one (accountId) — ${accounts.map((a) => `${a.id}${a.label ? ` (${a.label})` : ''}`).join(', ')}.`,
    )
    this.name = 'AccountAmbiguousError'
  }
}

async function pricingAccount(prisma: PrismaClient, productId: string, input: PriceResolutionInput): Promise<string | null> {
  if (input.channelConnectionId !== undefined) return input.channelConnectionId
  try {
    return (await primaryConnectionIds([input.channel])).get(input.channel) ?? null
  } catch (error) {
    if (!(error instanceof AmbiguousConnectionError)) throw error
    const listings = await prisma.channelListing.findMany({
      where: { productId, channel: input.channel, marketplace: input.marketplace, aliasKey: '' },
      select: { channelConnectionId: true, channelConnection: { select: { id: true, accountLabel: true, displayName: true } } },
    })
    const listed = [...new Map(listings.map((l) => [l.channelConnectionId, l.channelConnection])).entries()]
    if (listed.length === 1) return listed[0][0]
    const accounts = listed.length
      ? listed.map(([id, c]) => ({ id: id ?? 'none', label: c?.accountLabel ?? c?.displayName ?? null }))
      : (await listActiveConnections(input.channel, prisma)).map((c) => ({ id: c.id, label: c.accountLabel ?? c.displayName ?? null }))
    throw new AccountAmbiguousError(input.channel, input.marketplace, accounts, listed.length > 0)
  }
}

/**
 * Resolve a price for a single (sku, channel, marketplace, fm) tuple.
 *
 * Returns a fully-constrained, currency-correct price + breakdown.
 * Caller materializes the result into PricingSnapshot or pushes to
 * the marketplace via OutboundSyncQueue.
 */
export async function resolvePrice(
  prisma: PrismaClient,
  input: PriceResolutionInput,
): Promise<PriceResolution> {
  const asOf = input.asOf ?? new Date()
  const reasoning: string[] = []
  const warnings: string[] = []

  // ── Resolve marketplace metadata + currency ─────────────────────
  const marketplace = await prisma.marketplace.findUnique({
    where: { channel_code: workspaceKey({ channel: input.channel, code: input.marketplace }) },
  })
  // CX (main-session ruling 2026-09-26) — no Marketplace row, or no currency on it, is a REFUSAL
  // (market_currency_unconfigured, the codebase's own): it read as EUR.
  const currency = marketCurrency(input.channel, input.marketplace,
    marketplace ? [{ channel: input.channel, code: input.marketplace, currency: marketplace.currency }] : [])
  const vatRate = marketplace?.vatRate ? Number(marketplace.vatRate) : 0
  const taxInclusive = marketplace?.taxInclusive ?? false

  // ── Resolve the variant + parent product (for cost + master price + margin) ─
  // SKUs can live as ProductVariation OR Product (hub-and-spoke). Try
  // variant first (canonical for new data), fall back to Product.
  const variant = await prisma.productVariation.findUnique({
    where: { workspace_sku: workspaceKey({ sku: input.sku }) },
    select: {
      id: true,
      sku: true,
      price: true,
      costPrice: true,
      minPrice: true,
      maxPrice: true,
      mapPrice: true,
      productId: true,
      product: {
        select: {
          id: true,
          basePrice: true,
          costPrice: true,
          minPrice: true,
          maxPrice: true,
        },
      },
    },
  })

  const standaloneProduct = variant
    ? null
    : await prisma.product.findFirst({
        where: { sku: input.sku },
        select: {
          id: true,
          basePrice: true,
          costPrice: true,
          minPrice: true,
          maxPrice: true,
        },
      })

  const productId = variant?.productId ?? standaloneProduct?.id ?? null
  const masterPrice = variant
    ? Number(variant.price)
    : standaloneProduct
    ? Number(standaloneProduct.basePrice)
    : null
  const costPrice =
    (variant?.costPrice ? Number(variant.costPrice) : null) ??
    (variant?.product?.costPrice
      ? Number(variant.product.costPrice)
      : standaloneProduct?.costPrice
      ? Number(standaloneProduct.costPrice)
      : null)
  const minPrice =
    (variant?.minPrice ? Number(variant.minPrice) : null) ??
    (variant?.product?.minPrice
      ? Number(variant.product.minPrice)
      : standaloneProduct?.minPrice
      ? Number(standaloneProduct.minPrice)
      : null)
  const maxPrice =
    (variant?.maxPrice ? Number(variant.maxPrice) : null) ??
    (variant?.product?.maxPrice
      ? Number(variant.product.maxPrice)
      : standaloneProduct?.maxPrice
      ? Number(standaloneProduct.maxPrice)
      : null)
  const mapPrice = variant?.mapPrice ? Number(variant.mapPrice) : null

  if (masterPrice == null) {
    warnings.push(`SKU ${input.sku} has no master price`)
  }
  if (costPrice == null) {
    warnings.push(`SKU ${input.sku} has no cost price — margin floor unenforceable`)
  }

  // ── Resolve ChannelListing (per-marketplace overrides + fees) ───
  // MAP.2b — a price read must name the account whose listing it means.
  const pricingConn = productId ? await pricingAccount(prisma, productId, input) : null
  // MCP full control 08 (price-explain) — with no active account for the channel `pricingConn` is null, and a compound
  // unique cannot target a null: the lookup threw and /pricing/explain answered 500. The same key as a filter finds the
  // listing that names no account (the one a business without a connection holds), and is the unique row otherwise.
  const channelListing = productId
    ? pricingConn
      ? await prisma.channelListing.findUnique({
          where: {
            productId_channel_marketplace: workspaceKey({
              productId,
              channel: input.channel,
              marketplace: input.marketplace,
              channelConnectionId: pricingConn,
              // PES.5 — aliasKey joins the key; '' = the product's PRIMARY listing, which is what every writer here addresses. NOT NULL because Prisma cannot target a null inside a compound unique.
              aliasKey: '',
            }),
          },
        })
      : await prisma.channelListing.findFirst({
          where: { productId, channel: input.channel, marketplace: input.marketplace, channelConnectionId: null, aliasKey: '' },
        })
    : null

  const fbaFee = channelListing?.estimatedFbaFee
    ? Number(channelListing.estimatedFbaFee)
    : 0
  const referralFeePercent = channelListing?.referralFeePercent
    ? Number(channelListing.referralFeePercent)
    : 0

  // ── Resolve FX rate (master is EUR by convention; engine multiplies) ─
  // Master price assumed to be in EUR. When marketplace currency differs,
  // we apply the most recent FX rate. fx-rate.service handles fallback to
  // the latest cached rate if today's hasn't been fetched.
  // CX (review 2026-09-26) — no rate stored at all is a REFUSAL (it read as 1:1: a €10 master priced £10). Every
  // FX-dependent number below (master inherit, rules, the cost/min/max/MAP floor) would be wrong, so nothing is priced.
  const fxRate = currency === 'EUR' ? 1 : await storedFxRate(prisma, 'EUR', currency, asOf)
  if (fxRate === null) throw new FxRateMissingError('EUR', currency, `SKU ${input.sku} on ${input.channel}/${input.marketplace}`)

  // ── Resolve landed cost (C.1) ───────────────────────────────────
  // Receipts via StockCostLayer (S.20) carry per-unit unitCost + freight
  // + duty + insurance + broker. When present, landed cost is the truth
  // the floor calc enforces against; fall back to operator-entered
  // costPrice when no receipts exist yet (catalog SKU not yet inbound).
  const landedCost = productId
    ? await getLatestLandedCost(prisma, productId)
    : null
  const effectiveCostBasis = landedCost ?? costPrice
  if (landedCost != null && costPrice != null && landedCost > costPrice * 1.01) {
    // Soft warning when receipts diverge from the operator estimate by
    // more than 1% — the cost spreadsheet is stale and margin is being
    // squeezed silently.
    warnings.push(
      `Landed cost ${landedCost.toFixed(2)} > entered cost ${costPrice.toFixed(2)} — review supplier estimate`,
    )
  }

  // ── Compute floor + ceiling for clamping ────────────────────────
  // Convert master-currency cost into marketplace currency for the floor.
  const costInMpCurrency =
    effectiveCostBasis != null ? effectiveCostBasis * fxRate : null
  // Per-unit referral fee at the moment of pricing — referralFeePercent is
  // applied to the proposed price; we approximate at masterPrice * fxRate
  // for floor calculation (real referral on actual sale price; this is a
  // conservative floor).
  const refFeeApprox =
    masterPrice != null
      ? (masterPrice * fxRate * referralFeePercent) / 100
      : 0
  const minMarginPercent = DEFAULT_MIN_MARGIN_PERCENT
  const marginFloor =
    costInMpCurrency != null
      ? costInMpCurrency * (1 + minMarginPercent / 100) + fbaFee + refFeeApprox
      : 0

  const minPriceInMp = minPrice != null ? minPrice * fxRate : 0
  const mapPriceInMp = mapPrice != null ? mapPrice * fxRate : 0
  const floor = Math.max(minPriceInMp, marginFloor, mapPriceInMp)
  const ceiling = maxPrice != null ? maxPrice * fxRate : null

  // ── Layered source resolution ───────────────────────────────────
  let resolved: { price: number; source: PriceSource; ruleAppliedId?: string; ruleAppliedType?: string; ruleAdjustment?: number; salePriceWindow?: { startsAt: Date | null; endsAt: Date | null } } | null = null

  // 1. SCHEDULED_SALE — ChannelListing.salePrice within an active window.
  // The promotion scheduler stamps salePrice + uses lastOverrideAt as the
  // window-start marker; the value of salePrice itself is the active price.
  // Engine treats the salePrice as live until cleared by the scheduler.
  if (
    channelListing?.salePrice != null &&
    Number(channelListing.salePrice) > 0
  ) {
    resolved = {
      price: Number(channelListing.salePrice),
      source: 'SCHEDULED_SALE',
      salePriceWindow: {
        startsAt: channelListing.lastOverrideAt ?? null,
        endsAt: null,
      },
    }
    reasoning.push(`Active scheduled sale: ${resolved.price.toFixed(2)} ${currency}`)
  }

  // 2. OFFER_OVERRIDE — Offer.price for the requested FBA/FBM method.
  if (!resolved && input.fulfillmentMethod && channelListing) {
    const offer = await prisma.offer.findUnique({
      where: {
        channelListingId_fulfillmentMethod: workspaceKey({
          channelListingId: channelListing.id,
          fulfillmentMethod: input.fulfillmentMethod,
        }),
      },
    })
    if (offer?.price != null) {
      resolved = {
        price: Number(offer.price),
        source: 'OFFER_OVERRIDE',
      }
      reasoning.push(
        `Offer override (${input.fulfillmentMethod}): ${resolved.price.toFixed(2)} ${currency}`,
      )
    }
  }

  // ── 3–4. A LISTING's price is the price Nexus's own rules give it (2026-10-01) ─────────────────────────────────
  // What this engine shows as a listing's price must be what the listing carries — the price the master-price cascade
  // and the channel price door store and send (`@nexus/shared/listing-price`, one maths), never a number of its own:
  //   - a PINNED listing (followMasterPrice = false) keeps its own price (priceOverride, else price). No rule applies:
  //     the channel rule used to price a pinned listing that had no priceOverride.
  //   - a FOLLOWING listing carries its rule's price from the master — FIXED = the master, PERCENT_OF_MASTER = master
  //     × (1 + percent/100) — rounded to cents. No FX: a market in another currency than the master is never sent a
  //     converted master (refuse, don't convert), so it keeps its own price and this says why. No VAT on top: the
  //     cascade sends the master number as the channel's price.
  //   - MATCH_AMAZON takes no price from the master: the listing keeps the price it holds, and the competitor undercut
  //     is a SUGGESTION (`breakdown.suggestion`), never the listing's price.
  // The engine's other numbers (a PricingRule's price, the competitor undercut) are suggestions; a cost, MAP or product
  // floor or ceiling the listing's price breaks is a warning, not a changed price.
  const master = masterCurrency()
  let suggestion: PriceSuggestion | undefined
  if (!resolved && channelListing && channelListing.followMasterPrice === false) {
    const own = channelListing.priceOverride ?? channelListing.price
    if (own != null) {
      resolved = { price: Number(own), source: 'CHANNEL_OVERRIDE' }
      reasoning.push(`Pinned listing: its own price ${Number(own).toFixed(2)} ${currency}`)
    } else {
      warnings.push('This listing is pinned at its own price but holds none.')
    }
  }
  if (!resolved && channelListing && channelListing.followMasterPrice !== false) {
    const rule = channelListing.pricingRule
    const stored = channelListing.price != null ? Number(channelListing.price) : null
    if (rule === 'MATCH_AMAZON') {
      if (channelListing.lowestCompetitorPrice != null) {
        const competitor = Number(channelListing.lowestCompetitorPrice)
        suggestion = { kind: 'MATCH_AMAZON', price: roundCents(Math.max(0, competitor - 0.01)), reason: `Match Amazon suggestion: the lowest competitor ${competitor.toFixed(2)} − 0.01` }
      }
      if (stored != null) {
        resolved = { price: stored, source: 'LISTING_PRICE', ruleAppliedType: 'MATCH_AMAZON' }
        reasoning.push(`Match Amazon: the listing keeps the price it holds, ${stored.toFixed(2)} ${currency} (Amazon's pricing drives it, not the master)`)
      }
    } else if (masterPrice == null) {
      if (stored != null) resolved = { price: stored, source: 'LISTING_PRICE' }
    } else if (currency !== master) {
      warnings.push(`Not converted: the master price is ${master} ${masterPrice.toFixed(2)} and this market sells in ${currency}. Nexus does not send a market a converted master price (refuse, don't convert), so the listing keeps its own price.`)
      if (stored != null) {
        resolved = { price: stored, source: 'LISTING_PRICE' }
        reasoning.push(`The listing's own price: ${stored.toFixed(2)} ${currency}`)
      }
    } else {
      const next = followerListingPrice(masterPrice, rule, channelListing.priceAdjustmentPercent as never)!
      if (rule === 'PERCENT_OF_MASTER') {
        const adj = channelListing.priceAdjustmentPercent == null ? 0 : Number(channelListing.priceAdjustmentPercent)
        resolved = { price: next, source: 'CHANNEL_RULE', ruleAppliedType: 'PERCENT_OF_MASTER', ruleAdjustment: adj }
        reasoning.push(`Follows ${pricingRuleLabel(rule, adj)}: ${next.toFixed(2)} ${currency}`)
      } else {
        resolved = { price: next, source: 'MASTER_INHERIT' }
        reasoning.push(`Follows the master price: ${next.toFixed(2)} ${currency}`)
      }
    }
  }

  // 5. PRICING_RULE — variant-level rules from PricingRule table.
  // Walks the priority chain; first applicable rule wins. Margin clamp
  // happens inline with the rule.
  // A listing's price is decided above; a PricingRule's price for it is a SUGGESTION. Without a listing (an estimate
  // for a market the SKU is not on) the rule prices the estimate, as before.
  if (variant && masterPrice != null && (!resolved || channelListing)) {
    const variantRules = await prisma.pricingRuleVariation.findMany({
      where: { variationId: variant.id, rule: { isActive: true } },
      include: { rule: true },
      orderBy: { rule: { priority: 'asc' } },
    })
    for (const link of variantRules) {
      const r = link.rule
      const params = (r.parameters ?? {}) as Record<string, unknown>
      let rulePrice: number | null = null
      switch (r.type) {
        case 'COST_PLUS_MARGIN': {
          if (costPrice != null && typeof params.marginPercent === 'number') {
            rulePrice = costPrice * (1 + params.marginPercent / 100) * fxRate
          }
          break
        }
        case 'PERCENTAGE_BELOW': {
          if (
            channelListing?.lowestCompetitorPrice != null &&
            typeof params.percentageBelow === 'number'
          ) {
            const competitor = Number(channelListing.lowestCompetitorPrice)
            rulePrice = competitor * (1 - params.percentageBelow / 100)
          }
          break
        }
        case 'MATCH_LOW': {
          if (channelListing?.lowestCompetitorPrice != null) {
            rulePrice = Number(channelListing.lowestCompetitorPrice)
          }
          break
        }
        case 'FIXED_PRICE': {
          if (typeof params.fixedPrice === 'number') {
            rulePrice = params.fixedPrice
          }
          break
        }
        case 'DYNAMIC_MARGIN': {
          if (costPrice != null && typeof params.targetMargin === 'number') {
            rulePrice = costPrice * (1 + params.targetMargin / 100) * fxRate
          }
          break
        }
      }
      if (rulePrice != null && Number.isFinite(rulePrice) && rulePrice > 0) {
        if (channelListing) {
          suggestion = { kind: 'PRICING_RULE', price: rulePrice, ruleId: r.id, ruleType: r.type, reason: `Pricing rule "${r.name}" (${r.type}) suggests ${rulePrice.toFixed(2)} ${currency}` }
        } else {
          resolved = {
            price: rulePrice,
            source: 'PRICING_RULE',
            ruleAppliedId: r.id,
            ruleAppliedType: r.type,
          }
          reasoning.push(
            `Pricing rule "${r.name}" (${r.type}): ${rulePrice.toFixed(2)} ${currency}`,
          )
        }
        break
      }
    }
  }

  // 6. MASTER_INHERIT — Product.basePrice × FX rate: an ESTIMATE for a market the SKU has no listing on. A listing's
  // price was decided above, and a following listing's in another currency is never converted.
  if (!resolved && masterPrice != null && !channelListing) {
    const inherited = masterPrice * fxRate
    resolved = { price: inherited, source: 'MASTER_INHERIT' }
    reasoning.push(
      currency === 'EUR'
        ? `Master inherit: ${inherited.toFixed(2)} ${currency}`
        : `Master inherit: ${masterPrice.toFixed(2)} EUR × ${fxRate.toFixed(4)} = ${inherited.toFixed(2)} ${currency}`,
    )
  }

  // 7. FALLBACK — nothing matched.
  if (!resolved) {
    resolved = { price: 0, source: 'FALLBACK' }
    warnings.push('No price resolution path matched — emitted 0')
    reasoning.push('Fallback to 0 (no master / variant / override found)')
  }

  // ── VAT application for tax-inclusive markets ────────────────────
  // Amazon EU expects value_with_tax (the price the buyer sees). If the
  // resolved price came from MASTER_INHERIT or rules that compute on net
  // values, we add VAT here. If it came from CHANNEL_OVERRIDE / SCHEDULED_SALE,
  // those are seller-entered values which we treat as the final displayed
  // price (already inclusive). Caller can opt out via marketplace settings.
  // 2026-10-01 — only an ESTIMATE (no listing) and a PricingRule SUGGESTION are grossed up: a listing's price is what it
  // carries and is sent as it is (the cascade sends the master number as the channel's price).
  if (
    !channelListing &&
    taxInclusive &&
    vatRate > 0 &&
    (resolved.source === 'MASTER_INHERIT' ||
      resolved.source === 'PRICING_RULE' ||
      resolved.source === 'CHANNEL_RULE')
  ) {
    const withTax = resolved.price * (1 + vatRate / 100)
    reasoning.push(
      `VAT ${vatRate}% applied (tax-inclusive market): ${resolved.price.toFixed(2)} → ${withTax.toFixed(2)} ${currency}`,
    )
    resolved.price = withTax
  }
  if (suggestion?.kind === 'PRICING_RULE' && taxInclusive && vatRate > 0) {
    suggestion.price = suggestion.price * (1 + vatRate / 100)
    suggestion.reason += ` (VAT ${vatRate}% added: tax-inclusive market)`
  }

  // ── Constraint clamping ────────────────────────────────────────
  // 2026-10-01 — a LISTING's price is never changed here: the price it carries is the price it carries. A floor or
  // ceiling it breaks is a warning. Only an estimate (no listing) and a suggestion are clamped, as before.
  if (suggestion) {
    const raw = suggestion.price
    const cut = Math.min(ceiling ?? Infinity, Math.max(floor, raw))
    if (cut !== raw) { suggestion.clampedFrom = roundCents(raw); suggestion.reason += ` — clamped to ${roundCents(cut).toFixed(2)}` }
    suggestion.price = roundCents(cut)
  }
  // In the master currency only: the floor and ceiling are master-currency numbers (refuse, don't convert).
  if (channelListing && resolved.source !== 'FALLBACK' && currency === master) {
    const own = roundCents(resolved.price)
    if (floor > 0 && own < floor) warnings.push(`The listing's price ${own.toFixed(2)} is below the floor ${roundCents(floor).toFixed(2)} ${currency} (the product's floor, MAP, or cost + ${minMarginPercent}% + fees). It is not changed here.`)
    if (ceiling != null && own > ceiling) warnings.push(`The listing's price ${own.toFixed(2)} is above the product's ceiling ${roundCents(ceiling).toFixed(2)} ${currency}. It is not changed here.`)
  }
  const preClamp = resolved.price
  let isClamped = false
  let clamped = preClamp
  if (!channelListing && clamped < floor) {
    clamped = floor
    isClamped = true
    if (mapPriceInMp > 0 && preClamp < mapPriceInMp) {
      warnings.push(`Below MAP — clamped from ${preClamp.toFixed(2)} to ${floor.toFixed(2)}`)
      reasoning.push(`Clamped to MAP/margin floor ${floor.toFixed(2)} (was ${preClamp.toFixed(2)})`)
    } else {
      reasoning.push(`Clamped to floor ${floor.toFixed(2)} (was ${preClamp.toFixed(2)})`)
    }
  }
  if (!channelListing && ceiling != null && clamped > ceiling) {
    clamped = ceiling
    isClamped = true
    reasoning.push(`Clamped to ceiling ${ceiling.toFixed(2)} (was ${preClamp.toFixed(2)})`)
  }

  // Round to cents with the one cents helper the cascade, the door and the screens use (1.005 → 1.01).
  const finalPrice = roundCents(clamped)
  if (suggestion) reasoning.push(`${suggestion.reason}: ${suggestion.price.toFixed(2)} ${currency} — a suggestion, not the listing's price`)

  return {
    price: finalPrice,
    currency,
    source: resolved.source,
    breakdown: {
      masterPrice,
      fxRate,
      appliedRule: resolved.ruleAppliedType
        ? {
            id: resolved.ruleAppliedId,
            type: resolved.ruleAppliedType,
            adjustment: resolved.ruleAdjustment,
          }
        : undefined,
      fbaFee,
      referralFee: refFeeApprox,
      vatRate,
      taxInclusive,
      costPrice,
      landedCost,
      effectiveCostBasis,
      minMarginPercent,
      salePriceWindow: resolved.salePriceWindow,
      ...(suggestion ? { suggestion } : {}),
    },
    constraints: {
      floor,
      ceiling,
      isClamped,
      clampedFrom: preClamp,
    },
    warnings,
    reasoning,
    computedAt: asOf,
  }
}

/**
 * Verbose alias — same as resolvePrice. The existing PriceResolution
 * already includes a `reasoning` array; if a future caller needs the
 * "what would happen if I changed X?" simulator, swap parameters into
 * the input and call this directly.
 */
export async function explainPrice(
  prisma: PrismaClient,
  input: PriceResolutionInput,
): Promise<PriceResolution> {
  return resolvePrice(prisma, input)
}
