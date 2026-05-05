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
import { getFxRate } from './fx-rate.service.js'

export type PriceSource =
  | 'SCHEDULED_SALE'
  | 'OFFER_OVERRIDE'
  | 'CHANNEL_OVERRIDE'
  | 'CHANNEL_RULE'
  | 'PRICING_RULE'
  | 'MASTER_INHERIT'
  | 'FALLBACK'

export interface PriceResolutionInput {
  sku: string
  channel: string
  marketplace: string
  fulfillmentMethod?: 'FBA' | 'FBM' | null
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
  minMarginPercent: number | null
  salePriceWindow?: { startsAt: Date | null; endsAt: Date | null }
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
    where: { channel_code: { channel: input.channel, code: input.marketplace } },
  })
  const currency = marketplace?.currency ?? 'EUR'
  const vatRate = marketplace?.vatRate ? Number(marketplace.vatRate) : 0
  const taxInclusive = marketplace?.taxInclusive ?? false

  // ── Resolve the variant + parent product (for cost + master price + margin) ─
  // SKUs can live as ProductVariation OR Product (hub-and-spoke). Try
  // variant first (canonical for new data), fall back to Product.
  const variant = await prisma.productVariation.findUnique({
    where: { sku: input.sku },
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
  const channelListing = productId
    ? await prisma.channelListing.findUnique({
        where: {
          productId_channel_marketplace: {
            productId,
            channel: input.channel,
            marketplace: input.marketplace,
          },
        },
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
  const fxRate = currency === 'EUR' ? 1 : await getFxRate(prisma, 'EUR', currency, asOf)
  if (currency !== 'EUR' && fxRate === 1) {
    warnings.push(`No FX rate for EUR→${currency}; treating 1:1`)
  }

  // ── Compute floor + ceiling for clamping ────────────────────────
  // Convert master-currency cost into marketplace currency for the floor.
  const costInMpCurrency = costPrice != null ? costPrice * fxRate : null
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
        channelListingId_fulfillmentMethod: {
          channelListingId: channelListing.id,
          fulfillmentMethod: input.fulfillmentMethod,
        },
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

  // 3. CHANNEL_OVERRIDE — explicit priceOverride with followMasterPrice = false.
  if (
    !resolved &&
    channelListing &&
    channelListing.followMasterPrice === false &&
    channelListing.priceOverride != null
  ) {
    resolved = {
      price: Number(channelListing.priceOverride),
      source: 'CHANNEL_OVERRIDE',
    }
    reasoning.push(
      `Manual channel override: ${resolved.price.toFixed(2)} ${currency}`,
    )
  }

  // 4. CHANNEL_RULE — pricingRule × priceAdjustmentPercent.
  if (!resolved && channelListing && masterPrice != null) {
    const rule = channelListing.pricingRule
    if (rule === 'PERCENT_OF_MASTER' && channelListing.priceAdjustmentPercent != null) {
      const adj = Number(channelListing.priceAdjustmentPercent)
      const masterInMp = masterPrice * fxRate
      const computed = masterInMp * (1 + adj / 100)
      resolved = {
        price: computed,
        source: 'CHANNEL_RULE',
        ruleAppliedType: 'PERCENT_OF_MASTER',
        ruleAdjustment: adj,
      }
      reasoning.push(
        `Channel rule PERCENT_OF_MASTER ${adj >= 0 ? '+' : ''}${adj}%: ${computed.toFixed(2)} ${currency}`,
      )
    } else if (rule === 'MATCH_AMAZON' && channelListing.lowestCompetitorPrice != null) {
      const competitor = Number(channelListing.lowestCompetitorPrice)
      // Match-Amazon: sit €0.01 (or 0.01 in marketplace currency) below.
      resolved = {
        price: Math.max(0, competitor - 0.01),
        source: 'CHANNEL_RULE',
        ruleAppliedType: 'MATCH_AMAZON',
      }
      reasoning.push(
        `Channel rule MATCH_AMAZON: ${competitor.toFixed(2)} − 0.01 = ${resolved.price.toFixed(2)} ${currency}`,
      )
    }
    // FIXED rule has no price source on its own — it's just "use ChannelListing.price";
    // that's handled by the MASTER_INHERIT branch which reads price/priceOverride.
  }

  // 5. PRICING_RULE — variant-level rules from PricingRule table.
  // Walks the priority chain; first applicable rule wins. Margin clamp
  // happens inline with the rule.
  if (!resolved && variant && masterPrice != null) {
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
        resolved = {
          price: rulePrice,
          source: 'PRICING_RULE',
          ruleAppliedId: r.id,
          ruleAppliedType: r.type,
        }
        reasoning.push(
          `Pricing rule "${r.name}" (${r.type}): ${rulePrice.toFixed(2)} ${currency}`,
        )
        break
      }
    }
  }

  // 6. MASTER_INHERIT — Product.basePrice × FX rate.
  if (!resolved && masterPrice != null) {
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
  if (
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

  // ── Constraint clamping ────────────────────────────────────────
  const preClamp = resolved.price
  let isClamped = false
  let clamped = preClamp
  if (clamped < floor) {
    clamped = floor
    isClamped = true
    if (mapPriceInMp > 0 && preClamp < mapPriceInMp) {
      warnings.push(`Below MAP — clamped from ${preClamp.toFixed(2)} to ${floor.toFixed(2)}`)
      reasoning.push(`Clamped to MAP/margin floor ${floor.toFixed(2)} (was ${preClamp.toFixed(2)})`)
    } else {
      reasoning.push(`Clamped to floor ${floor.toFixed(2)} (was ${preClamp.toFixed(2)})`)
    }
  }
  if (ceiling != null && clamped > ceiling) {
    clamped = ceiling
    isClamped = true
    reasoning.push(`Clamped to ceiling ${ceiling.toFixed(2)} (was ${preClamp.toFixed(2)})`)
  }

  // Round to 2 decimals (currency precision).
  const finalPrice = Math.round(clamped * 100) / 100

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
      minMarginPercent,
      salePriceWindow: resolved.salePriceWindow,
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
