/**
 * R.1 — Forecast accuracy service.
 *
 * Compares each prior-day ReplenishmentForecast row to its
 * DailySalesAggregate actual and writes a ForecastAccuracy row.
 * Surfaces MAPE / MAE / band calibration aggregations for the
 * drawer + workspace dashboards.
 *
 * MAPE policy:
 *   percentError = |forecast - actual| / actual * 100, NULL when
 *   actualUnits = 0. MAPE roll-ups exclude NULLs; MAE roll-ups use
 *   absoluteError which is always defined.
 *
 * "Predicted in advance" filter:
 *   When picking which forecast row scored a given day, we require
 *   forecast.generatedAt < startOfDayUTC(day). Otherwise we'd be
 *   scoring a curve fit (forecast made after the actual was visible)
 *   which inflates apparent accuracy.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export type ModelRegime = 'COLD_START' | 'TRAILING_MEAN_FALLBACK' | 'HOLT_LINEAR' | 'HOLT_WINTERS'

export interface AccuracyRowInput {
  forecastUnits: number
  forecastLower80: number | null
  forecastUpper80: number | null
  actualUnits: number
}

export interface AccuracyRowComputed {
  forecastUnits: number
  forecastLower80: number | null
  forecastUpper80: number | null
  actualUnits: number
  absoluteError: number
  percentError: number | null
  withinBand: boolean
}

/**
 * Pure-function: given a forecast + actual, compute the row's metrics.
 * Negative forecasts are clamped to 0 before comparison (a negative
 * forecast means the model is broken; treating it as 0 floors the
 * error at the actual). withinBand is false when bands are missing
 * because we have no statement to score.
 */
export function computeAccuracyRow(input: AccuracyRowInput): AccuracyRowComputed {
  const forecast = Math.max(0, input.forecastUnits)
  const actual = Math.max(0, input.actualUnits)
  const absoluteError = Math.abs(forecast - actual)
  const percentError = actual === 0 ? null : (absoluteError / actual) * 100
  const lower = input.forecastLower80 != null ? Math.max(0, input.forecastLower80) : null
  const upper = input.forecastUpper80
  const withinBand = lower != null && upper != null && actual >= lower && actual <= upper
  return {
    forecastUnits: forecast,
    forecastLower80: input.forecastLower80,
    forecastUpper80: input.forecastUpper80,
    actualUnits: actual,
    absoluteError,
    percentError: percentError == null ? null : Number(percentError.toFixed(2)),
    withinBand,
  }
}

/**
 * Translate a ReplenishmentForecast.generationTag (or absence thereof)
 * into the ModelRegime label we store on accuracy rows. Keeps the
 * regime taxonomy in one place.
 */
export function regimeFromGenerationTag(tag: string | null | undefined): ModelRegime {
  if (tag === 'COLD_START') return 'COLD_START'
  if (tag === 'TRAILING_MEAN_FALLBACK') return 'TRAILING_MEAN_FALLBACK'
  if (tag === 'HOLT_LINEAR') return 'HOLT_LINEAR'
  // Default: full Holt-Winters (regime 4 — the unmarked common case).
  return 'HOLT_WINTERS'
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0))
}

