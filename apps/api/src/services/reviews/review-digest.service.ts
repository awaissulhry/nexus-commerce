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
 *
 * Audit 2026-10-27: every number is the one the pages show — visible rows only (fixtures never count), the ONE rating
 * (review-rating.ts), the ONE needs-a-reply rule (review-visibility.ts) — the pipeline warnings are the words Settings
 * shows (never a setting's name), and the link opens the Inbox inside this business.
 */

import prisma from '../../db.js'
import { sendEmail } from '../email/transport.js'
import { logger } from '../../utils/logger.js'
import { digestFallbackRecipients, readAlert, teamMembers } from './review-settings.service.js'
import { needsReplyWhere, visibleReviewWhere } from './review-visibility.js'
import { ratingOf } from './review-rating.js'
import { businessWebLink } from './review-alert-notify.service.js'

const WEB_URL = process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-web.up.railway.app'

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
  // Output-freshness warnings (silent-stall guard) — empty when healthy.
  pipelineWarnings: string[]
}

export async function buildReviewDigest(windowHours = 24): Promise<ReviewDigest> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000)
  const recent = await prisma.review.findMany({
    where: visibleReviewWhere({ ingestedAt: { gte: since } }),
    select: { channel: true, kind: true, ingestSource: true, rating: true, sentiment: { select: { label: true, categories: true } } },
  })
  const counts = { POSITIVE: 0, NEUTRAL: 0, NEGATIVE: 0 }
  const negCats: Record<string, number> = {}
  for (const r of recent) {
    if (r.sentiment) {
      counts[r.sentiment.label as keyof typeof counts] =
        (counts[r.sentiment.label as keyof typeof counts] ?? 0) + 1
      if (r.sentiment.label === 'NEGATIVE') {
        for (const c of r.sentiment.categories) negCats[c] = (negCats[c] ?? 0) + 1
      }
    }
  }
  const rating = ratingOf(recent)
  const topNegativeCategories = Object.entries(negCats)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  const [openSpikes, openDeskItems, negativesAwaiting] = await Promise.all([
    prisma.reviewSpike.count({ where: { status: 'OPEN' } }),
    // The badges' number: reviews that need a reply (answerable, not imported, open).
    prisma.review.count({ where: needsReplyWhere() }),
    prisma.review.count({ where: { AND: [needsReplyWhere(), { sentiment: { is: { label: 'NEGATIVE' } } }] } }),
  ])

  const { computeReviewPipelineFreshness } = await import('./review-pipeline-health.service.js')
  const { freshnessProblems } = await import('./review-settings-health.js')
  const freshness = await computeReviewPipelineFreshness()

  return {
    windowHours,
    newReviews: recent.length,
    counts,
    avgRating: rating.stars,
    topNegativeCategories,
    openDeskItems,
    negativesAwaiting,
    openSpikes,
    pipelineWarnings: freshnessProblems(freshness),
  }
}

function renderDigestHtml(d: ReviewDigest): string {
  const cats =
    d.topNegativeCategories.length > 0
      ? d.topNegativeCategories
          .map((c) => `<li>${CATEGORY_LABEL[c.category] ?? c.category} — ${c.count}</li>`)
          .join('')
      : '<li>None</li>'
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:560px;margin:0 auto;padding:16px">
  <h2 style="margin:0 0 4px">Daily review digest</h2>
  <p style="color:#64748b;margin:0 0 16px">Last ${d.windowHours}h across Amazon · eBay · Shopify</p>
  ${d.pipelineWarnings.length > 0 ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;margin:0 0 16px"><strong style="color:#b91c1c">⚠ Pipeline needs attention</strong><ul style="margin:6px 0 0;color:#7f1d1d">${d.pipelineWarnings.map((w) => `<li>${w}</li>`).join('')}</ul></div>` : ''}
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
    <tr>
      <td style="padding:8px;border:1px solid #e2e8f0"><strong>${d.newReviews}</strong><br>new reviews</td>
      <td style="padding:8px;border:1px solid #e2e8f0"><strong>${d.avgRating != null ? d.avgRating.toFixed(1) + '★' : '—'}</strong><br>average stars (product reviews; Amazon from imported reviews)</td>
      <td style="padding:8px;border:1px solid #e2e8f0;color:#be123c"><strong>${d.counts.NEGATIVE}</strong><br>negative</td>
    </tr>
  </table>
  <p style="margin:0 0 4px"><strong>Waiting for you</strong></p>
  <ul style="margin:0 0 16px">
    <li><strong style="color:#be123c">${d.negativesAwaiting}</strong> negative reviews to answer</li>
    <li><strong>${d.openDeskItems}</strong> reviews need a reply</li>
    <li><strong>${d.openSpikes}</strong> open spikes</li>
  </ul>
  <p style="margin:0 0 4px"><strong>Top complaint categories (24h)</strong></p>
  <ul style="margin:0 0 16px">${cats}</ul>
  <a href="${businessWebLink('/marketing/reviews/inbox?reply=needed&period=all', WEB_URL) ?? ''}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open the Inbox →</a>
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
  // Reviews Settings › Alerts: the business may turn the digest off, and picks who gets it.
  const alert = await readAlert('digest')
  if (!alert.on) return { sent: false, skipped: 'turned off in Reviews settings', digest }
  if (digest.newReviews === 0 && digest.negativesAwaiting === 0 && digest.openSpikes === 0 && digest.pipelineWarnings.length === 0) {
    return { sent: false, skipped: 'nothing to report', digest }
  }
  const to = await digestRecipients(alert.recipients)
  if (to.length === 0) return { sent: false, skipped: 'nobody to send to', digest }
  try {
    await sendEmail({
      to,
      subject: `${digest.pipelineWarnings.length > 0 ? '⚠ ' : ''}Daily review digest — ${digest.newReviews} new · ${digest.negativesAwaiting} to answer`,
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

/** The addresses of the people picked under Alerts who are still members, else where the digest went before. */
export async function digestRecipients(picked: readonly string[]): Promise<string[]> {
  const team = await teamMembers()
  const chosen = team.filter((m) => picked.includes(m.userId) && m.email).map((m) => m.email)
  return chosen.length ? chosen : digestFallbackRecipients(team)
}

export function summarizeReviewDigest(r: { sent: boolean; skipped?: string; digest: ReviewDigest }): string {
  return [
    r.sent ? 'sent' : `skipped(${r.skipped ?? '?'})`,
    `new=${r.digest.newReviews}`,
    `toAnswer=${r.digest.negativesAwaiting}`,
    `spikes=${r.digest.openSpikes}`,
  ].join(' · ')
}
