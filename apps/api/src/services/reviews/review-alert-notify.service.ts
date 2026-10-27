/**
 * Reviews › Settings › Alerts (2026-10-26, build spec §3.6 / B15, PR D) — "New negative review": when the review intake
 * reads a NEW review of 1 or 2 stars, or one the AI reads as negative, the people the business picked hear about it at
 * once — in Nexus (a Notification row in the bell, like publish-refusal-notify.service.ts) and/or by e-mail.
 *
 * Rules (the lessons publish-refusal-notify.service.ts states):
 *   - RECIPIENTS ARE THIS BUSINESS'S PEOPLE, never every user: the members the business picked under Alerts; nobody
 *     picked = its active owners. Someone who left the business gets nothing.
 *   - DEDUPED: one unread notice per review per person.
 *   - Only reviews that ARRIVE: an imported file of old reviews and sandbox (fixture) rows alert nobody.
 *   - Best-effort: a failure here is logged and never turns a read review into a failed intake.
 *
 * The e-mail goes through the shared transport (sendEmail), which sends nothing unless outbound e-mail is on, and
 * carries this business's own sender (business-identity.service.ts); without one, no e-mail is sent.
 *
 * "Rating drop" (Phase 3) uses the same delivery: when the hourly check opens a rating-drop alert, the people picked
 * for it hear once per alert, in Nexus and/or by e-mail as Settings says (`notifyRatingDrop`).
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { resolveBusinessIdentity } from '../business-identity.service.js'
import { sendEmail } from '../email/transport.js'
import { channelMarketLabel } from './overviewMath.js'
import { ratingDropNoticeWords, type StoredDrop } from './rating-drop-math.js'
import { readAlert, teamMembers, type AlertSetting, type TeamMember } from './review-settings.service.js'

export const NEGATIVE_REVIEW_ALERT_TYPE = 'review-negative'

export interface NegativeReviewInput {
  reviewId: string
  channel: string
  marketplace: string | null
  rating: number | null
  /** The AI's reading: POSITIVE | NEUTRAL | NEGATIVE. */
  label: string | null
  /** How the review arrived (Review.ingestSource). */
  ingestSource: string | null
  title?: string | null
  body: string
  productName?: string | null
}

export interface AlertNotifyResult {
  created: number
  /** Skipped because the same notice is still unread. */
  deduped: number
  emailed: number
  /** Why nothing was sent, when nothing was ("off", "not negative", "imported", "nobody"). */
  skipped?: string
}

/** Sources that are not a review arriving: a file of old reviews, a hand entry, sandbox rows. */
const NOT_ARRIVALS = new Set(['IMPORT_CSV', 'IMPORT', 'MANUAL', 'FIXTURE'])

/** Whether a review counts as a new negative one for the alert. Pure. */
export function isAlertableNegative(input: Pick<NegativeReviewInput, 'rating' | 'label' | 'ingestSource'>): { alert: boolean; why?: string } {
  if (NOT_ARRIVALS.has((input.ingestSource ?? '').toUpperCase())) return { alert: false, why: 'imported' }
  const negative = input.label === 'NEGATIVE' || (input.rating != null && input.rating <= 2)
  return negative ? { alert: true } : { alert: false, why: 'not negative' }
}

/** Who gets it: the picked members still in the business, else its owners. Pure. */
export function alertRecipients(alert: Pick<AlertSetting, 'recipients'>, team: readonly TeamMember[]): TeamMember[] {
  const picked = team.filter((m) => alert.recipients.includes(m.userId))
  return picked.length ? picked : team.filter((m) => m.owner)
}

/** The notice's title and body, in words. Pure. */
export function negativeAlertWords(input: Pick<NegativeReviewInput, 'channel' | 'marketplace' | 'rating' | 'title' | 'body' | 'productName'>): { title: string; body: string } {
  const where = channelMarketLabel(input.channel, input.marketplace)
  const stars = input.rating != null ? `${input.rating} ${input.rating === 1 ? 'star' : 'stars'}` : 'Negative'
  const about = input.productName ? ` · ${input.productName}` : ''
  const quote = (input.title ? `${input.title} — ` : '') + input.body.replace(/\s+/g, ' ').trim()
  return {
    title: `New negative review: ${stars} on ${where}${about}`,
    body: quote.length > 200 ? `“${quote.slice(0, 199)}…”` : `“${quote}”`,
  }
}

