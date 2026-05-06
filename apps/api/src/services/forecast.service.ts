/**
 * F.4.4 — Forecast worker orchestrator.
 *
 * Per (sku, channel, marketplace):
 *   1. Read DailySalesAggregate for the trailing 365 days (or however
 *      much exists), zero-fill missing days.
 *   2. Run Holt-Winters via holt-winters.service.ts → 90-day point
 *      forecast + 80% prediction interval.
 *   3. Resolve external signals (holiday + weather + retail events) for
 *      every horizon day.
 *   4. Multiply baseline × signals.combined → adjusted forecast.
 *   5. Upsert one ReplenishmentForecast row per horizon day.
 *
 * Idempotent — re-running on the same series produces the same forecast
 * rows (Holt-Winters is deterministic given fixed parameters; signals
 * are deterministic given the same external API responses on the same
 * day).
 *
 * Two entrypoints:
 *   - generateForecastForSeries: one (sku, channel, marketplace) tuple
 *   - generateForecastsForAll: every distinct (sku, channel, marketplace)
 *     in DailySalesAggregate that's been seen in the last 365 days
 *
 * Performance note: at Xavia's scale (~3.2K SKUs × 5 marketplaces =
 * ~16K series), each series takes ~10ms (Holt-Winters in pure TS) +
 * ~50ms (signal API calls, batched per marketplace). Worst case:
 * 16K × 60ms = ~16 minutes total; acceptable for a nightly batch.
 * External signal fetches are de-duplicated per marketplace — same
 * weather forecast is reused across every SKU on AMAZON:IT.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  forecastDailyDemand,
  type ForecastResult,
  type ForecastRegime,
} from './holt-winters.service.js'
import {
  resolveForecastSignals,
  type SignalsForDay,
} from './forecast-signals.service.js'

const HORIZON_DAYS = 90
const HISTORY_DAYS = 365

interface SeriesIdentity {
  sku: string
  channel: string
  marketplace: string
  /** Optional product type for category-aware weather elasticity. */
  productType?: string | null
}

export interface SeriesForecastResult {
  sku: string
  channel: string
  marketplace: string
  regime: ForecastRegime
  rowsWritten: number
  generationTag: string | null
  durationMs: number
}

/**
 * Forecast a single (sku, channel, marketplace) series. Reads its 365d
 * history, runs HW, applies signals, writes 90 days of ReplenishmentForecast
 * rows.
 *
 * The optional `signalsCache` lets the caller (the all-series orchestrator)
 * share fetched holiday/weather signals across every series in the same
 * marketplace — turning N × API calls into 1 × API call.
 */
export async function generateForecastForSeries(
  identity: SeriesIdentity,
  signalsCache?: Map<string, SignalsForDay>,
): Promise<SeriesForecastResult> {
  const startedAt = Date.now()

  // Today (UTC, day boundary) — anchor for both history and horizon.
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const historyStart = new Date(today)
  historyStart.setUTCDate(historyStart.getUTCDate() - HISTORY_DAYS)

  // ── Read history ────────────────────────────────────────────────
  const aggregates = await prisma.dailySalesAggregate.findMany({
    where: {
      sku: identity.sku,
      channel: identity.channel,
      marketplace: identity.marketplace,
      day: { gte: historyStart, lt: today },
    },
    orderBy: { day: 'asc' },
    select: { day: true, unitsSold: true },
  })

  // Zero-fill missing days so the series is dense (Holt-Winters needs
  // continuous data; gaps would be interpreted as legitimate zeros
  // anyway, but explicit zeros are easier to reason about).
  const dayMap = new Map<string, number>()
  for (const row of aggregates) {
    dayMap.set(row.day.toISOString().slice(0, 10), row.unitsSold)
  }
  const history: number[] = []
  const cursor = new Date(historyStart)
  while (cursor < today) {
    const key = cursor.toISOString().slice(0, 10)
    history.push(dayMap.get(key) ?? 0)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  // ── Run Holt-Winters ────────────────────────────────────────────
  const baseline: ForecastResult = forecastDailyDemand(history, HORIZON_DAYS)

  // ── Resolve external signals ────────────────────────────────────
  const horizonDays: Date[] = []
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() + i)
    horizonDays.push(d)
  }

  let signals: Map<string, SignalsForDay>
  if (signalsCache && signalsCache.size > 0) {
    signals = signalsCache
  } else {
    signals = await resolveForecastSignals({
      marketplace: identity.marketplace,
      channel: identity.channel,
      productType: identity.productType,
      days: horizonDays,
    })
  }

  // ── Compose adjusted forecast + upsert rows ─────────────────────
  let rowsWritten = 0
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const horizonDay = horizonDays[i]
    const dayKey = horizonDay.toISOString().slice(0, 10)
    const point = baseline.points[i]
    if (!point) continue

    const sig = signals.get(dayKey) ?? {
      holiday: 1,
      weather: 1,
      retail: 1,
      combined: 1,
      notes: [],
    }
    const adjusted = point.value * sig.combined
    const lower80 = point.lower80 * sig.combined
    const upper80 = point.upper80 * sig.combined

    // R.16 — unique key includes model to support champion +
    // challenger dual-write. v1 still always uses HOLT_WINTERS_V1
    // as the model identifier; model A/B happens by registering
    // alternate forecaster modules and routing via
    // forecast-routing.service.
    const modelId = 'HOLT_WINTERS_V1'
    await prisma.replenishmentForecast.upsert({
      where: {
        sku_channel_marketplace_horizonDay_model: {
          sku: identity.sku,
          channel: identity.channel,
          marketplace: identity.marketplace,
          horizonDay,
          model: modelId,
        },
      },
      create: {
        sku: identity.sku,
        channel: identity.channel,
        marketplace: identity.marketplace,
        horizonDay,
        forecastUnits: clamp2(adjusted),
        lower80: clamp2(lower80),
        upper80: clamp2(upper80),
        signals: sig as any,
        generationTag: regimeToTag(baseline.regime),
        model: modelId,
      },
      update: {
        forecastUnits: clamp2(adjusted),
        lower80: clamp2(lower80),
        upper80: clamp2(upper80),
        signals: sig as any,
        generationTag: regimeToTag(baseline.regime),
        generatedAt: new Date(),
      },
    })
    rowsWritten++
  }

  const durationMs = Date.now() - startedAt
  return {
    sku: identity.sku,
    channel: identity.channel,
    marketplace: identity.marketplace,
    regime: baseline.regime,
    rowsWritten,
    generationTag: regimeToTag(baseline.regime),
    durationMs,
  }
}

