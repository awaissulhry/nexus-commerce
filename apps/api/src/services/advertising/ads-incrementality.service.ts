/**
 * AX3.5 — iROAS / incrementality (modeled).
 *
 * True incrementality needs a holdout experiment or AMC; until those run we
 * give a transparent *modeled* iROAS — the metric Pacvue/Intentwise lean on.
 * The idea: not every ad-attributed sale is incremental. Branded-search
 * sales would largely have happened anyway (low incrementality); non-brand /
 * discovery sales are mostly new demand (high incrementality). We classify
 * each campaign branded vs non-branded (by brand-term match in the name) and
 * apply an adjustable incrementality factor:
 *
 *   incrementalSales = adSales × factor
 *   iROAS            = incrementalSales / adSpend
 *
 * Factors are caller-tunable and the output labels itself as a model — not
 * measured truth. Real incrementality plugs in later via AMC (AX3.4 path).
 */

import prisma from '../../db.js'

export interface IncrementalityRow {
  campaignId: string; name: string; marketplace: string | null
  branded: boolean; spendCents: number; adSalesCents: number
  roas: number | null; incrementalityFactor: number; incrementalSalesCents: number; iroas: number | null
}
export interface IncrementalityResult {
  windowDays: number; brandTerms: string[]; brandedFactor: number; nonBrandedFactor: number
  totals: { spendCents: number; adSalesCents: number; roas: number | null; incrementalSalesCents: number; iroas: number | null; brandedSpendCents: number; nonBrandedSpendCents: number }
  rows: IncrementalityRow[]
  note: string
}

export async function analyzeIncrementality(opts: { windowDays?: number; brandTerms?: string[]; brandedFactor?: number; nonBrandedFactor?: number } = {}): Promise<IncrementalityResult> {
  const windowDays = opts.windowDays ?? 30
  const brandedFactor = clamp(opts.brandedFactor ?? 0.3)
  const nonBrandedFactor = clamp(opts.nonBrandedFactor ?? 0.85)
  const brandTerms = (opts.brandTerms ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)
  const since = new Date(Date.now() - windowDays * 86_400_000)

  const perf = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'], where: { entityType: 'CAMPAIGN', date: { gte: since }, localEntityId: { not: null } },
    _sum: { costMicros: true, sales7dCents: true },
  })
  const ids = perf.map((p) => p.localEntityId).filter(Boolean) as string[]
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, marketplace: true } })
  const cMap = new Map(campaigns.map((c) => [c.id, c]))

  const rows: IncrementalityRow[] = []
  for (const p of perf) {
    const c = p.localEntityId ? cMap.get(p.localEntityId) : null
    if (!c) continue
    const spendCents = Math.round(Number(p._sum.costMicros ?? 0) / 10_000)
    const adSalesCents = p._sum.sales7dCents ?? 0
    if (spendCents === 0 && adSalesCents === 0) continue
    const branded = brandTerms.length > 0 && brandTerms.some((t) => c.name.toLowerCase().includes(t))
    const incrementalityFactor = branded ? brandedFactor : nonBrandedFactor
    const incrementalSalesCents = Math.round(adSalesCents * incrementalityFactor)
    rows.push({
      campaignId: c.id, name: c.name, marketplace: c.marketplace, branded,
      spendCents, adSalesCents, roas: spendCents > 0 ? adSalesCents / spendCents : null,
      incrementalityFactor, incrementalSalesCents, iroas: spendCents > 0 ? incrementalSalesCents / spendCents : null,
    })
  }
  rows.sort((a, b) => b.spendCents - a.spendCents)

  const t = rows.reduce((a, r) => ({
    spend: a.spend + r.spendCents, adSales: a.adSales + r.adSalesCents, inc: a.inc + r.incrementalSalesCents,
    bSpend: a.bSpend + (r.branded ? r.spendCents : 0), nbSpend: a.nbSpend + (r.branded ? 0 : r.spendCents),
  }), { spend: 0, adSales: 0, inc: 0, bSpend: 0, nbSpend: 0 })

  return {
    windowDays, brandTerms, brandedFactor, nonBrandedFactor,
    totals: {
      spendCents: t.spend, adSalesCents: t.adSales, roas: t.spend > 0 ? t.adSales / t.spend : null,
      incrementalSalesCents: t.inc, iroas: t.spend > 0 ? t.inc / t.spend : null,
      brandedSpendCents: t.bSpend, nonBrandedSpendCents: t.nbSpend,
    },
    rows,
    note: brandTerms.length === 0
      ? 'No brand terms set — every campaign treated as non-branded. Add your brand terms to separate defensive branded spend (low incrementality) from discovery spend.'
      : `Modeled iROAS: branded sales ×${brandedFactor}, non-branded ×${nonBrandedFactor}. For measured incrementality, run an AMC/experiment holdout.`,
  }
}

function clamp(n: number): number { return Math.max(0, Math.min(1, n)) }
