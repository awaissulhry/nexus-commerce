/**
 * IH.17 — forecasting & projections.
 *
 * Surfaces the existing replenishment forecast pipeline as a proper
 * insights report. Reads `ReplenishmentForecast` rows (next 30/60/90
 * day demand per SKU × channel × marketplace, with 80% prediction
 * intervals + multiplicative signal factors), joins with current
 * `StockLevel.available` and `Product.costPrice` + recent AOV to
 * project revenue + days-to-stockout, and rolls up
 * `ForecastAccuracy` from the last 30 days into a MAPE / band-
 * calibration summary so the operator can trust the curve.
 *
 * Where IH.7 inventory answers "what stock do I have right now",
 * IH.17 answers "what's about to happen". The same horizon (30 / 60
 * / 90 days) appears across the operator's three forward-looking
 * surfaces: this one, IH.10 scenarios, and IH.11 AI brief.
 */

import prisma from '../../db.js'
import {
  type InsightsFilters,
  resolveWindowRange,
} from './index.js'

export interface ForecastTrendPoint {
  date: string
  forecast: number
  lower80: number
  upper80: number
}

export interface ForecastSkuRow {
  sku: string
  productName: string | null
  brand: string | null
  forecast30: number
  forecast60: number
  forecast90: number
  lower30: number
  upper30: number
  projectedRevenue30: number
  available: number
  daysToStockout: number | null
  needsReorder: boolean
  signalsActive: string[]
  modelRegime: string | null
}

export interface AccuracyBucket {
  modelRegime: string
  rowCount: number
  mape: number | null
  meanAbsError: number
  withinBandPct: number
}

export interface ForecastReport {
  generatedAt: string
  horizonStart: string
  horizonEnd: string
  totals: {
    forecast30: number
    forecast60: number
    forecast90: number
    projectedRevenue30: number
    stockoutRiskCount: number
    skuCount: number
  }
  trend: ForecastTrendPoint[]
  topSkus: ForecastSkuRow[]
  stockoutWatch: ForecastSkuRow[]
  accuracyOverall: AccuracyBucket
  accuracyByModel: AccuracyBucket[]
}

function dayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

function bucketAccuracy(
  rows: Array<{
    modelRegime: string
    absoluteError: number
    percentError: number | null
    withinBand: boolean
  }>,
  regime: string,
): AccuracyBucket {
  const pe = rows.map((r) => r.percentError).filter((x): x is number => x != null)
  const mape = pe.length > 0 ? pe.reduce((s, v) => s + v, 0) / pe.length : null
  const mae =
    rows.length > 0
      ? rows.reduce((s, r) => s + r.absoluteError, 0) / rows.length
      : 0
  const withinBand =
    rows.length > 0
      ? (rows.filter((r) => r.withinBand).length / rows.length) * 100
      : 0
  return {
    modelRegime: regime,
    rowCount: rows.length,
    mape: mape == null ? null : Math.round(mape * 10) / 10,
    meanAbsError: Math.round(mae * 10) / 10,
    withinBandPct: Math.round(withinBand * 10) / 10,
  }
}