function addDaysUTC(d: Date, days: number): Date {
  const next = new Date(d)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

/**
 * Run the accuracy sweep for a single target day. Used by both the
 * daily cron (target = yesterday) and the backfill endpoint (loops).
 *
 * Idempotent: UPSERT on the unique (sku, channel, marketplace, day)
 * tuple. Re-running for the same day produces the same row.
 *
 * Returns counts so the caller can log + the backfill endpoint can
 * report progress.
 */
export async function runForecastAccuracySweepForDay(targetDay: Date): Promise<{
  day: string
  evaluated: number
  skippedNoForecast: number
}> {
  const dayStart = startOfDayUTC(targetDay)
  const dayEnd = addDaysUTC(dayStart, 1)

  // All (sku, channel, marketplace) tuples with sales aggregated for
  // this day. We anchor on aggregates (not forecasts) because we only
  // score days where actuals are available.
  const aggregates = await prisma.dailySalesAggregate.findMany({
    where: { day: dayStart },
    select: { sku: true, channel: true, marketplace: true, unitsSold: true },
  })

  let evaluated = 0
  let skippedNoForecast = 0

  for (const agg of aggregates) {
    // Pick the most recent forecast that was generated BEFORE the day
    // started. A forecast with generatedAt >= dayStart is a curve fit,
    // not a prediction; excluding it keeps MAPE honest.
    const forecast = await prisma.replenishmentForecast.findFirst({
      where: {
        sku: agg.sku,
        channel: agg.channel,
        marketplace: agg.marketplace,
        horizonDay: dayStart,
        generatedAt: { lt: dayStart },
      },
      orderBy: { generatedAt: 'desc' },
    })
    if (!forecast) {
      skippedNoForecast++
      continue
    }

    const row = computeAccuracyRow({
      forecastUnits: Number(forecast.forecastUnits),
      forecastLower80: forecast.lower80 != null ? Number(forecast.lower80) : null,
      forecastUpper80: forecast.upper80 != null ? Number(forecast.upper80) : null,
      actualUnits: agg.unitsSold,
    })

    await prisma.forecastAccuracy.upsert({
      where: {
        sku_channel_marketplace_day: {
          sku: agg.sku,
          channel: agg.channel,
          marketplace: agg.marketplace,
          day: dayStart,
        },
      },
      create: {
        sku: agg.sku,
        channel: agg.channel,
        marketplace: agg.marketplace,
        day: dayStart,
        forecastUnits: row.forecastUnits,
        forecastLower80: row.forecastLower80,
        forecastUpper80: row.forecastUpper80,
        actualUnits: row.actualUnits,
        absoluteError: row.absoluteError,
        percentError: row.percentError,
        withinBand: row.withinBand,
        modelRegime: regimeFromGenerationTag(forecast.generationTag),
        model: forecast.model,
        forecastGeneratedAt: forecast.generatedAt,
      },
      update: {
        forecastUnits: row.forecastUnits,
        forecastLower80: row.forecastLower80,
        forecastUpper80: row.forecastUpper80,
        actualUnits: row.actualUnits,
        absoluteError: row.absoluteError,
        percentError: row.percentError,
        withinBand: row.withinBand,
        modelRegime: regimeFromGenerationTag(forecast.generationTag),
        model: forecast.model,
        forecastGeneratedAt: forecast.generatedAt,
        evaluatedAt: new Date(),
      },
    })
    evaluated++
  }

  return { day: dayStart.toISOString().slice(0, 10), evaluated, skippedNoForecast }
}

/**
 * Daily cron entrypoint. Targets yesterday (one full closed day).
 */
export async function runForecastAccuracySweep(): Promise<{
  day: string
  evaluated: number
  skippedNoForecast: number
}> {
  const yesterday = addDaysUTC(startOfDayUTC(new Date()), -1)
  const result = await runForecastAccuracySweepForDay(yesterday)
  if (result.evaluated > 0 || result.skippedNoForecast > 0) {
    logger.info('forecast-accuracy: swept', result)
  }
  return result
}

/**
 * Backfill across a window. Days where no qualifying forecast exists
 * are reported as skipped — we don't try to manufacture predictions
 * retroactively.
 */
export async function backfillForecastAccuracy(args: {
  fromDay: Date
  toDay: Date
}): Promise<{ days: number; evaluated: number; skippedNoForecast: number }> {
  const fromStart = startOfDayUTC(args.fromDay)
  const toStart = startOfDayUTC(args.toDay)
  if (toStart < fromStart) throw new Error('toDay must be >= fromDay')

  let evaluated = 0
  let skippedNoForecast = 0
  let days = 0
  let cursor = fromStart
  while (cursor <= toStart) {
    const r = await runForecastAccuracySweepForDay(cursor)
    evaluated += r.evaluated
    skippedNoForecast += r.skippedNoForecast
    days++
    cursor = addDaysUTC(cursor, 1)
  }
  logger.info('forecast-accuracy: backfilled', { days, evaluated, skippedNoForecast })
  return { days, evaluated, skippedNoForecast }
}

// ─── Aggregation helpers (read-side) ───────────────────────────────

export interface AccuracyStats {
  sampleCount: number
  mape: number | null
  mae: number | null
  bandCalibration: number | null
}

function stats(rows: { absoluteError: any; percentError: any | null; withinBand: boolean }[]): AccuracyStats {
  if (rows.length === 0) return { sampleCount: 0, mape: null, mae: null, bandCalibration: null }
  const mae = rows.reduce((s, r) => s + Number(r.absoluteError), 0) / rows.length
  const mapeRows = rows.filter((r) => r.percentError != null)
  const mape = mapeRows.length === 0 ? null : mapeRows.reduce((s, r) => s + Number(r.percentError), 0) / mapeRows.length
  const bandCalibration = (rows.filter((r) => r.withinBand).length / rows.length) * 100
  return {
    sampleCount: rows.length,
    mape: mape == null ? null : Number(mape.toFixed(2)),
    mae: Number(mae.toFixed(2)),
    bandCalibration: Number(bandCalibration.toFixed(1)),
  }
}

export async function getAccuracyForSku(args: {
  sku: string
  channel?: string
  marketplace?: string
  windowDays: number
}) {
  const since = addDaysUTC(startOfDayUTC(new Date()), -args.windowDays)
  const where: any = { sku: args.sku, day: { gte: since } }
  if (args.channel) where.channel = args.channel
  if (args.marketplace) where.marketplace = args.marketplace

  const rows = await prisma.forecastAccuracy.findMany({
    where,
    orderBy: { day: 'asc' },
  })

  const overall = stats(rows)

  const byRegime: Record<string, AccuracyStats> = {}
  const grouped = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = grouped.get(r.modelRegime) ?? []
    list.push(r)
    grouped.set(r.modelRegime, list)
  }
  for (const [regime, list] of grouped.entries()) {
    byRegime[regime] = stats(list)
  }

  return {
    sku: args.sku,
    channel: args.channel ?? null,
    marketplace: args.marketplace ?? null,
    windowDays: args.windowDays,
    ...overall,
    byRegime,
    series: rows.map((r) => ({
      day: r.day,
      forecastUnits: Number(r.forecastUnits),
      actualUnits: r.actualUnits,
      percentError: r.percentError == null ? null : Number(r.percentError),
      withinBand: r.withinBand,
      modelRegime: r.modelRegime,
    })),
  }
}

