/**
 * Reviews › "Rating drop" alert (Phase 3) — the check the hourly alerts job runs (jobs/review-pipeline.job.ts, after the
 * complaint-spike check, through lib/cron/clustered.ts, once per business). The rules are in rating-drop-math.ts.
 *
 *   Off in Settings › Alerts (the default) → nothing is read and nothing opens.
 *   On → for each product family and market whose average stars fell (last 7 days against the 28 days before), ONE
 *        alert in Insights › Alerts (a ReviewSpike row, category RATING_DROP: the same Acknowledge / Resolve / bulk flow
 *        and Overview › Needs you), and the notice to the people Settings names, in Nexus and/or by e-mail as Settings
 *        says (review-alert-notify.service.ts: the shared transport, nothing new that sends).
 *
 * The stored numbers: rate7d = the stars summed over the rated reviews of the last 7 days / how many; rate28d = the same
 * for the 28 days before. spikeMultiplier holds the change in stars (negative). Every Review read is visible rows only.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { publishReviewEvent } from '../review-events.service.js'
import { notifyRatingDrop } from './review-alert-notify.service.js'
import { readAlert } from './review-settings.service.js'
import { reviewKindWhere, visibleReviewWhere } from './review-visibility.js'
import {
  isRatingDrop, RATING_DROP_CATEGORY, RATING_DROP_RULE, ratingDropHeld, ratingDropStats, ratingDropWindows,
  type RatingDropRow,
} from './rating-drop-math.js'

const DAY = 86_400_000

export interface RatingDropSummary {
  /** The alert is off in Settings: nothing was checked. */
  off: boolean
  /** Families × markets with rated reviews in either window. */
  checked: number
  dropped: number
  opened: number
  /** Dropped, but an alert for it is open or acknowledged. */
  skippedOpen: number
  /** Dropped, but its alert was resolved less than 7 days ago. */
  skippedResolved: number
  notified: number
  errors: string[]
}

export async function runRatingDropCheckOnce(now = new Date()): Promise<RatingDropSummary> {
  const summary: RatingDropSummary = { off: false, checked: 0, dropped: 0, opened: 0, skippedOpen: 0, skippedResolved: 0, notified: 0, errors: [] }
  const alert = await readAlert('ratingDrop')
  if (!alert.on) return { ...summary, off: true }

  const w = ratingDropWindows(now)
  const rows: RatingDropRow[] = await prisma.review.findMany({
    where: visibleReviewWhere({
      AND: [
        reviewKindWhere('product'),
        { productId: { not: null }, rating: { not: null }, marketplace: { not: null }, channel: { not: 'EBAY' }, postedAt: { gte: w.beforeFrom, lte: w.to } },
      ],
    }),
    select: {
      productId: true, channel: true, marketplace: true, rating: true, kind: true, ingestSource: true, postedAt: true,
      sentiment: { select: { label: true, topPhrases: true } },
    },
  })
  if (rows.length === 0) return summary

  // Families: a variant belongs to its parent; a product with no parent is its own family; a deleted product counts nowhere.
  const productIds = [...new Set(rows.map((r) => r.productId!).filter(Boolean))]
  const products = await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true, parentId: true, name: true } })
  const familyOf = new Map(products.map((p) => [p.id, p.parentId ?? p.id]))
  const stats = ratingDropStats(rows, (id) => familyOf.get(id) ?? null, now)
  summary.checked = stats.length
  const drops = stats.filter((s) => isRatingDrop(s).drop)
  summary.dropped = drops.length
  if (drops.length === 0) return summary

  const families = [...new Set(drops.map((d) => d.familyId))]
  const [existing, heads] = await Promise.all([
    prisma.reviewSpike.findMany({
      where: {
        category: RATING_DROP_CATEGORY,
        productId: { in: families },
        OR: [{ status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, { status: 'RESOLVED', resolvedAt: { gte: new Date(now.getTime() - RATING_DROP_RULE.reopenAfterDays * DAY) } }],
      },
      select: { productId: true, marketplace: true, status: true, resolvedAt: true },
    }),
    prisma.product.findMany({ where: { id: { in: families } }, select: { id: true, name: true } }),
  ])
  const nameOf = new Map(heads.map((p) => [p.id, p.name]))

  for (const d of drops) {
    try {
      const held = ratingDropHeld(existing.filter((e) => e.productId === d.familyId && e.marketplace === d.market), now)
      if (held === 'open') {
        summary.skippedOpen += 1
        continue
      }
      if (held === 'resolved recently') {
        summary.skippedResolved += 1
        continue
      }
      const stored = { rate7dNumerator: d.recentSum, rate7dDenominator: d.recentCount, rate28dNumerator: d.beforeSum, rate28dDenominator: d.beforeCount }
      const created = await prisma.reviewSpike.create({
        data: {
          productId: d.familyId,
          marketplace: d.market,
          category: RATING_DROP_CATEGORY,
          ...stored,
          spikeMultiplier: d.change,
          sampleTopPhrases: d.phrases,
          status: 'OPEN',
          detectedAt: now,
        },
        select: { id: true },
      })
      // A second family/market in this run must see the one just opened (the same family can drop in two markets).
      existing.push({ productId: d.familyId, marketplace: d.market, status: 'OPEN', resolvedAt: null })
      summary.opened += 1
      publishReviewEvent({ type: 'review.spike.detected', spikeId: created.id, productId: d.familyId, marketplace: d.market, category: RATING_DROP_CATEGORY, multiplier: null, ts: Date.now() })
      const told = await notifyRatingDrop({ spikeId: created.id, market: d.market, channels: d.channels, productName: nameOf.get(d.familyId) ?? null, ...stored }, alert)
      summary.notified += told.created + told.emailed
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      summary.errors.push(`${d.familyId}/${d.market}: ${msg}`)
      logger.warn('[rating-drop] family failed', { familyId: d.familyId, market: d.market, error: msg })
    }
  }
  return summary
}

export function summarizeRatingDrop(s: RatingDropSummary): string {
  if (s.off) return 'rating drop: off'
  return [
    `rating drop: checked=${s.checked}`,
    `opened=${s.opened}`,
    s.skippedOpen > 0 ? `already open=${s.skippedOpen}` : null,
    s.skippedResolved > 0 ? `resolved recently=${s.skippedResolved}` : null,
    s.errors.length > 0 ? `errors=${s.errors.length}` : null,
  ].filter(Boolean).join(' · ')
}
