/**
 * E2 (eBay Ads) — margin math (pure, unit-tested) + the EbayListingEconomics
 * materializer. THE guardrail source: break-even ad rate per listing.
 *
 * Definitions (E8.0-5 — closes the ⚠️VERIFY marker on adFeeBase in
 * E0-ARCHITECTURE §4, using the fee base confirmed by the EA-series research):
 *
 *   A (adFeeBase)        = item price + buyer-paid shipping + tax.
 *                          eBay widened the base from item-price-only on
 *                          2022-06-01. Our listed price is VAT-inclusive, so T
 *                          is already inside P for IT; S is the term that was
 *                          missing. Charging the ad rate on P alone
 *                          UNDERSTATES the fee and therefore OVERSTATES the
 *                          affordable rate — worst on heavy, low-ASP items.
 *   contributionMargin   = price + shipping charged − COGS − eBay fees
 *                          − shipping cost.
 *   breakEvenAdRatePct   = contributionMargin ÷ (A × (1 + VAT_on_fees)) × 100.
 *   breakEvenCpcCents    = contributionMargin × trailing CVR (≥ MIN_CLICKS).
 *
 * VAT_on_fees: eBay adds VAT to seller fees unless the seller is VAT-registered
 * and reverse-charged. We cannot infer which applies, so it is env-tunable and
 * DEFAULTS TO 0 — i.e. today's behaviour is preserved exactly. Set
 * NEXUS_EBAY_VAT_ON_FEES_PCT=0.22 if eBay does add Italian VAT to our ad fees;
 * every break-even then tightens, which is the conservative direction.
 *
 * Buyer-paid shipping is likewise 0 until per-listing shipping lands in
 * EbayListingIndex (no shipping column exists yet), so A == price today. The
 * arithmetic is correct and inert rather than correct and wrong.
 *
 * Fees: no per-listing fee actuals exist in the DB yet, so v1 uses a
 * CATEGORY_ESTIMATE (env-tunable FVF% + fixed) and LABELS it as such
 * (feesSource + dataStatus='ESTIMATED') — estimates are never presented as
 * actuals. Missing COGS ⇒ dataStatus='MISSING_COGS' ⇒ "manual only": the
 * automation layer must skip these listings entirely.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export interface EconomicsInput {
  priceCents: number | null
  cogsCents: number | null
  ebayFeesCents: number | null
  shippingCostCents: number
  /** Buyer-paid shipping (S). Part of the ad-fee base AND of revenue. */
  shippingChargedCents?: number
}

export interface EconomicsResult {
  contributionMarginCents: number | null
  contributionMarginPct: number | null // vs the ad-fee base
  breakEvenAdRatePct: number | null
  /** A = price + buyer-paid shipping (+ tax, already inside our VAT-inclusive price). */
  adFeeBaseCents: number | null
  dataStatus: 'ESTIMATED' | 'OK' | 'MISSING_COGS' | 'MISSING_PRICE'
}

/**
 * VAT eBay adds on top of seller fees. 0 = reverse-charged / no VAT on fees.
 * See the header — deliberately defaults to 0 so this correction does not
 * silently move live guardrails.
 */
const VAT_ON_FEES = Number(process.env.NEXUS_EBAY_VAT_ON_FEES_PCT ?? 0)

/** A = item price + buyer-paid shipping + tax (tax already inside our price). */
export function adFeeBaseCents(priceCents: number, shippingChargedCents = 0): number {
  return priceCents + shippingChargedCents
}

/** Pure economics — the single formula every surface and guardrail uses. */
export function computeEconomics(i: EconomicsInput, feesAreEstimate = true): EconomicsResult {
  if (i.priceCents == null || i.priceCents <= 0) {
    return { contributionMarginCents: null, contributionMarginPct: null, breakEvenAdRatePct: null, adFeeBaseCents: null, dataStatus: 'MISSING_PRICE' }
  }
  if (i.cogsCents == null) {
    return { contributionMarginCents: null, contributionMarginPct: null, breakEvenAdRatePct: null, adFeeBaseCents: null, dataStatus: 'MISSING_COGS' }
  }
  const shipCharged = i.shippingChargedCents ?? 0
  const base = adFeeBaseCents(i.priceCents, shipCharged)
  // Buyer-paid shipping is revenue as well as fee base — count it on both
  // sides, or a listing with paid shipping looks artificially unprofitable.
  const margin = i.priceCents + shipCharged - i.cogsCents - (i.ebayFeesCents ?? 0) - i.shippingCostCents
  // The ad fee is charged on A and then itself carries VAT, so the rate the
  // margin can absorb is m ÷ (A × (1 + VAT_on_fees)).
  const pct = (margin / (base * (1 + VAT_ON_FEES))) * 100
  return {
    contributionMarginCents: margin,
    contributionMarginPct: round2(pct),
    // Never negative: a loss-making listing has a 0% break-even (any ad fee deepens the loss).
    breakEvenAdRatePct: round2(Math.max(0, pct)),
    adFeeBaseCents: base,
    dataStatus: feesAreEstimate ? 'ESTIMATED' : 'OK',
  }
}

export function computeBreakEvenCpcCents(contributionMarginCents: number, clicks: number, soldQty: number, minClicks = 50): number | null {
  if (clicks < minClicks || clicks <= 0) return null
  const cvr = soldQty / clicks
  return Math.max(0, Math.round(contributionMarginCents * cvr))
}

const round2 = (n: number) => Math.round(n * 100) / 100

