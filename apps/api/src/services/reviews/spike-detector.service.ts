/**
 * SR.1 — Review spike detector.
 *
 * Compares 7-day vs 28-day negative-rate per (productId, marketplace,
 * category). When 7d rate > THRESHOLD_MULTIPLIER × 28d baseline AND
 * absolute count ≥ MIN_NEGATIVE_7D, writes an OPEN ReviewSpike row.
 *
 * Reads ReviewCategoryRate counters maintained by review-ingest. The
 * counters are already pre-aggregated per-day, so this scan is cheap
 * even at scale.
 *
 * SR.3 will wire spike events into the AutomationRule engine as a new
 * REVIEW_SPIKE_DETECTED trigger; the spike-driven A+ generator + bullet-
 * update actions consume the open spikes via the trigger context builder.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

const SPIKE_MULTIPLIER = Number(process.env.NEXUS_REVIEW_SPIKE_MULTIPLIER ?? 2.0)
const MIN_NEGATIVE_7D = Number(process.env.NEXUS_REVIEW_SPIKE_MIN_7D ?? 3)
const MIN_BASELINE_28D = Number(process.env.NEXUS_REVIEW_SPIKE_MIN_BASELINE ?? 5)

interface DetectionSummary {
  cohortsScanned: number
  spikesDetected: number
  spikesSkippedDuplicate: number // open spike already exists for this cohort
  errors: string[]
}

interface CohortKey {
  productId: string
  marketplace: string
  category: string
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

interface CohortStats {
  rate7dNumerator: number
  rate7dDenominator: number
  rate28dNumerator: number
  rate28dDenominator: number
}

async function aggregateRates(
  key: CohortKey,
  today: Date,
): Promise<CohortStats> {
  const day7 = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
  const day28 = new Date(today.getTime() - 28 * 24 * 60 * 60 * 1000)
  const [r7, r28] = await Promise.all([
    prisma.reviewCategoryRate.aggregate({
      where: {
        productId: key.productId,
        marketplace: key.marketplace,
        category: key.category,
        date: { gte: day7 },
      },
      _sum: { total: true, negative: true },
    }),
    prisma.reviewCategoryRate.aggregate({
      where: {
        productId: key.productId,
        marketplace: key.marketplace,
        category: key.category,
        date: { gte: day28 },
      },
      _sum: { total: true, negative: true },
    }),
  ])
  return {
    rate7dNumerator: r7._sum.negative ?? 0,
    rate7dDenominator: r7._sum.total ?? 0,
    rate28dNumerator: r28._sum.negative ?? 0,
    rate28dDenominator: r28._sum.total ?? 0,
  }
}

function isSpike(stats: CohortStats): { spike: boolean; multiplier: number | null } {
  if (stats.rate7dNumerator < MIN_NEGATIVE_7D) return { spike: false, multiplier: null }
  if (stats.rate28dDenominator < MIN_BASELINE_28D) return { spike: false, multiplier: null }
  const rate7d = stats.rate7dNumerator / Math.max(1, stats.rate7dDenominator)
  const rate28d = stats.rate28dNumerator / Math.max(1, stats.rate28dDenominator)
  if (rate28d === 0) {
    // Pure-novelty signal: no historic negatives but ≥MIN_NEGATIVE_7D in
    // the last 7 days — that's itself a spike.
    return { spike: true, multiplier: 99 }
  }
  const multiplier = rate7d / rate28d
  return { spike: multiplier >= SPIKE_MULTIPLIER, multiplier }
}

async function collectSampleTopPhrases(key: CohortKey): Promise<string[]> {
  const day7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const reviews = await prisma.review.findMany({
    where: {
      productId: key.productId,
      marketplace: key.marketplace,
      postedAt: { gte: day7 },
      sentiment: {
        is: {
          label: 'NEGATIVE',
          categories: { has: key.category },
        },
      },
    },
    orderBy: { postedAt: 'desc' },
    take: 5,
    select: { sentiment: { select: { topPhrases: true } } },
  })
  const phrases: string[] = []
  for (const r of reviews) {
    for (const p of r.sentiment?.topPhrases ?? []) {
      phrases.push(p)
      if (phrases.length >= 3) break
    }
    if (phrases.length >= 3) break
  }
  return phrases
}

async function hasOpenSpike(key: CohortKey): Promise<boolean> {
  const existing = await prisma.reviewSpike.findFirst({
    where: {
      productId: key.productId,
      marketplace: key.marketplace,
      category: key.category,
      status: 'OPEN',
    },
    select: { id: true },
  })
  return !!existing
}

/**
 * Find every (productId, marketplace, category) cohort that has any
 * activity in the last 7 days and evaluate it. Returns the count
 * detected + audit rows already persisted.
 */
export async function runSpikeDetectorOnce(): Promise<DetectionSummary> {
  const summary: DetectionSummary = {
    cohortsScanned: 0,
    spikesDetected: 0,
    spikesSkippedDuplicate: 0,
    errors: [],
  }
  const today = utcMidnight(new Date())
  const day7 = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)

  // Find active cohorts in last 7d.
  const rows = await prisma.reviewCategoryRate.findMany({
    where: { date: { gte: day7 }, negative: { gt: 0 } },
    select: { productId: true, marketplace: true, category: true },
    distinct: ['productId', 'marketplace', 'category'],
  })
  summary.cohortsScanned = rows.length

  for (const row of rows) {
    try {
      const stats = await aggregateRates(row, today)
      const { spike, multiplier } = isSpike(stats)
      if (!spike) continue
      if (await hasOpenSpike(row)) {
        summary.spikesSkippedDuplicate += 1
        continue
      }
      const sampleTopPhrases = await collectSampleTopPhrases(row)
      await prisma.reviewSpike.create({
        data: {
          productId: row.productId,
          marketplace: row.marketplace,
          category: row.category,
          rate7dNumerator: stats.rate7dNumerator,
          rate7dDenominator: stats.rate7dDenominator,
          rate28dNumerator: stats.rate28dNumerator,
          rate28dDenominator: stats.rate28dDenominator,
          spikeMultiplier: multiplier,
          sampleTopPhrases,
          status: 'OPEN',
        },
      })
      summary.spikesDetected += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`${row.productId}/${row.marketplace}/${row.category}: ${msg}`)
      logger.warn('[spike-detector] cohort failed', { cohort: row, error: msg })
    }
  }

  return summary
}

export function summarizeSpikeDetector(s: DetectionSummary): string {
  return [
    `cohorts=${s.cohortsScanned}`,
    `spikes+=${s.spikesDetected}`,
    s.spikesSkippedDuplicate > 0 ? `dedup=${s.spikesSkippedDuplicate}` : null,
    s.errors.length > 0 ? `errors=${s.errors.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
