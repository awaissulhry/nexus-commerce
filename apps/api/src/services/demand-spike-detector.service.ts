/**
 * W4.12 — Demand-spike detector.
 *
 * Compares trailing 7-day velocity to trailing 30-day baseline per
 * (sku, channel, marketplace) tuple. Returns spikes where the ratio
 * exceeds a threshold (default 2.0) AND there's enough signal to
 * be confident — at least 3 selling days in the recent window AND
 * the trailing-30 baseline is non-trivial (≥ 0.5 units/day).
 *
 * Reads from DailySalesAggregate exclusively — no live OrderItem
 * scans. The W1.1 hooks keep DSA current, so this detector runs
 * cheap (one query per call).
 *
 * Output shape per spike matches the trigger-payload contract:
 *
 *   {
 *     spike: {
 *       velocityRatio: number,
 *       trailingShortVelocity: number,    // units/day, last 7d
 *       trailingLongVelocity: number,     // units/day, last 30d
 *       sellingDaysShort: number,
 *       confidenceExcludesBaseline: boolean
 *     },
 *     product: { id, sku },
 *     recommendation: { ... } | null      // attached if ACTIVE rec exists
 *   }
 *
 * confidenceExcludesBaseline: a coarse heuristic — when the short-
 * window velocity is more than 1 standard-deviation away from the
 * baseline, AND the ratio crosses the threshold, we treat the
 * spike as significant. Real Bayesian / Poisson confidence work
 * lands in W8 causal-factor depth; this gets us 80% there with a
 * single query.
 */

import prisma from '../db.js'

export interface DetectedSpike {
  spike: {
    velocityRatio: number
    trailingShortVelocity: number
    trailingLongVelocity: number
    sellingDaysShort: number
    confidenceExcludesBaseline: boolean
  }
  product: {
    id: string | null
    sku: string
  }
  channel: string
  marketplace: string
}

export interface DetectSpikesArgs {
  /** Default 2.0 — short-window must be ≥ 2x baseline. */
  ratioThreshold?: number
  /** Default 7. */
  shortWindowDays?: number
  /** Default 30. */
  longWindowDays?: number
  /** Minimum days with sales in short window. Default 3. */
  minSellingDaysShort?: number
  /** Minimum baseline (units/day). Default 0.5 — skips noise on
   *  low-velocity SKUs where 1 unit on a slow day looks like a
   *  10x ratio. */
  minBaselineVelocity?: number
}

export async function detectDemandSpikes(
  args: DetectSpikesArgs = {},
): Promise<DetectedSpike[]> {
  const ratioThreshold = args.ratioThreshold ?? 2.0
  const shortDays = args.shortWindowDays ?? 7
  const longDays = args.longWindowDays ?? 30
  const minSellingShort = args.minSellingDaysShort ?? 3
  const minBaseline = args.minBaselineVelocity ?? 0.5

  // Single-query aggregation. Both windows computed in the same
  // pass over DailySalesAggregate; no per-SKU round trip.
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const shortStart = new Date(today.getTime() - shortDays * 86_400_000)
  const longStart = new Date(today.getTime() - longDays * 86_400_000)

  const rows = await prisma.$queryRaw<
    Array<{
      sku: string
      channel: string
      marketplace: string
      short_units: bigint
      short_days: bigint
      long_units: bigint
      long_days: bigint
      long_stddev: number | null
    }>
  >`
    SELECT
      sku, channel, marketplace,
      SUM("unitsSold") FILTER (WHERE day >= ${shortStart}::date)::bigint AS short_units,
      count(*) FILTER (WHERE day >= ${shortStart}::date AND "unitsSold" > 0)::bigint AS short_days,
      SUM("unitsSold") FILTER (WHERE day >= ${longStart}::date)::bigint AS long_units,
      count(*) FILTER (WHERE day >= ${longStart}::date AND "unitsSold" > 0)::bigint AS long_days,
      stddev_samp("unitsSold") FILTER (WHERE day >= ${longStart}::date)::float AS long_stddev
    FROM "DailySalesAggregate"
    WHERE day >= ${longStart}::date
    GROUP BY sku, channel, marketplace
    HAVING SUM("unitsSold") FILTER (WHERE day >= ${longStart}::date) > 0
  `

  const spikes: DetectedSpike[] = []
  for (const row of rows) {
    const shortUnits = Number(row.short_units ?? 0)
    const shortDaysCount = Number(row.short_days ?? 0)
    const longUnits = Number(row.long_units ?? 0)
    const trailingShort = shortUnits / shortDays // units/day
    const trailingLong = longUnits / longDays
    const stddev = row.long_stddev ?? 0

    if (shortDaysCount < minSellingShort) continue
    if (trailingLong < minBaseline) continue
    if (trailingLong === 0) continue
    const ratio = trailingShort / trailingLong
    if (ratio < ratioThreshold) continue

    // Coarse confidence: short velocity exceeds mean by > 1 stddev.
    // Falls back to "has 3+ selling days + ratio threshold" when
    // stddev is missing (single-day samples / Postgres NULL).
    const confident = stddev > 0 ? trailingShort - trailingLong > stddev : true

    spikes.push({
      spike: {
        velocityRatio: Number(ratio.toFixed(3)),
        trailingShortVelocity: Number(trailingShort.toFixed(3)),
        trailingLongVelocity: Number(trailingLong.toFixed(3)),
        sellingDaysShort: shortDaysCount,
        confidenceExcludesBaseline: confident,
      },
      product: {
        id: null, // hydrated by caller via productId lookup if needed
        sku: row.sku,
      },
      channel: row.channel,
      marketplace: row.marketplace,
    })
  }

  return spikes
}