function regimeToTag(regime: ForecastRegime): string | null {
  switch (regime) {
    case 'COLD_START':
      return 'COLD_START'
    case 'TRAILING_MEAN':
      return 'TRAILING_MEAN_FALLBACK'
    case 'HOLT_LINEAR':
      return 'HOLT_LINEAR'
    case 'HOLT_WINTERS':
      return null // canonical / no special tag
    default:
      return null
  }
}

function clamp2(v: number): string {
  if (!Number.isFinite(v) || v < 0) return '0.00'
  // Decimal(12, 2) cap at 9_999_999_999.99 — clamp absurd outliers.
  const capped = Math.min(v, 9_999_999_999.99)
  return capped.toFixed(2)
}

/**
 * Generate forecasts for every (sku, channel, marketplace) tuple that has
 * shown up in DailySalesAggregate within the last 365 days. Caches per-
 * marketplace external signals so we don't blow holidays / weather /
 * retail-event API budget on duplicate fetches.
 *
 * Skips tuples where the series has fewer than 7 historical rows by
 * default — those are too cold to forecast meaningfully (unless the
 * caller passes includeColdStart: true for catch-up runs).
 */
export async function generateForecastsForAll(args: {
  includeColdStart?: boolean
} = {}): Promise<{
  seriesProcessed: number
  rowsWritten: number
  durationMs: number
  byRegime: Record<ForecastRegime, number>
  errors: Array<{ identity: string; error: string }>
}> {
  const startedAt = Date.now()

  // Distinct series we've seen in the last 365 days.
  const oneYearAgo = new Date()
  oneYearAgo.setUTCHours(0, 0, 0, 0)
  oneYearAgo.setUTCDate(oneYearAgo.getUTCDate() - HISTORY_DAYS)

  const distinct = await prisma.dailySalesAggregate.groupBy({
    by: ['sku', 'channel', 'marketplace'],
    where: { day: { gte: oneYearAgo } },
    _count: true,
  })

  // Filter cold starts unless explicitly included.
  const eligible = args.includeColdStart
    ? distinct
    : distinct.filter((d) => d._count >= 7)

  // Resolve product types for category-aware weather elasticity. Single
  // batched query — looks up the Product / ProductVariation row whose
  // sku matches each series.
  const skus = [...new Set(eligible.map((s) => s.sku))]
  const [products, variants] = await Promise.all([
    prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, productType: true },
    }),
    prisma.productVariation.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, product: { select: { productType: true } } },
    }),
  ])
  const productTypeBySku = new Map<string, string | null>()
  for (const p of products) productTypeBySku.set(p.sku, p.productType)
  for (const v of variants) {
    if (!productTypeBySku.has(v.sku)) {
      productTypeBySku.set(v.sku, v.product.productType)
    }
  }

  // Build the per-marketplace signals cache — one fetch per
  // (channel, marketplace) shared across every SKU on that marketplace.
  // Note: weather signal IS productType-aware, so we cache only
  // holiday + retail-event signals at this level. Weather is fetched
  // per (marketplace, productType) — much smaller than per-SKU.
  const horizonDays: Date[] = []
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() + i)
    horizonDays.push(d)
  }

  const sigCacheKey = (mp: string, ch: string, pt: string | null) =>
    `${ch}:${mp}:${pt ?? '_'}`
  const sigCache = new Map<string, Map<string, SignalsForDay>>()
  const byRegime: Record<ForecastRegime, number> = {
    COLD_START: 0,
    TRAILING_MEAN: 0,
    HOLT_LINEAR: 0,
    HOLT_WINTERS: 0,
  }
  const errors: Array<{ identity: string; error: string }> = []
  let rowsWritten = 0

  for (const series of eligible) {
    const productType = productTypeBySku.get(series.sku) ?? null
    const cacheKey = sigCacheKey(series.marketplace, series.channel, productType)
    let sig = sigCache.get(cacheKey)
    if (!sig) {
      sig = await resolveForecastSignals({
        marketplace: series.marketplace,
        channel: series.channel,
        productType,
        days: horizonDays,
      })
      sigCache.set(cacheKey, sig)
    }

    try {
      const result = await generateForecastForSeries(
        { ...series, productType },
        sig,
      )
      byRegime[result.regime]++
      rowsWritten += result.rowsWritten
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({
        identity: `${series.sku}|${series.channel}|${series.marketplace}`,
        error: message,
      })
    }
  }

  const durationMs = Date.now() - startedAt
  logger.info('forecast: full run complete', {
    seriesProcessed: eligible.length,
    rowsWritten,
    durationMs,
    byRegime,
    errorCount: errors.length,
  })

  return {
    seriesProcessed: eligible.length,
    rowsWritten,
    durationMs,
    byRegime,
    errors,
  }
}