export async function computeForecastReport(
  filters: InsightsFilters,
): Promise<ForecastReport> {
  const current = resolveWindowRange(filters)
  const today = new Date(current.to)
  today.setUTCHours(0, 0, 0, 0)
  const horizon30 = new Date(today.getTime() + 30 * 24 * 3600_000)
  const horizon60 = new Date(today.getTime() + 60 * 24 * 3600_000)
  const horizon90 = new Date(today.getTime() + 90 * 24 * 3600_000)

  const whereChannel =
    filters.channels.length > 0
      ? { in: filters.channels as string[] }
      : undefined
  const whereMarket =
    filters.markets.length > 0 ? { in: filters.markets } : undefined

  const forecasts = await prisma.replenishmentForecast.findMany({
    where: {
      horizonDay: { gte: today, lt: horizon90 },
      ...(whereChannel ? { channel: whereChannel } : {}),
      ...(whereMarket ? { marketplace: whereMarket } : {}),
    },
    select: {
      sku: true,
      channel: true,
      marketplace: true,
      horizonDay: true,
      forecastUnits: true,
      lower80: true,
      upper80: true,
      signals: true,
      generationTag: true,
      model: true,
    },
    take: 500_000,
  })

  const skuMap = new Map<
    string,
    {
      f30: number
      f60: number
      f90: number
      lower30: number
      upper30: number
      signals: Set<string>
      model: string | null
    }
  >()
  const trendMap = new Map<string, { f: number; l: number; u: number }>()
  for (const row of forecasts) {
    const units = Number(row.forecastUnits)
    const lower = Number(row.lower80)
    const upper = Number(row.upper80)
    const ageDays = Math.floor(
      (row.horizonDay.getTime() - today.getTime()) / (24 * 3600_000),
    )
    const slot = skuMap.get(row.sku) ?? {
      f30: 0,
      f60: 0,
      f90: 0,
      lower30: 0,
      upper30: 0,
      signals: new Set<string>(),
      model: row.model,
    }
    if (ageDays < 30) {
      slot.f30 += units
      slot.lower30 += lower
      slot.upper30 += upper
    }
    if (ageDays < 60) slot.f60 += units
    slot.f90 += units
    if (row.signals && typeof row.signals === 'object') {
      for (const k of Object.keys(row.signals as Record<string, unknown>)) {
        slot.signals.add(k)
      }
    }
    skuMap.set(row.sku, slot)

    const dk = dayKey(row.horizonDay)
    const t = trendMap.get(dk) ?? { f: 0, l: 0, u: 0 }
    t.f += units
    t.l += lower
    t.u += upper
    trendMap.set(dk, t)
  }

  const skus = [...skuMap.keys()]
  if (skus.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      horizonStart: today.toISOString(),
      horizonEnd: horizon90.toISOString(),
      totals: {
        forecast30: 0,
        forecast60: 0,
        forecast90: 0,
        projectedRevenue30: 0,
        stockoutRiskCount: 0,
        skuCount: 0,
      },
      trend: [],
      topSkus: [],
      stockoutWatch: [],
      accuracyOverall: {
        modelRegime: 'overall',
        rowCount: 0,
        mape: null,
        meanAbsError: 0,
        withinBandPct: 0,
      },
      accuracyByModel: [],
    }
  }

  const [products, stockLevels, recentSales, accuracyRows] = await Promise.all([
    prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { id: true, sku: true, name: true, brand: true, basePrice: true },
    }),
    prisma.stockLevel.groupBy({
      by: ['productId'],
      where: { product: { sku: { in: skus } } },
      _sum: { available: true },
    }),
    prisma.orderItem.findMany({
      where: {
        sku: { in: skus },
        order: {
          purchaseDate: { gte: new Date(today.getTime() - 30 * 24 * 3600_000) },
          deletedAt: null,
        },
      },
      select: { sku: true, quantity: true, price: true },
      take: 200_000,
    }),
    prisma.forecastAccuracy.findMany({
      where: {
        day: { gte: new Date(today.getTime() - 30 * 24 * 3600_000) },
        ...(whereChannel ? { channel: whereChannel } : {}),
        ...(whereMarket ? { marketplace: whereMarket } : {}),
      },
      select: {
        modelRegime: true,
        absoluteError: true,
        percentError: true,
        withinBand: true,
      },
      take: 100_000,
    }),
  ])

  const productMap = new Map(products.map((p) => [p.sku, p]))
  const productIdToSku = new Map(products.map((p) => [p.id, p.sku]))
  const stockMap = new Map<string, number>()
  for (const s of stockLevels) {
    const sku = productIdToSku.get(s.productId)
    if (sku) stockMap.set(sku, s._sum.available ?? 0)
  }
  const aovBySku = new Map<string, number>()
  const unitsBySku = new Map<string, number>()
  for (const it of recentSales) {
    const totalRev = (aovBySku.get(it.sku) ?? 0) + Number(it.price) * it.quantity
    const totalUnits = (unitsBySku.get(it.sku) ?? 0) + it.quantity
    aovBySku.set(it.sku, totalRev)
    unitsBySku.set(it.sku, totalUnits)
  }

  const rows: ForecastSkuRow[] = skus.map((sku) => {
    const slot = skuMap.get(sku)!
    const product = productMap.get(sku)
    const totalRev30 = aovBySku.get(sku) ?? 0
    const totalUnits30 = unitsBySku.get(sku) ?? 0
    const unitPrice =
      totalUnits30 > 0
        ? totalRev30 / totalUnits30
        : product?.basePrice
          ? Number(product.basePrice)
          : 0
    const projectedRevenue30 = slot.f30 * unitPrice
    const available = stockMap.get(sku) ?? 0
    const dailyForecast = slot.f30 / 30
    const daysToStockout =
      dailyForecast > 0 ? available / dailyForecast : null
    const needsReorder =
      daysToStockout != null && daysToStockout < 21 && slot.f30 > 0
    return {
      sku,
      productName: product?.name ?? null,
      brand: product?.brand ?? null,
      forecast30: Math.round(slot.f30),
      forecast60: Math.round(slot.f60),
      forecast90: Math.round(slot.f90),
      lower30: Math.round(slot.lower30),
      upper30: Math.round(slot.upper30),
      projectedRevenue30: Math.round(projectedRevenue30),
      available,
      daysToStockout:
        daysToStockout == null ? null : Math.round(daysToStockout * 10) / 10,
      needsReorder,
      signalsActive: [...slot.signals],
      modelRegime: slot.model,
    }
  })

  const totalForecast30 = rows.reduce((s, r) => s + r.forecast30, 0)
  const totalForecast60 = rows.reduce((s, r) => s + r.forecast60, 0)
  const totalForecast90 = rows.reduce((s, r) => s + r.forecast90, 0)
  const totalProjectedRevenue30 = rows.reduce(
    (s, r) => s + r.projectedRevenue30,
    0,
  )
  const stockoutRisk = rows.filter((r) => r.needsReorder)

  const dayMs = 24 * 3600_000
  const trend: ForecastTrendPoint[] = []
  for (let t = today.getTime(); t < horizon90.getTime(); t += dayMs) {
    const dk = dayKey(new Date(t))
    const slot = trendMap.get(dk) ?? { f: 0, l: 0, u: 0 }
    trend.push({
      date: dk,
      forecast: Math.round(slot.f),
      lower80: Math.round(slot.l),
      upper80: Math.round(slot.u),
    })
  }

  const normalized = accuracyRows.map((r) => ({
    modelRegime: r.modelRegime,
    absoluteError: Number(r.absoluteError),
    percentError: r.percentError == null ? null : Number(r.percentError),
    withinBand: r.withinBand,
  }))
  const accuracyOverall = bucketAccuracy(normalized, 'overall')
  const regimes = Array.from(new Set(normalized.map((r) => r.modelRegime)))
  const accuracyByModel = regimes.map((regime) =>
    bucketAccuracy(
      normalized.filter((r) => r.modelRegime === regime),
      regime,
    ),
  )

  return {
    generatedAt: new Date().toISOString(),
    horizonStart: today.toISOString(),
    horizonEnd: horizon90.toISOString(),
    totals: {
      forecast30: totalForecast30,
      forecast60: totalForecast60,
      forecast90: totalForecast90,
      projectedRevenue30: Math.round(totalProjectedRevenue30),
      stockoutRiskCount: stockoutRisk.length,
      skuCount: rows.length,
    },
    trend,
    topSkus: [...rows].sort((a, b) => b.forecast30 - a.forecast30).slice(0, 50),
    stockoutWatch: [...stockoutRisk]
      .sort((a, b) => (a.daysToStockout ?? 999) - (b.daysToStockout ?? 999))
      .slice(0, 50),
    accuracyOverall,
    accuracyByModel: accuracyByModel.sort((a, b) => b.rowCount - a.rowCount),
  }
}

export function forecastReportToCsv(report: ForecastReport): string {
  const lines: string[] = []
  lines.push(
    [
      'sku',
      'name',
      'brand',
      'forecast_30d',
      'forecast_60d',
      'forecast_90d',
      'lower80_30d',
      'upper80_30d',
      'projected_revenue_30d',
      'available',
      'days_to_stockout',
      'needs_reorder',
      'signals',
      'model',
    ].join(','),
  )
  for (const r of report.topSkus) {
    lines.push(
      [
        r.sku,
        JSON.stringify(r.productName ?? ''),
        JSON.stringify(r.brand ?? ''),
        r.forecast30,
        r.forecast60,
        r.forecast90,
        r.lower30,
        r.upper30,
        r.projectedRevenue30,
        r.available,
        r.daysToStockout ?? '',
        r.needsReorder ? '1' : '0',
        JSON.stringify(r.signalsActive.join(';')),
        r.modelRegime ?? '',
      ].join(','),
    )
  }
  return lines.join('\n')
}
