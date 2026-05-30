/**
 * RX.3 — Daily review digest email.
 *
 * Summarizes the last 24h of review activity (new reviews by sentiment,
 * average rating, top complaint categories, what's waiting in the
 * Response Desk, open spikes) and emails it to the operator inbox.
 *
 * Gated by NEXUS_ENABLE_REVIEW_DIGEST=1 (and the global outbound-email
 * flag inside sendEmail). Skips sending when there's nothing to report
 * so a quiet day doesn't generate noise.
 */

import prisma from '../../db.js'
import { sendEmail } from '../email/transport.js'
import { logger } from '../../utils/logger.js'

const WEB_URL = process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-three.vercel.app'

const CATEGORY_LABEL: Record<string, string> = {
  FIT_SIZING: 'Fit / Sizing',
  DURABILITY: 'Durability',
  SHIPPING: 'Shipping',
  VALUE: 'Value',
  DESIGN: 'Design',
  QUALITY: 'Quality',
  SAFETY: 'Safety',
  COMFORT: 'Comfort',
  OTHER: 'Other',
}

export interface ReviewDigest {
  windowHours: number
  newReviews: number
  counts: { POSITIVE: number; NEUTRAL: number; NEGATIVE: number }
  avgRating: number | null
  topNegativeCategories: { category: string; count: number }[]
  openDeskItems: number
  negativesAwaiting: number
  openSpikes: number
}

export async function buildReviewDigest(windowHours = 24): Promise<ReviewDigest> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000)
  const recent = await prisma.review.findMany({
    where: { ingestedAt: { gte: since } },
    select: { rating: true, sentiment: { select: { label: true, categories: true } } },
  })
  const counts = { POSITIVE: 0, NEUTRAL: 0, NEGATIVE: 0 }
  const negCats: Record<string, number> = {}
  let ratingSum = 0
  let ratingN = 0
  for (const r of recent) {
    if (r.sentiment) {
      counts[r.sentiment.label as keyof typeof counts] =
        (counts[r.sentiment.label as keyof typeof counts] ?? 0) + 1
      if (r.sentiment.label === 'NEGATIVE') {
        for (const c of r.sentiment.categories) negCats[c] = (negCats[c] ?? 0) + 1
      }
    }
    if (r.rating != null) {
      ratingSum += r.rating
      ratingN += 1
    }
  }
  const topNegativeCategories = Object.entries(negCats)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  const [openSpikes, openDeskItems, negativesAwaiting] = await Promise.all([
    prisma.reviewSpike.count({ where: { status: 'OPEN' } }),
    prisma.review.count({
      where: { OR: [{ triageStatus: 'NEW' }, { triageStatus: null }, { triageStatus: 'IN_PROGRESS' }] },
    }),
    prisma.review.count({
      where: {
        sentiment: { is: { label: 'NEGATIVE' } },
        NOT: { triageStatus: { in: ['RESPONDED', 'RESOLVED', 'IGNORED'] } },
      },
    }),
  ])

  return {
    windowHours,
    newReviews: recent.length,
    counts,
    avgRating: ratingN > 0 ? ratingSum / ratingN : null,
    topNegativeCategories,
    openDeskItems,
    negativesAwaiting,
    openSpikes,
  }
}

function renderDigestHtml(d: ReviewDigest): string {
  const cats =
    d.topNegativeCategories.length > 0
      ? d.topNegativeCategories
          .map((c) => `<li>${CATEGORY_LABEL[c.category] ?? c.category} — ${c.count}</li>`)
          .join('')
      : '<li>None 🎉</li>'
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:560px;margin:0 auto;padding:16px">
  <h2 style="margin:0 0 4px">Daily review digest</h2>
  <p style="color:#64748b;margin:0 0 16px">Last ${d.windowHours}h across Amazon · eBay · Shopify</p>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
    <tr>
      <td style="padding:8px;border:1px solid #e2e8f0"><strong>${d.newReviews}</strong><br>new reviews</td>
      <td style="padding:8px;border:1px solid #e2e8f0"><strong>${d.avgRating != null ? d.avgRating.toFixed(2) + '★' : '—'}</strong><br>avg rating</td>
      <td style="padding:8px;border:1px solid #e2e8f0;color:#be123c"><strong>${d.counts.NEGATIVE}</strong><br>negative</td>
    </tr>
  </table>
  <p style="margin:0 0 4px"><strong>Waiting for you</strong></p>
  <ul style="margin:0 0 16px">
    <li><strong style="color:#be123c">${d.negativesAwaiting}</strong> negative reviews to answer</li>
    <li><strong>${d.openDeskItems}</strong> open in the Response Desk</li>
    <li><strong>${d.openSpikes}</strong> open spikes</li>
  </ul>
  <p style="margin:0 0 4px"><strong>Top complaint categories (24h)</strong></p>
  <ul style="margin:0 0 16px">${cats}</ul>
  <a href="${WEB_URL}/marketing/reviews/desk" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open the Response Desk →</a>
  </body></html>`
}

export async function sendReviewDigestOnce(): Promise<{
  sent: boolean
  skipped?: string
  digest: ReviewDigest
}> {
  const windowHours = Number(process.env.NEXUS_REVIEW_DIGEST_WINDOW_HOURS ?? 24)
  const digest = await buildReviewDigest(windowHours)
  if (process.env.NEXUS_ENABLE_REVIEW_DIGEST !== '1') {
    return { sent: false, skipped: 'NEXUS_ENABLE_REVIEW_DIGEST not set', digest }
  }
  if (digest.newReviews === 0 && digest.negativesAwaiting === 0 && digest.openSpikes === 0) {
    return { sent: false, skipped: 'nothing to report', digest }
  }
  const to = (process.env.NEXUS_REVIEW_DIGEST_TO ?? process.env.NEXUS_SUPPORT_INBOX ?? 'support@xavia.it')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  try {
    await sendEmail({
      to,
      subject: `Daily review digest — ${digest.newReviews} new · ${digest.negativesAwaiting} to answer`,
      html: renderDigestHtml(digest),
    })
    return { sent: true, digest }
  } catch (err) {
    logger.warn('[review-digest] send failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { sent: false, skipped: 'send failed', digest }
  }
}

export function summarizeReviewDigest(r: { sent: boolean; skipped?: string; digest: ReviewDigest }): string {
  return [
    r.sent ? 'sent' : `skipped(${r.skipped ?? '?'})`,
    `new=${r.digest.newReviews}`,
    `toAnswer=${r.digest.negativesAwaiting}`,
    `spikes=${r.digest.openSpikes}`,
  ].join(' · ')
}