export async function getAccuracyAggregate(args: {
  windowDays: number
  groupBy?: 'regime' | 'channel' | 'marketplace' | 'none'
}) {
  const since = addDaysUTC(startOfDayUTC(new Date()), -args.windowDays)
  const rows = await prisma.forecastAccuracy.findMany({
    where: { day: { gte: since } },
    select: {
      day: true,
      modelRegime: true,
      channel: true,
      marketplace: true,
      absoluteError: true,
      percentError: true,
      withinBand: true,
      sku: true,
    },
  })

  const overall = stats(rows)

  // Group key resolver per groupBy mode
  let groups: Array<{ key: string } & AccuracyStats> = []
  if (args.groupBy && args.groupBy !== 'none') {
    const buckets = new Map<string, typeof rows>()
    for (const r of rows) {
      const key =
        args.groupBy === 'regime' ? r.modelRegime
          : args.groupBy === 'channel' ? r.channel
          : r.marketplace
      const list = buckets.get(key) ?? []
      list.push(r)
      buckets.set(key, list)
    }
    groups = Array.from(buckets.entries()).map(([key, list]) => ({ key, ...stats(list) }))
    groups.sort((a, b) => b.sampleCount - a.sampleCount)
  }

  // Daily trend (always)
  const byDay = new Map<string, typeof rows>()
  for (const r of rows) {
    const k = r.day.toISOString().slice(0, 10)
    const list = byDay.get(k) ?? []
    list.push(r)
    byDay.set(k, list)
  }
  const trend = Array.from(byDay.entries())
    .map(([day, list]) => ({ day, ...stats(list) }))
    .sort((a, b) => a.day.localeCompare(b.day))

  // Worst SKU (highest MAPE with sampleCount >= 3)
  const bySku = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = bySku.get(r.sku) ?? []
    list.push(r)
    bySku.set(r.sku, list)
  }
  let worstSku: { sku: string; mape: number | null; sampleCount: number } | null = null
  for (const [sku, list] of bySku.entries()) {
    const s = stats(list)
    if (s.sampleCount < 3 || s.mape == null) continue
    if (worstSku == null || s.mape > worstSku.mape!) {
      worstSku = { sku, mape: s.mape, sampleCount: s.sampleCount }
    }
  }

  return {
    windowDays: args.windowDays,
    overall,
    groups,
    trend,
    worstSku,
  }
}
