/**
 * SR.1 — Review spike detector ("Complaint spike").
 *
 * Compares 7-day vs 28-day negative-rate per (productId, marketplace,
 * category). The rule (thresholds, windows, once per cohort) lives in
 * complaint-spike-math.ts — ONE source for this check, the Settings page's
 * words and the notice. When a cohort spikes and no alert holds it, writes
 * an OPEN ReviewSpike row (Insights › Alerts) and, when the business switched
 * "Complaint spike" on in Reviews › Settings › Alerts, tells the people it
 * picked once for that alert, in Nexus and/or by e-mail
 * (review-alert-notify.service.ts `notifyComplaintSpike`).
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
import { publishReviewEvent } from '../review-events.service.js'
import { COMPLAINT_SPIKE_RULE, complaintSpikeHeld, complaintSpikeVerdict } from './complaint-spike-math.js'
import { notifyComplaintSpike } from './review-alert-notify.service.js'
import { readAlert, type AlertSetting } from './review-settings.service.js'
import { visibleReviewWhere } from './review-visibility.js'

const DAY = 86_400_000

interface DetectionSummary {
  cohortsScanned: number
  spikesDetected: number
  spikesSkippedDuplicate: number // open or acknowledged spike already exists for this cohort
  spikesSkippedResolved: number // its alert was resolved less than reopenAfterDays ago
  /** Notices delivered for the spikes opened (bell notices + e-mail recipients); 0 while the alert is off. */
  notified: number
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
  const day7 = new Date(today.getTime() - COMPLAINT_SPIKE_RULE.recentDays * DAY)
  const day28 = new Date(today.getTime() - COMPLAINT_SPIKE_RULE.baselineDays * DAY)
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

/** The alerts that may hold this cohort: open or acknowledged, or resolved within reopenAfterDays. */
async function heldBy(key: CohortKey, now: Date): Promise<'open' | 'resolved recently' | null> {
  const existing = await prisma.reviewSpike.findMany({
    where: {
      productId: key.productId,
      marketplace: key.marketplace,
      category: key.category,
      OR: [
        { status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        { status: 'RESOLVED', resolvedAt: { gte: new Date(now.getTime() - COMPLAINT_SPIKE_RULE.reopenAfterDays * DAY) } },
      ],
    },
    select: { status: true, resolvedAt: true },
  })
  return complaintSpikeHeld(existing, now)
}

/** The channels of the recent window's negative reviews about the theme (for the notice's "where"). */
async function cohortChannels(key: CohortKey, since: Date): Promise<string[]> {
  const rows = await prisma.review.findMany({
    where: visibleReviewWhere({
      productId: key.productId,
      marketplace: key.marketplace,
      postedAt: { gte: since },
      sentiment: { is: { label: 'NEGATIVE', categories: { has: key.category } } },
    }),
    select: { channel: true },
    distinct: ['channel'],
  })
  return [...new Set(rows.map((r) => r.channel.toUpperCase()))].sort()
}

/**
 * Find every (productId, marketplace, category) cohort that has any
 * activity in the last 7 days and evaluate it. Returns the count
 * detected + audit rows already persisted.
 */
export async function runSpikeDetectorOnce(now: Date = new Date()): Promise<DetectionSummary> {
  const summary: DetectionSummary = {
    cohortsScanned: 0,
    spikesDetected: 0,
    spikesSkippedDuplicate: 0,
    spikesSkippedResolved: 0,
    notified: 0,
    errors: [],
  }
  const today = utcMidnight(now)
  const day7 = new Date(today.getTime() - COMPLAINT_SPIKE_RULE.recentDays * DAY)
  // "Complaint spike" in Settings › Alerts, read once per run when the first spike opens.
  let alert: AlertSetting | null = null

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
      const { spike, multiplier } = complaintSpikeVerdict(stats)
      if (!spike) continue
      // Once per cohort: an open or acknowledged alert holds it, and a resolve holds it for reopenAfterDays.
      const held = await heldBy(row, now)
      if (held === 'open') {
        summary.spikesSkippedDuplicate += 1
        continue
      }
      if (held === 'resolved recently') {
        summary.spikesSkippedResolved += 1
        continue
      }
      const sampleTopPhrases = await collectSampleTopPhrases(row)
      const created = await prisma.reviewSpike.create({
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
          detectedAt: now,
        },
        select: { id: true },
      })
      summary.spikesDetected += 1
      // RX.3 — push to the live bus for the spike banner + notification.
      publishReviewEvent({
        type: 'review.spike.detected',
        spikeId: created.id,
        productId: row.productId,
        marketplace: row.marketplace,
        category: row.category,
        multiplier: typeof multiplier === 'number' ? multiplier : Number(multiplier) || null,
        ts: Date.now(),
      })
      // The notice: once, for this new alert, as Settings › Alerts › "Complaint spike" says (off by default).
      alert ??= await readAlert('complaintSpike')
      if (alert.on) {
        const [product, channels] = await Promise.all([
          prisma.product.findUnique({ where: { id: row.productId }, select: { name: true } }),
          cohortChannels(row, day7),
        ])
        const told = await notifyComplaintSpike({
          spikeId: created.id,
          productId: row.productId,
          market: row.marketplace,
          theme: row.category,
          channels,
          productName: product?.name ?? null,
          phrases: sampleTopPhrases,
          ...stats,
        }, alert)
        summary.notified += told.created + told.emailed
      }
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
    s.spikesSkippedResolved > 0 ? `resolved recently=${s.spikesSkippedResolved}` : null,
    s.notified > 0 ? `notified=${s.notified}` : null,
    s.errors.length > 0 ? `errors=${s.errors.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
