/**
 * E2 (eBay Ads) — margin math (pure, unit-tested) + the EbayListingEconomics
 * materializer. THE guardrail source: break-even ad rate per listing.
 *
 * Definitions (E0-ARCHITECTURE §4, verified fee base):
 *   adFeeBase            ≈ listing price (VAT-inclusive) + shipping charged.
 *                          eBay charges the ad rate on the TOTAL sale amount
 *                          (item + shipping + taxes); our listed price is
 *                          VAT-inclusive and shipping is predominantly free
 *                          on these listings, so base = price is the honest
 *                          approximation until per-order shipping lands.
 *   contributionMargin   = price − COGS − eBay fees − shipping cost.
 *   breakEvenAdRatePct   = contributionMargin ÷ adFeeBase × 100.
 *   breakEvenCpcCents    = contributionMargin × trailing CVR (≥ MIN_CLICKS).
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
}

export interface EconomicsResult {
  contributionMarginCents: number | null
  contributionMarginPct: number | null // vs the ad-fee base
  breakEvenAdRatePct: number | null
  dataStatus: 'ESTIMATED' | 'OK' | 'MISSING_COGS' | 'MISSING_PRICE'
}

/** Pure economics — the single formula every surface and guardrail uses. */
export function computeEconomics(i: EconomicsInput, feesAreEstimate = true): EconomicsResult {
  if (i.priceCents == null || i.priceCents <= 0) {
    return { contributionMarginCents: null, contributionMarginPct: null, breakEvenAdRatePct: null, dataStatus: 'MISSING_PRICE' }
  }
  if (i.cogsCents == null) {
    return { contributionMarginCents: null, contributionMarginPct: null, breakEvenAdRatePct: null, dataStatus: 'MISSING_COGS' }
  }
  const adFeeBase = i.priceCents // + shipping charged (0 today; see header)
  const margin = i.priceCents - i.cogsCents - (i.ebayFeesCents ?? 0) - i.shippingCostCents
  const pct = (margin / adFeeBase) * 100
  return {
    contributionMarginCents: margin,
    contributionMarginPct: round2(pct),
    // Never negative: a loss-making listing has a 0% break-even (any ad fee deepens the loss).
    breakEvenAdRatePct: round2(Math.max(0, pct)),
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

export function estimateEbayFeesCents(priceCents: number): number {
  return Math.round(priceCents * FVF_PCT) + FEE_FIXED_CENTS
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
    const fees = priceCents != null ? estimateEbayFeesCents(priceCents) : null
    const eco = computeEconomics({ priceCents, cogsCents, ebayFeesCents: fees, shippingCostCents: 0 }, true)

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