// ── Fee estimator (labeled CATEGORY_ESTIMATE) ────────────────────────────────
const FVF_PCT = Number(process.env.NEXUS_EBAY_FVF_PCT ?? 0.115) // motor-gear IT typical
const FEE_FIXED_CENTS = Number(process.env.NEXUS_EBAY_FEE_FIXED_CENTS ?? 35)

/**
 * Final-value fee estimate. eBay charges FVF on the SAME total sale amount the
 * ad rate uses (item + shipping + tax), so pass the ad-fee base A, not the
 * bare item price. Identical while buyer-paid shipping is 0. (E8.0-5)
 */
export function estimateEbayFeesCents(adFeeBaseCentsValue: number): number {
  return Math.round(adFeeBaseCentsValue * FVF_PCT) + FEE_FIXED_CENTS
}

// ── Materializer ─────────────────────────────────────────────────────────────
export interface EconomicsRebuildReport { listings: number; ok: number; estimated: number; missingCogs: number; missingPrice: number }

export async function rebuildEbayListingEconomics(): Promise<EconomicsRebuildReport> {
  const report: EconomicsRebuildReport = { listings: 0, ok: 0, estimated: 0, missingCogs: 0, missingPrice: 0 }
  const live = await prisma.ebayListingIndex.findMany({
    where: { endedAt: null },
    select: { marketplace: true, itemId: true, price: true, currency: true, productIds: true },
  })

  // Trailing 30d listing-grain facts for CVR (break-even CPC).
  const since = new Date(); since.setUTCDate(since.getUTCDate() - 30)
  type FactAgg = { entityId: string; _sum: { clicks: number | null; soldQty: number | null } }
  let facts: FactAgg[] = []
  try {
    facts = (await prisma.ebayAdsDailyPerformance.groupBy({
      by: ['entityId'],
      where: { entityType: 'LISTING', date: { gte: since } },
      _sum: { clicks: true, soldQty: true },
    })) as unknown as FactAgg[]
  } catch { facts = [] }
  const cvrByItem = new Map<string, { clicks: number; sold: number }>()
  for (const f of facts) cvrByItem.set(f.entityId, { clicks: f._sum.clicks ?? 0, sold: f._sum.soldQty ?? 0 })

  for (const l of live) {
    report.listings++
    const priceCents = l.price != null ? Math.round(Number(l.price.toString()) * 100) : null
    let cogsCents: number | null = null
    const productId = l.productIds[0] ?? null
    if (productId) {
      // Cost sources in precedence order: explicit costPrice, then the WAC
      // cost master (Product.weightedAvgCostCents, fed by StockCostLayer).
      // Whichever gets populated first lights up break-evens — no code change.
      const p = await prisma.product.findUnique({ where: { id: productId }, select: { costPrice: true, weightedAvgCostCents: true } })
      if (p?.costPrice != null) cogsCents = Math.round(Number(p.costPrice.toString()) * 100)
      else if ((p?.weightedAvgCostCents ?? 0) > 0) cogsCents = p!.weightedAvgCostCents!
    }
    // Buyer-paid shipping is not yet captured per listing (no shipping column
    // on EbayListingIndex), so S = 0 and A == price for now. When it lands,
    // feed it here and both the fee estimate and the break-even tighten.
    const shippingChargedCents = 0
    const base = priceCents != null ? adFeeBaseCents(priceCents, shippingChargedCents) : null
    const fees = base != null ? estimateEbayFeesCents(base) : null
    const eco = computeEconomics({ priceCents, cogsCents, ebayFeesCents: fees, shippingCostCents: 0, shippingChargedCents }, true)

    let breakEvenCpcCents: number | null = null
    if (eco.contributionMarginCents != null) {
      const f = cvrByItem.get(l.itemId)
      if (f) breakEvenCpcCents = computeBreakEvenCpcCents(eco.contributionMarginCents, f.clicks, f.sold)
    }

    await prisma.ebayListingEconomics.upsert({
      where: { marketplace_itemId: { marketplace: l.marketplace, itemId: l.itemId } },
      create: {
        marketplace: l.marketplace,
        itemId: l.itemId,
        productId,
        priceCents,
        currency: l.currency ?? 'EUR',
        cogsCents,
        ebayFeesCents: fees,
        feesSource: fees != null ? 'CATEGORY_ESTIMATE' : null,
        shippingCostCents: 0,
        contributionMarginCents: eco.contributionMarginCents,
        contributionMarginPct: eco.contributionMarginPct != null ? eco.contributionMarginPct.toFixed(2) : null,
        breakEvenAdRatePct: eco.breakEvenAdRatePct != null ? eco.breakEvenAdRatePct.toFixed(2) : null,
        breakEvenCpcCents,
        dataStatus: eco.dataStatus,
        computedAt: new Date(),
      },
      update: {
        productId,
        priceCents,
        currency: l.currency ?? 'EUR',
        cogsCents,
        ebayFeesCents: fees,
        feesSource: fees != null ? 'CATEGORY_ESTIMATE' : null,
        contributionMarginCents: eco.contributionMarginCents,
        contributionMarginPct: eco.contributionMarginPct != null ? eco.contributionMarginPct.toFixed(2) : null,
        breakEvenAdRatePct: eco.breakEvenAdRatePct != null ? eco.breakEvenAdRatePct.toFixed(2) : null,
        breakEvenCpcCents,
        dataStatus: eco.dataStatus,
        computedAt: new Date(),
      },
    })
    if (eco.dataStatus === 'ESTIMATED') report.estimated++
    else if (eco.dataStatus === 'OK') report.ok++
    else if (eco.dataStatus === 'MISSING_COGS') report.missingCogs++
    else report.missingPrice++
  }

  logger.info('[E2][ebay-ads] economics rebuild', report as unknown as Record<string, unknown>)
  return report
}