export function inboxReviewHref(reviewId: string): string {
  return `/marketing/reviews/inbox?review=${encodeURIComponent(reviewId)}`
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Tell the picked people about a new negative review, as the business's "New negative review" alert says. Called by
 * the review intake for each new review; never throws.
 */
export async function notifyReviewAlert(input: NegativeReviewInput): Promise<AlertNotifyResult> {
  const none = (skipped: string): AlertNotifyResult => ({ created: 0, deduped: 0, emailed: 0, skipped })
  const negative = isAlertableNegative(input)
  if (!negative.alert) return none(negative.why ?? 'not negative')
  try {
    const alert = await readAlert('negative')
    if (!alert.on) return none('off')
    const recipients = alertRecipients(alert, await teamMembers())
    if (recipients.length === 0) return none('nobody')
    const words = negativeAlertWords(input)
    return await deliverAlert(alert, recipients, {
      type: NEGATIVE_REVIEW_ALERT_TYPE,
      entityType: 'Review',
      entityId: input.reviewId,
      words,
      href: inboxReviewHref(input.reviewId),
      meta: { channel: input.channel, marketplace: input.marketplace, rating: input.rating },
      tag: 'review-negative-alert',
      linkWords: 'Open it in the Inbox',
    })
  } catch (error) {
    logger.warn('[review-alert-notify] failed', { error: String(error).slice(0, 160) })
    return none('failed')
  }
}

// ── "Rating drop" (Phase 3) ─────────────────────────────────────────

export const RATING_DROP_ALERT_TYPE = 'review-rating-drop'

export interface RatingDropNoticeInput extends StoredDrop {
  /** The ReviewSpike row the hourly check just opened. */
  spikeId: string
  market: string
  channels: readonly string[]
  productName: string | null
}

/** Insights › Alerts on the alert's market (a bare path: the bell's router adds the business). */
export function ratingDropAlertsHref(market: string): string {
  return `/marketing/reviews/insights/alerts?market=${encodeURIComponent(market)}`
}

/**
 * Tell the picked people about a rating drop the hourly check just opened, as the business's "Rating drop" alert says:
 * in Nexus and/or by e-mail, once per alert per person. `saved` is the alert as the check read it (read again when
 * missing). Never throws.
 */
export async function notifyRatingDrop(input: RatingDropNoticeInput, saved?: AlertSetting): Promise<AlertNotifyResult> {
  const none = (skipped: string): AlertNotifyResult => ({ created: 0, deduped: 0, emailed: 0, skipped })
  try {
    const alert = saved ?? (await readAlert('ratingDrop'))
    if (!alert.on) return none('off')
    const recipients = alertRecipients(alert, await teamMembers())
    if (recipients.length === 0) return none('nobody')
    return await deliverAlert(alert, recipients, {
      type: RATING_DROP_ALERT_TYPE,
      entityType: 'ReviewSpike',
      entityId: input.spikeId,
      words: ratingDropNoticeWords(input),
      href: ratingDropAlertsHref(input.market),
      meta: { marketplace: input.market, channels: [...input.channels] },
      tag: 'review-rating-drop-alert',
      linkWords: 'Open it in Insights › Alerts',
    })
  } catch (error) {
    logger.warn('[review-alert-notify] rating drop failed', { error: String(error).slice(0, 160) })
    return none('failed')
  }
}

// ── Delivery (one path for every review alert) ──────────────────────

interface AlertNotice {
  type: string
  entityType: string
  entityId: string
  words: { title: string; body: string }
  /** A bare path; the bell's router adds the business, so the link cannot open another business. */
  href: string
  meta: Record<string, unknown>
  /** The e-mail's tag at the transport. */
  tag: string
  /** The e-mail's link words. */
  linkWords: string
}

/** The bell notice (one unread per entity per person) and, when the alert says so, the e-mail. */
async function deliverAlert(alert: AlertSetting, recipients: readonly TeamMember[], notice: AlertNotice): Promise<AlertNotifyResult> {
  const result: AlertNotifyResult = { created: 0, deduped: 0, emailed: 0 }
  const { words, href } = notice

  if (alert.via.includes('app')) {
    for (const person of recipients) {
      const unread = await prisma.notification.findFirst({
        where: { userId: person.userId, type: notice.type, entityType: notice.entityType, entityId: notice.entityId, readAt: null },
        select: { id: true },
      })
      if (unread) {
        result.deduped++
        continue
      }
      await prisma.notification.create({
        data: {
          userId: person.userId,
          type: notice.type,
          severity: 'warn',
          title: words.title,
          body: words.body,
          entityType: notice.entityType,
          entityId: notice.entityId,
          href,
          meta: notice.meta as object,
        },
      })
      result.created++
    }
  }

  if (alert.via.includes('email')) {
    const to = recipients.map((m) => m.email).filter(Boolean)
    const identity = await resolveBusinessIdentity()
    if (to.length && identity.ok) {
      const webBase = (process.env.NEXUS_WEB_URL ?? '').replace(/\/$/, '')
      // The same address the daily digest links to; the web app opens it in the signed-in person's business.
      const link = webBase ? `${webBase}${href}` : null
      const sent = await sendEmail({
        to,
        from: identity.identity.emailFrom,
        subject: words.title,
        html: `<p><strong>${escapeHtml(words.title)}</strong></p><p>${escapeHtml(words.body)}</p>${link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(notice.linkWords)}</a></p>` : ''}`,
        text: `${words.title}\n\n${words.body}${link ? `\n\n${notice.linkWords}: ${link}` : ''}`,
        tag: notice.tag,
      })
      if (sent.ok) result.emailed = to.length
      else logger.warn('[review-alert-notify] e-mail not sent', { error: (sent.error ?? '').slice(0, 160) })
    }
  }
  return result
}
